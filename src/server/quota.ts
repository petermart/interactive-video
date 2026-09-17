import { createHmac, timingSafeEqual } from "node:crypto";
import type { GuestPolicy } from "./constants";
import { db, logEvent } from "./db";

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

db.exec(`
  CREATE TABLE IF NOT EXISTS guest_usage (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,            -- 'cookie' or 'ip'
    generations INTEGER NOT NULL DEFAULT 0,
    games_completed INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS guest_usage_kind ON guest_usage(kind);
`);

const COOKIE = "sp_guest";
/** A year: the gate is about "have you played before", which should outlive a browser restart. */
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * How many times over the per-visitor allowance a single IP may go before it is treated as one person
 * cycling private windows rather than a room full of people. Deliberately generous: blocking a real
 * audience at a live demo is a far worse failure than letting one determined person have extra turns.
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

const upsert = db.prepare(
  `INSERT INTO guest_usage (id, kind) VALUES ($id, $kind)
   ON CONFLICT(id) DO UPDATE SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
);
const bump = (column: "generations" | "games_completed") =>
  db.prepare(`UPDATE guest_usage SET ${column} = ${column} + 1, last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = $id`);
const bumpGenerations = bump("generations");
const bumpGames = bump("games_completed");

type Usage = { generations: number; games_completed: number };
const readUsage = (id: string): Usage =>
  db.query<Usage, [string]>(`SELECT generations, games_completed FROM guest_usage WHERE id = ?`).get(id) ?? {
    generations: 0,
    games_completed: 0,
  };

/**
 * What one visitor gets under each policy. `null` means "no limit on this axis".
 *
 * These are counts of what is ALLOWED, and the gate falls when usage reaches the number — so "one-game" is
 * 1 (blocked once one story has been finished), not 0. Getting that backwards blocks every guest on their
 * very first move, which is the opposite of letting them play a game first.
 */
function allowanceFor(policy: GuestPolicy): { generations: number | null; games: number | null } {
  switch (policy) {
    case "unlimited":
      return { generations: null, games: null };
    case "one-game":
      // Unlimited steps within the first story; the gate falls once that story has ended.
      return { generations: null, games: 1 };
    case "one-generation":
      return { generations: 1, games: null };
    case "none":
      return { generations: 0, games: null };
  }
}

export type QuotaVerdict = {
  allowed: boolean;
  /** True when signing in is what would unblock them (as opposed to being out of credits, etc.). */
  requiresSignIn: boolean;
  reason: string;
  policy: GuestPolicy;
  used: { generations: number; games: number };
};

const ALLOWED: Omit<QuotaVerdict, "policy" | "used"> = { allowed: true, requiresSignIn: false, reason: "" };

/**
 * Decides whether this request may generate. Signed-in users are never limited here; the quota exists
 * purely to decide when to ask someone to sign in.
 */
export function checkQuota(guest: Guest, policy: GuestPolicy, signedIn: boolean): QuotaVerdict {
  const cookieUsage = readUsage(guest.cookieId);
  const used = { generations: cookieUsage.generations, games: cookieUsage.games_completed };
  if (signedIn || policy === "unlimited") return { ...ALLOWED, policy, used };

  const limit = allowanceFor(policy);
  const ipUsage = readUsage(`ip:${guest.ip}`);

  const over = (usedCount: number, ipCount: number, cap: number | null) =>
    cap !== null && (usedCount >= cap || ipCount >= (cap + 1) * IP_TOLERANCE);

  if (over(cookieUsage.generations, ipUsage.generations, limit.generations)) {
    return {
      allowed: false,
      requiresSignIn: true,
      reason:
        policy === "none"
          ? "Sign in to direct your first scene."
          : "That's your free scene. Sign in to keep directing.",
      policy,
      used,
    };
  }
  if (over(cookieUsage.games_completed, ipUsage.games_completed, limit.games)) {
    return { allowed: false, requiresSignIn: true, reason: "You've finished your free story. Sign in to start another.", policy, used };
  }
  return { ...ALLOWED, policy, used };
}

/** Counts one generated step against this guest (and their network). Signed-in users are not tracked. */
export function recordGeneration(guest: Guest, signedIn: boolean) {
  if (signedIn) return;
  for (const [id, kind] of [
    [guest.cookieId, "cookie"],
    [`ip:${guest.ip}`, "ip"],
  ] as const) {
    upsert.run({ $id: id, $kind: kind });
    bumpGenerations.run({ $id: id });
  }
}

/** Counts one finished story (escaped or caught) against this guest. */
export function recordGameCompleted(guest: Guest, signedIn: boolean) {
  if (signedIn) return;
  for (const [id, kind] of [
    [guest.cookieId, "cookie"],
    [`ip:${guest.ip}`, "ip"],
  ] as const) {
    upsert.run({ $id: id, $kind: kind });
    bumpGames.run({ $id: id });
  }
  logEvent({ kind: "job", label: "guest finished a story", response: { policy: "guest" } });
}

/** Guest-gate figures for the admin panel. */
export const quotaStats = () =>
  db
    .query<{ guests: number; generations: number | null; games: number | null }, []>(
      `SELECT COUNT(*) AS guests, SUM(generations) AS generations, SUM(games_completed) AS games
       FROM guest_usage WHERE kind = 'cookie'`,
    )
    .get();
