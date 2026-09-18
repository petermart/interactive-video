import { existsSync, mkdirSync, rmSync } from "node:fs";
import { CACHE_DIR, MEDIA_DIR, ROOT } from "./config";
import { logEvent, traced } from "./db";
import { clipFinalizer, refName, runFal, toDataUri } from "./falVideo";
import type { VideoRequest } from "./machgen";
import { buildSheet, SHEET_MAX_OTHERS, type SheetEntry } from "./refSheet";

/**
 * MiniMax H3 Max **turbo** on fal, with reference images smuggled in through the first frame.
 *
 * Turbo is H3 Max's cheap, fast image-to-video endpoint: it takes a first frame (and optionally a last frame) but
 * no reference images. So for a normal step we pack every reference the shot needs (environment, protagonist,
 * previous shot, cast) into one labeled 16:9 sheet (refSheet.ts), send that as the first frame, and tell the
 * model to jump cut away from it immediately. In testing the sheet was on screen for exactly one frame and the
 * model matched the environment and characters from their labels.
 *
 * Measured on one 15s 480P step: 4.4s from submit to saved file (1.6s inference), against 9.2s for H3 Max with
 * real references, at a quarter of the price during fal's launch promotion and half of it afterwards. Fidelity
 * is a little looser on the protagonist's details than with real references, and label text can leak onto
 * clothing, which the prompt now forbids.
 *
 * The sheet frame is dealt with twice: the player starts fal's CDN link at `clipStartSecs`, and the stored copy
 * made in the background is trimmed, so the archive, film stitching and share exports never contain it.
 */

const ENDPOINT = "minimax/h3-max-turbo/image-to-video";
const RESOLUTION = "480P";
/** fal's launch promotion halves turbo's price until the end of September 2026. */
const PROMO_ENDS = Date.parse("2026-10-01T00:00:00Z");
export const falTurboUsdPerSec = () => (Date.now() < PROMO_ENDS ? 0.0125 : 0.025);
/**
 * Seconds cut from the start of a sheet clip. The sheet itself is on screen for one frame (1/24s); a whole second
 * also drops whatever the model does while it finds its footing after the jump cut. The prompt tells it the first
 * second will be cut, so no story beat is lost.
 */
export const SHEET_TRIM_SECS = 1;

/**
 * Turbo needs local files, not URLs: the sheet is composed on this server. So "uploading" a repo asset just finds
 * (or makes, once) its 1600px JPEG, and a frame is used where it is.
 */
