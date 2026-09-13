// Generates looping clips on MachGen in two paid steps. Prompts live in common-generated-assets/videos/<name>*.txt.
//   bun scripts/gen-intro.ts <name> keyframe -> Nano Banana Pro I2I from reference images (~$0.079) -> <name>-keyframe.png
//   bun scripts/gen-intro.ts <name> video    -> MiniMax-H3 I2V, 480p, EXPRESS, first frame = last frame (~$0.035/s)
//                                               -> <name>.mp4 next to the prompt + media/intro/<name>.mp4 (served by the app)
import keys from "../keys.json";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const API = "https://api.machgen.ai/api/v0";
const auth = { Authorization: `Bearer ${keys.machgen}` };
const DIR = "common-generated-assets/videos";

async function upload(path: string) {
  const form = new FormData();
  form.append("file", Bun.file(path));
  const res = await fetch(`${API}/upload`, { method: "POST", headers: auth, body: form });
  const body: any = await res.json();
  if (!res.ok || !body.artifact_path) throw new Error(`upload ${path}: ${res.status} ${JSON.stringify(body)}`);
  return `@input/${body.artifact_path}`;
}

const withNoMusic = (p: string) => (/no music/i.test(p) ? p : `${p}
No music.`);

/** Downscales a PNG to a JPEG under MachGen's comfortable upload size. */
function toJpeg(src: string, out: string) {
  const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", "scale=1600:-2", "-q:v", "3", out]);
  if (p.exitCode !== 0) throw new Error(`ffmpeg ${src}: ${p.stderr}`);
  return out;
}

async function run(body: object, outFile: string) {
  const t0 = Date.now();
  const submit = await fetch(`${API}/generate`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const submitted: any = await submit.json();
  if (!submit.ok) throw new Error(`submit ${submit.status}: ${JSON.stringify(submitted)}`);
  console.log(`submitted task ${submitted.task_id}`);

  let task: any;
  while (true) {
    await Bun.sleep(2500);
    try {
      task = await (await fetch(`${API}/tasks/${submitted.task_id}`, { headers: auth })).json();
    } catch {
      continue;
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) break;
  }
  if (task.status !== "COMPLETED") throw new Error(`${task.status}: ${task.error_msg} (task ${submitted.task_id})`);

  const url = Object.values(task.task_output ?? {})[0] as string;
  const res = await fetch(url, { headers: auth, signal: AbortSignal.timeout(300_000) });
  await Bun.write(outFile, await res.arrayBuffer());
  console.log(`saved ${outFile} (${((Date.now() - t0) / 1000).toFixed(1)}s, gen ${task.generation_time_secs}s)`);
}

/** Looping clips: a Nano Banana keyframe, then H3 I2V with that keyframe as both first and last frame. */
const CLIPS: Record<string, { refs: string[]; secs: number }> = {
  // Larry + his cell -> Larry crouched in the cell; 15s multi-shot opening.
  intro: {
    refs: ["common-generated-assets/characters/larry-protagonist.png", "common-generated-assets/environments/cell-block-a.png"],
    secs: 15,
  },
  // The intro keyframe -> macro of Larry deliberating; 4s idle loop shown while the viewer decides.
  "larry-thinking": { refs: [`${DIR}/intro-keyframe.png`], secs: 4 },
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
  const refs = [];
  for (const ref of clip.refs) refs.push(await upload(jpeg(ref)));
  await run(
    {
      model: "Nano-Banana-Pro",
      task_type: "I2I",
      prompt: (await Bun.file(`${DIR}/${name}-keyframe.txt`).text()).trim(),
      src_image_urls: refs,
      image_config: { height: 1024, aspect_ratio: "16:9" },
    },
    `${DIR}/${name}-keyframe.png`,
  );
} else {
  if (!existsSync(`${DIR}/${name}-keyframe.png`)) throw new Error("Run the keyframe step first.");
  const frame = await upload(jpeg(`${DIR}/${name}-keyframe.png`));
  await run(
    {
      model: "MiniMax-H3",
      task_type: "I2V",
      prompt: withNoMusic((await Bun.file(`${DIR}/${name}.txt`).text()).trim()),
      src_image_urls: [frame, frame],
      keyframe_indices: [0, -1], // same first and last frame -> seamless loop
      optimization_level: "EXPRESS", // lowest H3 settings for speed/cost
      video_config: { duration_secs: clip.secs, height: 480, aspect_ratio: "16:9" },
    },
    `${DIR}/${name}.mp4`,
  );
  copyFileSync(`${DIR}/${name}.mp4`, `media/intro/${name}.mp4`);
  console.log(`copied to media/intro/${name}.mp4`);
}
