import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT } from "./config";

/**
 * Debug + persistence store (data/debug.sqlite, gitignored).
 * - events: everything the server does under the hood (LLM calls, uploads, generations, decisions, errors)
 * - jobs / nodes: pipeline state, so a page reload or server hot-reload doesn't lose in-flight or finished steps
 */
const g = globalThis as unknown as { __prisonDb?: Database };
export const db = (g.__prisonDb ??= new Database(`${ROOT}data/debug.sqlite`, { create: true }));

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

/** Carries the current job id through async calls so gmi/machgen logs attach to the right job. */
export const jobContext = new AsyncLocalStorage<{ jobId: string }>();

export type EventKind = "job" | "llm" | "decision" | "upload" | "video" | "error";

const insertEvent = db.prepare(
  `INSERT INTO events (job_id, kind, label, status, duration_ms, cost_usd, request, response)
   VALUES ($job_id, $kind, $label, $status, $duration_ms, $cost_usd, $request, $response)`,
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
  opts: { costUsd?: number; summarize?: (result: T) => unknown } = {},
): Promise<T> {
  const t0 = performance.now();
  try {
    const result = await fn();
    logEvent({ kind, label, durationMs: performance.now() - t0, costUsd: opts.costUsd, request, response: opts.summarize ? opts.summarize(result) : result });
    return result;
  } catch (err) {
    logEvent({ kind, label, status: "error", durationMs: performance.now() - t0, request, response: String((err as Error)?.message ?? err) });
    throw err;
  }
}

const upsertJob = db.prepare(
  `INSERT INTO jobs (id, from_node_id, direction, status, data) VALUES ($id, $from, $direction, $status, $data)
   ON CONFLICT(id) DO UPDATE SET status = $status, data = $data, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
);
export const saveJob = (job: { id: string; status: string }, fromNodeId: string, direction: string) =>
  upsertJob.run({ $id: job.id, $from: fromNodeId, $direction: direction, $status: job.status, $data: JSON.stringify(job) });

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

/** Recent jobs with their event counts, total cost and duration, newest first. */
export function recentJobs(limit = 50) {
  return db
    .query(
      `SELECT j.id, j.created_at, j.updated_at, j.direction, j.status,
              COUNT(e.id) AS events, ROUND(COALESCE(SUM(e.cost_usd), 0), 3) AS cost_usd,
              SUM(CASE WHEN e.status = 'error' THEN 1 ELSE 0 END) AS errors
       FROM jobs j LEFT JOIN events e ON e.job_id = j.id
       GROUP BY j.id ORDER BY j.created_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function jobEvents(jobId: string) {
  return db.query(`SELECT * FROM events WHERE job_id = ? ORDER BY id`).all(jobId);
}

/** Events not tied to a job (session starts, settings changes, background uploads). */
export function looseEvents(limit = 50) {
  return db.query(`SELECT * FROM events WHERE job_id IS NULL ORDER BY id DESC LIMIT ?`).all(limit);
}
