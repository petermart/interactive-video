import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { EXPORT_DIR, MEDIA_DIR, mediaPath } from "./config";
import { logEvent, traced } from "./db";
import { getNode, type StoryNode } from "./pipeline";

const MUSIC = `${MEDIA_DIR}/music/loop.mp3`;

/** In-flight renders, so two viewers (or a retry) never race on the same output file. */
const inFlight = new Map<string, Promise<{ url: string; cached: boolean; seconds?: number }>>();

/**
 * Runs ffmpeg into a temp file and renames it into place only on success, so an interrupted render
 * can never be picked up as a finished, cached export.
 */
async function renderTo(out: string, args: (tmp: string) => string[]) {
  const tmp = `${out}.${crypto.randomUUID().slice(0, 8)}.tmp.mp4`;
  try {
    const proc = Bun.spawn(args(tmp), { stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      // No stderr at all means ffmpeg was killed rather than failing: on a small container that is the OOM killer.
      const why = stderr.trim() ? stderr.slice(-600) : `killed (${proc.signalCode ?? `exit ${code}`}), most likely out of memory`;
      throw new Error(`ffmpeg failed: ${why}`);
    }
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Serialises repeat calls for the same output file. */
function once<T extends { url: string; cached: boolean; seconds?: number }>(key: string, fn: () => Promise<T>) {
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
const MUSIC_VOLUME = 0.35; // matches the in-browser soundtrack level
const W = 864;
const H = 480;
const FPS = 24;
/** 9:16 output size. Both dimensions must stay divisible by 10 for the /5 blur pass to land on whole pixels. */
const VW = 720;
const VH = 1280;

/** Probes a clip's duration and whether it has an audio track. */
async function probe(file: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]);
  const out: any = JSON.parse(await new Response(proc.stdout).text());
  return {
    duration: Number(out.format?.duration ?? 0),
    hasAudio: (out.streams ?? []).some((s: { codec_type: string }) => s.codec_type === "audio"),
  };
}

/** The story from the intro to this node, oldest first. */
function chain(node: StoryNode) {
  const nodes: StoryNode[] = [];
  for (let n: StoryNode | undefined = node; n; n = n.parentId ? getNode(n.parentId) : undefined) nodes.unshift(n);
  return nodes;
}

/**
 * 9:16 version of the film for Instagram/TikTok/Stories: the 16:9 film centred on a blurred fill of itself.
 * Built from the finished landscape export, so it costs nothing beyond ffmpeg time.
 */
export async function exportVertical(nodeId: string) {
  const landscape = `${EXPORT_DIR}/${nodeId}.mp4`;
  if (!existsSync(landscape)) await exportFilm(nodeId);
  const out = `${EXPORT_DIR}/${nodeId}-vertical.mp4`;
  const url = `/media/exports/${nodeId}-vertical.mp4`;
  if (existsSync(out)) return { url, cached: true };

  return once(out, () => traced("job", "export vertical film", { nodeId }, async () => {
    // Deliberately frugal: the deploy container is small, and a 1080x1920 multi-threaded x264 encode gets
    // SIGKILLed there. 720x1280 is still full quality for Reels/TikTok, the blur runs on a thumbnail-sized
    // copy before being scaled up (visually identical), and single-threaded x264 keeps one set of frame buffers.
    const filter = [
      `[0:v]scale=${VW / 5}:${VH / 5}:force_original_aspect_ratio=increase,crop=${VW / 5}:${VH / 5},boxblur=6:1,eq=brightness=-0.12,scale=${VW}:${VH},setsar=1[bg]`,
      `[0:v]scale=${VW}:-2,setsar=1[fg]`,
      "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]",
    ].join(";");
    await renderTo(out, tmp => [
      "ffmpeg", "-v", "error", "-y", "-threads", "1", "-filter_threads", "1", "-i", landscape,
      "-filter_complex", filter, "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "superfast", "-crf", "23", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", tmp,
    ]);
    return { url, cached: false };
  }));
}

/**
 * Stitches the intro and every generated step clip leading to `nodeId` into one MP4, with the background music
 * looped under the whole film. Steps played in no-video mode have no clip and are skipped. Cached per node.
 */
export async function exportFilm(nodeId: string) {
  const node = getNode(nodeId);
  if (!node) throw new Error("Unknown node");
  mkdirSync(EXPORT_DIR, { recursive: true });
  const out = `${EXPORT_DIR}/${node.id}.mp4`;
  const url = `/media/exports/${node.id}.mp4`;
  if (existsSync(out)) return { url, cached: true };

  const clips = chain(node)
    .map(n => mediaPath(n.clipUrl))
    .filter((f): f is string => Boolean(f && existsSync(f)));
  if (clips.length === 0) throw new Error("No video clips to stitch yet");

  return once(out, () => traced(
    "job",
    `export film (${clips.length} clips)`,
    { nodeId, clips },
    async () => {
      const probes = await Promise.all(clips.map(probe));
      const args = ["ffmpeg", "-v", "error", "-y"];
      const filters: string[] = [];
      const parts: string[] = [];

      clips.forEach((file, i) => args.push("-i", file));
      let nextInput = clips.length;

      clips.forEach((_, i) => {
        // Normalize every clip so concat accepts them: same size, fps, pixel format, sample rate and layout.
        filters.push(
          `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`,
        );
        if (probes[i]!.hasAudio) {
          filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
        } else {
          // Silent clips (e.g. the stripped thinking loop) get a matching silent track.
          args.push("-f", "lavfi", "-t", String(probes[i]!.duration), "-i", "anullsrc=r=48000:cl=stereo");
          filters.push(`[${nextInput++}:a]aformat=channel_layouts=stereo[a${i}]`);
        }
        parts.push(`[v${i}][a${i}]`);
      });
      filters.push(`${parts.join("")}concat=n=${clips.length}:v=1:a=1[v][clipaudio]`);

      if (existsSync(MUSIC)) {
        args.push("-stream_loop", "-1", "-i", MUSIC);
        filters.push(`[${nextInput}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${MUSIC_VOLUME}[music]`);
        filters.push(`[clipaudio][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`);
      } else {
        filters.push(`[clipaudio]anull[a]`);
      }

      await renderTo(out, tmp => [
        ...args,
        "-filter_complex", filters.join(";"),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        tmp,
      ]);

      const seconds = probes.reduce((sum, p) => sum + p.duration, 0);
      logEvent({ kind: "job", label: "film exported", response: { url, seconds: Number(seconds.toFixed(1)) } });
      return { url, cached: false, seconds };
    },
  ));
}
