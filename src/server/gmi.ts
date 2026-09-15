import { keys } from "./config";
import { gmiCallCost } from "./credits";
import { traced } from "./db";
import { isRetryableStatus, RetryableHttpError, withRetry } from "./net";

const BASE = "https://api.gmi-serving.com/v1";

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
          if (isRetryableStatus(res.status)) throw new RetryableHttpError(`GMI ${res.status}`);
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
