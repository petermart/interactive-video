import { CACHE_DIR, keys } from "./config";

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
    video_config: { duration_secs: durationSecs, height: 480, aspect_ratio: "16:9" },
  };
  // 480p measured at ~$0.035/sec.
  console.log(`[machgen] ${body.task_type} ${durationSecs}s submit (~$${(durationSecs * 0.035).toFixed(2)}): ${req.prompt.slice(0, 80)}…`);
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

/** Extracts the last frame of a video as a PNG (ffmpeg). */
export async function lastFrame(videoFile: string) {
  const out = videoFile.replace(/\.mp4$/, "-last.png");
  const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.1", "-i", videoFile, "-frames:v", "1", "-update", "1", out]);
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed extracting last frame of ${videoFile}`);
  return out;
}
