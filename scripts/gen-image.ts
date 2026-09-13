// Generates images with Nano Banana Pro (gemini-3-pro-image on GMI) from prompt .txt files.
// Saves each result as a .png next to its prompt. ~$0.134 per image.
// Usage: bun scripts/gen-image.ts <prompt.txt> [more.txt ...]
import keys from "../keys.json";

const API = "https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests";
const headers = { Authorization: `Bearer ${keys.gmi}`, "Content-Type": "application/json" };

async function generate(promptFile: string) {
  const prompt = (await Bun.file(promptFile).text()).trim();
  if (prompt.length > 2000) throw new Error(`${promptFile}: prompt is ${prompt.length} chars (max 2000)`);
  const t0 = Date.now();

  const submit = await fetch(API, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "gemini-3-pro-image",
      payload: { prompt, image_size: "2K", aspect_ratio: "16:9", image_output_format: "png" },
    }),
  });
  const submitted = await submit.json();
  if (!submit.ok) throw new Error(`${promptFile}: submit ${submit.status} ${JSON.stringify(submitted)}`);

  // Network hiccups must not lose a paid request: retry polls and the download.
  let req: any = submitted;
  while (!["success", "failed", "cancelled"].includes(req.status)) {
    await Bun.sleep(2000);
    req = await retry(async () => (await fetch(`${API}/${submitted.request_id}`, { headers })).json(), req);
  }
  if (req.status !== "success") throw new Error(`${promptFile}: ${req.status} ${JSON.stringify(req).slice(0, 400)}`);

  const url = req.outcome?.media_urls?.[0]?.url;
  if (!url) throw new Error(`${promptFile}: no media url in ${JSON.stringify(req.outcome)}`);
  const out = promptFile.replace(/\.txt$/, ".png");
  const image = await retry(async () => (await fetch(url, { signal: AbortSignal.timeout(180_000) })).arrayBuffer());
  if (!image) throw new Error(`${promptFile}: download failed; request ${submitted.request_id} succeeded, fetch it by id`);
  await Bun.write(out, image);
  console.log(`${out} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

async function retry<T>(fn: () => Promise<T>, fallback?: T, attempts = 4): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`  retry ${i}/${attempts}: ${err}`);
      await Bun.sleep(1500 * i);
    }
  }
  return fallback as T;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: bun scripts/gen-image.ts <prompt.txt> [more.txt ...]");
  process.exit(1);
}
const results = await Promise.allSettled(files.map(generate));
for (const r of results) if (r.status === "rejected") console.error(String(r.reason));
