import { readdirSync, rmSync, statSync } from "node:fs";
import { CACHE_DIR, EXPORT_DIR, FRAMES_DIR } from "./config";
import { logEvent } from "./db";
import { objectExists, putFile, r2Enabled } from "./storage";

/**
 * Moves generated media from the local volume into R2.
 *
 * Keys mirror the `/media/...` URL layout, so every share link and every clip_url already in the database keeps
 * resolving afterwards without touching a row.
 *
 * It lives in the server rather than only in a script because the files are on the deployment's volume: a script
 * run from a laptop (even through `railway run`) sees the laptop's disk, not the container's. Setting
 * MIGRATE_VOLUME_TO_R2=1 runs it once on boot, inside the container, where the files actually are.
 *
 * Safe to re-run and to interrupt: objects already in R2 are skipped, and a local copy is only deleted after its
 * upload has succeeded, so a failure can never take the only copy with it.
 */

const AREAS = [
  { dir: CACHE_DIR, prefix: "cache" },
  { dir: EXPORT_DIR, prefix: "exports" },
  { dir: FRAMES_DIR, prefix: "frames" },
];

function walk(dir: string, base = ""): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap(name => {
    const full = `${dir}/${name}`;
    const rel = base ? `${base}/${name}` : name;
    return statSync(full).isDirectory() ? walk(full, rel) : [rel];
  });
}

export type MigrationResult = {
  uploaded: number;
  skipped: number;
  failed: number;
  bytesMoved: number;
  bytesFreed: number;
};

export async function migrateVolumeToR2(opts: { apply: boolean; deleteLocal: boolean; log?: (line: string) => void }) {
  const log = opts.log ?? (() => {});
  const result: MigrationResult = { uploaded: 0, skipped: 0, failed: 0, bytesMoved: 0, bytesFreed: 0 };
  if (!r2Enabled()) throw new Error("R2 is not configured");

  for (const { dir, prefix } of AREAS) {
    const files = walk(dir);
    log(`${prefix}: ${files.length} files`);

    for (const rel of files) {
      const local = `${dir}/${rel}`;
      const key = `${prefix}/${rel}`;
      let size = 0;
      try {
        size = statSync(local).size;
      } catch {
        continue; // removed while we were walking
      }

      if (await objectExists(key)) {
        result.skipped++;
        if (opts.apply && opts.deleteLocal) {
          rmSync(local, { force: true });
          result.bytesFreed += size;
        }
        continue;
      }
      if (!opts.apply) {
        result.uploaded++;
        result.bytesMoved += size;
        continue;
      }

      try {
        // putFile records the object in the storage ledger, so admin usage reflects the migration.
        if (!(await putFile(key, local))) {
          log(`refused ${key}: storage cap reached`);
          result.failed++;
          continue;
        }
        result.uploaded++;
        result.bytesMoved += size;
        if (opts.deleteLocal) {
          rmSync(local, { force: true });
          result.bytesFreed += size;
        }
      } catch (err) {
        // Keep going: one bad object should not strand the rest, and a re-run picks it up.
        result.failed++;
        log(`failed ${key}: ${String(err)}`);
      }
    }
  }
  return result;
}

/** Boot hook: runs once when MIGRATE_VOLUME_TO_R2=1, in the background so the health check is not held up. */
export function migrateOnBootIfRequested() {
  if (process.env.MIGRATE_VOLUME_TO_R2 !== "1") return;
  const mb = (b: number) => (b / 1e6).toFixed(1);
  const log = (line: string) => console.log(`[migrate] ${line}`);
  log("MIGRATE_VOLUME_TO_R2=1 — moving volume media to R2 and freeing local copies");
  void migrateVolumeToR2({ apply: true, deleteLocal: true, log })
    .then(r => {
      const summary = `done: ${r.uploaded} uploaded (${mb(r.bytesMoved)} MB), ${r.skipped} already in R2, ${r.failed} failed, ${mb(r.bytesFreed)} MB freed`;
      log(summary);
      log("unset MIGRATE_VOLUME_TO_R2 now that it has run");
      logEvent({ kind: "job", label: "volume migrated to R2", status: r.failed ? "error" : "ok", response: r });
    })
    .catch(err => {
      log(`aborted: ${String(err)}`);
      logEvent({ kind: "error", label: "volume migration aborted", status: "error", response: String(err) });
    });
}