export async function uploadAsset(repoPath: string) {
  const committed = `${MEDIA_DIR}/refs/${refName(repoPath)}`;
  if (existsSync(committed)) return committed;
  const jpeg = `${CACHE_DIR}/refs/${refName(repoPath)}`;
  if (!existsSync(jpeg)) {
    mkdirSync(`${CACHE_DIR}/refs`, { recursive: true });
    const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-i", `${ROOT}${repoPath}`, "-vf", "scale=1600:-2", "-q:v", "3", jpeg]);
    if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed downscaling ${repoPath}`);
  }
  return jpeg;
}

export async function uploadFile(path: string) {
  return path;
}

/** Tells the model what the first frame is, what is on it, and to leave it at once. */
function sheetPreamble(placed: { sheetLabel: string; note: string }[]) {
  return [
    "The first frame is a labeled reference sheet, not part of the film. JUMP CUT IMMEDIATELY to the first shot: do not",
    "animate, pan across or zoom into the reference sheet, and never show it again after the first frame. Use it only as",
    "a guide: each location and character looks exactly like the panel with its label. No text, labels, captions, grids,",
    "numbers or lettering anywhere in the film, including on clothing. The first second is cut from the finished film:",
    "start the first shot at 1s and fit the whole shot list into the remaining time.",
    "On the sheet:",
    ...placed.map(p => `- ${p.sheetLabel}: ${p.note}.`),
  ].join("\n");
}

/**
 * Generates a clip on fal turbo and returns as soon as fal has it, like falVideo.generateVideo: `url` is the CDN
 * link (start it at `clipStartSecs`), `finalize()` stores a trimmed copy. Spends fal credits.
 */
export async function generateVideo({ durationSecs, ...req }: VideoRequest) {
  const duration = Math.min(15, Math.max(5, Math.round(durationSecs))); // turbo's minimum is 5s
  const images = req.src_image_urls ?? [];
  let prompt = req.shotPrompt ?? req.prompt;
  if (!/no music/i.test(prompt)) prompt = `${prompt}\nNo music.`;
  const input: Record<string, unknown> = { resolution: RESOLUTION, duration, prompt_expansion_mode: "disabled" };
  let trimSecs = 0;
  let mode = "text";

  if (req.task_type === "R2V" && images.length && req.refs?.length === images.length) {
    // Every reference into one labeled first frame. The environment gets the big panel; the rest keep their
    // priority order (protagonist, previous shot, then the cast the writer ranked).
    const entries = images.map((image, i) => ({ ...req.refs![i]!, image }));
    const environment = entries.find(e => e.kind === "environment") ?? entries[0]!;
    const others = entries.filter(e => e !== environment).slice(0, SHEET_MAX_OTHERS);
    const id = crypto.randomUUID();
    mkdirSync(`${CACHE_DIR}/sheets`, { recursive: true });
    const sheet = `${CACHE_DIR}/sheets/${id}.jpg`;
    const toSheet = (e: (typeof entries)[number]): SheetEntry => ({ label: e.sheetLabel, image: e.image });
    try {
      await buildSheet(toSheet(environment), others.map(toSheet), sheet);
      input.image_url = await toDataUri(sheet, `sheet-${id}.jpg`, { keep: false, width: 1662 });
    } finally {
      rmSync(sheet, { force: true }); // one-off: nothing about a sheet is worth keeping on disk
    }
    prompt = `${sheetPreamble([environment, ...others])}\n\n${prompt}`;
    trimSecs = SHEET_TRIM_SECS;
    mode = `sheet of ${1 + others.length}`;
  } else if (req.task_type === "I2V" && images[0]) {
    // A real first frame (e.g. an idle loop opening on the last frame): nothing to trim.
    input.image_url = await toDataUri(images[0], `frame-${crypto.randomUUID()}.jpg`, { keep: false });
    if (req.keyframe_indices?.includes(-1)) input.end_image_url = input.image_url;
    mode = "first frame";
  }
  input.prompt = prompt;

  const costUsd = Number((duration * falTurboUsdPerSec()).toFixed(4));
  console.log(`[fal turbo] ${mode}, ${duration}s ${RESOLUTION} submit (~$${costUsd.toFixed(2)}): ${(req.shotPrompt ?? req.prompt).slice(0, 80)}…`);
  // Logged without the image: it is hundreds of KB of base64 and would bloat the debug DB.
  const logged = { endpoint: ENDPOINT, mode, ...input, image_url: input.image_url ? "inline image" : undefined, end_image_url: undefined };

  return traced(
    "video",
    `fal H3 Max turbo (${mode}) ${duration}s ${RESOLUTION}`,
    logged,
    async () => {
      const { requestId, result, seconds } = await runFal(ENDPOINT, input);
      const remoteUrl: string | undefined = result.video?.url;
      if (!remoteUrl) throw new Error(`fal turbo request ${requestId} completed without a video: ${JSON.stringify(result).slice(0, 300)}`);
      const id = `falturbo-${requestId}`;
      logEvent({ kind: "video", label: "fal turbo clip ready", response: { requestId, seconds, inference: result.timings?.inference, mode } });
      return {
        taskId: id,
        url: remoteUrl,
        remote: true as const,
        finalize: clipFinalizer(remoteUrl, id, trimSecs),
        creditCost: costUsd,
        clipStartSecs: trimSecs,
      };
    },
    { costUsd, summarize: r => ({ taskId: r.taskId, url: r.url, clipStartSecs: r.clipStartSecs }) },
  );
}
