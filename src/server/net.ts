import { logEvent } from "./db";

/** Thrown for HTTP responses worth retrying (rate limits and server errors). */
export class RetryableHttpError extends Error {}

export const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

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
      const delay = 750 * 2 ** (attempt - 1);
      logEvent({ kind: "error", label: `retry ${attempt}/${attempts - 1}: ${label}`, status: "error", response: String((err as Error)?.message ?? err) });
      await Bun.sleep(delay);
    }
  }
}
