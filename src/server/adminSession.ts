import { createHmac, timingSafeEqual } from "node:crypto";
import { authSecret } from "./auth";
import { checkAdminPassword } from "./credits";

/**
 * Admin sign-in for the server-rendered admin pages (the archive manager).
 *
 * The in-game admin panel sends the password with each request, which is fine for a few fetches from React state
 * but not for a real page: a page has to know who you are when it loads. So signing in with the admin password
 * issues a signed, HttpOnly session cookie, and every admin page and admin API checks it on the server. Knowing
 * the URL gets you a login form and nothing else.
 *
 * SameSite=Strict keeps other sites from riding the cookie (no cross-site form can delete or regenerate a clip),
 * and HttpOnly keeps page scripts from reading it. The signature is keyed on AUTH_SECRET, so rotating that, or
 * changing the admin password, signs every admin out.
 */

const COOKIE = "sp_admin";
const TTL_SECONDS = 12 * 60 * 60;

/** Bound into the signature, so a new admin password invalidates every existing admin session. */
const passwordFingerprint = () => new Bun.CryptoHasher("sha256").update(process.env.ADMIN_PASSWORD ?? "legacy-default").digest("hex");

const sign = (expires: number) => createHmac("sha256", authSecret()).update(`admin:${expires}:${passwordFingerprint()}`).digest("base64url");

function readCookie(req: Request, name: string) {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

/** True for a request from a signed-in admin: a valid session cookie, or the password in `x-admin-password`. */
export function isAdmin(req: Request) {
  if (checkAdminPassword(req.headers.get("x-admin-password"))) return true;
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [expires, signature] = value.split(".");
  const exp = Number(expires);
  if (!exp || exp < Date.now() / 1000 || !signature) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const secure = (req: Request) => new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

/** Set-Cookie value for a fresh admin session. */
export function adminCookie(req: Request) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_SECONDS}${secure(req) ? "; Secure" : ""}`;
}

export const clearAdminCookie = (req: Request) => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(req) ? "; Secure" : ""}`;

/** Checks a submitted password. A short delay on failure makes guessing slow without bothering a real admin. */
export async function verifyAdminPassword(password: unknown) {
  const ok = checkAdminPassword(password);
  if (!ok) await Bun.sleep(750);
  return ok;
}
