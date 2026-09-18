import { existsSync } from "node:fs";
import { keys, ROOT, STORAGE_DIR } from "./config";
import { logEvent } from "./db";

/**
 * OAuth provider credentials, stored server-side and editable from the admin panel.
 *
 * Environment variables still win where they are set, so a deployment can pin credentials that no one can
 * change through the UI. Anything not pinned falls back to this file, which is what makes it possible to
 * finish the sign-in setup on a running server without a redeploy.
 *
 * The file lives beside the other writable state (a volume in deployment) and is gitignored. Secrets are
 * never sent back to the browser: the admin API reports only whether a secret is present.
 */

// Google only for now. Facebook was wired up too, but isn't wanted; adding a provider back is one entry here.
export type ProviderId = "google";
export const PROVIDER_IDS: ProviderId[] = ["google"];

export type ProviderCredentials = { clientId: string; clientSecret: string };
type Stored = Partial<Record<ProviderId, ProviderCredentials>>;

const FILE = STORAGE_DIR ? `${STORAGE_DIR}/auth-providers.json` : `${ROOT}data/auth-providers.json`;

/**
 * Pinned credentials, checked first so they can't be changed through the UI: environment variables in
 * deployment (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), or keys.json locally (googleClientId / googleClientSecret).
 */
const fromEnv = (id: ProviderId): ProviderCredentials | null => {
  const pinned = { google: { clientId: keys.googleClientId, clientSecret: keys.googleClientSecret } }[id];
  return pinned.clientId && pinned.clientSecret ? pinned : null;
};

let stored: Stored = existsSync(FILE) ? await Bun.file(FILE).json().catch(() => ({})) : {};

/** Credentials actually in force for one provider, env taking precedence over the stored file. */
export const credentialsFor = (id: ProviderId): ProviderCredentials | null => {
  const env = fromEnv(id);
  if (env) return env;
  const saved = stored[id];
  return saved?.clientId && saved?.clientSecret ? saved : null;
};

/** Every provider with usable credentials, in the shape Better Auth expects. */
export function activeProviders(): Record<string, ProviderCredentials> {
  const out: Record<string, ProviderCredentials> = {};
  for (const id of PROVIDER_IDS) {
    const creds = credentialsFor(id);
    if (creds) out[id] = creds;
  }
  return out;
}

/** True when this provider's credentials come from the environment and therefore cannot be edited here. */
export const isPinnedByEnv = (id: ProviderId) => fromEnv(id) !== null;

/**
 * What the admin UI is allowed to see: the client id (not secret, and needed to check against the provider
 * console) and whether a secret exists — never the secret itself.
 */
export const providerStatus = () =>
  PROVIDER_IDS.map(id => {
    const creds = credentialsFor(id);
    return {
      id,
      clientId: creds?.clientId ?? "",
      hasSecret: Boolean(creds?.clientSecret),
      configured: Boolean(creds),
      pinnedByEnv: isPinnedByEnv(id),
    };
  });

/**
 * Saves credentials for one provider. An empty secret leaves the existing one alone, so the UI can show a
 * blank secret field without wiping a working configuration every time something else is edited.
 * Passing an empty clientId clears the provider entirely.
 */
export async function saveProvider(id: ProviderId, clientId: string, clientSecret: string) {
  if (isPinnedByEnv(id)) throw new Error(`${id} is pinned by environment variables and cannot be edited here`);
  if (!clientId.trim()) {
    delete stored[id];
  } else {
    const existingSecret = stored[id]?.clientSecret ?? "";
    stored = { ...stored, [id]: { clientId: clientId.trim(), clientSecret: clientSecret.trim() || existingSecret } };
  }
  await Bun.write(FILE, JSON.stringify(stored, null, 2));
  logEvent({ kind: "job", label: "auth provider updated", response: { provider: id, cleared: !clientId.trim() } });
}
