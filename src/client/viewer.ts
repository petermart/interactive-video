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
