import { serve } from "bun";
import { existsSync } from "node:fs";
import index from "./index.html";
import { aboutPage } from "./server/about";
import { CACHE_DIR, EXPORT_DIR, FRAMES_DIR, getSettings, maskyAvailable, MEDIA_DIR, providerAvailable, publicBaseUrl, ROOT, updateSettings, world } from "./server/config";
import { VIDEO_PROVIDERS } from "./server/constants";
import { checkAdminPassword, creditsReport, MACHGEN_MIN_BALANCE_USD, videoGenerationAllowed } from "./server/credits";
import { jobContext, jobEvents, looseEvents, recentJobs } from "./server/db";
import { exportFilm } from "./server/export";
import { shareInfo, sharePage } from "./server/share";
import { createSession, getJob, getNode, startDirection } from "./server/pipeline";
import { objectExists, presignGet, PRESIGN_TTL_SECONDS, putBytes, r2Enabled, storageFull } from "./server/storage";
import { markDownloaded, viewerLeft } from "./server/ephemeral";
import { analyticsToken } from "./server/analytics";
import { auth, authBaseUrl, authEnabled, authSecret, callbackUrlFor, configuredProviders, currentUser, emailPasswordEnabled, reloadAuth } from "./server/auth";
import { PROVIDER_IDS, providerStatus, saveProvider } from "./server/authConfig";
import { checkQuota, grantShareCredit, guestCookie, identifyGuest, recordGameCompleted, recordGeneration, viewerIsMember, type Viewer } from "./server/quota";
import { migrateOnBootIfRequested } from "./server/migrateVolume";
import { startRetention } from "./server/retention";
import { startArchiveBackups } from "./server/archiveBackup";
import { tagJobOwner, usageReport } from "./server/usage";
import { deleteArchived, getArchived, listArchive, updateArchived } from "./server/actionCache";
import { adminArchivePage, adminLoginPage } from "./server/adminPages";
import { adminCookie, clearAdminCookie, isAdmin, verifyAdminPassword } from "./server/adminSession";
import { backupManifest, databaseSnapshot, stateFiles } from "./server/backup";
import { falTurboUsdPerSec } from "./server/falTurboVideo";
import { regenerateArchived, regenerationStatus } from "./server/pipeline";
import type { VideoProvider } from "./server/constants";

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

/**
 * Generated media (clips, exports, frames): served from R2 when it is configured, from disk otherwise.
 *
 * The URL the browser holds stays the same either way, which is what keeps already-shared links working.
 * R2 objects are private, so each request is redirected to a short-lived signed URL minted here; the
 * credentials never leave the server. The redirect is deliberately not cacheable for longer than the
 * signature lives, or a cached 302 would outlast the URL it points at.
 */
function generatedFrom(base: string, prefix: string) {
  const fallback = staticFrom(base, prefix);
  return async (req: Request) => {
    if (!r2Enabled()) return fallback(req);
    const rel = decodeURIComponent(new URL(req.url).pathname.slice(prefix.length));
    if (rel.includes("..")) return new Response("Forbidden", { status: 403 });
    const key = `${prefix.slice("/media/".length)}${rel}`;
    const signed = presignGet(key);
    if (!signed) return fallback(req);
    // A render still in progress has not been uploaded yet; fall back to the working copy on disk.
    if (!(await objectExists(key))) return fallback(req);
    return new Response(null, {
      status: 302,
      headers: { location: signed, "cache-control": `private, max-age=${Math.floor(PRESIGN_TTL_SECONDS / 2)}` },
    });
  };
}

const UNLIMITED = { mode: "unlimited", count: 0, resetDays: 0 } as const;

/**
 * The allowance actually in force for one viewer. A guest limit is only enforced once at least one provider
 * works: with none configured, enforcing it would block every visitor behind a sign-in screen that has no
 * buttons, locking the public out of the game. The admin panel warns about this instead. A member limit is
 * always enforced - they are already signed in, so there is nothing to lock them out of.
 */
const allowanceFor = (viewer: Viewer) => {
  const settings = getSettings();
  if (viewerIsMember(viewer)) return settings.memberAllowance;
  return authEnabled() ? settings.guestAllowance : UNLIMITED;
};

