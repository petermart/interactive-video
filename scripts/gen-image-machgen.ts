// Generates images with Nano Banana Pro on MachGen from prompt .txt files (~$0.079 per 2K image).
// Saves each result as a .png next to its prompt. Skips prompts that already have a .png.
// Usage: bun scripts/gen-image-machgen.ts <prompt.txt> [more.txt ...]
import keys from "../keys.json";
import { existsSync } from "node:fs";

const API = "https://api.machgen.ai/api/v0";
const auth = { Authorization: `Bearer ${keys.machgen}` };
const CONCURRENCY = 6;

async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`  retry ${i}/${attempts}: ${err}`);
      await Bun.sleep(1500 * i);
    }
  }
}

async function generate(promptFile: string) {
  const out = promptFile.replace(/\.txt$/, ".png");
  if (existsSync(out)) return console.log(`skip ${out} (exists)`);
  const prompt = (await Bun.file(promptFile).text()).trim();
  const t0 = Date.now();

  // Submit is not retried: a retry could double-charge.
  const submit = await fetch(`${API}/generate`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "Nano-Banana-Pro",
      task_type: "T2I",
      prompt,
      image_config: { height: 2048, aspect_ratio: "16:9" },
    }),
  });
  const submitted = await submit.json();
  if (!submit.ok) throw new Error(`${promptFile}: submit ${submit.status} ${JSON.stringify(submitted).slice(0, 400)}`);
  const id: string = submitted.task_id;

  let task: any;
  while (true) {
    await Bun.sleep(2500);
    task = await retry(async () => (await fetch(`${API}/tasks/${id}`, { headers: auth })).json());
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) break;
  }
  if (task.status !== "COMPLETED") throw new Error(`${promptFile}: ${task.status} ${task.error_msg ?? ""} (task ${id})`);

  const url = task.task_output?.image ?? Object.values(task.task_output ?? {})[0];
  const bytes = await retry(async () => {
    const res = await fetch(url as string, { headers: auth, signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`download ${res.status}`);
    return res.arrayBuffer();
  });
  await Bun.write(out, bytes);
  const m = task.metadata ?? {};
  console.log(`${out} ${m.width ?? "?"}x${m.height ?? "?"} (${((Date.now() - t0) / 1000).toFixed(1)}s, task ${id})`);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: bun scripts/gen-image-machgen.ts <prompt.txt> [more.txt ...]");
  process.exit(1);
}

const queue = [...files];
let failures = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      await generate(f).catch(err => {
        failures++;
        console.error(String(err));
      });
    }
  }),
);
console.log(`done: ${files.length - failures}/${files.length} ok`);
