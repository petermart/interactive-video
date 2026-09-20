/**
 * Verifies the sign-in gate: that the auth tables exist, and that guest and member allowances allow and
 * block the right things.
 *
 *   bun scripts/check-auth-quota.ts
 *
 * Runs entirely against the quota logic with synthetic viewers, so it needs no browser and no OAuth app.
 */

import type { Allowance } from "../src/server/constants";
import { db } from "../src/server/db";
import { checkQuota, grantShareCredit, recordGameCompleted, recordGeneration, type Guest, type Viewer } from "../src/server/quota";
import "../src/server/auth"; // importing runs the migration

const show = (label: string, ok: boolean, extra = "") => console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
let failed = false;
const check = (label: string, ok: boolean, extra = "") => {
  show(label, ok, extra);
  failed ||= !ok;
};

const UNLIMITED: Allowance = { mode: "unlimited", count: 0, resetDays: 0 };
const games = (count: number, resetDays = 0): Allowance => ({ mode: "games", count, resetDays });
const steps = (count: number, resetDays = 0): Allowance => ({ mode: "generations", count, resetDays });

// --- auth schema ------------------------------------------------------------
const tables = db.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
check("Better Auth tables created", ["user", "session", "account", "verification"].every(t => tables.includes(t)), tables.filter(t => ["user", "session", "account", "verification"].includes(t)).join(", "));
check("guest_usage table created", tables.includes("guest_usage"));
check("share_credits table created", tables.includes("share_credits"));

// --- viewers ----------------------------------------------------------------
let n = 0;
/** Each guest gets its own IP too, so the shared-network tolerance never clouds a single-guest test. */
const freshGuest = (): Viewer => {
  n++;
  return { guest: { cookieId: `test-cookie-${n}-${crypto.randomUUID()}`, ip: `203.0.113.${n}`, issueCookie: false }, userId: null };
};
const freshMember = (): Viewer => ({ ...freshGuest(), userId: `test-user-${crypto.randomUUID()}` });

// unlimited: never gated
{
  const v = freshGuest();
  for (let i = 0; i < 5; i++) recordGeneration(v, UNLIMITED);
  check("unlimited: still allowed after 5 generations", checkQuota(v, UNLIMITED).allowed);
}

// zero generations: blocked before the first one
{
  const v = freshGuest();
  const verdict = checkQuota(v, steps(0), UNLIMITED);
  check("0 generations: blocked immediately, sign-in offered", !verdict.allowed && verdict.requiresSignIn, verdict.reason);
}

// N generations: counts down and then gates
{
  const v = freshGuest();
  check("3 generations: first is allowed", checkQuota(v, steps(3)).allowed);
  recordGeneration(v, UNLIMITED);
  recordGeneration(v, UNLIMITED);
  check("3 generations: 1 left after two", checkQuota(v, steps(3)).remaining === 1);
  recordGeneration(v, UNLIMITED);
  const verdict = checkQuota(v, steps(3), UNLIMITED);
  check("3 generations: fourth is blocked", !verdict.allowed && verdict.remaining === 0, verdict.reason);
}

// games mode ignores the generation count: a story can run as long as it likes
{
  const v = freshGuest();
  for (let i = 0; i < 12; i++) recordGeneration(v, UNLIMITED);
  check("1 game: mid-story steps stay allowed however many", checkQuota(v, games(1)).allowed);
  recordGameCompleted(v, UNLIMITED);
  const verdict = checkQuota(v, games(1), UNLIMITED);
  check("1 game: blocked after finishing a story", !verdict.allowed && verdict.requiresSignIn, verdict.reason);
}

// two games: the second story is still allowed
{
  const v = freshGuest();
  recordGameCompleted(v, UNLIMITED);
  check("2 games: allowed after the first ending", checkQuota(v, games(2)).allowed);
  recordGameCompleted(v, UNLIMITED);
  check("2 games: blocked after the second", !checkQuota(v, games(2)).allowed);
}

// members are metered on their own account, against their own allowance
{
  const m = freshMember();
  check("member: allowed under an unlimited member allowance", checkQuota(m, UNLIMITED).allowed);
  recordGameCompleted(m, UNLIMITED);
  const verdict = checkQuota(m, games(1));
  check("member: a member limit does bite", !verdict.allowed, verdict.reason);
  check("member: is never told to sign in", !verdict.requiresSignIn);
}

// a member's activity is not charged to the guest cookie they arrived with
{
  const m = freshMember();
  recordGeneration(m, UNLIMITED);
  check("member activity is not charged to their guest cookie", checkQuota({ ...m, userId: null }, steps(1)).allowed);
}

// sign-in is offered whenever an account would actually unblock them
{
  const v = freshGuest();
  recordGeneration(v, UNLIMITED);
  check("sign-in nudge when members get more", checkQuota(v, steps(1), steps(5)).requiresSignIn);
  // An account is a fresh ledger, so the same-sized member allowance still gets them going again.
  check("sign-in nudge even when members get the same amount", checkQuota(v, steps(1), steps(1)).requiresSignIn);
  check("no sign-in nudge when members get nothing", !checkQuota(v, steps(1), steps(0)).requiresSignIn);
}

