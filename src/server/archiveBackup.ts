import { db, logEvent } from "./db";
import { putSmall, r2Enabled, readText } from "./storage";

/**
 * Off-site copy of the action archive: the mapping from "what someone tried in this location" to the clip we
 * already paid for. The clips themselves live in R2 under keys that mirror their /media URLs, so these rows
 * are the only part that could be lost — and losing them means paying to regenerate every clip.
 *
 * The deploy volume survives redeploys, but not the volume or service being deleted or recreated. This keeps
 * a copy beside the media, restores it automatically into an empty database, and lets any machine with the
 * R2 credentials start from production's library instead of an empty one.
 *
 * Only the deployment writes. A laptop running `bun dev` against the same bucket restores from the backup
 * when its own archive is empty but never uploads, so a local experiment cannot overwrite production's copy.
 */

const LATEST = "backups/action_clips.json";
/** One dated copy per day as well, so a bad write can be rolled back rather than only overwritten. */
const dated = () => `backups/action_clips-${new Date().toISOString().slice(0, 10)}.json`;
/** Coalesces a burst of saves (a busy demo) into one upload. */
const DEBOUNCE_MS = 15_000;

/** Railway writes by default (ARCHIVE_BACKUP=0 opts out); anywhere else must opt in with ARCHIVE_BACKUP=1. */
const isWriter = () => {
  if (!r2Enabled()) return false;
  const flag = process.env.ARCHIVE_BACKUP;
  return flag ? flag === "1" : Boolean(process.env.RAILWAY_ENVIRONMENT);
};

let pending: ReturnType<typeof setTimeout> | null = null;

/** Called after anything changes the archive. Cheap: at most one upload per debounce window. */
export function scheduleArchiveBackup() {
  if (!isWriter() || pending) return;
  pending = setTimeout(() => {
    pending = null;
    void backupArchive();
  }, DEBOUNCE_MS);
}

export async function backupArchive() {
  if (!isWriter()) return;
  try {
    const rows = db.query(`SELECT * FROM action_clips ORDER BY id`).all();
    const body = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), rows });
    await putSmall(LATEST, body);
    await putSmall(dated(), body);
    logEvent({ kind: "job", label: `action archive backed up (${rows.length})`, response: { key: LATEST, bytes: body.length } });
  } catch (err) {
    logEvent({ kind: "error", label: "action archive backup failed", status: "error", response: String(err) });
  }
}

/**
 * Refills an empty archive from the latest backup. Runs on every boot and does nothing when the table already
 * has rows, so it only ever fires on a fresh volume or a fresh local checkout.
 */
export async function restoreArchiveIfEmpty() {
  if (!r2Enabled()) return;
  const { n } = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM action_clips`).get() ?? { n: 0 };
  if (n > 0) return;
  try {
    const text = await readText(LATEST);
    if (!text) return;
    const { rows } = JSON.parse(text) as { rows: Record<string, unknown>[] };
    if (!rows?.length) return;

    // Only columns this build knows about, so a backup from a newer or older schema still restores.
    const columns = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(action_clips)`).all().map(c => c.name));
    const restore = db.transaction((all: Record<string, unknown>[]) => {
      for (const row of all) {
        const cols = Object.keys(row).filter(c => columns.has(c));
        db.query(`INSERT OR IGNORE INTO action_clips (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
          ...cols.map(c => row[c] as string | number | null),
        );
      }
    });
    restore(rows);
    logEvent({ kind: "job", label: `action archive restored from backup (${rows.length})`, response: { key: LATEST } });
  } catch (err) {
    logEvent({ kind: "error", label: "action archive restore failed", status: "error", response: String(err) });
  }
}

/** Boot: restore if empty, then make sure what this instance holds is backed up, then keep it fresh daily. */
export async function startArchiveBackups() {
  await restoreArchiveIfEmpty();
  if (!isWriter()) return;
  await backupArchive();
  setInterval(() => void backupArchive(), 24 * 60 * 60_000);
}
