import { serve } from "bun";
import { existsSync } from "node:fs";
import index from "./index.html";
import { CACHE_DIR, EXPORT_DIR, getSettings, MEDIA_DIR, ROOT, updateSettings } from "./server/config";
import { checkAdminPassword, creditsReport, MACHGEN_MIN_BALANCE_USD, videoGenerationAllowed } from "./server/credits";
import { jobContext, jobEvents, looseEvents, recentJobs } from "./server/db";
import { exportFilm } from "./server/export";
import { createSession, getJob, getNode, startDirection } from "./server/pipeline";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The per-browser-session viewer UUID sent by the client, if valid. */
const viewerOf = (req: Request) => {
  const id = req.headers.get("x-viewer-id") ?? "";
  return UUID.test(id) ? id.toLowerCase() : undefined;
};

/** Serves a file from a base directory, refusing path traversal. */
function staticFrom(base: string, prefix: string) {
  return (req: Request) => {
    const rel = decodeURIComponent(new URL(req.url).pathname.slice(prefix.length));
    if (rel.includes("..")) return new Response("Forbidden", { status: 403 });
    const path = `${base}/${rel}`;
    return existsSync(path) ? new Response(Bun.file(path)) : new Response("Not found", { status: 404 });
  };
}

const server = serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/*": index,

    // Generated clips and exports live in writable storage (a volume in deployment); the rest is committed media.
    "/media/cache/*": staticFrom(CACHE_DIR, "/media/cache/"),
    "/media/exports/*": staticFrom(EXPORT_DIR, "/media/exports/"),
    "/media/*": staticFrom(MEDIA_DIR, "/media/"),
    "/hyperframes/*": staticFrom(`${ROOT}hyperframes`, "/hyperframes/"),

    "/api/settings": {
      GET: () => Response.json(getSettings()),
      PUT: async req => Response.json(await updateSettings(await req.json())),
    },

    "/api/session": {
      POST: req => Response.json(createSession(viewerOf(req))),
    },

    // Resume a node after a page reload (e.g. to replay a step that finished while the tab was closed).
    "/api/node/:id": req => {
      const node = getNode(req.params.id);
      return node ? Response.json(node) : Response.json({ error: "Unknown node" }, { status: 404 });
    },

    // Public: lets the page show the out-of-credits banner. Only reports a boolean, never the balance.
    "/api/status": async () => {
      const paused = getSettings().liveVideo && !(await videoGenerationAllowed());
      return Response.json({ generationPaused: paused, minBalanceUsd: MACHGEN_MIN_BALANCE_USD });
    },

    // Admin-only credit balances (password checked against a stored SHA-256 hash).
    "/api/admin/credits": {
      POST: async req => {
        const { password } = await req.json().catch(() => ({}));
        if (!checkAdminPassword(password)) return Response.json({ error: "Wrong password" }, { status: 401 });
        return Response.json(await creditsReport());
      },
    },

    // Stitch the intro + every generated clip up to a node into one MP4 with the soundtrack.
    "/api/export": {
      POST: async req => {
        const { nodeId } = await req.json().catch(() => ({}));
        try {
          return Response.json(await jobContext.run({ viewerId: viewerOf(req) }, () => exportFilm(String(nodeId))));
        } catch (err) {
          return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 400 });
        }
      },
    },

    // Debug history (SQLite): recent jobs, then every event for one job.
    // Scoped to the requesting viewer's session UUID; without one there is nothing to show.
    "/api/debug/jobs": req => {
      const viewer = viewerOf(req);
      return Response.json(viewer ? { jobs: recentJobs(viewer, 50), other: looseEvents(viewer, 30) } : { jobs: [], other: [] });
    },
    "/api/debug/jobs/:id": req => {
      const viewer = viewerOf(req);
      return Response.json({ events: viewer ? jobEvents(req.params.id, viewer) : [] });
    },

    "/api/direct": {
      POST: async req => {
        const { fromNodeId, direction } = await req.json();
        if (!direction?.trim()) return Response.json({ error: "Empty direction" }, { status: 400 });
        try {
          const job = startDirection(fromNodeId, direction, viewerOf(req));
          return Response.json({ jobId: job.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/job/:id": req => {
      const job = getJob(req.params.id);
      return job ? Response.json(job) : Response.json({ error: "Unknown job" }, { status: 404 });
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Prison Escape running at ${server.url}`);
