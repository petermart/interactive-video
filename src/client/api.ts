import type { Settings } from "../server/config";
import type { Job, StoryNode } from "../server/pipeline";
import { apiFetch } from "./viewer";

/** Settings plus whether this server has a Masky key configured. */
export type SettingsView = Settings & { maskyAvailable: boolean };

export type { Job, Settings, StoryNode };

const json = async <T,>(res: Response): Promise<T> => {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
};

export const api = {
  settings: () => apiFetch("/api/settings").then(r => json<SettingsView>(r)),
  saveSettings: (patch: Partial<Settings>) =>
    apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(patch) }).then(r => json<SettingsView>(r)),
  session: () => apiFetch("/api/session", { method: "POST" }).then(r => json<{ root: StoryNode; music: string | null; thinkingLoop: string }>(r)),
  direct: (fromNodeId: string, direction: string) =>
    apiFetch("/api/direct", { method: "POST", body: JSON.stringify({ fromNodeId, direction }) }).then(r =>
      json<{ jobId: string }>(r),
    ),
  node: (id: string) => apiFetch(`/api/node/${id}`).then(r => json<StoryNode>(r)),
  job: (id: string) => apiFetch(`/api/job/${id}`).then(r => json<Job>(r)),
};
