import { serve } from "bun";
import { existsSync } from "node:fs";
import index from "./index.html";
import { getSettings, MEDIA_DIR, ROOT, updateSettings } from "./server/config";
import { jobEvents, looseEvents, recentJobs } from "./server/db";
import { createSession, getJob, getNode, startDirection } from "./server/pipeline";

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
  port: 3000,
  routes: {
    "/*": index,

    "/media/*": staticFrom(MEDIA_DIR, "/media/"),
    "/hyperframes/*": staticFrom(`${ROOT}hyperframes`, "/hyperframes/"),

    "/api/settings": {
      GET: () => Response.json(getSettings()),
      PUT: async req => Response.json(await updateSettings(await req.json())),
    },

    "/api/session": {
      POST: () => Response.json(createSession()),
    },

    // Resume a node after a page reload (e.g. to replay a step that finished while the tab was closed).
    "/api/node/:id": req => {
      const node = getNode(req.params.id);
      return node ? Response.json(node) : Response.json({ error: "Unknown node" }, { status: 404 });
    },

    // Debug history (SQLite): recent jobs, then every event for one job.
    "/api/debug/jobs": () => Response.json({ jobs: recentJobs(50), other: looseEvents(30) }),
    "/api/debug/jobs/:id": req => Response.json({ events: jobEvents(req.params.id) }),

    "/api/direct": {
      POST: async req => {
        const { fromNodeId, direction } = await req.json();
        if (!direction?.trim()) return Response.json({ error: "Empty direction" }, { status: 400 });
        try {
          const job = startDirection(fromNodeId, direction);
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
