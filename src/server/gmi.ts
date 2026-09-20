import { keys } from "./config";
import { gmiCallCost } from "./credits";
import { traced } from "./db";
import { isRetryableStatus, RetryableHttpError, retryAfterMs, withRetry } from "./net";

const BASE = "https://api.gmi-serving.com/v1";

/**
 * The raw GMI client. Callers go through llm.ts, which falls back to fal when GMI is overloaded and owns
 * the player-facing wording - this file keeps the real status code and GMI's own words so the fallback can
 * tell a capacity problem from a bad request.
 */

/** Chat completion that must return a JSON object. Logged to the debug DB with prompts, output and latency. */
export async function chatJSON<T>(model: string, system: string, user: string, label = "LLM call"): Promise<T> {
  const request = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.8,
  };
  const { parsed } = await traced(
    "llm",
    `${label} · ${model}`,
    request,
    // LLM calls cost fractions of a cent, so retrying a dropped socket or 5xx is worth it.
    () =>
      withRetry(
        `${label} · ${model}`,
        async () => {
          const res = await fetch(`${BASE}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${keys.gmi}`, "Content-Type": "application/json" },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(60_000),
          });
          if (isRetryableStatus(res.status)) {
            // Read the body even on a retryable status: "GMI 429" alone cannot tell an overloaded provider
            // (their problem, wait) from an exhausted quota (ours, top up), and that is the whole diagnosis.
            const detail = await res.text().catch(() => "");
            throw new RetryableHttpError(`GMI ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`, retryAfterMs(res.headers.get("retry-after")));
          }
          const body = await res.json();
          if (!res.ok) throw new Error(`GMI ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
          const text: string = body.choices?.[0]?.message?.content ?? "";
          const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T;
          return { parsed, usage: body.usage };
        },
        3,
      ),
    { summarize: r => r, cost: r => gmiCallCost(model, r.usage) },
  );
  return parsed;
}
