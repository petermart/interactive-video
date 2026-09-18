// Generates looping clips on GMI Cloud in two paid steps. Prompts live in common-generated-assets/videos/<name>*.txt.
//   bun scripts/gen-intro.ts <name> keyframe -> Nano Banana Pro (gemini-3-pro-image) from reference images (~$0.134)
//                                               -> <name>-keyframe.png
//   bun scripts/gen-intro.ts <name> video    -> MiniMax-H3 I2V at 768P, first frame = last frame ($0.08/s)
//                                               -> <name>.mp4 next to the prompt + media/intro/<name>.mp4 (served by the app)
// Reference images must be fetchable URLs: set the R2_* variables in .env (or the deployment hosts them).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { download, generateVideo, outcomeUrl, runRequest, uploadFile } from "../src/server/gmiVideo";

const DIR = "common-generated-assets/videos";

/** Downscales a PNG to a 1600px JPEG: references don't need the full-size sheet. */
function toJpeg(src: string, out: string) {
  const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", "scale=1600:-2", "-q:v", "3", out]);
  if (p.exitCode !== 0) throw new Error(`ffmpeg ${src}: ${p.stderr}`);
  return out;
}

/** Looping clips: a Nano Banana keyframe, then H3 I2V with that keyframe as both first and last frame. */
const CLIPS: Record<string, { refs: string[]; secs: number }> = {
  // Sloppy Joe + his cell -> Sloppy Joe crouched in the cell; 15s multi-shot opening.
  intro: {
    refs: ["common-generated-assets/characters/sloppy-joe-protagonist.png", "common-generated-assets/environments/cell-block-a.png"],
    secs: 15,
  },
  // The intro keyframe -> macro of Sloppy Joe deliberating; 4s idle loop shown while the viewer decides.
  "sloppy-joe-thinking": { refs: [`${DIR}/intro-keyframe.png`], secs: 4 },
};

const [name = "", step = ""] = process.argv.slice(2);
const clip = CLIPS[name];
if (!clip || !["keyframe", "video"].includes(step)) {
  console.error(`Usage: bun scripts/gen-intro.ts <${Object.keys(CLIPS).join("|")}> <keyframe|video>`);
  process.exit(1);
}
mkdirSync("media/intro/refs", { recursive: true });
const jpeg = (png: string) => toJpeg(png, `media/intro/refs/${png.split("/").pop()!.replace(/.png$/, ".jpg")}`);

if (step === "keyframe") {
  const image = await Promise.all(clip.refs.map(ref => uploadFile(jpeg(ref))));
  const { requestId, request, seconds } = await runRequest("gemini-3-pro-image", {
    prompt: (await Bun.file(`${DIR}/${name}-keyframe.txt`).text()).trim(),
    image,
    image_size: "1K",
    aspect_ratio: "16:9",
    image_output_format: "png",
  });
  const url = outcomeUrl(request.outcome);
  if (!url) throw new Error(`No image in outcome ${JSON.stringify(request.outcome).slice(0, 300)} (request ${requestId})`);
  await download(url, `${DIR}/${name}-keyframe.png`);
  console.log(`saved ${DIR}/${name}-keyframe.png (${seconds}s, request ${requestId})`);
} else {
  if (!existsSync(`${DIR}/${name}-keyframe.png`)) throw new Error("Run the keyframe step first.");
  const frame = await uploadFile(jpeg(`${DIR}/${name}-keyframe.png`));
  const result = await generateVideo({
    task_type: "I2V",
    prompt: (await Bun.file(`${DIR}/${name}.txt`).text()).trim(),
    src_image_urls: [frame, frame],
    keyframe_indices: [0, -1], // same first and last frame -> seamless loop
    durationSecs: clip.secs,
  });
  copyFileSync(result.file, `${DIR}/${name}.mp4`);
  copyFileSync(result.file, `media/intro/${name}.mp4`);
  console.log(`saved ${DIR}/${name}.mp4 and media/intro/${name}.mp4`);
}
process.exit(0);
