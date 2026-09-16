import { existsSync, rmSync } from "node:fs";
import { db, logEvent } from "./db";

/**
 * Films that only exist on the container's disk, because R2 was full when they were rendered.
 *
 * These are deliberately temporary. The viewer can watch and download them, but they are never shareable:
 * a share link outlives the session that made it, and this file will not. Letting one be shared would hand
 * out a URL guaranteed to 404 later, which is worse than refusing up front.
 *
 * They are deleted when the viewer leaves the story (tab closed, restarted, or simply gone quiet), and
 * shortly after a download, so the disk that R2 was supposed to protect does not fill up again.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS ephemeral_files (
    path TEXT PRIMARY KEY,
    media_url TEXT NOT NULL,
    viewer_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    downloaded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ephemeral_by_viewer ON ephemeral_files(viewer_id);

  CREATE TABLE IF NOT EXISTS viewer_activity (
    viewer_id TEXT PRIMARY KEY,
    last_seen TEXT NOT NULL,
    left_at TEXT
  );
`);

/**
 * How long a disk-only film is kept, measured from when it was rendered.
 *
 * A flat cache window rather than an idle timer: watching a film makes no API calls, so tracking liveness
 * would mean heartbeating the whole session just to avoid deleting a file out from under someone. An hour
 * comfortably outlasts any single sitting, and bounds how long the disk can be held either way.
 */
const CACHE_TTL_MS = 60 * 60_000;
/** Grace after a download starts, so the transfer is not cut off mid-flight. */
const DOWNLOAD_GRACE_MS = 60_000;

const now = () => new Date().toISOString();

/** Records a render that stayed on disk, so the sweeper can reclaim it later. */
export function markEphemeral(path: string, mediaUrl: string, viewerId?: string) {
  db.query(
    `INSERT INTO ephemeral_files (path, media_url, viewer_id) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET viewer_id = COALESCE(excluded.viewer_id, viewer_id)`,
  ).run(path, mediaUrl, viewerId ?? null);
  logEvent({ kind: "job", label: "film kept on disk (not shareable)", response: { mediaUrl, viewerId } });
}

/** True when this media URL is disk-only, and therefore must not be given a share link. */
export function isEphemeral(mediaUrl: string) {
  return Boolean(db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ephemeral_files WHERE media_url = ?`).get(mediaUrl)?.n);
}

/** The viewer closed the tab or restarted the story: their disk-only films can go now. */
export function viewerLeft(viewerId?: string) {
  if (!viewerId) return;
  db.query(`INSERT INTO viewer_activity (viewer_id, last_seen, left_at) VALUES (?, ?, ?)
            ON CONFLICT(viewer_id) DO UPDATE SET left_at = excluded.left_at`).run(viewerId, now(), now());
  sweep();
}

/** Marks a file as downloaded; it is removed once the grace period is up. */
export function markDownloaded(mediaUrl: string) {
  db.query(`UPDATE ephemeral_files SET downloaded_at = ? WHERE media_url = ? AND downloaded_at IS NULL`).run(now(), mediaUrl);
}

/**
 * Deletes disk-only films whose viewer has gone, whose download has finished, or which have simply aged out.
 * Returns how many were reclaimed.
 */
export function sweep() {
  const expiredCutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
  const downloadCutoff = new Date(Date.now() - DOWNLOAD_GRACE_MS).toISOString();

  const doomed = db
    .query<{ path: string; media_url: string }, [string, string]>(
      `SELECT f.path, f.media_url FROM ephemeral_files f
       LEFT JOIN viewer_activity v ON v.viewer_id = f.viewer_id
       WHERE f.created_at < ?                                       -- past the cache window
          OR v.left_at IS NOT NULL                                  -- viewer closed the tab or restarted
          OR (f.downloaded_at IS NOT NULL AND f.downloaded_at < ?)  -- download finished`,
    )
    .all(expiredCutoff, downloadCutoff);
  if (!doomed.length) return 0;

  for (const { path, media_url } of doomed) {
    try {
      if (existsSync(path)) rmSync(path, { force: true });
    } catch (err) {
      logEvent({ kind: "error", label: "ephemeral file could not be deleted", status: "error", response: { path, error: String(err) } });
    }
    db.query(`DELETE FROM ephemeral_files WHERE path = ?`).run(path);
    void media_url;
  }
  logEvent({ kind: "job", label: `ephemeral films reclaimed (${doomed.length})`, response: { paths: doomed.map(d => d.path) } });
  return doomed.length;
}

/** How much disk the temporary films are currently holding, for the admin panel. */
export function ephemeralStats() {
  const row = db.query<{ files: number }, []>(`SELECT COUNT(*) AS files FROM ephemeral_files`).get();
  return { files: row?.files ?? 0 };
}

// A viewer who closes the tab without the beacon landing still has to be cleaned up eventually.
const timer = setInterval(sweep, 60_000);
// Do not keep the process alive purely to run the sweeper.
(timer as unknown as { unref?: () => void }).unref?.();
