/**
 * Verifies the sign-in gate: that the auth tables exist, and that each guest policy allows and blocks the
 * right things.
 *
 *   bun scripts/check-auth-quota.ts
 *
 * Runs entirely against the quota logic with synthetic guests, so it needs no browser and no OAuth app.
 */

import { db } from "../src/server/db";
import { checkQuota, recordGameCompleted, recordGeneration, type Guest } from "../src/server/quota";
import "../src/server/auth"; // importing runs the migration

const show = (label: string, ok: boolean, extra = "") => console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
let failed = false;
const check = (label: string, ok: boolean, extra = "") => {
  show(label, ok, extra);
  failed ||= !ok;
};

// --- auth schema ------------------------------------------------------------
const tables = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
check("Better Auth tables created", ["user", "session", "account", "verification"].every(t => tables.includes(t)), tables.filter(t => ["user", "session", "account", "verification"].includes(t)).join(", "));
check("guest_usage table created", tables.includes("guest_usage"));

// --- quota ------------------------------------------------------------------
let n = 0;
/** Each guest gets its own IP too, so the shared-network tolerance never clouds a single-guest test. */
const freshGuest = (): Guest => {
  n++;
  return { cookieId: `test-cookie-${n}-${crypto.randomUUID()}`, ip: `203.0.113.${n}`, issueCookie: false };
};

// unlimited: never gated
{
  const g = freshGuest();
  for (let i = 0; i < 5; i++) recordGeneration(g, false);
  check("unlimited: still allowed after 5 generations", checkQuota(g, "unlimited", false).allowed);
}

// none: blocked before the first generation
{
  const g = freshGuest();
  const v = checkQuota(g, "none", false);
  check("none: blocked immediately", !v.allowed && v.requiresSignIn, v.reason);
}

// one-generation: one through, then gated
{
  const g = freshGuest();
  check("one-generation: first is allowed", checkQuota(g, "one-generation", false).allowed);
  recordGeneration(g, false);
  const v = checkQuota(g, "one-generation", false);
  check("one-generation: second is blocked", !v.allowed && v.requiresSignIn, v.reason);
}

// one-game: unlimited steps until a story ends, then gated
{
  const g = freshGuest();
  for (let i = 0; i < 6; i++) recordGeneration(g, false);
  check("one-game: mid-story steps stay allowed", checkQuota(g, "one-game", false).allowed);
  recordGameCompleted(g, false);
  const v = checkQuota(g, "one-game", false);
  check("one-game: blocked after finishing a story", !v.allowed && v.requiresSignIn, v.reason);
}

// signing in lifts every limit
{
  const g = freshGuest();
  recordGameCompleted(g, false);
  recordGeneration(g, false);
  check("signed in: never gated, whatever the policy", ["none", "one-generation", "one-game"].every(p => checkQuota(g, p as never, true).allowed));
}

// a signed-in user's activity is not counted against a guest row
{
  const g = freshGuest();
  recordGeneration(g, true);
  check("signed-in activity is not metered", checkQuota(g, "one-generation", false).allowed);
}

// shared network: separate cookies on ONE ip each keep their own allowance
{
  const ip = "198.51.100.77";
  const a: Guest = { cookieId: `room-a-${crypto.randomUUID()}`, ip, issueCookie: false };
  const b: Guest = { cookieId: `room-b-${crypto.randomUUID()}`, ip, issueCookie: false };
  recordGeneration(a, false);
  check("shared wifi: one device's use does not block another", checkQuota(b, "one-generation", false).allowed);
}

// the same network abused repeatedly does eventually trip the IP tolerance
{
  const ip = "198.51.100.99";
  for (let i = 0; i < 20; i++) recordGeneration({ cookieId: `abuse-${i}-${crypto.randomUUID()}`, ip, issueCookie: false }, false);
  const next: Guest = { cookieId: `abuse-next-${crypto.randomUUID()}`, ip, issueCookie: false };
  check("cookie-clearing is eventually caught by the IP limit", !checkQuota(next, "one-generation", false).allowed);
}

// cleanup
db.query(`DELETE FROM guest_usage WHERE id LIKE 'test-cookie-%' OR id LIKE 'room-%' OR id LIKE 'abuse-%' OR id LIKE 'ip:203.0.113.%' OR id LIKE 'ip:198.51.100.%'`).run();

console.log(failed ? "\nSomething is wrong — see above." : "\nSign-in gate behaves.");
process.exit(failed ? 1 : 0);
