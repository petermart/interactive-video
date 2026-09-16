/**
 * One-time move of everything already sitting on the deploy volume into R2.
 *
 *   railway run bun scripts/migrate-storage-to-r2.ts          # report what would move, change nothing
 *   railway run bun scripts/migrate-storage-to-r2.ts --apply  # upload
 *   railway run bun scripts/migrate-storage-to-r2.ts --apply --delete-local   # upload, then free the disk
 *
 * Keys mirror the `/media/...` URL layout, so every share link and every clip_url already in the database
 * keeps resolving afterwards without touching a single row.
 *
 * Deleting the local copies is a separate flag on purpose: run it once the uploads are verified, so a failed
 * upload can never take the only copy with it. Files already present in R2 are skipped, so this is safe to
 * re-run and safe to interrupt.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { CACHE_DIR, EXPORT_DIR, FRAMES_DIR } from "../src/server/config";
import { objectExists, putFile, r2Enabled } from "../src/server/storage";

const apply = process.argv.includes("--apply");
const deleteLocal = process.argv.includes("--delete-local");

if (!r2Enabled()) {
  console.error(
    "R2 is not configured. This needs R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.\n" +
      "Run it through `railway run` so the deployment's own variables are used.",
  );
  process.exit(1);
}

/** The three directories that hold generated media, each mapped to its key prefix. */
const AREAS: { dir: string; prefix: string }[] = [
  { dir: CACHE_DIR, prefix: "cache" },
  { dir: EXPORT_DIR, prefix: "exports" },
  { dir: FRAMES_DIR, prefix: "frames" },
];

/** Every file under `dir`, relative to it. One level of nesting is enough (cache/refs is the only one). */
function walk(dir: string, base = ""): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // the directory never existed on this deployment
  }
  return entries.flatMap(name => {
    const full = `${dir}/${name}`;
    const rel = base ? `${base}/${name}` : name;
    return statSync(full).isDirectory() ? walk(full, rel) : [rel];
  });
}

const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);

let uploaded = 0;
let skipped = 0;
let failed = 0;
let bytesMoved = 0;
let bytesFreed = 0;

for (const { dir, prefix } of AREAS) {
  const files = walk(dir);
  if (!files.length) {
    console.log(`\n${prefix}: nothing on disk`);
    continue;
  }
  const total = files.reduce((sum, rel) => sum + statSync(`${dir}/${rel}`).size, 0);
  console.log(`\n${prefix}: ${files.length} files, ${mb(total)} MB`);

  for (const rel of files) {
    const local = `${dir}/${rel}`;
    const key = `${prefix}/${rel}`;
    const size = statSync(local).size;

    if (await objectExists(key)) {
      skipped++;
      if (deleteLocal && apply) {
        rmSync(local, { force: true });
        bytesFreed += size;
      }
      continue;
    }

    if (!apply) {
      console.log(`  would upload ${key} (${mb(size)} MB)`);
      uploaded++;
      bytesMoved += size;
      continue;
    }

    try {
      // putFile also records the object in the local ledger, so the admin usage figure reflects the migration.
      if (!(await putFile(key, local))) {
        console.error(`  REFUSED ${key}: storage cap reached (raise R2_MAX_GB or free space, then re-run)`);
        failed++;
        continue;
      }
      uploaded++;
      bytesMoved += size;
      if (deleteLocal) {
        rmSync(local, { force: true });
        bytesFreed += size;
      }
      console.log(`  uploaded ${key} (${mb(size)} MB)`);
    } catch (err) {
      // Keep going: one bad object should not strand the rest, and a re-run picks it up.
      failed++;
      console.error(`  FAILED ${key}: ${String(err)}`);
    }
  }
}

console.log(
  `\n${apply ? "Done" : "Dry run"}: ${uploaded} ${apply ? "uploaded" : "to upload"} (${mb(bytesMoved)} MB), ` +
    `${skipped} already in R2, ${failed} failed.`,
);
if (deleteLocal && apply) console.log(`Freed ${mb(bytesFreed)} MB from the volume.`);
if (!apply) console.log("Nothing was changed. Re-run with --apply to upload.");
if (apply && !deleteLocal) console.log("Local copies were kept. Re-run with --delete-local once you have verified the app serves from R2.");
if (failed) process.exitCode = 1;
