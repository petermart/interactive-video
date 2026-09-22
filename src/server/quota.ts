import { createHmac, timingSafeEqual } from "node:crypto";
import { goSize, type Allowance } from "./constants";
import { db, logEvent, tryExec, tryQuery } from "./db";

/**
 * How much an unsigned-in viewer is allowed to do, and how we decide who they are.
 *
 * Identity is a signed httpOnly cookie, with the client IP as a secondary signal. The cookie is what makes
 * shared networks work: at an in-person event everyone is behind one address, and keying the quota on IP
 * alone would let the first person through the door consume the free game for the whole room. The IP is
 * still tracked, with a much looser limit, so that clearing cookies or reopening in a private window is not
 * a free reset button.
 *
 * None of this is airtight — a VPN or a different browser defeats it — and it is not meant to be. It is a
 * soft gate that makes signing in the path of least resistance, not DRM.
 */

tryExec("guest usage", `
  CREATE TABLE IF NOT EXISTS guest_usage (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,            -- 'cookie', 'ip' or 'user'
    generations INTEGER NOT NULL DEFAULT 0,
    games_completed INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS guest_usage_kind ON guest_usage(kind);
`);
// Extra allowance earned by sharing a run, and the runs already paid out for (so one ending is worth one
// credit, however many times its share sheet is opened). Added after the table shipped.
tryExec("bonus column", `ALTER TABLE guest_usage ADD COLUMN bonus INTEGER NOT NULL DEFAULT 0`);
// When the current allowance window opened. Allowances refill on a rolling window per person, so this is
// the clock each row is measured against; null on rows that predate it, which fall back to first_seen.
tryExec("window column", `ALTER TABLE guest_usage ADD COLUMN window_start TEXT`);
// Bought credits. Kept apart from the free counters because they never expire: reopen() leaves them alone
// when an allowance window turns over. A bought game is taken from paid_games when its first paid step
// starts, and paid_game_open then lets the rest of that story through until it ends.
tryExec("paid generations column", `ALTER TABLE guest_usage ADD COLUMN paid_generations INTEGER NOT NULL DEFAULT 0`);
tryExec("paid games column", `ALTER TABLE guest_usage ADD COLUMN paid_games INTEGER NOT NULL DEFAULT 0`);
tryExec("paid game open column", `ALTER TABLE guest_usage ADD COLUMN paid_game_open INTEGER NOT NULL DEFAULT 0`);
// One row per completed Stripe checkout. The session id is the key, so a webhook Stripe retries is paid once.
tryExec("purchases", `
  CREATE TABLE IF NOT EXISTS purchases (
    session_id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL,
    unit TEXT NOT NULL,            -- 'generations' or 'games'
    units INTEGER NOT NULL,
    amount_cents INTEGER,
    currency TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);
tryExec("share credits", `
  CREATE TABLE IF NOT EXISTS share_credits (
    id TEXT PRIMARY KEY,           -- '<identity>:<nodeId>'
    granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

const COOKIE = "sp_guest";
/** A year: the gate is about "have you played before", which should outlive a browser restart. */
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * The default for how many times over the per-visitor allowance a single IP may go before it is treated as
 * one person cycling private windows rather than a room full of people (an admin setting). Deliberately
 * generous: blocking a real audience at a live demo is a far worse failure than letting one determined
 * person have extra turns.
 */
const IP_TOLERANCE = 5;

/**
 * Signing secret. Set AUTH_SECRET in deployment; without it the cookie is still signed, but the key changes
 * on restart, which simply means existing guest cookies stop validating and those visitors look new.
 */
const SECRET = process.env.AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET ?? crypto.randomUUID();

const sign = (value: string) => createHmac("sha256", SECRET).update(value).digest("base64url");

/** `<uuid>.<signature>`, so a guest cannot hand themselves someone else's id or invent a fresh one cheaply. */
function readSignedCookie(header: string | null): string | null {
  const raw = header
    ?.split(";")
    .map(c => c.trim())
    .find(c => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [value, signature] = decodeURIComponent(raw).split(".");
  if (!value || !signature) return null;
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return value;
}

export const guestCookie = (value: string) =>
  `${COOKIE}=${encodeURIComponent(`${value}.${sign(value)}`)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`;

/**
 * The client's real address. Railway (like any proxy) terminates the connection itself, so the socket
 * address is the proxy — the original client is the leftmost entry of X-Forwarded-For.
 */
export function clientIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
}

export type Guest = {
  /** Stable id for this browser. */
  cookieId: string;
  ip: string;
  /** Set when the caller must attach a Set-Cookie header (the guest had no valid cookie). */
  issueCookie: boolean;
};

export function identifyGuest(req: Request): Guest {
  const existing = readSignedCookie(req.headers.get("cookie"));
  return { cookieId: existing ?? crypto.randomUUID(), ip: clientIp(req), issueCookie: !existing };
}

/** Prepared lazily: preparing against a table that does not exist throws, which at import time is fatal. */
const cache = new Map<string, ReturnType<typeof db.prepare>>();
const prepared = (key: string, sql: string) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const stmt = db.prepare(sql);
  cache.set(key, stmt);
  return stmt;
};
const upsert = () =>
  prepared("upsert", `INSERT INTO guest_usage (id, kind) VALUES ($id, $kind)
   ON CONFLICT(id) DO UPDATE SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
const bump = (column: "generations" | "games_completed" | "bonus") =>
  prepared(column, `UPDATE guest_usage SET ${column} = ${column} + 1, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $id`);

/** Wipes a row's counters and starts its window now. Used when the previous window has run out. */
const reopen = () =>
  prepared(
    "reopen",
    `UPDATE guest_usage SET generations = 0, games_completed = 0, bonus = 0,
      window_start = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = $id`,
  );

type Row = {
  generations: number;
  games_completed: number;
  bonus: number;
  window_start: string | null;
  first_seen: string;
  paid_generations: number;
  paid_games: number;
  paid_game_open: number;
};
const NO_ROW: Row = {
  generations: 0,
  games_completed: 0,
  bonus: 0,
  window_start: null,
  first_seen: new Date().toISOString(),
  paid_generations: 0,
  paid_games: 0,
  paid_game_open: 0,
};
/** A missing table reads as "no usage yet": viewers are let through rather than blocked by a broken ledger. */
const readRow = (id: string): Row =>
  tryQuery(
    () =>
      db
        .query<Row, [string]>(
          `SELECT generations, games_completed, bonus, window_start, first_seen, paid_generations, paid_games, paid_game_open
           FROM guest_usage WHERE id = ?`,
        )
        .get(id),
    null,
    "usage",
  ) ?? NO_ROW;

const DAY = 24 * 60 * 60 * 1000;

export type Usage = { generations: number; games_completed: number; bonus: number; expired: boolean; resetsAt: string | null };

/**
 * A row read through its allowance window. Past the window the slate is clean, and the row itself is only
 * rewritten when the viewer next does something - a lazy reset, so nothing has to sweep the table.
 */
function windowed(row: Row, resetDays: number): Usage {
  const clean = { generations: row.generations, games_completed: row.games_completed, bonus: row.bonus };
  if (!resetDays) return { ...clean, expired: false, resetsAt: null };
  const started = Date.parse(row.window_start ?? row.first_seen);
  const ends = (Number.isFinite(started) ? started : Date.now()) + resetDays * DAY;
  if (Date.now() >= ends) return { generations: 0, games_completed: 0, bonus: 0, expired: true, resetsAt: null };
  return { ...clean, expired: false, resetsAt: new Date(ends).toISOString() };
}

const readUsage = (id: string, resetDays: number) => windowed(readRow(id), resetDays);

/**
 * Who is being measured. A signed-in member is counted against their account, a guest against their cookie
 * (and, loosely, their network). `signedIn` is derived rather than passed so the two can never disagree.
 */
export type Viewer = { guest: Guest; userId: string | null };
export const viewerIsMember = (v: Viewer) => Boolean(v.userId);

/** The ledger row this viewer is counted against: their account if signed in, else their guest cookie. */
function ledgerOf(v: Viewer): { id: string; kind: "cookie" | "user" } {
  return v.userId ? { id: `user:${v.userId}`, kind: "user" } : { id: v.guest.cookieId, kind: "cookie" };
}

export type QuotaVerdict = {
  allowed: boolean;
  /** True when signing in is what would unblock them, as opposed to having used up a member allowance. */
  requiresSignIn: boolean;
  reason: string;
  allowance: Allowance;
  used: { generations: number; games: number };
  /** Goes earned by sharing (each worth a whole game, or a whole allowance of steps). */
  bonus: number;
  /** What is left on the active axis; null when unlimited. */
  remaining: number | null;
  /** When this allowance refills; null when it never does, or when nothing has been used yet. */
  resetsAt: string | null;
  /** Bought credits left. `gameOpen` is a bought game that has started and not yet ended. */
  paid: { generations: number; games: number; gameOpen: boolean };
  /** The free allowance is spent and this step would be taken from bought credits. */
  usesPaid: boolean;
};

const paidOf = (row: Row) => ({ generations: row.paid_generations, games: row.paid_games, gameOpen: row.paid_game_open > 0 });
const hasPaid = (p: QuotaVerdict["paid"]) => p.gameOpen || p.generations > 0 || p.games > 0;

/**
 * Decides whether this viewer may generate, against the allowance for their side of the sign-in line.
 *
 * Games and generations are alternatives: in "games" mode a story can run as long as it likes and the gate
 * falls only once it has ended, so the generation number is not consulted at all. Counts are what is
 * ALLOWED, and the gate falls when usage reaches the number - 1 game means blocked after one ending, not
 * before the first move.
 */
export function checkQuota(viewer: Viewer, allowance: Allowance, memberAllowance?: Allowance, networkTolerance = IP_TOLERANCE): QuotaVerdict {
  const member = viewerIsMember(viewer);
  const row = readRow(ledgerOf(viewer).id);
  const usage = windowed(row, allowance.resetDays);
  const used = { generations: usage.generations, games: usage.games_completed };
  const paid = paidOf(row);
  const base = { allowance, used, bonus: usage.bonus, resetsAt: usage.resetsAt, paid, usesPaid: false };

  if (allowance.mode === "unlimited") return { allowed: true, requiresSignIn: false, reason: "", remaining: null, ...base };

  const games = allowance.mode === "games";
  // Each earned go is worth a whole game, or a whole allowance of steps - never a single step.
  const cap = allowance.count + usage.bonus * goSize(allowance);
  const spent = games ? usage.games_completed : usage.generations;
  // A guest can also be caught by their network's much looser limit: cookies are cheap to clear. 0 = no limit.
  const networkSpent = member || !networkTolerance ? 0 : (() => {
    const ip = readUsage(`ip:${viewer.guest.ip}`, allowance.resetDays);
    return games ? ip.games_completed : ip.generations;
  })();
  const blocked = spent >= cap || (networkTolerance > 0 && networkSpent >= (cap + 1) * networkTolerance);
  const remaining = Math.max(0, cap - spent);
  if (!blocked) return { allowed: true, requiresSignIn: false, reason: "", remaining, ...base };
  // Past the free allowance, bought credits carry on where it stopped.
  if (hasPaid(paid)) return { allowed: true, requiresSignIn: false, reason: "", remaining: 0, ...base, usesPaid: true };

  /**
   * Whether signing in would actually unblock them. It usually would, and not only when members are allowed
   * more: an account is a fresh ledger, so a guest who has spent their free story starts a signed-in one at
   * zero. The only case where the offer would be a lie is a member allowance of nothing at all.
   */
  const signInHelps = !member && (!memberAllowance || memberAllowance.mode === "unlimited" || memberAllowance.count > 0);
  const unit = games ? "story" : "scene";
  const units = games ? "stories" : "scenes";
  const spentIt = allowance.count === 1 ? `That's your ${member ? "" : "free "}${unit} for now.` : `That's all ${allowance.count} of your ${units} for now.`;
  // Nothing at all allowed is a different situation from having used what you were given, and saying
  // "paused" to someone who simply spent their go would be a lie they can check against the clock.
  // Kept to one short line: the gate's own copy makes the case underneath it, and a two-sentence headline
  // wrapped to three lines on a phone.
  const reason = cap === 0 ? (signInHelps ? `Sign in to direct your first ${unit}.` : "Generating is paused for now.")
    : signInHelps ? `That's your free ${unit}.`
    : spentIt;

  return { allowed: false, requiresSignIn: signInHelps, reason, remaining: 0, ...base };
}

/**
 * Counts one generated step against this viewer (and, for a guest, their network). Pass the verdict that let
 * the step through: when it was paid for, a bought credit is taken too - an open bought game first, then a
 * bought generation, then a new bought game.
 */
export function recordGeneration(viewer: Viewer, allowance: Allowance, verdict?: Pick<QuotaVerdict, "usesPaid">) {
  record(viewer, "generations", allowance.resetDays);
  if (!verdict?.usesPaid) return;
  tryQuery(
    () =>
      db
        .query(
          `UPDATE guest_usage SET
             paid_generations = CASE WHEN paid_game_open = 0 AND paid_generations > 0 THEN paid_generations - 1 ELSE paid_generations END,
             paid_games = CASE WHEN paid_game_open = 0 AND paid_generations = 0 AND paid_games > 0 THEN paid_games - 1 ELSE paid_games END,
             paid_game_open = CASE WHEN paid_game_open = 0 AND paid_generations = 0 AND paid_games > 0 THEN 1 ELSE paid_game_open END
           WHERE id = ?`,
        )
        .run(ledgerOf(viewer).id),
    null,
    "spend paid credit",
  );
}

/** Counts one finished story (escaped or caught) against this viewer, closing any bought game it was. */
export function recordGameCompleted(viewer: Viewer, allowance: Allowance) {
  record(viewer, "games_completed", allowance.resetDays);
  tryQuery(() => db.query(`UPDATE guest_usage SET paid_game_open = 0 WHERE id = ?`).run(ledgerOf(viewer).id), null, "close paid game");
  logEvent({ kind: "job", label: "story finished", response: { member: viewerIsMember(viewer) } });
}

/** Makes sure a row exists and its window is current, so a count lands in the right window. */
function touch(id: string, kind: "cookie" | "user" | "ip", resetDays: number) {
  upsert().run({ $id: id, $kind: kind });
  if (windowed(readRow(id), resetDays).expired) reopen().run({ $id: id });
}

function record(viewer: Viewer, column: "generations" | "games_completed", resetDays: number) {
  const rows: { id: string; kind: "cookie" | "user" | "ip" }[] = [ledgerOf(viewer)];
  // A guest's network is tracked too, so clearing cookies is not a reset button. Members are not.
  if (!viewerIsMember(viewer)) rows.push({ id: `ip:${viewer.guest.ip}`, kind: "ip" });
  for (const { id, kind } of rows) {
    tryQuery(() => {
      touch(id, kind, resetDays);
      bump(column).run({ $id: id });
    }, null, `record ${column}`);
  }
}

/**
 * Pays out the "share your run for another go" offer: one credit per finished run, up to `max` per allowance
 * window. Returns false when this run has already been paid for, so reopening the share sheet earns nothing,
 * or when the window's credits are used up, so sharing run after run is not an endless supply.
 */
export function grantShareCredit(viewer: Viewer, nodeId: string, allowance: Allowance, max: number) {
  const { id: ledgerId, kind } = ledgerOf(viewer);
  const key = `${ledgerId}:${nodeId}`;
  return (
    tryQuery(
      () => {
        if (max <= 0) return false;
        const claimed = db.query(`SELECT 1 FROM share_credits WHERE id = ?`).get(key);
        if (claimed) return false;
        // Touch first: a credit earned after the window turned over belongs to the new window, not the old.
        touch(ledgerId, kind, allowance.resetDays);
        if (readUsage(ledgerId, allowance.resetDays).bonus >= max) return false;
        db.query(`INSERT INTO share_credits (id) VALUES (?)`).run(key);
        bump("bonus").run({ $id: ledgerId });
        logEvent({ kind: "job", label: "share earned another game", response: { member: viewerIsMember(viewer) } });
        return true;
      },
      false,
      "share credit",
    ) ?? false
  );
}

/** The ledger a signed-in account's purchases are credited to. Purchases need an account: a cookie can be lost. */
export const memberLedgerId = (userId: string) => `user:${userId}`;

/**
 * Credits a completed Stripe checkout. Returns false when this session has already been credited, which is
 * how a webhook Stripe delivers twice (it retries until it gets a 2xx) is paid for once.
 */
export function creditPurchase(p: {
  sessionId: string;
  ledgerId: string;
  unit: "generations" | "games";
  units: number;
  amountCents: number | null;
  currency: string | null;
}) {
  const column = p.unit === "games" ? "paid_games" : "paid_generations";
  return db.transaction(() => {
    const inserted = db
      .query(`INSERT OR IGNORE INTO purchases (session_id, ledger_id, unit, units, amount_cents, currency) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.sessionId, p.ledgerId, p.unit, p.units, p.amountCents, p.currency);
    if (!inserted.changes) return false;
    upsert().run({ $id: p.ledgerId, $kind: p.ledgerId.startsWith("user:") ? "user" : "cookie" });
    db.query(`UPDATE guest_usage SET ${column} = ${column} + ? WHERE id = ?`).run(p.units, p.ledgerId);
    logEvent({ kind: "job", label: `purchase: ${p.units} ${p.unit}`, response: { amountCents: p.amountCents, currency: p.currency } });
    return true;
  })();
}

/** Sales figures for the admin panel. */
export const purchaseStats = () =>
  tryQuery(
    () =>
      db
        .query<{ purchases: number; revenue_cents: number | null; buyers: number }, []>(
          `SELECT COUNT(*) AS purchases, SUM(amount_cents) AS revenue_cents, COUNT(DISTINCT ledger_id) AS buyers FROM purchases`,
        )
        .get(),
    null,
    "purchase stats",
  );

/** Guest-gate figures for the admin panel. */
export const quotaStats = () =>
  tryQuery(() => db
    .query<{ guests: number; generations: number | null; games: number | null }, []>(
      `SELECT COUNT(*) AS guests, SUM(generations) AS generations, SUM(games_completed) AS games
       FROM guest_usage WHERE kind = 'cookie'`,
    )
    .get(), null, "quota stats");
