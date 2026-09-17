/**
 * Loads the Cloudflare Web Analytics beacon into the single-page app.
 *
 * index.html is a static file bundled by Bun, so the site token cannot be baked into it without a build
 * step. Instead the token comes from /api/status (it is public, not a credential) and the beacon is added
 * once at runtime. Nothing is injected when the server has no token configured, which keeps local
 * development out of the numbers entirely.
 *
 * The SPA never reloads, so Cloudflare sees one page view per session rather than per screen. That is the
 * honest shape of this app — the gameplay funnel lives in the server's own event log, which knows far more
 * than a page view ever could.
 */
export async function startAnalytics() {
  try {
    const { analyticsToken } = await fetch("/api/status").then(r => r.json());
    if (!analyticsToken || document.querySelector("script[data-cf-beacon]")) return;
    const script = document.createElement("script");
    script.defer = true;
    script.src = "https://static.cloudflareinsights.com/beacon.min.js";
    script.setAttribute("data-cf-beacon", JSON.stringify({ token: analyticsToken }));
    document.head.appendChild(script);
  } catch {
    // Analytics must never be the reason the game fails to start.
  }
}
