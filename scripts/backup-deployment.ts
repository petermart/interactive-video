/**
 * Pulls the deployment's state to this machine: `bun scripts/backup-deployment.ts`.
 *
 * Clips and exports are in R2 and the action archive backs itself up there, but the SQLite database on the
 * Railway volume is the only copy of the story nodes behind every /s/<id> share link, the user accounts, the
 * guest allowances and the event log. This downloads that database (a VACUUM INTO snapshot taken while the
 * server runs) plus settings.json and auth-providers.json into a timestamped folder under .prod-data/backups/.
 *
 *   bun scripts/backup-deployment.ts                     # production, password from the environment
 *   bun scripts/backup-deployment.ts http://localhost:3000
 *   BACKUP_URL=... ADMIN_PASSWORD=... bun scripts/backup-deployment.ts
 *
 * The backup holds OAuth client secrets and session tokens, so .prod-data/ is gitignored - keep it that way.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DEFAULT_URL = "https://prison-escape-production.up.railway.app";
/** Older backups are small (megabytes) and the newest is not always the good one, so a few are kept. */
const KEEP = 10;

const keys: Record<string, string> = existsSync(`${ROOT}/keys.json`) ? await Bun.file(`${ROOT}/keys.json`).json() : {};
const base = (process.argv[2] ?? process.env.BACKUP_URL ?? DEFAULT_URL).replace(/\/+$/, "");
const password = process.env.ADMIN_PASSWORD ?? keys.adminPassword;
if (!password) {
  console.error("No admin password. Set ADMIN_PASSWORD, or put adminPassword in keys.json.");
  process.exit(1);
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

async function get(path: string) {
  const res = await fetch(`${base}${path}`, { headers: { "x-admin-password": password! } });
  if (res.status === 401) throw new Error(`${path}: the admin password was rejected`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/**
 * A deployment older than the backup endpoint can still hand over its action archive, which is the expensive
 * part (every generated clip and the prompt that made it). Better a partial backup than none while the new
 * code waits for a deploy; the share links and accounts still need one.
 */
async function archiveOnly() {
  console.log("  no backup endpoint on this deployment (it predates it) - falling back to the action archive");
  const { rows } = await (await get("/api/admin/archive")).json();
  const dir = `${ROOT}/.prod-data/backups/${stamp()}-archive-only`;
  mkdirSync(dir, { recursive: true });
  await Bun.write(`${dir}/action_clips.json`, JSON.stringify(rows, null, 2));
  await Bun.write(`${dir}/manifest.json`, JSON.stringify({ partial: true, source: base, downloadedAt: new Date().toISOString(), tables: { action_clips: rows.length } }, null, 2));
  console.log(`Saved ${rows.length} archive rows to ${dir.slice(ROOT.length + 1)}`);
  console.log("Share links (nodes), accounts and settings are NOT in this backup: deploy the current code and run this again.");
}

console.log(`Backing up ${base}`);
// An older deployment has no such route, and the catch-all answers with the app's HTML rather than a 404.
const probe = await fetch(`${base}/api/admin/backup`, { headers: { "x-admin-password": password } });
if (probe.status === 404 || !probe.headers.get("content-type")?.includes("json")) {
  await archiveOnly();
  process.exit(0);
}
const manifest = await (await get("/api/admin/backup")).json();
const tables = Object.entries(manifest.tables as Record<string, number>);
console.log(`  ${tables.length} tables: ${tables.map(([n, c]) => `${n} ${c}`).join(", ")}`);

const at = stamp();
const dir = `${ROOT}/.prod-data/backups/${at}`;
mkdirSync(dir, { recursive: true });

const dbBytes = new Uint8Array(await (await get("/api/admin/backup/db")).arrayBuffer());
await Bun.write(`${dir}/debug.sqlite`, dbBytes);
const state = await (await get("/api/admin/backup/files")).json();
await Bun.write(`${dir}/state.json`, JSON.stringify(state, null, 2));
await Bun.write(`${dir}/manifest.json`, JSON.stringify({ ...manifest, source: base, downloadedAt: new Date().toISOString(), dbBytes: dbBytes.byteLength }, null, 2));

// A backup nobody has opened is a guess. Check the file is a working database with the rows the server promised.
const copy = new Database(`${dir}/debug.sqlite`, { readonly: true });
const integrity = copy.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check;
const mismatches = tables
  .map(([name, count]) => [name, count, copy.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n ?? -1] as const)
  .filter(([, expected, got]) => expected >= 0 && expected !== got);
copy.close();

console.log(`  database ${mb(dbBytes.byteLength)}, integrity_check: ${integrity}`);
console.log(`  files: ${Object.keys(state).join(", ") || "none"}`);
if (integrity !== "ok" || mismatches.length) {
  console.error(`  BAD BACKUP: ${mismatches.map(([n, e, g]) => `${n} expected ${e} got ${g}`).join("; ") || integrity}`);
  process.exit(1);
}

const backups = readdirSync(`${ROOT}/.prod-data/backups`).sort();
for (const old of backups.slice(0, Math.max(0, backups.length - KEEP))) {
  rmSync(`${ROOT}/.prod-data/backups/${old}`, { recursive: true, force: true });
  console.log(`  pruned ${old}`);
}

const total = readdirSync(`${ROOT}/.prod-data/backups`).reduce(
  (sum, d) => sum + readdirSync(`${ROOT}/.prod-data/backups/${d}`).reduce((s, f) => s + statSync(`${ROOT}/.prod-data/backups/${d}/${f}`).size, 0),
  0,
);
console.log(`Saved to .prod-data/backups/${at} (${backups.length > KEEP ? KEEP : backups.length} kept, ${mb(total)} total)`);
