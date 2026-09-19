/**
 * Generates the committed film assets on fal (MiniMax H3 Max, not turbo), at $0.05 per output second.
 *
 *   bun scripts/gen-intro-fal.ts intro        15s seamless loop, I2V with intro-keyframe.png as first AND last
 *                                             frame, so it can idle behind the opening prompt forever ($0.75)
 *   bun scripts/gen-intro-fal.ts share-open   5s opening shot for share exports, R2V from the perimeter fence
 *                                             plate, the cell-block plate and Sloppy Joe's sheet ($0.25)
 *   bun scripts/gen-intro-fal.ts intro-open   5s replacement for the FIRST 5s of the intro, then stitched back
 *                                             onto the rest of it ($0.25). Use when one shot of the loop is
 *                                             wrong and re-rolling the whole 15s would cost three times as much.
 *
 * Prompts live next to the output in common-generated-assets/videos/<name>.txt. Each clip is written there and
 * copied into media/intro/, which the app serves. Every run spends real money, so it asks first unless --yes.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { FAL_H3_MAX_USD_PER_SEC, generateVideo, uploadAsset, uploadFile } from "../src/server/falVideo";

const DIR = "common-generated-assets/videos";

const run = (args: string[]) => {
  const p = Bun.spawnSync(args, { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${args[0]} failed: ${p.stderr.toString().trim().slice(-300)}`);
};

type Clip = {
  secs: number;
  /** I2V opening and closing on <name>-keyframe.png: a seamless loop. */
  loop?: boolean;
  /** R2V reference images. */
  refs?: string[];
  /**
   * Regenerate the head of an existing clip. The new clip starts on `keyframe` and is forced to END on the
   * frame that `into` already has at `secs`, so the two halves can be concatenated without a visible seam -
   * and because the tail is untouched, the loop still closes on the keyframe.
   */
  replaceHeadOf?: { into: string; keyframe: string };
};

const CLIPS: Record<string, Clip> = {
  // Opens and closes on the same keyframe: the intro doubles as the idle loop behind the first prompt.
  intro: { secs: 15, loop: true },
  // The opening of a shared film. References rather than a first frame: it starts outside the prison, not in the
  // cell. 5s is H3 Max's minimum length.
  "share-open": {
    secs: 5,
    refs: [
      "common-generated-assets/environments/perimeter-fence.png",
      "common-generated-assets/environments/cell-block-a.png",
      "common-generated-assets/characters/sloppy-joe-protagonist.png",
    ],
  },
  // The first take put a second inmate in Sloppy Joe's cell in shot 1. This re-rolls shots 1-2 only.
  "intro-open": { secs: 5, replaceHeadOf: { into: `${DIR}/intro.mp4`, keyframe: `${DIR}/intro-keyframe.png` } },
};

const [name = "", ...flags] = process.argv.slice(2);
const clip = CLIPS[name];
if (!clip) {
  console.error(`Usage: bun scripts/gen-intro-fal.ts <${Object.keys(CLIPS).join("|")}> [--yes]`);
  process.exit(1);
}

const prompt = (await Bun.file(`${DIR}/${name}.txt`).text()).trim();
const cost = (clip.secs * FAL_H3_MAX_USD_PER_SEC).toFixed(2);
console.log(`${name}: ${clip.secs}s on fal H3 Max 480P, about $${cost}.`);
if (!flags.includes("--yes")) {
  console.error("Add --yes to actually spend it.");
  process.exit(1);
}

let images: string[] = [];
const head = clip.replaceHeadOf;
if (head) {
  if (!existsSync(head.into)) throw new Error(`Missing ${head.into}: there is nothing to stitch onto.`);
  // The frame the old clip shows at the cut, as this clip's forced last frame.
  const seam = `${DIR}/${name}-seam.png`;
  run(["ffmpeg", "-v", "error", "-y", "-ss", String(clip.secs), "-i", head.into, "-frames:v", "1", "-update", "1", seam]);
  images = [await uploadFile(head.keyframe), await uploadFile(seam)];
} else if (clip.loop) {
  const keyframe = `${DIR}/${name}-keyframe.png`;
  if (!existsSync(keyframe)) throw new Error(`Missing ${keyframe}: generate the keyframe first.`);
  const frame = await uploadFile(keyframe);
  images = [frame, frame];
} else {
  images = await Promise.all((clip.refs ?? []).map(uploadAsset));
}

const result = await generateVideo({
  task_type: clip.loop || head ? "I2V" : "R2V",
  prompt,
  src_image_urls: images,
  keyframe_indices: clip.loop || head ? [0, -1] : undefined,
  durationSecs: clip.secs,
});

// generateVideo returns as soon as fal has the clip; finalize() brings it down to disk.
const { file } = await result.finalize();
mkdirSync("media/intro", { recursive: true });
copyFileSync(file, `${DIR}/${name}.mp4`);

if (head) {
  // New head + everything after the cut, re-encoded through one filter graph so the join is frame-exact.
  const target = head.into;
  const backup = target.replace(/\.mp4$/, `-before-${name}.mp4`);
  if (!existsSync(backup)) copyFileSync(target, backup);
  const stitched = `${DIR}/${name}-stitched.mp4`;
  run([
    "ffmpeg", "-v", "error", "-y", "-i", file, "-ss", String(clip.secs), "-i", backup,
    "-filter_complex",
    // Both halves come from the same 480P endpoint; the scale is belt and braces in case one comes back odd.
    "[0:v]scale=864:480,fps=24,format=yuv420p[v0];[1:v]scale=864:480,fps=24,format=yuv420p[v1];" +
      "[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];[1:a]aresample=48000,aformat=channel_layouts=stereo[a1];" +
      "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", stitched,
  ]);
  renameSync(stitched, target);
  copyFileSync(target, `media/intro/${target.split("/").pop()}`);
  console.log(`stitched into ${target} (old one kept at ${backup}), spent ~$${result.creditCost}`);
} else {
  copyFileSync(file, `media/intro/${name}.mp4`);
  console.log(`saved ${DIR}/${name}.mp4 and media/intro/${name}.mp4 (spent ~$${result.creditCost})`);
}
process.exit(0);