/** The verdict plus everything the client needs to explain it. */
const quotaFor = (viewer: Viewer) => checkQuota(viewer, allowanceFor(viewer), getSettings().memberAllowance);

const viewerFor = async (req: Request): Promise<Viewer> => ({ guest: identifyGuest(req), userId: (await currentUser(req))?.id ?? null });

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
const redirect = (to: string, headers: Record<string, string> = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });
const unauthorized = () => Response.json({ error: "Admin sign-in required" }, { status: 401 });

/** Providers the archive page can regenerate with (Masky can't: it needs a first frame), with a rough 15s price. */
const regenerationProviders = () =>
  availableProviders()
    .filter(p => p !== "masky")
    .map(id => ({
      id,
      price:
        id === "fal-turbo" ? `~$${(15 * falTurboUsdPerSec()).toFixed(2)}`
        : id === "fal-turbo-half" ? `~$${(8 * falTurboUsdPerSec()).toFixed(2)}`
        : id === "gmi" ? "~$1.20"
        : "~$0.75",
    }));

/** Video providers that have an API key here, in preference order: the only ones the admin panel offers. */
const availableProviders = () => VIDEO_PROVIDERS.filter(providerAvailable);

/**
 * Blanks the cost column of debug rows when the operator has turned spend off for viewers. An admin (the
 * password in this browser, sent as a header) always sees the real numbers - it is their bill.
 */
function withoutSpend(req: Request) {
  if (getSettings().showDebugSpend || isAdmin(req)) return (row: unknown) => row;
  return (row: unknown) => (row && typeof row === "object" && "cost_usd" in row ? { ...row, cost_usd: null } : row);
}

