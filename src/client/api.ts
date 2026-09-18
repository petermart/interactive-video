import type { Settings } from "../server/config";
import type { VideoProvider } from "../server/constants";
import type { Job, StoryNode } from "../server/pipeline";
import { apiFetch } from "./viewer";

/** Settings plus whether this server has a Masky key configured. */
/** authEnabled: whether any sign-in provider works, so a sign-in policy is actually being enforced. */
export type SettingsView = Settings & { maskyAvailable: boolean; authEnabled: boolean; availableProviders?: VideoProvider[] };

export type { Job, Settings, StoryNode };

/** Carries the HTTP status, so callers can tell "you need to sign in" (401) from a genuine failure. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const json = async <T,>(res: Response): Promise<T> => {
  const body = await res.json();
  if (!res.ok) throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
  return body as T;
};

export const api = {
  settings: () => apiFetch("/api/settings").then(r => json<SettingsView>(r)),
  /** Changing settings is admin-only; the password rides in a header so the body stays the patch. */
  saveSettings: (patch: Partial<Settings>, password: string) =>
    apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(patch), headers: { "x-admin-password": password } }).then(r =>
      json<SettingsView>(r),
    ),
  session: () => apiFetch("/api/session", { method: "POST" }).then(r => json<{ root: StoryNode; music: string | null; thinkingLoop: string }>(r)),
  direct: (fromNodeId: string, direction: string) =>
    apiFetch("/api/direct", { method: "POST", body: JSON.stringify({ fromNodeId, direction }) }).then(r =>
      json<{ jobId: string }>(r),
    ),
  node: (id: string) => apiFetch(`/api/node/${id}`).then(r => json<StoryNode>(r)),
  job: (id: string) => apiFetch(`/api/job/${id}`).then(r => json<Job>(r)),
};
