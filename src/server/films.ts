import { existsSync, readdirSync, statSync } from "node:fs";
import { EXPORT_DIR } from "./config";
import { db, tryQuery } from "./db";
import { getNode } from "./pipeline";

/**
 * Every stitched film this server has made, for the admin films dashboard.
 *
 * No single record covers them all, so three are merged, keyed on the node the film ends on:
 * - the R2 upload ledger (stored_objects), for films living in the bucket
 * - the export directory on disk, for local dev and for films kept on the volume when R2 was full
 * - the "film exported" log events, which also remember films whose file has since been swept away
 *
 * The 9:16 vertical cut and the share thumbnail are companions of a film, not films of their own.
 */

export type Film = {
  nodeId: string;
  url: string;
  /** When it was stitched: the earliest any source saw it. */
  createdAt: string;
  seconds: number | null;
  clips: number | null;
  bytes: number | null;
  /** Where the file is now: in the bucket, on this server's disk, or gone (only the log remembers it). */
  stored: "r2" | "disk" | "gone";
  vertical: boolean;
  thumbnail: string | null;
  outcome: string | null;
  owner: "member" | "guest" | "unknown";
};

const FILM = /^([0-9a-f-]{36})\.mp4$/;

export function listFilms(): Film[] {
  const films = new Map<string, Film>();
  const extras = new Set<string>(); // "<nodeId>-vertical.mp4", "<nodeId>.jpg" wherever they are
  const at = (nodeId: string) => {
    let f = films.get(nodeId);
    if (!f) {
      f = { nodeId, url: `/media/exports/${nodeId}.mp4`, createdAt: "", seconds: null, clips: null, bytes: null, stored: "gone", vertical: false, thumbnail: null, outcome: null, owner: "unknown" };
      films.set(nodeId, f);
    }
    return f;
  };
  const seen = (f: Film, when: string) => {
    if (when && (!f.createdAt || when < f.createdAt)) f.createdAt = when;
  };

  // 1. The bucket, by way of the upload ledger.
  const stored = tryQuery(
    () => db.query<{ key: string; bytes: number; created_at: string }, []>(`SELECT key, bytes, created_at FROM stored_objects WHERE key LIKE 'exports/%'`).all(),
    [],
    "films in R2",
  );
  for (const { key, bytes, created_at } of stored) {
    const name = key.slice("exports/".length);
    const match = FILM.exec(name);
    if (!match) {
      extras.add(name);
      continue;
    }
    const f = at(match[1]!);
    f.stored = "r2";
    f.bytes = bytes;
    seen(f, created_at);
  }

  // 2. The export directory on disk.
  if (existsSync(EXPORT_DIR)) {
    for (const name of readdirSync(EXPORT_DIR)) {
      if (name.includes(".tmp.")) continue; // a render still in progress, or one that died
      const match = FILM.exec(name);
      if (!match) {
        extras.add(name);
        continue;
      }
      const f = at(match[1]!);
      const stat = statSync(`${EXPORT_DIR}/${name}`);
      if (f.stored !== "r2") f.stored = "disk";
      f.bytes ??= stat.size;
      seen(f, stat.birthtime.toISOString());
    }
  }

  // 3. The export log: length and clip count, and films whose file has gone.
  const logged = tryQuery(
    () => db.query<{ ts: string; response: string }, []>(`SELECT ts, response FROM events WHERE label = 'film exported'`).all(),
    [],
    "exported films",
  );
  for (const { ts, response } of logged) {
    try {
      const { url, clips, seconds } = JSON.parse(response) as { url?: string; clips?: number; seconds?: number };
      const match = url && FILM.exec(url.split("/").pop() ?? "");
      if (!match) continue;
      const f = at(match[1]!);
      f.clips ??= clips ?? null;
      f.seconds ??= seconds ?? null;
      seen(f, ts);
    } catch {
      // a malformed log row is not worth losing the page over
    }
  }

  // Who made each film: the owner of the step that produced the node it ends on.
  const owners = new Map(
    tryQuery(
      () =>
        db
          .query<{ node_id: string; user_id: string | null; guest_id: string | null }, []>(
            `SELECT json_extract(data, '$.node.id') AS node_id, user_id, guest_id FROM jobs WHERE json_extract(data, '$.node.id') IS NOT NULL`,
          )
          .all(),
      [],
      "film owners",
    ).map(r => [r.node_id, r.user_id ? "member" : r.guest_id ? "guest" : "unknown"] as const),
  );

  for (const f of films.values()) {
    f.vertical = extras.has(`${f.nodeId}-vertical.mp4`);
    f.thumbnail = extras.has(`${f.nodeId}.jpg`) ? `/media/exports/${f.nodeId}.jpg` : null;
    f.outcome = getNode(f.nodeId)?.outcome ?? null;
    f.owner = owners.get(f.nodeId) ?? "unknown";
  }

  return [...films.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
