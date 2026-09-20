import { logEvent } from "./db";

/**
 * Thrown for HTTP responses worth retrying (rate limits and server errors). `retryAfterMs` carries the
 * service's own Retry-After hint, which is worth more than any backoff curve we invent.
 */
export class RetryableHttpError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

export const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

/** Retry-After is either seconds or an HTTP date; anything else is ignored. */
export function retryAfterMs(header: string | null) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Longest we will sit on a retry. Beyond this someone is waiting at a prompt, watching nothing happen. */
const MAX_BACKOFF_MS = 8_000;
/**
 * A hint longer than this means the service is not coming back inside anyone's patience, so we stop
 * immediately instead of burning two more attempts and several seconds to be told the same thing.
 */
const HOPELESS_MS = 20_000;

/**
 * Retries an idempotent network operation on dropped sockets, timeouts, and 408/429/5xx.
 * Never wrap a paid submit with this: a request that reached the server before the socket dropped
 * would be charged twice.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof RetryableHttpError || err instanceof TypeError || (err as Error)?.name === "TimeoutError";
      if (!retryable || attempt >= attempts) throw err;
      const hint = err instanceof RetryableHttpError ? err.retryAfterMs : undefined;
      if (hint !== undefined && hint > HOPELESS_MS) {
        logEvent({ kind: "error", label: `giving up on ${label}`, status: "error", response: `asked to wait ${Math.round(hint / 1000)}s` });
        throw err;
      }
      const delay = Math.min(hint ?? 750 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      logEvent({ kind: "error", label: `retry ${attempt}/${attempts - 1}: ${label}`, status: "error", response: String((err as Error)?.message ?? err) });
      await Bun.sleep(delay);
    }
  }
}
