/**
 * Moves generated media from a local STORAGE_DIR into R2.
 *
 *   bun scripts/migrate-storage-to-r2.ts                            # report what would move, change nothing
 *   bun scripts/migrate-storage-to-r2.ts --apply                    # upload, keep local copies
 *   bun scripts/migrate-storage-to-r2.ts --apply --delete-local     # upload, then free the disk
 *
 * This operates on the disk of the machine it runs on. For the Railway volume, don't use `railway run` (that
 * runs locally): set MIGRATE_VOLUME_TO_R2=1 on the service instead, and the server runs the same migration on
 * boot inside the container. See src/server/migrateVolume.ts.
 */

import { r2Enabled } from "../src/server/storage";
import { migrateVolumeToR2 } from "../src/server/migrateVolume";

const apply = process.argv.includes("--apply");
const deleteLocal = process.argv.includes("--delete-local");

if (!r2Enabled()) {
  console.error("R2 is not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.");
  process.exit(1);
}

const mb = (b: number) => (b / 1e6).toFixed(1);
const r = await migrateVolumeToR2({ apply, deleteLocal, log: line => console.log(line) });

console.log(
  `\n${apply ? "Done" : "Dry run"}: ${r.uploaded} ${apply ? "uploaded" : "to upload"} (${mb(r.bytesMoved)} MB), ` +
    `${r.skipped} already in R2, ${r.failed} failed.`,
);
if (apply && deleteLocal) console.log(`Freed ${mb(r.bytesFreed)} MB.`);
if (!apply) console.log("Nothing was changed. Re-run with --apply to upload.");
if (r.failed) process.exitCode = 1;
