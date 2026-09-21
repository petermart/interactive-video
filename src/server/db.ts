import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { DB_FILE } from "./config";

/**
 * Debug + persistence store (data/debug.sqlite, gitignored).
 * - events: everything the server does under the hood (LLM calls, uploads, generations, decisions, errors)
 * - jobs / nodes: pipeline state, so a page reload or server hot-reload doesn't lose in-flight or finished steps
 */
const g = globalThis as unknown as { __prisonDb?: Database };
export const db = (g.__prisonDb ??= new Database(DB_FILE, { create: true }));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    job_id TEXT,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    duration_ms INTEGER,
    cost_usd REAL,
    request TEXT,
    response TEXT
  );
  CREATE INDEX IF NOT EXISTS events_job ON events(job_id);
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    from_node_id TEXT,
    direction TEXT,
    status TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL
  );
`);

// Per-viewer scoping (added after the first deploy of this schema): each browser session sends a UUID.
for (const table of ["events", "jobs"]) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN viewer_id TEXT`);
  } catch {
    // column already exists
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS events_viewer ON events(viewer_id); CREATE INDEX IF NOT EXISTS jobs_viewer ON jobs(viewer_id);`);

/** Carries the current job and viewer through async calls so gmi/machgen logs attach to the right job and viewer. */
export const jobContext = new AsyncLocalStorage<{ jobId?: string; viewerId?: string }>();

export type EventKind = "job" | "llm" | "decision" | "upload" | "video" | "error";

const insertEvent = db.prepare(
  `INSERT INTO events (job_id, viewer_id, kind, label, status, duration_ms, cost_usd, request, response)
   VALUES ($job_id, $viewer_id, $kind, $label, $status, $duration_ms, $cost_usd, $request, $response)`,
);

const json = (v: unknown) => (v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));

export function logEvent(e: {
  kind: EventKind;
  label: string;
  status?: "ok" | "error";
  durationMs?: number;
  costUsd?: number;
  request?: unknown;
  response?: unknown;
}) {
  try {
    insertEvent.run({
      $job_id: jobContext.getStore()?.jobId ?? null,
      $viewer_id: jobContext.getStore()?.viewerId ?? null,
      $kind: e.kind,
      $label: e.label,
      $status: e.status ?? "ok",
      $duration_ms: e.durationMs == null ? null : Math.round(e.durationMs),
      $cost_usd: e.costUsd ?? null,
      $request: json(e.request),
      $response: json(e.response),
    });
  } catch (err) {
    console.error("[db] logEvent failed", err);
  }
}

/** Times an async operation and logs it (with error details on failure). */
export async function traced<T>(
  kind: EventKind,
  label: string,
  request: unknown,
  fn: () => Promise<T>,
  opts: { costUsd?: number; cost?: (result: T) => number | undefined; summarize?: (result: T) => unknown } = {},
): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    const costUsd = opts.cost ? opts.cost(result) : opts.costUsd;
    logEvent({ kind, label, durationMs: performance.now() - t0, costUsd, request, response: opts.summarize ? opts.summarize(result) : result });
    return result;
  } catch (err) {
    logEvent({ kind, label, status: "error", durationMs: performance.now() - t0, request, response: String((err as Error)?.message ?? err) });
    throw err;
  }
}

const upsertJob = db.prepare(
  `INSERT INTO jobs (id, viewer_id, from_node_id, direction, status, data) VALUES ($id, $viewer, $from, $direction, $status, $data)
   ON CONFLICT(id) DO UPDATE SET status = $status, data = $data, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
);
export const saveJob = (job: { id: string; status: string; viewerId?: string }, fromNodeId: string, direction: string) =>
  upsertJob.run({ $id: job.id, $viewer: job.viewerId ?? null, $from: fromNodeId, $direction: direction, $status: job.status, $data: JSON.stringify(job) });

const upsertNode = db.prepare(`INSERT INTO nodes (id, data) VALUES ($id, $data) ON CONFLICT(id) DO UPDATE SET data = $data`);
export const saveNode = (node: { id: string }) => upsertNode.run({ $id: node.id, $data: JSON.stringify(node) });

export const loadJob = <T>(id: string) => {
  const row = db.query<{ data: string }, [string]>(`SELECT data FROM jobs WHERE id = ?`).get(id);
  return row ? (JSON.parse(row.data) as T) : undefined;
};
export const loadNode = <T>(id: string) => {
  const row = db.query<{ data: string }, [string]>(`SELECT data FROM nodes WHERE id = ?`).get(id);
  return row ? (JSON.parse(row.data) as T) : undefined;
};

/** A viewer's recent jobs with their event counts, total cost and duration, newest first. */
export function recentJobs(viewerId: string, limit = 50) {
  return db
    .query(
      `SELECT j.id, j.created_at, j.updated_at, j.direction, j.status,
              COUNT(e.id) AS events, ROUND(COALESCE(SUM(e.cost_usd), 0), 3) AS cost_usd,
              SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) AS errors
       FROM jobs j LEFT JOIN events e ON e.job_id = j.id
       WHERE j.viewer_id = ?
       GROUP BY j.id ORDER BY j.created_at DESC LIMIT ?`,
    )
    .all(viewerId, limit);
}

export function jobEvents(jobId: string, viewerId: string) {
  return db.query(`SELECT * FROM events WHERE job_id = ? AND job_id IN (SELECT id FROM jobs WHERE viewer_id = ?) ORDER BY id`).all(jobId, viewerId);
}

/** A viewer's events not tied to a job (session starts, exports). */
export function looseEvents(viewerId: string, limit = 50) {
  return db.query(`SELECT * FROM events WHERE job_id IS NULL AND viewer_id = ? ORDER BY id DESC LIMIT ?`).all(viewerId, limit);
}

/**
 * Runs schema DDL without letting a failure take the server down.
 *
 * Tables are created at import time, so an exception here happens before the server can listen - and a
 * server that cannot boot cannot run the one migration that would fix the underlying problem. That is
 * exactly what happened when the volume filled: SQLite could not write the new tables, and the deploy
 * crash-looped. Bookkeeping must degrade, never block.
 *
 * Returns whether the schema is usable, so callers can retry later (after a migration frees space) rather
 * than assuming their tables exist.
 */
export function tryExec(label: string, sql: string) {
  try {
    db.exec(sql);
    return true;
  } catch (err) {
    // An ADD COLUMN migration runs on every boot; after the first, "already there" is the expected outcome.
    if (/duplicate column name/i.test(String(err))) return true;
    console.error(`[schema] ${label} unavailable: ${String(err)}`);
    return false;
  }
}

/** Wraps a read so a missing or unwritable table degrades to a fallback instead of throwing. */
export function tryQuery<T>(fn: () => T, fallback: T, label = "query"): T {
  try {
    return fn();
  } catch (err) {
    console.error(`[schema] ${label} failed: ${String(err)}`);
    return fallback;
  }
}