// sharing a run buys one more go, once per run
{
  const v = freshGuest();
  recordGameCompleted(v, UNLIMITED);
  check("1 game: blocked before sharing", !checkQuota(v, games(1)).allowed);
  check("share grants a credit", grantShareCredit(v, "node-1", games(1)));
  check("1 game + shared: allowed again", checkQuota(v, games(1)).allowed);
  check("the same run cannot be cashed twice", !grantShareCredit(v, "node-1", games(1)));
  recordGameCompleted(v, UNLIMITED);
  check("1 game + shared: blocked after the extra story", !checkQuota(v, games(1)).allowed);
  check("a different run can be cashed", grantShareCredit(v, "node-2", games(1)));
}

// in generations mode a share is worth a whole go, not a single step
{
  const v = freshGuest();
  const three = steps(3);
  for (let i = 0; i < 3; i++) recordGeneration(v, three);
  check("3 generations: blocked before sharing", !checkQuota(v, three).allowed);
  grantShareCredit(v, "node-gen", three);
  const verdict = checkQuota(v, three);
  check("3 generations + shared: a full allowance more, not one step", verdict.allowed && verdict.remaining === 3, `remaining ${verdict.remaining}`);
}

// a member at a finished-game cap can also share for another go
{
  const m = freshMember();
  recordGameCompleted(m, games(1));
  check("member at the game cap is blocked", !checkQuota(m, games(1)).allowed);
  check("member can cash a share", grantShareCredit(m, "node-member", games(1)));
  check("member: allowed again after sharing", checkQuota(m, games(1)).allowed);
}

// the allowance refills once its window has passed
{
  const v = freshGuest();
  const daily = games(1, 1);
  recordGameCompleted(v, daily);
  check("daily window: blocked inside the window", !checkQuota(v, daily).allowed);
  const soon = checkQuota(v, daily).resetsAt;
  check("daily window: reports when it refills", Boolean(soon) && Date.parse(soon!) > Date.now(), soon ?? "none");
  // Backdate the window rather than waiting a day.
  db.query(`UPDATE guest_usage SET window_start = ? WHERE id = ?`).run(new Date(Date.now() - 2 * 86_400_000).toISOString(), v.guest.cookieId);
  check("daily window: allowed again once it has passed", checkQuota(v, daily).allowed);
  check("daily window: the old usage is not counted", checkQuota(v, daily).used.games === 0);
  // And the next recorded game opens a fresh window rather than topping up the stale one.
  recordGameCompleted(v, daily);
  check("daily window: blocked again after one game in the new window", !checkQuota(v, daily).allowed);
}

// a window of 0 days never refills
{
  const v = freshGuest();
  recordGameCompleted(v, games(1, 0));
  db.query(`UPDATE guest_usage SET window_start = ? WHERE id = ?`).run(new Date(Date.now() - 400 * 86_400_000).toISOString(), v.guest.cookieId);
  check("0 days: never refills", !checkQuota(v, games(1, 0)).allowed);
}

// shared network: separate cookies on ONE ip each keep their own allowance
{
  const ip = "198.51.100.77";
  const guest = (id: string): Viewer => ({ guest: { cookieId: `room-${id}-${crypto.randomUUID()}`, ip, issueCookie: false } as Guest, userId: null });
  recordGeneration(guest("a"), UNLIMITED);
  check("shared wifi: one device's use does not block another", checkQuota(guest("b"), steps(1)).allowed);
}

// the same network abused repeatedly does eventually trip the IP tolerance
{
  const ip = "198.51.100.99";
  for (let i = 0; i < 20; i++) recordGeneration({ guest: { cookieId: `abuse-${i}-${crypto.randomUUID()}`, ip, issueCookie: false }, userId: null }, UNLIMITED);
  const next: Viewer = { guest: { cookieId: `abuse-next-${crypto.randomUUID()}`, ip, issueCookie: false }, userId: null };
  check("cookie-clearing is eventually caught by the IP limit", !checkQuota(next, steps(1)).allowed);
}

// cleanup
db.query(
  `DELETE FROM guest_usage WHERE id LIKE 'test-cookie-%' OR id LIKE 'user:test-user-%' OR id LIKE 'room-%' OR id LIKE 'abuse-%' OR id LIKE 'ip:203.0.113.%' OR id LIKE 'ip:198.51.100.%'`,
).run();
db.query(`DELETE FROM share_credits WHERE id LIKE 'test-cookie-%' OR id LIKE 'user:test-user-%'`).run();

console.log(failed ? "\nSomething is wrong — see above." : "\nSign-in gate behaves.");
process.exit(failed ? 1 : 0);
