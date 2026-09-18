import { existsSync, mkdirSync } from "node:fs";
import { CACHE_DIR, keys, MEDIA_DIR, ROOT } from "./config";
import { logEvent, traced } from "./db";
import { isRetryableStatus, RetryableHttpError, withRetry } from "./net";
import { putFile } from "./storage";

const API = "https://api.machgen.ai/api/v0";
const auth = { Authorization: `Bearer ${keys.machgen}` };

export type VideoRequest = {
  model?: string;
  task_type: "T2V" | "I2V" | "R2V";
  prompt: string;
  src_image_urls?: string[];
  keyframe_indices?: (0 | -1)[];
  durationSecs: number;
  /**
   * What each entry of src_image_urls is, in the same order. Providers that take reference images use the prompt
   * legend instead; fal turbo, which only takes a first frame, packs them into one labeled sheet from this.
   */
  refs?: { kind: "environment" | "location" | "character" | "frame"; sheetLabel: string; note: string }[];
  /** The shot list without the "Image N: ..." legend, for providers that don't number their references. */
  shotPrompt?: string;
};

/** MachGen/MiniMax accept at most 9 reference images per request. */
export const MAX_IMAGE_REFS = 9;

/** Submits an H3 generation, waits for it, and caches the mp4 locally. Spends credits. */
export async function generateVideo({ durationSecs, ...req }: VideoRequest) {
  // The site plays its own soundtrack, so every H3 prompt must forbid generated music
  // (step clips add their own sound-effects/foley line; loops ask for silence).
  const prompt = /no music/i.test(req.prompt) ? req.prompt : `${req.prompt}
No music.`;
  const body = {
    model: "MiniMax-H3",
    ...req,
    prompt,
    src_image_urls: req.src_image_urls?.slice(0, MAX_IMAGE_REFS),
    optimization_level: "EXPRESS", // lowest H3 settings: fastest turnaround for live play
    video_config: { duration_secs: durationSecs, height: 480, aspect_ratio: "16:9" },
  };
  // 480p pricing: T2V/I2V $0.035/s, R2V (reference images) $0.05/s.
  const rate = body.task_type === "R2V" ? 0.05 : 0.035;
  const costUsd = Number((durationSecs * rate).toFixed(3));
  console.log(`[machgen] ${body.task_type} ${durationSecs}s submit (~${costUsd.toFixed(2)}): ${req.prompt.slice(0, 80)}…`);

  return traced(
    "video",
    `MiniMax-H3 ${body.task_type} ${durationSecs}s`,
    body,
    async () => {
      const submit = await fetch(`${API}/generate`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const submitted = await submit.json();
      if (!submit.ok) throw new Error(`MachGen submit ${submit.status}: ${JSON.stringify(submitted).slice(0, 300)}`);

      // From here on the clip is paid for and generating on MachGen: network blips must not abandon it.
      const taskId: string = submitted.task_id;
      let task: any;
      while (true) {
        await Bun.sleep(1500);
        task = await withRetry(`poll task ${taskId}`, () => getJson(`${API}/tasks/${taskId}`), 8);
        if (task.status === "COMPLETED") break;
        if (task.status === "FAILED" || task.status === "CANCELLED") {
          throw new Error(`MachGen task ${taskId} ${task.status}: ${task.error_msg ?? "unknown error"}`);
        }
      }

      const file = `${CACHE_DIR}/${taskId}.mp4`;
      const bytes = await withRetry(`download ${taskId}`, async () => {
        const res = await fetch(`${API}/assets/${taskId}`, { headers: auth, signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw isRetryableStatus(res.status) ? new RetryableHttpError(`download ${res.status}`) : new Error(`download ${res.status}`);
        return res.arrayBuffer();
      });
      // Written locally first even when R2 is configured: the pipeline still has to run ffmpeg over this
      // clip to pull its last frame, and ffmpeg needs a real file. releaseLocalCopy() drops it afterwards.
      await Bun.write(file, bytes);
      await putFile(`cache/${taskId}.mp4`, file);
      return {
        taskId,
        file,
        url: `/media/cache/${taskId}.mp4`,
        timings: { queue: task.queue_time_secs, generation: task.generation_time_secs, upload: task.upload_time_secs },
      };
    },
    { costUsd },
  );
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(30_000) });
  if (isRetryableStatus(res.status)) throw new RetryableHttpError(`${url} ${res.status}`);
  return res.json();
}

/** Uploads a local file and returns the `@input/...` reference usable in src_image_urls. */
export async function uploadFile(path: string) {
  // Response: {"artifact_path": "<account>/<id>__<name>", ...}; generate requests reference it as @input/<path>.
  // Uploads are free and a duplicate upload is harmless, so dropped sockets are retried.
  const name = path.split(/[\\/]/).pop();
  return traced("upload", `upload ${name}`, { path }, () =>
    withRetry(`upload ${name}`, async () => {
      const form = new FormData();
      form.append("file", Bun.file(path));
      const res = await fetch(`${API}/upload`, { method: "POST", headers: auth, body: form, signal: AbortSignal.timeout(60_000) });
      if (isRetryableStatus(res.status)) throw new RetryableHttpError(`MachGen upload ${res.status}`);
      const body = await res.json();
      if (!res.ok || !body.artifact_path) throw new Error(`MachGen upload ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
      return `@input/${body.artifact_path}`;
    }),
  );
}

const uploadedAssets = new Map<string, Promise<string>>();

const refName = (repoPath: string) => repoPath.replace(/[\\/]/g, "__").replace(/\.png$/i, ".jpg");
const prebuiltRef = (repoPath: string) => `${MEDIA_DIR}/refs/${refName(repoPath)}`;

/** True if an asset image can be used as a reference (full-size PNG locally, or its prebuilt JPEG). */
export const hasAsset = (repoPath: string) => existsSync(`${ROOT}${repoPath}`) || existsSync(prebuiltRef(repoPath));

/**
 * Uploads a repo asset image once per server run (downscaled to a 1600px JPEG) and caches its @input ref.
 * Asset PNGs are ~5MB at 3641x2048; references don't need that resolution.
 */
export function uploadAsset(repoPath: string) {
  let ref = uploadedAssets.get(repoPath);
  if (ref) {
    logEvent({ kind: "upload", label: `reuse cached ref ${repoPath.split("/").pop()}`, request: { repoPath } });
  } else {
    ref = (async () => {
      // Prefer the committed 1600px JPEG (media/refs) so deployments don't need the full-size PNGs.
      const prebuilt = prebuiltRef(repoPath);
      if (existsSync(prebuilt)) return uploadFile(prebuilt);
      const jpeg = `${CACHE_DIR}/refs/${refName(repoPath)}`;
      mkdirSync(`${CACHE_DIR}/refs`, { recursive: true });
      if (!existsSync(jpeg)) {
        const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", `${ROOT}${repoPath}`, "-vf", "scale=1600:-2", "-q:v", "3", jpeg]);
        if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed downscaling ${repoPath}`);
      }
      return uploadFile(jpeg);
    })();
    ref.catch(() => uploadedAssets.delete(repoPath));
    uploadedAssets.set(repoPath, ref);
  }
  return ref;
}

/**
 * Extracts the last frame of a video as a PNG (ffmpeg).
 *
 * Reports what actually went wrong: the bare "ffmpeg failed" this used to throw gave no way to tell a
 * missing input file from a missing ffmpeg binary from a corrupt download, and this failure blocks the
 * story (the next clip opens on this frame).
 */
export async function lastFrame(videoFile: string) {
  const out = videoFile.replace(/\.mp4$/, "-last.png");
  if (!existsSync(videoFile)) throw new Error(`No clip to read the last frame from: ${videoFile} does not exist`);
  const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.1", "-i", videoFile, "-frames:v", "1", "-update", "1", out], {
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`ffmpeg failed extracting last frame of ${videoFile}: ${stderr.trim().slice(-400) || "no output (is ffmpeg installed?)"}`);
  }
  if (!existsSync(out)) throw new Error(`ffmpeg reported success but wrote no frame for ${videoFile}`);
  return out;
}