const server = serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/*": index,

    // Generated clips and exports live in object storage (R2 in deployment, disk locally); the rest is committed media.
    "/media/cache/*": generatedFrom(CACHE_DIR, "/media/cache/"),
    "/media/exports/*": generatedFrom(EXPORT_DIR, "/media/exports/"),
    // Reachable by external generators (Masky) so they can fetch a first/last frame by URL.
    "/media/frames/*": generatedFrom(FRAMES_DIR, "/media/frames/"),
    "/media/*": staticFrom(MEDIA_DIR, "/media/"),
    "/hyperframes/*": staticFrom(`${ROOT}hyperframes`, "/hyperframes/"),

    /**
     * Settings are world-readable (the client needs them to render) but admin-only to change.
     *
     * Without the check on PUT, anyone could set guestPolicy to "unlimited" and walk straight through the
     * sign-in gate, or switch liveVideo on and spend the MachGen balance. The password travels in a header
     * so the body stays a plain settings patch.
     */
    "/api/settings": {
      // authEnabled lets the panel warn when a sign-in policy is set but cannot be enforced yet.
      GET: () => Response.json({ ...getSettings(), maskyAvailable: maskyAvailable(), availableProviders: availableProviders(), authEnabled: authEnabled() }),
      PUT: async req => {
        if (!checkAdminPassword(req.headers.get("x-admin-password"))) {
          return Response.json({ error: "Admin password required to change settings" }, { status: 401 });
        }
        return Response.json({ ...(await updateSettings(await req.json())), maskyAvailable: maskyAvailable(), availableProviders: availableProviders(), authEnabled: authEnabled() });
      },
    },

    "/api/session": {
      POST: req => Response.json(createSession(viewerOf(req))),
    },

    /**
     * The viewer left the story: tab closed, reloaded, or restarted. Sent with sendBeacon, so it must stay
     * cheap and must not rely on a response. Their temporary disk-only films are reclaimed immediately
     * rather than waiting for the idle sweep.
     */
    "/api/session/end": {
      POST: req => {
        // sendBeacon cannot set headers, so the viewer id arrives in the query string here.
        const q = new URL(req.url).searchParams.get("viewer") ?? "";
        viewerLeft(UUID.test(q) ? q.toLowerCase() : viewerOf(req));
        return new Response(null, { status: 204 });
      },
    },

    /** Marks a temporary film as downloaded, so the sweeper can reclaim it once the transfer has finished. */
    "/api/downloaded": {
      POST: async req => {
        const { url } = await req.json().catch(() => ({}));
        if (typeof url === "string") markDownloaded(new URL(url, "http://x").pathname);
        return new Response(null, { status: 204 });
      },
    },

    // Resume a node after a page reload (e.g. to replay a step that finished while the tab was closed).
    "/api/node/:id": req => {
      const node = getNode(req.params.id);
      return node ? Response.json(node) : Response.json({ error: "Unknown node" }, { status: 404 });
    },

    // Public: lets the page show the out-of-credits banner. Only reports booleans, never balances or usage.
    "/api/status": async () => {
      const settings = getSettings();
      const paused = settings.liveVideo && !(await videoGenerationAllowed(settings.videoProvider));
      // Enough for the settings panel to warn without unlocking; the GB and cost stay behind the password.
      // The analytics token is public by design (it ships in the HTML of every page) and identifies the
      // site rather than granting access, so serving it here is safe.
      return Response.json({
        generationPaused: paused,
        minBalanceUsd: MACHGEN_MIN_BALANCE_USD,
        storageFull: storageFull(),
        analyticsToken: analyticsToken(),
      });
    },

    // Admin-only credit balances (password checked against a stored SHA-256 hash).
    // Players and generations per player, for the admin usage report.
    "/api/admin/usage": {
      POST: async req => {
        const { password } = await req.json().catch(() => ({}));
        if (!checkAdminPassword(password)) return Response.json({ error: "Wrong password" }, { status: 401 });
        return Response.json(usageReport());
      },
    },

    "/api/admin/credits": {
      POST: async req => {
        const { password } = await req.json().catch(() => ({}));
        if (!checkAdminPassword(password)) return Response.json({ error: "Wrong password" }, { status: 401 });
        return Response.json(await creditsReport());
      },
    },

    /**
     * Publishes an image (e.g. a clip's last frame) at a public URL. Used by a local dev server to give
     * Masky a fetchable first-frame URL. Password-protected: it writes to this server's disk.
     */
    "/api/frames": {
      POST: async req => {
        if (!checkAdminPassword(req.headers.get("x-admin-password"))) return Response.json({ error: "Wrong password" }, { status: 401 });
        const bytes = await req.arrayBuffer();
        if (!bytes.byteLength || bytes.byteLength > 12_000_000) return Response.json({ error: "Empty or oversized image" }, { status: 400 });
        const ext = (req.headers.get("content-type") ?? "").includes("jpeg") ? "jpg" : "png";
        const id = `${crypto.randomUUID()}.${ext}`;
        if (!(await putBytes(`frames/${id}`, bytes))) await Bun.write(`${FRAMES_DIR}/${id}`, bytes);
        const base = publicBaseUrl() ?? new URL(req.url).origin;
        return Response.json({ url: `${base}/media/frames/${id}` });
      },
    },

    // Better Auth owns everything under /api/auth: the OAuth redirects, callbacks and session endpoints.
    // Resolved per request, because credentials can be edited from the admin panel while the server runs.
    "/api/auth/*": req => auth().handler(req),

    /**
     * Sign-in provider setup, so OAuth can be finished on a running server instead of needing a redeploy.
     * Password-gated like the credit balances. Client secrets are write-only here: the response says
     * whether a secret exists, never what it is.
     */
    "/api/admin/auth": {
      POST: async req => {
        const body = await req.json().catch(() => ({}));
        if (!checkAdminPassword(body.password)) return Response.json({ error: "Wrong password" }, { status: 401 });

        if (body.provider) {
          if (!PROVIDER_IDS.includes(body.provider)) return Response.json({ error: "Unknown provider" }, { status: 400 });
          try {
            await saveProvider(body.provider, String(body.clientId ?? ""), String(body.clientSecret ?? ""));
            reloadAuth();
          } catch (err) {
            return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 400 });
          }
        }
        return Response.json({
          providers: providerStatus().map(p => ({ ...p, callbackUrl: callbackUrlFor(p.id) })),
          enabled: authEnabled(),
          baseUrl: authBaseUrl(),
          // A weak secret makes every session forgeable, so surface it where it will actually be seen.
          weakSecret: authSecret().length < 32,
        });
      },
    },

    // Credits and context: what this is, where it was built, and a way into the source.
    "/about": () => new Response(aboutPage(), { headers: { "content-type": "text/html;charset=utf-8" } }),

    // ---------- Admin pages: signed-in admins only (adminSession.ts). The URL alone gets a login form. ----------
    "/admin": req => (isAdmin(req) ? redirect("/admin/archive") : html(adminLoginPage())),
    "/admin/login": {
      POST: async req => {
        const form = await req.formData().catch(() => null);
        if (!(await verifyAdminPassword(form?.get("password")))) return html(adminLoginPage("Wrong password."), 401);
        return redirect("/admin/archive", { "set-cookie": adminCookie(req) });
      },
    },
    "/admin/logout": { POST: req => redirect("/admin", { "set-cookie": clearAdminCookie(req) }) },
    "/admin/archive": req =>
      isAdmin(req) ? html(adminArchivePage(regenerationProviders(), world.environments.map(e => e.id))) : redirect("/admin"),

    // Lets the in-game admin panel open the archive page without a second login: it already has the password.
    "/api/admin/session": {
      POST: async req => {
        const { password } = await req.json().catch(() => ({}));
        if (!(await verifyAdminPassword(password))) return Response.json({ error: "Wrong password" }, { status: 401 });
        return Response.json({ ok: true }, { headers: { "set-cookie": adminCookie(req) } });
      },
    },
    "/api/admin/archive": req => (isAdmin(req) ? Response.json({ rows: listArchive() }) : unauthorized()),

    /**
     * Pulls the deployment's own state to wherever the admin is running scripts/backup-deployment.ts: the
     * database (share links, accounts, allowances, the event log) and the JSON settings beside it. Media is
     * not here - it already lives in R2.
     */
    "/api/admin/backup": req => (isAdmin(req) ? Response.json(backupManifest()) : unauthorized()),
    "/api/admin/backup/db": async req => {
      if (!isAdmin(req)) return unauthorized();
      const bytes = await databaseSnapshot();
      return new Response(bytes, {
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength), "cache-control": "no-store" },
      });
    },
    "/api/admin/backup/files": async req =>
      isAdmin(req) ? Response.json(await stateFiles(), { headers: { "cache-control": "no-store" } }) : unauthorized(),
    "/api/admin/archive/:id": {
      GET: req => {
        if (!isAdmin(req)) return unauthorized();
        const id = Number(req.params.id);
        const row = getArchived(id);
        return row ? Response.json({ row, regeneration: regenerationStatus(id) ?? null }) : Response.json({ error: "Not found" }, { status: 404 });
      },
      DELETE: req => {
        if (!isAdmin(req)) return unauthorized();
        return deleteArchived(Number(req.params.id)) ? Response.json({ ok: true }) : Response.json({ error: "Not found" }, { status: 404 });
      },
      PATCH: async req => {
        if (!isAdmin(req)) return unauthorized();
        const edit = await req.json().catch(() => null);
        if (!edit || typeof edit !== "object") return Response.json({ error: "Expected a JSON object" }, { status: 400 });
        const result = updateArchived(Number(req.params.id), edit, world.environments.map(e => e.id));
        return typeof result === "string" ? Response.json({ error: result }, { status: 400 }) : Response.json({ row: result });
      },
    },
    "/api/admin/archive/:id/regenerate": {
      POST: async req => {
        if (!isAdmin(req)) return unauthorized();
        const { provider } = await req.json().catch(() => ({}));
        if (!regenerationProviders().some(p => p.id === provider)) return Response.json({ error: "That provider isn't available here" }, { status: 400 });
        try {
          return Response.json(regenerateArchived(Number(req.params.id), provider as VideoProvider));
        } catch (err) {
          return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 400 });
        }
      },
    },

    // Public share page for one ending: the card social platforms scrape, plus a player.
    "/s/:id": async req => {
      try {
        return new Response(await sharePage(req.params.id, new URL(req.url).origin), {
          headers: { "content-type": "text/html;charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Not found: ${(err as Error)?.message}`, { status: 404 });
      }
    },

    // Share links + text for the in-game share buttons (stitches the film if needed).
    "/api/share/:id": async req => {
      try {
        const vertical = new URL(req.url).searchParams.get("vertical") === "1";
        return Response.json(await shareInfo(req.params.id, new URL(req.url).origin, { vertical }));
      } catch (err) {
        return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 400 });
      }
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
    // What a step cost is stripped here, not just hidden in the drawer, when showDebugSpend is off: the drawer
    // is open to every visitor, and a setting that only blanks the UI still ships the numbers to them.
    "/api/debug/jobs": req => {
      const viewer = viewerOf(req);
      if (!viewer) return Response.json({ jobs: [], other: [] });
      const hide = withoutSpend(req);
      return Response.json({ jobs: recentJobs(viewer, 50).map(hide), other: looseEvents(viewer, 30).map(hide) });
    },
    "/api/debug/jobs/:id": req => {
      const viewer = viewerOf(req);
      return Response.json({ events: viewer ? jobEvents(req.params.id, viewer).map(withoutSpend(req)) : [] });
    },

    "/api/direct": {
      POST: async req => {
        const { fromNodeId, direction } = await req.json();
        if (!direction?.trim()) return Response.json({ error: "Empty direction" }, { status: 400 });

        // The gate: whichever allowance applies to this viewer, guest or member.
        const viewer = await viewerFor(req);
        const guest = viewer.guest;
        const verdict = quotaFor(viewer);
        if (!verdict.allowed) {
          return Response.json(
            { error: verdict.reason, requiresSignIn: verdict.requiresSignIn, providers: configuredProviders() },
            { status: 401, headers: guest.issueCookie ? { "set-cookie": guestCookie(guest.cookieId) } : {} },
          );
        }

        try {
          const job = startDirection(fromNodeId, direction, viewerOf(req));
          recordGeneration(viewer, allowanceFor(viewer));
          tagJobOwner(job.id, guest.cookieId, viewer.userId);
          return Response.json(
            { jobId: job.id },
            { headers: guest.issueCookie ? { "set-cookie": guestCookie(guest.cookieId) } : {} },
          );
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    /** Who the viewer is and what they are still allowed to do, so the client can gate its own UI. */
    "/api/me": async req => {
      const user = await currentUser(req);
      const viewer: Viewer = { guest: identifyGuest(req), userId: user?.id ?? null };
      const verdict = quotaFor(viewer);
      return Response.json(
        {
          signedIn: Boolean(user),
          name: user?.name ?? null,
          image: user?.image ?? null,
          authEnabled: authEnabled(),
          providers: configuredProviders(),
          emailPassword: emailPasswordEnabled(),
          allowance: verdict.allowance,
          used: verdict.used,
          bonus: verdict.bonus,
          remaining: verdict.remaining,
          resetsAt: verdict.resetsAt,
          canGenerate: verdict.allowed,
          requiresSignIn: verdict.requiresSignIn,
          blockedReason: verdict.allowed ? null : verdict.reason,
          // Whether sharing an ending is currently worth an extra go, so the gate can offer it.
          shareGrantsGame: getSettings().shareGrantsGame,
        },
        { headers: viewer.guest.issueCookie ? { "set-cookie": guestCookie(viewer.guest.cookieId) } : {} },
      );
    },

    /** Counts a finished story against this viewer's allowance, so a "games" limit can ever be reached. */
    "/api/game-complete": {
      POST: async req => {
        const viewer = await viewerFor(req);
        recordGameCompleted(viewer, allowanceFor(viewer));
        return new Response(null, { status: 204 });
      },
    },

    /**
     * "Share your run for another go." Paid out once per ending, on the viewer's word that they shared it -
     * there is no way to verify a share, and the trade (a link out into the world for one more generation)
     * is worth more than the occasional freeloader.
     */
    "/api/share-credit": {
      POST: async req => {
        if (!getSettings().shareGrantsGame) return Response.json({ granted: false, reason: "Not offered" }, { status: 400 });
        const { nodeId } = await req.json().catch(() => ({}));
        if (!nodeId || typeof nodeId !== "string") return Response.json({ error: "Which run?" }, { status: 400 });
        const viewer = await viewerFor(req);
        const granted = grantShareCredit(viewer, nodeId, allowanceFor(viewer));
        return Response.json({ granted, ...quotaFor(viewer) });
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

console.log(`Escape from Slop Prison running at ${server.url}`);

// One-off: MIGRATE_VOLUME_TO_R2=1 moves the volume's media into R2 from inside the container. Runs after
// listen so the health check passes while it works.
migrateOnBootIfRequested();
// Debug history grows without bound and shares the volume with everything else.
startRetention();
void startArchiveBackups();
