// Generates images with Nano Banana Pro (gemini-3-pro-image) on GMI Cloud from prompt .txt files
// (~$0.134 per 1K/2K image). Saves each result as a .png next to its prompt. Skips prompts that already have one.
// Usage: bun scripts/gen-image-gmi.ts [--ref image.png ...] <prompt.txt> [more.txt ...]
//   --ref  reference images (character sheets, plates) blended into every prompt; up to 14.
//          They must be fetchable URLs, so they go through R2 (set the R2_* vars in .env) or the deployment.
import { existsSync } from "node:fs";
import { download, outcomeUrl, runRequest, uploadFile } from "../src/server/gmiVideo";

const MODEL = "gemini-3-pro-image";
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const refs: string[] = [];
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--ref") refs.push(args[++i]!);
  else files.push(args[i]!);
}
if (files.length === 0) {
  console.error("Usage: bun scripts/gen-image-gmi.ts [--ref image.png ...] <prompt.txt> [more.txt ...]");
  process.exit(1);
}

const refUrls = await Promise.all(refs.map(r => uploadFile(r)));

async function generate(promptFile: string) {
  const out = promptFile.replace(/\.txt$/, ".png");
  if (existsSync(out)) return console.log(`skip ${out} (exists)`);
  const prompt = (await Bun.file(promptFile).text()).trim();
  const payload: Record<string, unknown> = { prompt, image_size: "2K", aspect_ratio: "16:9", image_output_format: "png" };
  if (refUrls.length) payload.image = refUrls.slice(0, 14);

  const { requestId, request, seconds } = await runRequest(MODEL, payload, 10 * 60_000);
  const url = outcomeUrl(request.outcome);
  if (!url) throw new Error(`${promptFile}: no image in outcome ${JSON.stringify(request.outcome).slice(0, 300)} (request ${requestId})`);
  await download(url, out);
  console.log(`${out} (${seconds}s, request ${requestId})`);
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
process.exit(failures ? 1 : 0);
