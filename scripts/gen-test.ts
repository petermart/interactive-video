// One-off MachGen generation test: submit, poll, download, report timing.
// Usage: bun scripts/gen-test.ts <preset>
import keys from "../keys.json";
import { mkdirSync } from "node:fs";

const API = "https://api.machgen.ai/api/v0";
const auth = { Authorization: `Bearer ${keys.machgen}` };
const prompt =
  "A lone astronaut walks through a neon-lit alien marketplace at night, handheld camera, cinematic";

const presets: Record<string, object> = {
  "h3-480": {
    model: "MiniMax-H3",
    task_type: "T2V",
    prompt,
    video_config: { duration_secs: 4, height: 480, aspect_ratio: "16:9" },
  },
  "h3-768": {
    model: "MiniMax-H3",
    task_type: "T2V",
    prompt,
    video_config: { duration_secs: 4, height: 768, aspect_ratio: "16:9" },
  },
  "multimax-480": {
    model: "MiniMax-H3-MultiMax",
    task_type: "T2V",
    prompt,
    adapter: "plaguekind_parasyte_turbo",
    optimization_level: "EXPRESS",
    video_config: { duration_secs: 4, height: 480, aspect_ratio: "16:9" },
  },
};

const name = process.argv[2] ?? "";
const body = presets[name];
if (!body) {
  console.error(`Unknown preset. Options: ${Object.keys(presets).join(", ")}`);
  process.exit(1);
}

const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1);

const submit = await fetch(`${API}/generate`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const submitted = await submit.json();
console.log(`[${sec()}s] submit ${submit.status}`, JSON.stringify(submitted));
if (!submit.ok) process.exit(1);

const id = submitted.task_id;
let task: any;
while (true) {
  await Bun.sleep(2000);
  task = await (await fetch(`${API}/tasks/${id}`, { headers: auth })).json();
  console.log(`[${sec()}s] ${task.status}`);
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) break;
}
console.log(JSON.stringify(task, null, 2));

if (task.status === "COMPLETED") {
  mkdirSync("out", { recursive: true });
  const video = await fetch(task.task_output.video, { headers: auth });
  const file = `out/${name}-${id}.mp4`;
  await Bun.write(file, video);
  console.log(`[${sec()}s] saved ${file}`);
}
