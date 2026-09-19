import { existsSync, mkdirSync, rmSync } from "node:fs";
import { CACHE_DIR, keys, MEDIA_DIR, ROOT } from "./config";
import { logEvent, traced } from "./db";
import type { VideoRequest } from "./machgen";
import { isRetryableStatus, RetryableHttpError, withRetry } from "./net";
import { putFile } from "./storage";

/**
 * MiniMax H3 **Max** on fal.ai: the fast H3 variant, at 480P. Measured on one 15s reference-to-video step:
 * 9.2s from submit to a saved file (1.1s queue, 6.3s generating), against 15-17s for H3 on MachGen and
 * about 4.5 minutes on GMI. Same $0.05/s as MachGen's R2V, so a 15s step is $0.75.
 *
 * Drop-in for machgen.ts (same VideoRequest in), with one difference that makes steps faster: the clip is
 * returned as fal's CDN link the moment it is ready, so the player can start watching straight away. The
 * download, the copy to R2 and the last-frame extraction happen afterwards in `finalize()`, which the
 * pipeline runs in the background.
 *
 * References are sent inline as data URIs, so nothing is uploaded anywhere first and local development
 * needs no public URL. They are downscaled to 1024px because fal bills reference images above 4,096 tokens
 * (about 1,000 tokens per megapixel): nine 1600px sheets would add ~$0.17 a step, nine 1024px ones ~$0.02.
 *
 * The queue, download and inline-image helpers are shared with the turbo client (falTurboVideo.ts).
 */

const QUEUE = "https://queue.fal.run";
const ENDPOINTS = {
  R2V: "minimax/h3-max/reference-to-video",
  I2V: "minimax/h3-max/image-to-video",
  T2V: "minimax/h3-max/text-to-video",
} as const;
const RESOLUTION = "480P";
/** fal's listed price for H3 Max at 480P, per output second. */
export const FAL_H3_MAX_USD_PER_SEC = 0.05;
/** Reference width sent to fal: keeps the per-step reference token bill near zero. */
const REF_WIDTH = 1024;

const auth = () => ({ Authorization: `Key ${keys.fal}` });

/** Data URIs for repo assets, built once per process: the sheets never change while the server runs. */
const assetUris = new Map<string, Promise<string>>();

export const refName = (repoPath: string) => repoPath.replace(/[\\/]/g, "__").replace(/\.png$/i, ".jpg");

/**
 * Downscales an image to a JPEG and returns it as a data URI. Repo assets keep their JPEG in the cache (they are
 * reused every step); one-off images (`keep: false`, e.g. a clip's last frame) are deleted straight away so they
 * cannot pile up on the disk.
 */
