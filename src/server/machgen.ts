import { existsSync, mkdirSync } from "node:fs";
import { CACHE_DIR, keys, ROOT } from "./config";

const API = "https://api.machgen.ai/api/v0";
const auth = { Authorization: `Bearer ${keys.machgen}` };

export type VideoRequest = {
  model?: string;
  task_type: "T2V" | "I2V" | "R2V";
  prompt: string;
  src_image_urls?: string[];
  keyframe_indices?: (0 | -1)[];
  durationSecs: number;
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
  console.log(`[machgen] ${body.task_type} ${durationSecs}s submit (~$${(durationSecs * rate).toFixed(2)}): ${req.prompt.slice(0, 80)}…`);
  const submit = await fetch(`${API}/generate`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const submitted = await submit.json();
  if (!submit.ok) throw new Error(`MachGen submit ${submit.status}: ${JSON.stringify(submitted).slice(0, 300)}`);

  const taskId: string = submitted.task_id;
  while (true) {
    await Bun.sleep(1500);
    const task = await (await fetch(`${API}/tasks/${taskId}`, { headers: auth })).json();
    if (task.status === "COMPLETED") break;
    if (task.status === "FAILED" || task.status === "CANCELLED") {
      throw new Error(`MachGen task ${task.status}: ${task.error_msg ?? "unknown error"}`);
    }
  }

  const file = `${CACHE_DIR}/${taskId}.mp4`;
  await Bun.write(file, await fetch(`${API}/assets/${taskId}`, { headers: auth }));
  return { taskId, file, url: `/media/cache/${taskId}.mp4` };
}

/** Uploads a local file and returns the `@input/...` reference usable in src_image_urls. */
export async function uploadFile(path: string) {
  // Response: {"artifact_path": "<account>/<id>__<name>", ...}; generate requests reference it as @input/<path>.
  const form = new FormData();
  form.append("file", Bun.file(path));
  const res = await fetch(`${API}/upload`, { method: "POST", headers: auth, body: form });
  const body = await res.json();
  if (!res.ok || !body.artifact_path) throw new Error(`MachGen upload ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return `@input/${body.artifact_path}`;
}

const uploadedAssets = new Map<string, Promise<string>>();

/**
 * Uploads a repo asset image once per server run (downscaled to a 1600px JPEG) and caches its @input ref.
 * Asset PNGs are ~5MB at 3641x2048; references don't need that resolution.
 */
export function uploadAsset(repoPath: string) {
  let ref = uploadedAssets.get(repoPath);
  if (!ref) {
    ref = (async () => {
      const jpeg = `${CACHE_DIR}/refs/${repoPath.replace(/[\/]/g, "__").replace(/.png$/i, ".jpg")}`;
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

/** Extracts the last frame of a video as a PNG (ffmpeg). */
export async function lastFrame(videoFile: string) {
  const out = videoFile.replace(/\.mp4$/, "-last.png");
  const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.1", "-i", videoFile, "-frames:v", "1", "-update", "1", out]);
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed extracting last frame of ${videoFile}`);
  return out;
}
