import { existsSync } from "node:fs";
import { CACHE_DIR, FRAMES_DIR, keys, publicBaseUrl } from "./config";
import { logEvent, traced } from "./db";
import { isRetryableStatus, RetryableHttpError, withRetry } from "./net";
import { putBytes, putFile } from "./storage";

const API = "https://masky.ai/api";
const auth = { Authorization: `Bearer ${keys.masky}`, "Content-Type": "application/json" };

/** Live rates: 720p full 0.025 credits/sec, draft 0.015 (1 credit = $1). */
const RATE = { "720p": { full: 0.025, draft: 0.015 }, "1080p": { full: 0.05, draft: 0.03 } };

/**
 * Where a frame image can be published so Masky can fetch it.
 * When this server is public (Railway) it hosts frames itself; a local dev server pushes them to the
 * deployed instance (MASKY_FRAME_HOST) using the admin password.
 */
const FRAME_HOST = process.env.MASKY_FRAME_HOST ?? "https://prison-escape-production.up.railway.app";
// The deployed server's admin password; the legacy default only works until that server sets ADMIN_PASSWORD.
const FRAME_HOST_PASSWORD = process.env.FRAME_HOST_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "hackathon";

/** Publishes a local image file and returns a public https URL Masky can fetch. */
export async function publishFrame(file: string) {
  if (!existsSync(file)) throw new Error(`No such frame: ${file}`);
  const bytes = await Bun.file(file).arrayBuffer();
  const contentType = file.endsWith(".jpg") || file.endsWith(".jpeg") ? "image/jpeg" : "image/png";

  const base = publicBaseUrl();
  if (base) {
    // This server is already public: publish the frame under its own frames path and hand Masky that URL.
    const id = `${crypto.randomUUID()}.${contentType === "image/jpeg" ? "jpg" : "png"}`;
    if (!(await putBytes(`frames/${id}`, bytes))) await Bun.write(`${FRAMES_DIR}/${id}`, bytes);
    return `${base}/media/frames/${id}`;
  }

  return traced("upload", `publish frame ${file.split(/[\\/]/).pop()}`, { host: FRAME_HOST }, () =>
    withRetry("publish frame", async () => {
      const res = await fetch(`${FRAME_HOST}/api/frames`, {
        method: "POST",
        headers: { "content-type": contentType, "x-admin-password": FRAME_HOST_PASSWORD },
        body: bytes,
        signal: AbortSignal.timeout(60_000),
      });
      if (isRetryableStatus(res.status)) throw new RetryableHttpError(`frame host ${res.status}`);
      const body: any = await res.json();
      if (!res.ok || !body.url) throw new Error(`Frame host ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      return body.url as string;
    }),
  );
}

export type MaskyRequest = {
  prompt: string;
  /** Local image file used as the clip's opening frame (continuity from the previous clip). */
  firstFrameFile?: string | null;
  /** Local image file for the closing frame; same file as the opener gives a seamless loop. */
  lastFrameFile?: string | null;
  durationSecs: number;
  draft?: boolean;
  resolution?: "720p" | "1080p";
};

/** Generates one clip with Masky, waits for it, and caches the mp4 locally. Spends Masky credits. */
export async function generateMaskyVideo({ prompt, firstFrameFile, lastFrameFile, durationSecs, draft = false, resolution = "720p" }: MaskyRequest) {
  const image = firstFrameFile ? await publishFrame(firstFrameFile) : undefined;
  const lastFrameImage = lastFrameFile ? (lastFrameFile === firstFrameFile ? image : await publishFrame(lastFrameFile)) : undefined;
  const body = {
    prompt: /no music/i.test(prompt) ? prompt : `${prompt}\nNo music.`,
    ...(image ? { image } : { aspectRatio: "16:9" }), // aspectRatio is ignored when an image sets the frame
    ...(lastFrameImage ? { lastFrameImage } : {}),
    duration: durationSecs,
    resolution,
    fps: 24,
    draft,
    saveAudio: true,
  };
  const costUsd = Number((durationSecs * RATE[resolution][draft ? "draft" : "full"]).toFixed(3));
  console.log(`[masky] ${durationSecs}s ${resolution}${draft ? " draft" : ""} submit (~$${costUsd.toFixed(2)})${image ? " from frame" : ""}`);

  return traced(
    "video",
    `Masky ${durationSecs}s ${resolution}${draft ? " draft" : ""}`,
    body,
    async () => {
      const submit = await fetch(`${API}/videos/generate`, { method: "POST", headers: auth, body: JSON.stringify(body) });
      const started: any = await submit.json();
      if (!submit.ok) throw new Error(`Masky submit ${submit.status}: ${JSON.stringify(started).slice(0, 300)}`);

      // Paid once ready: never abandon a running generation because of a dropped socket.
      const id: string = started.generationId;
      let gen: any;
      while (true) {
        await Bun.sleep(4000);
        gen = await withRetry(`poll masky ${id}`, async () => {
          const res = await fetch(`${API}/videos/${id}`, { headers: auth, signal: AbortSignal.timeout(30_000) });
          if (isRetryableStatus(res.status)) throw new RetryableHttpError(`masky poll ${res.status}`);
          const json: any = await res.json();
          return json.generation ?? json;
        }, 8);
        if (gen.status === "ready" && gen.videoUrl) break;
        if (gen.status === "error" || gen.status === "failed") throw new Error(`Masky ${gen.status}: ${gen.error ?? JSON.stringify(gen).slice(0, 200)}`);
      }

      const file = `${CACHE_DIR}/masky-${id}.mp4`;
      const bytes = await withRetry(`download masky ${id}`, async () => {
        const res = await fetch(gen.videoUrl, { signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw isRetryableStatus(res.status) ? new RetryableHttpError(`download ${res.status}`) : new Error(`download ${res.status}`);
        return res.arrayBuffer();
      });
      // Written locally first even when R2 is configured: the pipeline runs ffmpeg over this clip to pull
      // its last frame, and ffmpeg needs a real file. releaseLocalCopy() drops it afterwards.
      await Bun.write(file, bytes);
      await putFile(`cache/masky-${id}.mp4`, file);
      logEvent({ kind: "video", label: "masky clip ready", response: { id, slug: gen.slug, seconds: gen.seconds, creditCost: gen.creditCost } });
      return { taskId: id, file, url: `/media/cache/masky-${id}.mp4`, seconds: gen.seconds, creditCost: gen.creditCost };
    },
    { cost: r => r.creditCost ?? costUsd },
  );
}
