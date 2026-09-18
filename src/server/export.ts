import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { EXPORT_DIR, MEDIA_DIR, mediaPath } from "./config";
import { jobContext, logEvent, traced } from "./db";
import { markEphemeral } from "./ephemeral";
import { getNode, whenFinalized, type StoryNode } from "./pipeline";
import { fetchTo, isGeneratedUrl, keyForMediaUrl, objectExists, offload, r2Enabled, withTempDir } from "./storage";

const MUSIC = `${MEDIA_DIR}/music/loop.mp3`;

/** True when a finished export is already available, wherever it is served from. */
async function exportExists(name: string) {
  return r2Enabled() ? objectExists(`exports/${name}`) : existsSync(`${EXPORT_DIR}/${name}`);
}

/**
 * Where a render should be written. With R2 that is a scratch directory the caller throws away; without it,
 * the export directory the file is served from, so the local-dev path behaves exactly as it always did.
 */
const renderDir = (scratch: string) => (r2Enabled() ? scratch : EXPORT_DIR);

/**
 * Hands a finished render to R2 and drops the container's copy. A no-op when already serving from disk.
 *
 * If R2 refuses the upload because the storage cap is reached, the render must NOT be left in the scratch
 * directory: that is deleted the moment this render finishes, and the film would vanish. Copy it onto the
 * volume instead, where the /media/exports fallback will still find and serve it.
 */
async function publishExport(name: string, rendered: string) {
  if (!r2Enabled()) return; // already written straight into EXPORT_DIR
  if (await offload(`exports/${name}`, rendered)) return;
  mkdirSync(EXPORT_DIR, { recursive: true });
  // copy rather than rename: the scratch dir and the volume are different filesystems.
  const kept = `${EXPORT_DIR}/${name}`;
  copyFileSync(rendered, kept);
  // Watchable and downloadable, but temporary and never shareable. The sweeper reclaims it when the
  // viewer leaves, so the disk R2 was meant to protect does not quietly fill up instead.
  markEphemeral(kept, `/media/exports/${name}`, jobContext.getStore()?.viewerId);
  logEvent({ kind: "error", label: "export kept on disk (R2 cap reached)", status: "error", response: { name } });
}

/**
 * A local file ffmpeg can read for one `/media/...` URL, or null when there is nothing to read.
 * Generated media is pulled out of R2 into `dir` for the length of the render; committed assets are used
 * in place. Returns null rather than throwing so a chain with one missing clip still exports the rest.
 */
async function materialize(url: string | null, dir: string) {
  if (!url) return null;
  if (r2Enabled() && isGeneratedUrl(url)) {
    const key = keyForMediaUrl(url);
    if (!key || !(await objectExists(key))) return null;
    return fetchTo(key, dir);
  }
  const local = mediaPath(url);
  return local && existsSync(local) ? local : null;
}

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
  const name = `${nodeId}-vertical.mp4`;
  const url = `/media/exports/${name}`;
  if (await exportExists(name)) return { url, cached: true };
  if (!(await exportExists(`${nodeId}.mp4`))) await exportFilm(nodeId);

  return once(url, () => traced("job", "export vertical film", { nodeId }, () => withTempDir("vertical", async scratch => {
    const landscape = await materialize(`/media/exports/${nodeId}.mp4`, scratch);
    if (!landscape) throw new Error("The landscape film is missing, so there is nothing to reframe");
    const out = `${renderDir(scratch)}/${name}`;
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
    await publishExport(name, out);
    return { url, cached: false };
  })));
}

/**
 * Poster frame for the share card, pulled from near the end of the film. Like the exports themselves it is
 * rendered in a scratch directory and handed to R2, so sharing an ending leaves nothing on the container.
 */
export async function ensureThumbnail(nodeId: string) {
  const name = `${nodeId}.jpg`;
  const url = `/media/exports/${name}`;
  if (await exportExists(name)) return url;

  return once(url, () => traced("job", "share thumbnail", { nodeId }, () => withTempDir("thumb", async scratch => {
    const mp4 = await materialize(`/media/exports/${nodeId}.mp4`, scratch);
    if (!mp4) throw new Error("The film is missing, so there is no frame to grab");
    const out = `${renderDir(scratch)}/${name}`;
    const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-sseof", "-2", "-i", mp4, "-frames:v", "1", "-update", "1", "-vf", "scale=1280:-2", out]);
    if ((await proc.exited) !== 0) throw new Error("ffmpeg failed making the share thumbnail");
    await publishExport(name, out);
    return { url, cached: false };
  }))).then(() => url);
}

/**
 * Stitches the intro and every generated step clip leading to `nodeId` into one MP4, with the background music
 * looped under the whole film. Steps played in no-video mode have no clip and are skipped. Cached per node.
 */
export async function exportFilm(nodeId: string) {
  const node = getNode(nodeId);
  if (!node) throw new Error("Unknown node");
  mkdirSync(EXPORT_DIR, { recursive: true });
  const name = `${node.id}.mp4`;
  const url = `/media/exports/${name}`;
  if (await exportExists(name)) return { url, cached: true };

  // A step's clip may still be moving from the provider's CDN into storage; stitch the stored copies.
  const steps = chain(node);
  await Promise.all(steps.map(n => whenFinalized(n.id)));
  const clipUrls = steps.map(n => n.clipUrl);

  return once(url, () => traced(
    "job",
    "export film",
    { nodeId, clipUrls },
    () => withTempDir("film", async scratch => {
      // ffmpeg needs real files, so any clip living in R2 comes back to disk for the length of this render.
      const clips = (await Promise.all(clipUrls.map(u => materialize(u, scratch)))).filter((f): f is string => Boolean(f));
      if (clips.length === 0) throw new Error("No video clips to stitch yet");
      const out = `${renderDir(scratch)}/${name}`;

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

      await publishExport(name, out);
      const seconds = probes.reduce((sum, p) => sum + p.duration, 0);
      logEvent({ kind: "job", label: "film exported", response: { url, clips: clips.length, seconds: Number(seconds.toFixed(1)) } });
      return { url, cached: false, seconds };
    }),
  ));
}
