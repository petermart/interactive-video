import { existsSync, mkdirSync } from "node:fs";
import { EXPORT_DIR, MEDIA_DIR, mediaPath } from "./config";
import { logEvent, traced } from "./db";
import { getNode, type StoryNode } from "./pipeline";

const MUSIC = `${MEDIA_DIR}/music/loop.mp3`;
const MUSIC_VOLUME = 0.35; // matches the in-browser soundtrack level
const W = 864;
const H = 480;
const FPS = 24;

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

  return traced(
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

      args.push(
        "-filter_complex", filters.join(";"),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        out,
      );
      const proc = Bun.spawn(args, { stderr: "pipe" });
      const stderr = await new Response(proc.stderr).text();
      if ((await proc.exited) !== 0) throw new Error(`ffmpeg export failed: ${stderr.slice(-600)}`);

      const seconds = probes.reduce((sum, p) => sum + p.duration, 0);
      logEvent({ kind: "job", label: "film exported", response: { url, seconds: Number(seconds.toFixed(1)) } });
      return { url, cached: false, seconds };
    },
  );
}
