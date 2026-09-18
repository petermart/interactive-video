import { rmSync } from "node:fs";
import { mediaPath } from "./config";
import { db, logEvent } from "./db";
import { scheduleArchiveBackup } from "./archiveBackup";
import { chatJSON } from "./gmi";
import type { Outcome } from "./pipeline";
import { deleteObject, isGeneratedUrl, keyForMediaUrl, r2Enabled } from "./storage";

/**
 * Reusable library of already-generated clips, keyed by the environment a viewer is standing in and the
 * action they typed. A later viewer who tries the same idea in the same place gets the saved clip instead
 * of a paid generation: candidates are shortlisted by keyword overlap, then a lite Gemma call decides
 * whether the two actions really mean the same thing.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS action_clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    environment_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    direction TEXT NOT NULL,
    keywords TEXT NOT NULL,
    summary TEXT NOT NULL,
    shot_prompt TEXT NOT NULL,
    to_environment_id TEXT NOT NULL,
    fail_type TEXT,
    clip_url TEXT NOT NULL,
    last_frame_file TEXT,
    provider TEXT NOT NULL,
    cost_usd REAL,
    uses INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS action_clips_lookup ON action_clips(environment_id, outcome);
`);
try {
  db.exec(`ALTER TABLE action_clips ADD COLUMN intent_key TEXT`);
} catch {
  // column already exists
}
try {
  db.exec(`ALTER TABLE action_clips ADD COLUMN rejection_reason TEXT`);
} catch {
  // column already exists
}
// Who was on screen (JSON array of character ids), so an admin can regenerate a clip with the same references.
try {
  db.exec(`ALTER TABLE action_clips ADD COLUMN character_ids TEXT`);
} catch {
  // column already exists
}
db.exec(`CREATE INDEX IF NOT EXISTS action_clips_intent ON action_clips(environment_id, outcome, intent_key)`);
db.exec(`CREATE INDEX IF NOT EXISTS action_clips_env ON action_clips(environment_id)`);

/**
 * Keeps the archive from growing without bound: most-reused clips per location survive.
 * At 50 across the world's locations this is roughly 2GB of stored clips, well inside the R2 free tier.
 */
const MAX_PER_LOCATION = 50;
/** Past this many clips in one location, a weak word score means a genuinely new idea, so skip the Gemma sweep. */
const FALLBACK_ARCHIVE_LIMIT = 40;
/** Longest the Gemma match may take before the lookup counts as a miss (typical: ~2.6s). */
const MATCH_TIMEOUT_MS = 4000;

/** Canonical form of an intent key, so small wording differences can't split the same key. */
const normalizeIntent = (key: string | undefined) =>
  (key ?? "")
    .toLowerCase()
    .split(":")
    .map(part =>
      part
        .trim()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean)
    .join(":");

/** Words too common to say anything about what the viewer is attempting. */
const STOP = new Set(
  `a an and the to at in on of for with his her its my your their into onto out off up down then than that this those
   these is are was were be being been do does did doing go goes going get gets got try tries trying use uses using
   make makes making take takes taking sloppy joe larry he him himself i we you it there here now just very really so as by from
   over under after before while when if but or not no yes can could should would will shall may might must`
    .split(/\s+/)
    .filter(Boolean),
);

/** Lowercased, de-duplicated content words; crude singularisation so "guards" matches "guard". */
export function keywordsOf(text: string) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
    .map(w =>
      w.endsWith("ies")
        ? `${w.slice(0, -3)}y`
        : w.endsWith("es") && w.length > 4
          ? w.slice(0, -2)
          : w.endsWith("s") && !w.endsWith("ss")
            ? w.slice(0, -1)
            : w,
    );
  return [...new Set(words)];
}

/** Jaccard overlap of two keyword sets: 1 = identical wording, 0 = nothing in common. */
function similarity(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const B = new Set(b);
  const shared = a.filter(w => B.has(w)).length;
  return shared / (a.length + b.length - shared);
}

