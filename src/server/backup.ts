import { existsSync, rmSync, statSync } from "node:fs";
import { CACHE_DIR, STORAGE_DIR } from "./config";
import { db } from "./db";

/**
 * Whole-deployment backup, pulled by an admin over HTTPS (scripts/backup-deployment.ts).
 *
 * Generated clips and exports live in R2 and the action archive backs itself up there (archiveBackup.ts), but
 * everything else the deployment knows only exists on the Railway volume: the story nodes behind every /s/<id>
 * share link, user accounts and sessions, guest allowances, the event log and the settings. Lose the volume and
 * the MP4s survive while the links to them do not.
 *
 * So this exposes the volume's state as two downloads: a consistent copy of the SQLite database (VACUUM INTO,
 * which folds in the WAL and skips free pages) and the small JSON files beside it. Media is deliberately left
 * out: it is already in R2 and is gigabytes, not megabytes.
 */

const stateFileNames = ["settings.json", "auth-providers.json"] as const;
const dataDir = STORAGE_DIR ?? `${new URL("../../data", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")}`;
const stateFile = (name: string) => `${dataDir}/${name}`;

const tableNames = () =>
  db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map(r => r.name);

const rowCount = (table: string) => {
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0;
  } catch {
    return -1; // unreadable table: worth backing up anyway, just not countable
  }
};

/** What a backup would contain, so the script (and a human) can see it is getting the real thing. */
export function backupManifest() {
  const tables: Record<string, number> = {};
  for (const name of tableNames()) tables[name] = rowCount(name);
  return {
    exportedAt: new Date().toISOString(),
    dataDir,
    tables,
    files: stateFileNames.filter(name => existsSync(stateFile(name))).map(name => ({ name, bytes: statSync(stateFile(name)).size })),
  };
}

/**
 * A consistent copy of the database as bytes. VACUUM INTO takes its own read transaction, so this is safe while
 * the server is serving; the snapshot goes to the cache directory (the volume's roomiest place) and is deleted
 * as soon as it has been read.
 */
export async function databaseSnapshot() {
  const path = `${CACHE_DIR}/backup-${crypto.randomUUID()}.sqlite`;
  rmSync(path, { force: true }); // VACUUM INTO refuses to overwrite
  try {
    db.run(`VACUUM INTO ?`, [path]);
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  } finally {
    rmSync(path, { force: true });
  }
}

/** The JSON state beside the database. Contains OAuth client secrets, so it is admin-only and stays off disk here. */
export async function stateFiles() {
  const out: Record<string, unknown> = {};
  for (const name of stateFileNames) {
    if (existsSync(stateFile(name))) out[name] = await Bun.file(stateFile(name)).json().catch(() => null);
  }
  return out;
}
