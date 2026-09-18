import { existsSync, mkdirSync } from "node:fs";
import { CACHE_DIR, keys, MEDIA_DIR, ROOT } from "./config";
import { recordGmiSpend } from "./credits";
import { logEvent, traced } from "./db";
import type { VideoRequest } from "./machgen";
import { publishFrame } from "./masky";
import { isRetryableStatus, RetryableHttpError, withRetry } from "./net";
import { objectExists, presignGet, putFile, r2Enabled } from "./storage";

/**
 * MiniMax-H3 through GMI Cloud's request queue: the same model MachGen served, on the account that has the
 * credits. Drop-in for machgen.ts — same VideoRequest in, same { file, url } out — so the pipeline only
 * chooses which one to call.
 *
 * Differences worth knowing:
 * - GMI offers MiniMax-H3 at 768P or 2K only. No 480p and no H3 Max, so 768P is the cheapest tier:
 *   $0.08/s, i.e. $1.20 for a 15s step (MachGen 480p was $0.75 R2V / $0.525 I2V).
 * - Reference images must be public URLs; there is no upload endpoint. They go to R2 and are handed over as
 *   signed URLs (or, on a local server without R2, published through the deployment's frame host).
 * - First/last frames and reference images cannot be combined in one request, which matches how the
 *   pipeline already uses them (R2V uses references, I2V uses frames).
 */

const API = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey";
const MODEL = "MiniMax-H3";
const RESOLUTION = "768P";
/** GMI's listed price for MiniMax-H3 at 768P, per output second. */
export const GMI_H3_USD_PER_SEC = 0.08;
const auth = () => ({ Authorization: `Bearer ${keys.gmi}` });

/** Signed URLs outlive a queued generation comfortably: MiniMax fetches references when the job starts. */
const REF_URL_TTL_SECONDS = 6 * 60 * 60;
const refUrlCache = new Map<string, { url: string; expires: number }>();

/**
 * A URL MiniMax can fetch for a local image. Stored under `key` in R2 once and re-signed as needed, so the
 * same character sheet is uploaded a single time rather than once per clip.
 */
async function publicUrl(localPath: string, key: string) {
  const cached = refUrlCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.url;
  if (!r2Enabled()) return publishFrame(localPath); // local dev without R2: the deployment hosts it
  if (!(await objectExists(key)) && !(await putFile(key, localPath))) {
    throw new Error(`Could not store reference ${key} in R2 (storage cap reached?)`);
  }
  const url = presignGet(key, REF_URL_TTL_SECONDS)!;
  // Re-sign well before expiry so a reference never goes stale mid-queue.
  refUrlCache.set(key, { url, expires: Date.now() + (REF_URL_TTL_SECONDS / 2) * 1000 });
  return url;
}

/** Publishes a generated frame (e.g. the previous clip's last frame) and returns a fetchable URL. */
export function uploadFile(path: string) {
  const ext = path.toLowerCase().endsWith(".jpg") || path.toLowerCase().endsWith(".jpeg") ? "jpg" : "png";
  return traced("upload", `publish ${path.split(/[\\/]/).pop()} for GMI`, { path }, () =>
    publicUrl(path, `frames/${crypto.randomUUID()}.${ext}`),
  );
}

const refName = (repoPath: string) => repoPath.replace(/[\\/]/g, "__").replace(/\.png$/i, ".jpg");

