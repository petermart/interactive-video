import { db, tryExec, tryQuery } from "./db";

/**
 * Who plays and how much: unique players, directions and paid generations per player, reuse rate.
 *
 * A "player" is the most durable identity we have for a job: the signed-in user, else the one-year guest
 * cookie the sign-in gate already issues, else (jobs from before attribution existed) the browser-tab session.
 * Tab sessions over-count people — one person, two tabs, two "players" — so the report says how many
 * players are only known by session.
 *
 * Deliberately nothing about what anyone typed: counts only.
 */

for (const column of ["guest_id", "user_id"]) {
  try {
    db.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
  } catch {
    // column already exists
  }
}
tryExec("jobs owner index", `CREATE INDEX IF NOT EXISTS jobs_guest ON jobs(guest_id); CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id);`);

/** Records who started a job. Separate from saveJob so the pipeline stays ignorant of sign-in. */
export function tagJobOwner(jobId: string, guestId: string | null, userId: string | null) {
  db.query(`UPDATE jobs SET guest_id = ?, user_id = ? WHERE id = ?`).run(guestId, userId, jobId);
}

/** One row per job with who ran it and what it cost us, as SQL so the aggregates stay in SQLite. */
const JOBS = `
  SELECT
    CASE
      WHEN user_id IS NOT NULL THEN 'user:' || user_id
      WHEN guest_id IS NOT NULL THEN 'guest:' || guest_id
      ELSE 'session:' || COALESCE(viewer_id, id)
    END AS player,
    substr(created_at, 1, 10) AS day,
    created_at,
    CASE
      WHEN status = 'rejected' THEN 'rejected'
      WHEN status = 'error' THEN 'error'
      WHEN status != 'done' THEN 'in_progress'
      WHEN json_extract(data, '$.node.reusedFrom') IS NOT NULL THEN 'reused'
      WHEN json_extract(data, '$.node.clipUrl') IS NOT NULL THEN 'generated'
      ELSE 'text_only'
    END AS result,
    json_extract(data, '$.node.outcome') AS outcome
  FROM jobs`;

type Totals = {
  players: number;
  signedInPlayers: number;
  guestPlayers: number;
  sessionOnlyPlayers: number;
  directions: number;
  generated: number;
  reused: number;
  rejected: number;
  textOnly: number;
  errors: number;
  escapes: number;
  fails: number;
};

export function usageReport() {
  const totals = tryQuery(
    () =>
      db
        .query<Totals, []>(
          `SELECT
             COUNT(DISTINCT player) AS players,
             COUNT(DISTINCT CASE WHEN player LIKE 'user:%' THEN player END) AS signedInPlayers,
             COUNT(DISTINCT CASE WHEN player LIKE 'guest:%' THEN player END) AS guestPlayers,
             COUNT(DISTINCT CASE WHEN player LIKE 'session:%' THEN player END) AS sessionOnlyPlayers,
             COUNT(*) AS directions,
             SUM(result = 'generated') AS generated,
             SUM(result = 'reused') AS reused,
             SUM(result = 'rejected') AS rejected,
             SUM(result = 'text_only') AS textOnly,
             SUM(result = 'error') AS errors,
             SUM(outcome = 'escaped') AS escapes,
             SUM(outcome = 'fail') AS fails
           FROM (${JOBS})`,
        )
        .get(),
    null,
    "usage totals",
  );

  const perDay = tryQuery(
    () =>
      db
        .query<{ day: string; players: number; directions: number; generated: number; reused: number }, []>(
          `SELECT day, COUNT(DISTINCT player) AS players, COUNT(*) AS directions,
                  SUM(result = 'generated') AS generated, SUM(result = 'reused') AS reused
           FROM (${JOBS}) GROUP BY day ORDER BY day DESC LIMIT 30`,
        )
        .all(),
    [],
    "usage per day",
  );

  const players = tryQuery(
    () =>
      db
        .query<
          { player: string; directions: number; generated: number; reused: number; rejected: number; escapes: number; firstSeen: string; lastSeen: string },
          []
        >(
          `SELECT player, COUNT(*) AS directions,
                  SUM(result = 'generated') AS generated, SUM(result = 'reused') AS reused, SUM(result = 'rejected') AS rejected,
                  SUM(outcome = 'escaped') AS escapes, MIN(created_at) AS firstSeen, MAX(created_at) AS lastSeen
           FROM (${JOBS}) GROUP BY player ORDER BY generated DESC, directions DESC`,
        )
        .all(),
    [],
    "usage per player",
  );

  // How paid generations spread across players: are a few people doing all of it?
  const buckets = [
    { label: "0", min: 0, max: 0 },
    { label: "1", min: 1, max: 1 },
    { label: "2–3", min: 2, max: 3 },
    { label: "4–6", min: 4, max: 6 },
    { label: "7+", min: 7, max: Infinity },
  ].map(b => ({ label: b.label, players: players.filter(p => p.generated >= b.min && p.generated <= b.max).length }));

  const t = totals ?? ({} as Partial<Totals>);
  const n = t.players || 0;
  const reusePool = (t.generated ?? 0) + (t.reused ?? 0);
  return {
    since: players.reduce<string | null>((min, p) => (!min || p.firstSeen < min ? p.firstSeen : min), null),
    totals: {
      ...t,
      directionsPerPlayer: n ? (t.directions ?? 0) / n : 0,
      generationsPerPlayer: n ? (t.generated ?? 0) / n : 0,
      reuseRate: reusePool ? (t.reused ?? 0) / reusePool : 0,
    },
    perDay,
    distribution: buckets,
    // Short ids only: enough to tell rows apart, not to identify anyone.
    topPlayers: players.slice(0, 25).map(p => ({ ...p, player: shortId(p.player) })),
  };
}

const shortId = (player: string) => {
  const [kind, id] = player.split(":");
  return `${kind}:${(id ?? "").slice(0, 8)}`;
};

export type UsageReport = ReturnType<typeof usageReport>;
