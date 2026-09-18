import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Database } from "bun:sqlite";
import { activeProviders } from "./authConfig";
import { DB_FILE, publicBaseUrl } from "./config";
import { logEvent } from "./db";

/**
 * Social sign-in, used as the gate once a guest has spent their free play.
 *
 * Self-hosted on the SQLite database this server already keeps, so there is no per-user cost and no third
 * service to depend on. Better Auth creates and migrates its own tables (user, session, account,
 * verification) inside that file.
 *
 * The instance is rebuilt rather than fixed at startup, because provider credentials can be entered through
 * the admin panel on a running server: pinning them at import time would mean a redeploy just to finish
 * the OAuth setup.
 *
 * Apple is deliberately absent: Sign in with Apple requires a paid Apple Developer account, and adding it
 * later is configuration rather than rework, because providers are declared uniformly here.
 */

/** Shared by Better Auth's sessions and the guest cookie, so both die together if it is rotated. */
export const authSecret = () => process.env.AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET ?? "dev-only-insecure-secret";

/** Where this server is reachable, used to build OAuth redirect URLs. */
export const authBaseUrl = () => publicBaseUrl() ?? `http://localhost:${process.env.PORT ?? 3000}`;

/** The exact URI that has to be whitelisted in the provider's console, shown in the admin panel. */
export const callbackUrlFor = (provider: string) => `${authBaseUrl()}/api/auth/callback/${provider}`;

const buildOptions = () => ({
  database: new Database(DB_FILE, { create: true }),
  baseURL: authBaseUrl(),
  secret: authSecret(),
  socialProviders: activeProviders(),
  // Email + password alongside Google, so nobody needs a Google account to keep playing. Better Auth hashes the
  // passwords (scrypt) in its own `account` table. There is no email service yet, so addresses are not verified
  // and there is no "forgot password" email: both need a mail provider wired into sendVerificationEmail /
  // sendResetPassword before they can be turned on.
  emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128, autoSignIn: true, requireEmailVerification: false },
});

let instance = betterAuth(buildOptions());

/** The live auth instance. Always call this rather than caching it: credentials can change at runtime. */
export const auth = () => instance;

/** Rebuilds after credentials are edited, so a new provider works without restarting the server. */
export function reloadAuth() {
  instance = betterAuth(buildOptions());
  logEvent({ kind: "job", label: "auth reloaded", response: { providers: configuredProviders() } });
}

/** Email + password is always available, so signing in is always possible and the gate can be enforced. */
export const emailPasswordEnabled = () => true;
export const authEnabled = () => emailPasswordEnabled() || Object.keys(activeProviders()).length > 0;
/** Social providers with working credentials (the sign-in buttons); email + password is reported separately. */
export const configuredProviders = () => Object.keys(activeProviders());

/**
 * Creates Better Auth's tables on boot if they are not there yet.
 *
 * Done in-process rather than via `npx auth migrate` so deployment stays a single `bun src/index.ts`: the
 * container has no migration step to forget, and a fresh volume becomes a working database on first start.
 * The schema does not depend on which providers are enabled, so this only needs to run once.
 */
try {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(buildOptions());
  if (toBeCreated.length || toBeAdded.length) {
    await runMigrations();
    logEvent({
      kind: "job",
      label: "auth tables migrated",
      response: { created: toBeCreated.map(t => t.table), altered: toBeAdded.map(t => t.table) },
    });
  }
} catch (err) {
  // A failed migration must not take the game down: sign-in breaks, directing still works.
  logEvent({ kind: "error", label: "auth migration failed", status: "error", response: String(err) });
}

/** The signed-in user for this request, or null. Never throws: a broken session just means "guest". */
export async function currentUser(req: Request) {
  if (!authEnabled()) return null;
  try {
    const session = await instance.api.getSession({ headers: req.headers });
    return session?.user ?? null;
  } catch {
    return null;
  }
}