export type CachedClip = {
  id: number;
  direction: string;
  outcome: Outcome | "rejected";
  rejection_reason: string | null;
  summary: string;
  shot_prompt: string;
  to_environment_id: string;
  fail_type: string | null;
  clip_url: string;
  last_frame_file: string | null;
  provider: string;
  keywords: string;
  uses: number;
};

/** Shortlist: same place, same outcome, ranked by how many content words the two actions share. */
const COLUMNS = `id, direction, outcome, rejection_reason, summary, shot_prompt, to_environment_id, fail_type,
                 clip_url, last_frame_file, provider, keywords, uses`;

/** Everything archived for one location: all outcomes, including actions that were rejected outright. */
function archived(environmentId: string) {
  return db
    .query<CachedClip, [string]>(`SELECT ${COLUMNS} FROM action_clips WHERE environment_id = ? ORDER BY uses DESC, id DESC LIMIT 200`)
    .all(environmentId);
}

/** Same place, same outcome, ranked by shared content words. */
function shortlist(rows: CachedClip[], keywords: string[], limit = 5) {
  return rows
    .map(row => ({ row, score: similarity(keywords, row.keywords.split(",")) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Wording this close is the same action; no need to spend an LLM call confirming it. */
const CERTAIN_MATCH = 0.75;
/** Below this, wording alone is not evidence; Gemma decides instead. */
const WORTH_CHECKING = 0.15;
/**
 * Synonyms ("faking a seizure" vs "pretend to have a heart attack") share no words, so when nothing scores
 * well we still show Gemma the most-used clips from this location. One lite call (~$0.0005) is far cheaper
 * than re-generating a clip (~$0.75).
 */
const FALLBACK_CANDIDATES = 6;

const MATCH_SYSTEM = `You decide whether a viewer's action in an interactive prison-escape film has already been filmed.
You are given the NEW action and a numbered list of PAST actions attempted in the SAME location.
Judge the attempt itself, never how it turned out: the past action's result is not part of the comparison.

Answer with the number of a past action when it describes essentially the same attempt: the same method, the same tool
(or an obvious synonym for it, e.g. spoon / cutlery), the same target, and the same resulting move. Wording, verb choice
and extra detail do not matter. Different tools, different targets, different people or a different route are NOT matches.
When nothing matches, answer null.

Respond with JSON only: {"match": number|null, "why": string}`;

/**
 * Finds a saved clip for this action, or null. Keyword overlap shortlists; Gemma confirms the meaning.
 * Only runs an LLM call when the wording is close enough to be plausible but not already obviously identical.
 */
/** Exact intent-key hit for this location, if the caller already knows the key (LLM 1 has run). */
export function findByIntent(environmentId: string, intentKey: string | undefined) {
  const intent = normalizeIntent(intentKey);
  if (!intent) return null;
  const row = db
    .query<CachedClip, [string, string]>(
      `SELECT ${COLUMNS} FROM action_clips WHERE environment_id = ? AND intent_key = ? ORDER BY uses DESC LIMIT 1`,
    )
    .get(environmentId, intent);
  if (row) logEvent({ kind: "decision", label: "action cache hit (intent key)", request: { intent }, response: row.direction });
  return row ?? null;
}

/**
 * Looks for this action in the location's archive WITHOUT knowing its outcome yet, so a hit also supplies the
 * verdict (allowed/rejected, success/fail), the destination and the clip: both LLM calls can then be skipped.
 */
export async function findReusableClip(opts: {
  environmentId: string;
  direction: string;
  intentKey?: string;
  model: string;
  liveLLM: boolean;
}) {
  const byIntent = findByIntent(opts.environmentId, opts.intentKey);
  if (byIntent) return byIntent;

  const keywords = keywordsOf(opts.direction);
  const rows = archived(opts.environmentId);
  if (!rows.length) return null;
  const candidates = shortlist(rows, keywords);

  const best = candidates[0]!;
  if (best.score >= CERTAIN_MATCH) {
    logEvent({
      kind: "decision",
      label: "action cache hit (wording)",
      request: { direction: opts.direction, score: +best.score.toFixed(2) },
      response: best.row.direction,
    });
    return best.row;
  }

  if (!opts.liveLLM) return null;
  // Word overlap first; when nothing looks close, hand Gemma this location's archive anyway.
  const plausible = candidates.filter(c => c.score >= WORTH_CHECKING);
  const sweep = rows.length <= FALLBACK_ARCHIVE_LIMIT ? candidates.slice(0, FALLBACK_CANDIDATES) : [];
  const toCheck = plausible.length ? plausible : sweep;
  if (!toCheck.length) return null;

  const user = JSON.stringify({
    newAction: opts.direction,
    location: opts.environmentId,
    pastActions: toCheck.map((c, i) => ({ number: i + 1, action: c.row.direction })),
  });
  // Bounded: this runs alongside LLM 1 and a slow answer (one took 16s) would hold the whole step. Past the
  // limit it counts as a miss, which only costs a generation we would have paid for anyway.
  const timeout = new Promise<{ match: null; why: string }>(resolve =>
    setTimeout(() => resolve({ match: null, why: `timed out after ${MATCH_TIMEOUT_MS / 1000}s` }), MATCH_TIMEOUT_MS),
  );
  const verdict = await Promise.race([
    chatJSON<{ match: number | null; why: string }>(opts.model, MATCH_SYSTEM, user, "Action cache match"),
    timeout,
  ]).catch(err => {
    logEvent({ kind: "error", label: "action cache match failed", status: "error", response: String(err) });
    return { match: null, why: "" };
  });
  const picked = verdict.match ? toCheck[verdict.match - 1] : undefined;
  logEvent({
    kind: "decision",
    label: picked ? "action cache hit (Gemma)" : "action cache miss",
    request: { direction: opts.direction, candidates: toCheck.map(c => ({ action: c.row.direction, score: +c.score.toFixed(2) })) },
    response: { match: picked?.row.direction ?? null, why: verdict.why },
  });
  return picked?.row ?? null;
}

const insert = db.prepare(
  `INSERT INTO action_clips (environment_id, outcome, direction, intent_key, keywords, summary, shot_prompt, to_environment_id, fail_type, clip_url, last_frame_file, provider, cost_usd, rejection_reason, character_ids)
   VALUES ($env, $outcome, $direction, $intent, $keywords, $summary, $shot, $to_env, $fail, $clip, $frame, $provider, $cost, $reason, $chars)`,
);

/** Saves a freshly generated clip so the next viewer attempting the same thing here reuses it. */
export function rememberClip(c: {
  environmentId: string;
  outcome: Outcome | "rejected";
  direction: string;
  intentKey?: string;
  summary: string;
  shotPrompt: string;
  toEnvironmentId: string;
  failType?: string | null;
  clipUrl: string;
  lastFrameFile?: string | null;
  provider: string;
  costUsd?: number;
  rejectionReason?: string | null;
  characterIds?: string[];
}) {
  insert.run({
    $env: c.environmentId,
    $outcome: c.outcome,
    $direction: c.direction,
    $intent: normalizeIntent(c.intentKey) || null,
    $keywords: keywordsOf(c.direction).join(","),
    $summary: c.summary,
    $shot: c.shotPrompt,
    $to_env: c.toEnvironmentId,
    $fail: c.failType ?? null,
    $clip: c.clipUrl,
    $reason: c.rejectionReason ?? null,
    $frame: c.lastFrameFile ?? null,
    $provider: c.provider,
    $cost: c.costUsd ?? null,
    $chars: c.characterIds?.length ? JSON.stringify(c.characterIds) : null,
  });
  prune(c.environmentId, c.outcome);
  scheduleArchiveBackup();
  logEvent({
    kind: "job",
    label: "action clip saved for reuse",
    response: { environment: c.environmentId, outcome: c.outcome, direction: c.direction, intent: normalizeIntent(c.intentKey) },
  });
}

/**
 * Drops the least-used clips once a location exceeds the cap, deleting the stored video along with the row.
 *
 * This used to delete rows only, which leaked every pruned clip: the file stayed in storage with nothing
 * left pointing at it, and on the deploy volume that eventually filled the disk and broke generation.
 */
function prune(environmentId: string, outcome: Outcome | "rejected") {
  const doomed = db
    .query<{ id: number; clip_url: string }, [string, string, number]>(
      `SELECT id, clip_url FROM action_clips WHERE environment_id = ? AND outcome = ?
       ORDER BY uses DESC, id DESC LIMIT -1 OFFSET ?`,
    )
    .all(environmentId, outcome, MAX_PER_LOCATION);
  if (!doomed.length) return;

  db.query(`DELETE FROM action_clips WHERE id IN (${doomed.map(() => "?").join(",")})`).run(...doomed.map(d => d.id));

  // Reclaim the storage the rows were holding. A clip shared by another row is left alone.
  for (const { clip_url } of doomed) {
    const stillReferenced = db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM action_clips WHERE clip_url = ?`).get(clip_url);
    if (stillReferenced && stillReferenced.n > 0) continue;
    void discardClip(clip_url);
  }
  logEvent({ kind: "job", label: `archive pruned (${doomed.length})`, response: { environmentId, outcome, keep: MAX_PER_LOCATION } });
}

// ---------- Admin: browse, delete and replace archived clips ----------

export type ArchiveRow = {
  id: number;
  created_at: string;
  environment_id: string;
  outcome: Outcome | "rejected";
  direction: string;
  intent_key: string | null;
  summary: string;
  shot_prompt: string;
  to_environment_id: string;
  fail_type: string | null;
  clip_url: string;
  last_frame_file: string | null;
  provider: string;
  cost_usd: number | null;
  uses: number;
  rejection_reason: string | null;
  character_ids: string | null;
};

const ADMIN_COLUMNS = `id, created_at, environment_id, outcome, direction, intent_key, summary, shot_prompt, to_environment_id,
  fail_type, clip_url, last_frame_file, provider, cost_usd, uses, rejection_reason, character_ids`;

/** Every archived action, newest first. */
export const listArchive = () => db.query<ArchiveRow, []>(`SELECT ${ADMIN_COLUMNS} FROM action_clips ORDER BY id DESC`).all();

export const getArchived = (id: number) => db.query<ArchiveRow, [number]>(`SELECT ${ADMIN_COLUMNS} FROM action_clips WHERE id = ?`).get(id);

/** Deletes a clip's stored video, unless another archive row still points at the same file. */
function releaseClip(clipUrl: string) {
  if (!clipUrl) return;
  const n = db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM action_clips WHERE clip_url = ?`).get(clipUrl)?.n ?? 0;
  if (n === 0) void discardClip(clipUrl);
}

/** Removes an archived action, and its video with it. Returns false when there was no such row. */
export function deleteArchived(id: number) {
  const row = getArchived(id);
  if (!row) return false;
  db.query(`DELETE FROM action_clips WHERE id = ?`).run(id);
  releaseClip(row.clip_url);
  scheduleArchiveBackup();
  logEvent({ kind: "job", label: "archive entry deleted (admin)", response: { id, direction: row.direction, clipUrl: row.clip_url } });
  return true;
}

export type ArchiveEdit = Partial<{
  outcome: ArchiveRow["outcome"];
  fail_type: "redetained" | "dead" | null;
  to_environment_id: string;
  summary: string;
  shot_prompt: string;
  rejection_reason: string | null;
}>;

const OUTCOMES = new Set(["success", "escaped", "fail", "rejected"]);

/**
 * Hand-edits an archived action: what the next player who tries it will be told happened, and the shot list a
 * regeneration will film. Validates every field and returns the updated row, or an error string.
 */
export function updateArchived(id: number, edit: ArchiveEdit, knownEnvironments: string[]): ArchiveRow | string {
  const row = getArchived(id);
  if (!row) return "No such archive entry";
  const next = { ...row };
  if (edit.outcome !== undefined) {
    if (!OUTCOMES.has(edit.outcome)) return "Unknown outcome";
    next.outcome = edit.outcome;
  }
  if (edit.fail_type !== undefined) {
    if (edit.fail_type !== null && edit.fail_type !== "redetained" && edit.fail_type !== "dead") return "Fail type must be redetained or dead";
    next.fail_type = edit.fail_type;
  }
  if (next.outcome !== "fail") next.fail_type = null;
  else if (!next.fail_type) next.fail_type = "redetained";
  if (edit.to_environment_id !== undefined) {
    if (!knownEnvironments.includes(edit.to_environment_id)) return "Unknown location";
    next.to_environment_id = edit.to_environment_id;
  }
  for (const [field, max] of [["summary", 2000], ["shot_prompt", 7000], ["rejection_reason", 1000]] as const) {
    const value = edit[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") return `${field} must be text`;
    if ((value ?? "").length > max) return `${field} is too long (max ${max} characters)`;
    (next as Record<string, unknown>)[field] = value === null ? null : value.trim();
  }
  db.query(
    `UPDATE action_clips SET outcome = ?, fail_type = ?, to_environment_id = ?, summary = ?, shot_prompt = ?, rejection_reason = ? WHERE id = ?`,
  ).run(next.outcome, next.fail_type, next.to_environment_id, next.summary, next.shot_prompt, next.rejection_reason, id);
  scheduleArchiveBackup();
  logEvent({ kind: "job", label: "archive entry edited (admin)", response: { id, fields: Object.keys(edit) } });
  return getArchived(id)!;
}

/** Points an archived action at a newly generated clip, deleting the old video once nothing refers to it. */
export function replaceArchivedClip(id: number, c: { clipUrl: string; lastFrameFile: string | null; provider: string; costUsd?: number }) {
  const row = getArchived(id);
  if (!row) return false;
  db.query(`UPDATE action_clips SET clip_url = ?, last_frame_file = ?, provider = ?, cost_usd = ? WHERE id = ?`).run(
    c.clipUrl,
    c.lastFrameFile,
    c.provider,
    c.costUsd ?? null,
    id,
  );
  if (row.clip_url !== c.clipUrl) releaseClip(row.clip_url);
  scheduleArchiveBackup();
  logEvent({ kind: "job", label: "archive clip regenerated (admin)", response: { id, provider: c.provider, old: row.clip_url, new: c.clipUrl } });
  return true;
}

/** Removes one clip's bytes from wherever it is kept: R2 in deployment, the cache directory locally. */
async function discardClip(clipUrl: string) {
  try {
    if (r2Enabled() && isGeneratedUrl(clipUrl)) {
      const key = keyForMediaUrl(clipUrl);
      if (key) await deleteObject(key);
      return;
    }
    const local = mediaPath(clipUrl);
    if (local) rmSync(local, { force: true });
  } catch (err) {
    logEvent({ kind: "error", label: "pruned clip could not be deleted", status: "error", response: { clipUrl, error: String(err) } });
  }
}

export const markClipUsed = (id: number) => {
  db.query(`UPDATE action_clips SET uses = uses + 1 WHERE id = ?`).run(id);
  scheduleArchiveBackup(); // use counts decide what pruning keeps, so they are worth preserving too
};

/** Library stats for the admin panel. */
export const libraryStats = () =>
  db
    .query<{ clips: number; reuses: number; saved_usd: number | null }, []>(
      `SELECT COUNT(*) AS clips, COALESCE(SUM(uses), 0) AS reuses, ROUND(SUM(uses * COALESCE(cost_usd, 0)), 2) AS saved_usd FROM action_clips`,
    )
    .get();
