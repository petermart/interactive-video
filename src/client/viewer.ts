const KEY = "prison-escape:viewer-id";

/** A new UUID per browser session (sessionStorage), identifying this viewer's jobs and debug history. */
export function viewerId() {
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return (fallback ??= crypto.randomUUID());
  }
}
let fallback: string | undefined;

/** fetch() that tags every request with the viewer's session UUID. */
export function apiFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-viewer-id", viewerId());
  return fetch(input, { ...init, headers });
}

/**
 * Tells the server the viewer has left, so any film that only exists on its disk can be reclaimed at once
 * instead of waiting out the idle timeout.
 *
 * `pagehide` rather than `beforeunload`: it is the event that actually fires on mobile Safari and on a
 * bfcache navigation. sendBeacon because a normal fetch is cancelled when the page goes away, and the
 * viewer id travels in the body since beacons cannot set headers.
 */
export function reportLeavingOnUnload() {
  const leave = () => {
    try {
      const body = new Blob([JSON.stringify({ viewerId: viewerId() })], { type: "application/json" });
      navigator.sendBeacon(`/api/session/end?viewer=${viewerId()}`, body);
    } catch {}
  };
  addEventListener("pagehide", leave);
}

