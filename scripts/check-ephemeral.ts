/**
 * Exercises the temporary-film policy without needing a full render.
 *
 *   bun scripts/check-ephemeral.ts
 *
 * Covers the three ways a disk-only film should disappear — the one-hour cache window expiring, the viewer
 * leaving, and a finished download — and confirms a fresh film is NOT swept while it is still in window.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { db } from "../src/server/db";
import { isEphemeral, markDownloaded, markEphemeral, sweep, viewerLeft } from "../src/server/ephemeral";

const show = (label: string, ok: boolean, extra = "") => console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
let failed = false;
const check = (label: string, ok: boolean, extra = "") => {
  show(label, ok, extra);
  failed ||= !ok;
};

const dir = `${tmpdir()}/slop-ephemeral-check`;
mkdirSync(dir, { recursive: true });
const make = (name: string) => {
  const p = `${dir}/${name}`;
  writeFileSync(p, "film");
  return p;
};

// Start from a clean slate so earlier runs cannot colour the result.
db.query(`DELETE FROM ephemeral_files WHERE path LIKE ?`).run(`${dir}%`);
db.query(`DELETE FROM viewer_activity WHERE viewer_id LIKE 'check-%'`).run();

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// 1. A film inside the cache window must survive a sweep, even with no sign of life from the viewer.
// This is the case the old idle timer got wrong: watching makes no API calls.
const active = make("active.mp4");
markEphemeral(active, "/media/exports/active.mp4", "check-active");
check("temporary film is flagged unshareable", isEphemeral("/media/exports/active.mp4"));
sweep();
check("fresh film survives the sweep", existsSync(active));

// 2. Viewer closes the tab: gone at once, without waiting out the window.
const left = make("left.mp4");
markEphemeral(left, "/media/exports/left.mp4", "check-left");
viewerLeft("check-left"); // viewerLeft sweeps immediately
check("film deleted when the viewer leaves", !existsSync(left));

// 3. Past the one-hour window, with no close event ever arriving.
const stale = make("stale.mp4");
markEphemeral(stale, "/media/exports/stale.mp4", "check-stale");
db.query(`UPDATE ephemeral_files SET created_at = ? WHERE path = ?`).run(ago(61 * 60_000), stale);
sweep();
check("film deleted once the cache window expires", !existsSync(stale));

// 3b. Just inside the window must NOT be swept.
const nearly = make("nearly.mp4");
markEphemeral(nearly, "/media/exports/nearly.mp4", "check-nearly");
db.query(`UPDATE ephemeral_files SET created_at = ? WHERE path = ?`).run(ago(59 * 60_000), nearly);
sweep();
check("film at 59 minutes is still kept", existsSync(nearly));

// 4. Download finished.
const got = make("downloaded.mp4");
markEphemeral(got, "/media/exports/downloaded.mp4", "check-active");
markDownloaded("/media/exports/downloaded.mp4");
db.query(`UPDATE ephemeral_files SET downloaded_at = ? WHERE media_url = ?`).run(ago(2 * 60_000), "/media/exports/downloaded.mp4");
sweep();
check("film deleted after the download completes", !existsSync(got));

// The fresh film should STILL be there after all that.
check("fresh film still untouched at the end", existsSync(active));

// A film that was never ephemeral must stay shareable.
check("a normal film is not flagged", !isEphemeral("/media/exports/normal-r2-film.mp4"));

// Cleanup.
db.query(`DELETE FROM ephemeral_files WHERE path LIKE ?`).run(`${dir}%`);
db.query(`DELETE FROM viewer_activity WHERE viewer_id LIKE 'check-%'`).run();
rmSync(dir, { recursive: true, force: true });

console.log(failed ? "\nSomething is wrong — see above." : "\nTemporary-film policy behaves.");
process.exit(failed ? 1 : 0);
