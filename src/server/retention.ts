import { renameSync, rmSync, statSync } from "node:fs";
import { DB_FILE } from "./config";
import { db, tryQuery } from "./db";

/**
 * Keeps the debug database from eating the volume.
 *
 * Every LLM call, decision and generation is logged with its full request and response, which is what makes
 * the debug panel useful — and also means the table grows without bound. Moving the media to R2 freed 438MB
 * and the volume stayed full, because by then the database was most of it.
 *
 * Old events are deleted on boot and daily afterwards. Deleting rows does not shrink the file on its own
 * (SQLite keeps the freed pages), so the file is compacted separately once it is worth doing.
 */

/** Debug history older than this is not worth the disk it sits on. */
const MAX_AGE_DAYS = 7;
/** Hard ceiling regardless of age, so one busy day cannot fill the disk by itself. */
const MAX_EVENTS = 20_000;
/** Below this there is nothing worth compacting. */
const COMPACT_ABOVE_BYTES = 50_000_000;

export const dbBytes = () => {
  let total = 0;
  // The WAL and shared-memory files sit beside the database and count against the same volume.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(`${DB_FILE}${suffix}`).size;
    } catch {
      // not present is fine
    }
  }
  return total;
};

/** Deletes aged-out and surplus events. Returns how many rows went. */
export function pruneEvents() {
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60_000).toISOString();
  const byAge = tryQuery(() => db.query(`DELETE FROM events WHERE ts < ?`).run(cutoff).changes, 0, "prune events by age");
  // Keep the most recent MAX_EVENTS whatever their age.
  const byCount = tryQuery(
    () =>
      db
        .query(`DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)`)
        .run(MAX_EVENTS).changes,
    0,
    "prune events by count",
  );
  return byAge + byCount;
}

/**
 * Rewrites the database without its free pages.
 *
 * `VACUUM INTO` is used rather than plain `VACUUM`: plain VACUUM needs room for a second copy of the whole
 * file, which is exactly what a nearly-full volume does not have. VACUUM INTO writes only the live data, so
 * after a big prune the copy is small enough to fit. If it does not fit, the attempt fails harmlessly and
 * the original is untouched.
 */
export function compactDatabase() {
  const before = dbBytes();
  if (before < COMPACT_ABOVE_BYTES) return { before, after: before, compacted: false };
  const temp = `${DB_FILE}.compact`;
  try {
    rmSync(temp, { force: true });
    db.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
    // Checkpoint and close cleanly before swapping the file under the open connection.
    db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
    db.close();
    renameSync(temp, DB_FILE);
    rmSync(`${DB_FILE}-wal`, { force: true });
    rmSync(`${DB_FILE}-shm`, { force: true });
    // The process must restart to reopen the swapped file; Railway does that for us.
    console.log(`[retention] compacted ${(before / 1e6).toFixed(1)}MB -> ${(statSync(DB_FILE).size / 1e6).toFixed(1)}MB, restarting`);
    process.exit(0);
  } catch (err) {
    rmSync(temp, { force: true });
    console.error(`[retention] compaction skipped: ${String(err)}`);
    return { before, after: before, compacted: false };
  }
}

/** Boot hook: prune now, then daily. Compaction only runs when COMPACT_DB=1, since it restarts the process. */
export function startRetention() {
  const run = () => {
    const removed = pruneEvents();
    if (removed) console.log(`[retention] removed ${removed} old debug events (db now ${(dbBytes() / 1e6).toFixed(1)}MB)`);
  };
  run();
  if (process.env.COMPACT_DB === "1") compactDatabase();
  const timer = setInterval(run, 24 * 60 * 60_000);
  (timer as unknown as { unref?: () => void }).unref?.();
}