export async function toDataUri(source: string, cacheName: string, { keep = true, width = REF_WIDTH } = {}) {
  mkdirSync(`${CACHE_DIR}/fal-refs`, { recursive: true });
  const jpeg = `${CACHE_DIR}/fal-refs/${cacheName}`;
  if (!existsSync(jpeg)) {
    const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", source, "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", jpeg]);
    if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed preparing reference ${source}`);
  }
  try {
    return `data:image/jpeg;base64,${Buffer.from(await Bun.file(jpeg).arrayBuffer()).toString("base64")}`;
  } finally {
    if (!keep) rmSync(jpeg, { force: true });
  }
}

/** A repo asset (character sheet, environment plate) as an inline reference. No upload. */
export function uploadAsset(repoPath: string) {
  let uri = assetUris.get(repoPath);
  if (!uri) {
    const committed = `${MEDIA_DIR}/refs/${refName(repoPath)}`;
    uri = toDataUri(existsSync(committed) ? committed : `${ROOT}${repoPath}`, refName(repoPath));
    uri.catch(() => assetUris.delete(repoPath));
    assetUris.set(repoPath, uri);
  }
  return uri;
}

/** A generated frame (the previous clip's last frame) as an inline reference. New every step, so not kept. */
export function uploadFile(path: string) {
  return toDataUri(path, `frame-${crypto.randomUUID()}.jpg`, { keep: false });
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: auth(), signal: AbortSignal.timeout(30_000) });
  if (isRetryableStatus(res.status)) throw new RetryableHttpError(`${url} ${res.status}`);
  const body = await res.json();
  if (!res.ok) throw new Error(`fal ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/**
 * Submits one request to a fal queue endpoint and waits for the result. The submit is deliberately not retried:
 * once it reaches fal it is a paid generation, and a retry could pay twice. Polling and the result fetch are,
 * because by then the work is paid for and a network blip must not abandon it.
 */
export async function runFal(endpoint: string, input: Record<string, unknown>) {
  const submit = await fetch(`${QUEUE}/${endpoint}`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(60_000),
  });
  const queued: any = await submit.json().catch(() => ({}));
  if (!submit.ok || !queued.request_id) throw new Error(`fal submit ${submit.status}: ${JSON.stringify(queued).slice(0, 300)}`);

  const requestId: string = queued.request_id;
  const started = Date.now();
  while (true) {
    await Bun.sleep(750);
    const status = await withRetry(`poll fal ${requestId}`, () => getJson(queued.status_url), 8);
    if (status.status === "COMPLETED") break;
    if (status.error) throw new Error(`fal request ${requestId} failed: ${JSON.stringify(status.error).slice(0, 300)}`);
    if (Date.now() - started > 15 * 60_000) throw new Error(`fal request ${requestId} still ${status.status} after 15 minutes`);
  }
  const result = await withRetry(`fal result ${requestId}`, () => getJson(queued.response_url), 6);
  return { requestId, result, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * The background half of a fal clip: downloads it, optionally drops the first `trimSecs` (the reference sheet a
 * turbo clip opens on), stores it in R2 and returns the stable /media/cache URL plus a local file for ffmpeg.
 *
 * Only the finished clip is kept: the untrimmed download is deleted as soon as the trimmed copy exists, so the
 * archive, film stitching and share exports all see the clean clip and a trimmed provider costs no extra storage.
 * Safe to call more than once.
 */
export function clipFinalizer(remoteUrl: string, id: string, trimSecs = 0, slowdown = 1) {
  let finalizing: Promise<{ file: string; url: string }> | undefined;
  return () =>
    (finalizing ??= (async () => {
      mkdirSync(CACHE_DIR, { recursive: true });
      const file = `${CACHE_DIR}/${id}.mp4`;
      const reencode = trimSecs > 0 || slowdown !== 1;
      const download = reencode ? `${CACHE_DIR}/${id}-untrimmed.mp4` : file;
      const bytes = await withRetry(`download ${id}`, async () => {
        const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw isRetryableStatus(res.status) ? new RetryableHttpError(`download ${res.status}`) : new Error(`download ${res.status}`);
        return res.arrayBuffer();
      });
      await Bun.write(download, bytes);
      if (reencode) {
        try {
          // Re-encoded rather than stream-copied: a copy can only cut on a keyframe, which would keep the sheet.
          // `trimSecs` is in the clip's own (unslowed) time. A slowdown only stretches the timestamps (every frame
          // is kept and shown longer, nothing is interpolated) and slows the audio to match, keeping its pitch.
          const slow =
            slowdown !== 1
              ? ["-vf", `setpts=${slowdown.toFixed(4)}*PTS`, "-r", (24 / slowdown).toFixed(3), "-af", `atempo=${(1 / slowdown).toFixed(4)}`]
              : [];
          const proc = Bun.spawn(
            [
              "ffmpeg", "-v", "error", "-y", "-ss", String(trimSecs), "-i", download, ...slow,
              "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-threads", "1",
              "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", file,
            ],
            { stderr: "pipe" },
          );
          const stderr = await new Response(proc.stderr).text();
          if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed trimming ${id}: ${stderr.trim().slice(-300)}`);
        } finally {
          rmSync(download, { force: true });
        }
      }
      await putFile(`cache/${id}.mp4`, file);
      return { file, url: `/media/cache/${id}.mp4` };
    })());
}

/**
 * Generates a clip on fal and returns as soon as fal has it. `url` is fal's CDN link, playable immediately;
 * `finalize()` downloads it, stores it in R2 and returns the stable /media/cache URL plus a local file for
 * ffmpeg. Spends fal credits.
 */
export async function generateVideo({ durationSecs, ...req }: VideoRequest) {
  const prompt = /no music/i.test(req.prompt) ? req.prompt : `${req.prompt}\nNo music.`;
  const images = req.src_image_urls ?? [];
  const duration = Math.min(15, Math.max(5, Math.round(durationSecs))); // H3 Max rejects anything under 5s
  const input: Record<string, unknown> = { prompt, resolution: RESOLUTION, duration, prompt_expansion_mode: "disabled" };

  let endpoint: string = ENDPOINTS.T2V;
  if (req.task_type === "R2V" && images.length) {
    endpoint = ENDPOINTS.R2V;
    input.reference_image_urls = images.slice(0, 9);
    input.aspect_ratio = "16:9";
  } else if (req.task_type === "I2V" && images[0]) {
    endpoint = ENDPOINTS.I2V;
    input.image_url = images[0];
    // keyframe_indices [0, -1] means "open and close on this frame": a seamless loop.
    if (req.keyframe_indices?.includes(-1)) input.end_image_url = images[1] ?? images[0];
  } else {
    input.aspect_ratio = "16:9";
  }
  const costUsd = Number((duration * FAL_H3_MAX_USD_PER_SEC).toFixed(3));
  console.log(`[fal] H3 Max ${req.task_type} ${duration}s ${RESOLUTION} submit (~$${costUsd.toFixed(2)}): ${req.prompt.slice(0, 80)}…`);

  // The logged request leaves out the inline images: they are megabytes of base64 and would bloat the debug DB.
  const logged = { endpoint, ...input, reference_image_urls: images.length ? `${images.length} inline images` : undefined, image_url: undefined, end_image_url: undefined };

  return traced(
    "video",
    `fal H3 Max ${req.task_type} ${duration}s ${RESOLUTION}`,
    logged,
    async () => {
      const { requestId, result, seconds } = await runFal(endpoint, input);
      const remoteUrl: string | undefined = result.video?.url;
      if (!remoteUrl) throw new Error(`fal request ${requestId} completed without a video: ${JSON.stringify(result).slice(0, 300)}`);
      const id = `fal-${requestId}`;
      logEvent({ kind: "video", label: "fal clip ready", response: { requestId, seconds, inference: result.timings?.inference } });
      return { taskId: id, url: remoteUrl, remote: true as const, finalize: clipFinalizer(remoteUrl, id), creditCost: costUsd, clipStartSecs: 0 };
    },
    { costUsd, summarize: r => ({ taskId: r.taskId, url: r.url }) },
  );
}