/** Publishes a repo asset (character sheet, environment plate) as a reference image, once. */
export async function uploadAsset(repoPath: string) {
  const name = refName(repoPath);
  let local = `${MEDIA_DIR}/refs/${name}`;
  if (!existsSync(local)) {
    // No committed 1600px JPEG: make one from the full-size PNG. References don't need 3641px.
    local = `${CACHE_DIR}/refs/${name}`;
    mkdirSync(`${CACHE_DIR}/refs`, { recursive: true });
    if (!existsSync(local)) {
      const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", `${ROOT}${repoPath}`, "-vf", "scale=1600:-2", "-q:v", "3", local]);
      if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed downscaling ${repoPath}`);
    }
  }
  return publicUrl(local, `refs/${name}`);
}

/**
 * Submits one request to GMI's queue and waits for it to finish. Shared by the pipeline and the asset scripts.
 * The submit is deliberately not retried: once it reaches GMI it is a paid generation, and a retry could pay
 * twice. Polling is retried, because by then the work is paid for and a network blip must not abandon it.
 */
export async function runRequest(model: string, payload: Record<string, unknown>, timeoutMs = 20 * 60_000) {
  const submit = await fetch(`${API}/requests`, {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ model, payload }),
    signal: AbortSignal.timeout(60_000),
  });
  const submitted: any = await submit.json().catch(() => ({}));
  if (!submit.ok || !submitted.request_id) throw new Error(`GMI submit ${submit.status}: ${JSON.stringify(submitted).slice(0, 300)}`);

  const requestId: string = submitted.request_id;
  const started = Date.now();
  while (true) {
    await Bun.sleep(2000);
    const request = await withRetry(`poll GMI ${requestId}`, () => getJson(`${API}/requests/${requestId}`), 8);
    if (request.status === "success") return { requestId, request, seconds: Math.round((Date.now() - started) / 1000) };
    if (request.status === "failed" || request.status === "cancelled") {
      throw new Error(`GMI request ${requestId} ${request.status}: ${JSON.stringify(request.outcome ?? request.error ?? {}).slice(0, 300)}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error(`GMI request ${requestId} still ${request.status} after ${timeoutMs / 60_000} minutes`);
  }
}

/** The media URL in a finished request's outcome. Video and image models name the field differently. */
export function outcomeUrl(outcome: any): string | undefined {
  return (
    outcome?.video_url ??
    outcome?.image_url ??
    outcome?.image_urls?.[0] ??
    outcome?.media_urls?.[0]?.url ??
    outcome?.images?.[0]?.url ??
    (typeof outcome?.images?.[0] === "string" ? outcome.images[0] : undefined)
  );
}

/** Downloads a finished result to `file`, retrying: the generation is already paid for. */
export async function download(url: string, file: string) {
  const bytes = await withRetry(`download ${file.split(/[\\/]/).pop()}`, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw isRetryableStatus(res.status) ? new RetryableHttpError(`download ${res.status}`) : new Error(`download ${res.status}`);
    return res.arrayBuffer();
  });
  await Bun.write(file, bytes);
  return file;
}

/** Submits an H3 generation on GMI, waits for it, and caches the mp4 locally. Spends GMI credits. */
export async function generateVideo({ durationSecs, ...req }: VideoRequest) {
  // The site plays its own soundtrack, so every H3 prompt must forbid generated music.
  const prompt = /no music/i.test(req.prompt) ? req.prompt : `${req.prompt}\nNo music.`;
  const images = req.src_image_urls ?? [];
  const payload: Record<string, unknown> = {
    prompt,
    resolution: RESOLUTION,
    duration: Math.min(15, Math.max(4, Math.round(durationSecs))),
    ratio: "16:9",
  };
  if (req.task_type === "R2V") {
    payload.reference_images = images.slice(0, 9);
  } else if (req.task_type === "I2V" && images[0]) {
    payload.first_frame_image = images[0];
    // keyframe_indices [0, -1] means "open and close on this frame": a seamless loop.
    if (req.keyframe_indices?.includes(-1)) payload.last_frame_image = images[1] ?? images[0];
  }
  const costUsd = Number(((payload.duration as number) * GMI_H3_USD_PER_SEC).toFixed(3));
  console.log(`[gmi] H3 ${req.task_type} ${payload.duration}s ${RESOLUTION} submit (~$${costUsd.toFixed(2)}): ${req.prompt.slice(0, 80)}…`);

  return traced(
    "video",
    `GMI MiniMax-H3 ${req.task_type} ${payload.duration}s ${RESOLUTION}`,
    { model: MODEL, payload },
    async () => {
      const { requestId, request, seconds } = await runRequest(MODEL, payload);
      const videoUrl = outcomeUrl(request.outcome);
      if (!videoUrl) throw new Error(`GMI request ${requestId} succeeded without a video URL: ${JSON.stringify(request.outcome).slice(0, 300)}`);

      const id = `gmi-${requestId}`;
      const file = `${CACHE_DIR}/${id}.mp4`;
      // Written locally first even with R2: the pipeline runs ffmpeg over the clip for its last frame.
      mkdirSync(CACHE_DIR, { recursive: true });
      await download(videoUrl, file);
      await putFile(`cache/${id}.mp4`, file);
      // Billed once GMI reports success; record it durably for the balance estimate the credit guard uses.
      recordGmiSpend("video", costUsd, `${req.task_type} ${payload.duration}s ${RESOLUTION}`);
      logEvent({ kind: "video", label: "GMI clip ready", response: { requestId, seconds } });
      return { taskId: id, file, url: `/media/cache/${id}.mp4`, creditCost: costUsd };
    },
    { costUsd },
  );
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: auth(), signal: AbortSignal.timeout(30_000) });
  if (isRetryableStatus(res.status)) throw new RetryableHttpError(`${url} ${res.status}`);
  const body = await res.json();
  if (!res.ok) throw new Error(`GMI ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
