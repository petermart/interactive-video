import type { Settings } from "../server/config";
import type { Job, StoryNode } from "../server/pipeline";

export type { Job, Settings, StoryNode };

const json = async <T,>(res: Response): Promise<T> => {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
};

export const api = {
  settings: () => fetch("/api/settings").then(r => json<Settings>(r)),
  saveSettings: (patch: Partial<Settings>) =>
    fetch("/api/settings", { method: "PUT", body: JSON.stringify(patch) }).then(r => json<Settings>(r)),
  session: () => fetch("/api/session", { method: "POST" }).then(r => json<{ root: StoryNode; music: string | null; thinkingLoop: string }>(r)),
  direct: (fromNodeId: string, direction: string) =>
    fetch("/api/direct", { method: "POST", body: JSON.stringify({ fromNodeId, direction }) }).then(r =>
      json<{ jobId: string }>(r),
    ),
  job: (id: string) => fetch(`/api/job/${id}`).then(r => json<Job>(r)),
};
