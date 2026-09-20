import { keys } from "./config";
import { logEvent, traced } from "./db";
import { runFal } from "./falVideo";
import { chatJSON as gmiChatJSON } from "./gmi";
import { RetryableHttpError } from "./net";

/**
 * Every LLM call in the game, with a second provider behind the first.
 *
 * GMI hosts the models, and on 2026-09-20 it answered every request with "all endpoints are currently
 * overloaded" for the best part of an hour. Video was healthy on fal the whole time, but the game was down
 * anyway: LLM 1 judges the direction, so nothing can be filmed without it. So when GMI fails for a reason
 * that is about GMI's capacity rather than our request, the same prompt goes to fal's any-llm endpoint
 * instead. A bad request, a rejected key or unparseable JSON are NOT failed over: those are our bugs, and
 * paying a second provider to reproduce them would only hide them.
 *
 * fal's any-llm has no JSON mode, which is survivable because every system prompt here already ends with
 * "Respond with JSON only" and the parser slices from the first brace to the last.
 */

/**
 * GMI's model ids do not exist on fal, so each maps to the nearest thing in fal's catalogue - matched by
 * tier (lite vs full) rather than by name, so a future GMI model lands somewhere sensible by default.
 */
const FAL_EQUIVALENTS: [RegExp, string][] = [
  [/flash-lite|gemma|lite/i, "google/gemini-2.5-flash-lite"],
  [/pro/i, "google/gemini-2.5-pro"],
  [/flash/i, "google/gemini-2.5-flash"],
];
const FAL_DEFAULT = "google/gemini-2.5-flash-lite";
const falModelFor = (model: string) => FAL_EQUIVALENTS.find(([pattern]) => pattern.test(model))?.[1] ?? FAL_DEFAULT;

/**
 * Rough per-token price for the lite tier on fal's OpenRouter-backed endpoint, used only so the spend panel
 * shows something other than zero while the fallback is carrying the game. Blended input+output; the real
 * bill is per model and per direction, so treat these figures as an order of magnitude, not an invoice.
 */
const FAL_LLM_USD_PER_1K_TOKENS = 0.0003;
const estimateCost = (prompt: string, output: string) => Number((((prompt.length + output.length) / 4 / 1000) * FAL_LLM_USD_PER_1K_TOKENS).toFixed(5));

/**
 * While GMI is failing, stop asking it. Without this every single call pays the round trip to a service we
 * already know is down before falling back, which is latency the player feels on every step.
 */
let skipGmiUntil = 0;
const MAX_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;

/** True for failures that are about the provider being unable to serve us, not about what we asked for. */
function isCapacityFailure(err: unknown) {
  if (err instanceof RetryableHttpError) return true;
  if (err instanceof TypeError || (err as Error)?.name === "TimeoutError") return true; // dropped socket, timeout
  return /\b(429|5\d\d)\b|overloaded|capacity|rate.?limit|unavailable/i.test(String((err as Error)?.message ?? err));
}

/** Turns a provider failure into something a player can act on, once both providers have had their turn. */
function playerFacing(err: unknown) {
  const message = String((err as Error)?.message ?? err);
  if (/\b429\b|rate.?limit|overloaded|capacity|unavailable/i.test(message)) {
    return new Error("the writers' room is overloaded right now — give it a minute and try again");
  }
  if (/\b(401|403)\b/.test(message)) return new Error("the writers' room isn't answering (the server's API key was rejected)");
  return err;
}

/** One chat completion on fal, returning the parsed JSON object. */
async function falChatJSON<T>(model: string, system: string, user: string, label: string): Promise<T> {
  const falModel = falModelFor(model);
  const input = {
    model: falModel,
    system_prompt: system,
    prompt: user,
    temperature: 0.8,
    max_tokens: 2048,
    // A player is waiting at the prompt, so pay fal's latency-optimised path rather than the throughput one.
    priority: "latency",
  };
  return traced(
    "llm",
    `${label} · fal ${falModel} (GMI fallback)`,
    input,
    async () => {
      const { result } = await runFal("fal-ai/any-llm", input);
      const text: string = result.output ?? "";
      if (result.error) throw new Error(`fal any-llm: ${String(result.error).slice(0, 200)}`);
      const braces = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      if (!braces) throw new Error(`fal any-llm returned no JSON: ${text.slice(0, 200)}`);
      return { parsed: JSON.parse(braces) as T, text };
    },
    { summarize: r => r.parsed, cost: r => estimateCost(system + user, r.text) },
  ).then(r => r.parsed);
}

/**
 * A chat completion that must return a JSON object, from whichever provider can serve it.
 * Logged to the debug DB either way, with the serving provider in the label.
 */
export async function chatJSON<T>(model: string, system: string, user: string, label = "LLM call"): Promise<T> {
  const canFallBack = Boolean(keys.fal);

  // GMI was down moments ago: skip straight to fal until the cooldown expires.
  if (canFallBack && Date.now() < skipGmiUntil) {
    try {
      return await falChatJSON<T>(model, system, user, label);
    } catch (err) {
      // fal is failing too, so stop avoiding GMI - it may well have recovered while we were not looking.
      skipGmiUntil = 0;
      throw playerFacing(err);
    }
  }

  try {
    return await gmiChatJSON<T>(model, system, user, label);
  } catch (err) {
    if (!canFallBack || !isCapacityFailure(err)) throw playerFacing(err);
    const cooldown = Math.min(err instanceof RetryableHttpError && err.retryAfterMs ? err.retryAfterMs : DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
    skipGmiUntil = Date.now() + cooldown;
    logEvent({
      kind: "llm",
      label: "GMI unavailable — falling back to fal",
      response: { reason: String((err as Error)?.message ?? err).slice(0, 200), skippingGmiForSecs: Math.round(cooldown / 1000) },
    });
    try {
      return await falChatJSON<T>(model, system, user, label);
    } catch (fallbackErr) {
      logEvent({ kind: "error", label: "both LLM providers failed", status: "error", response: String((fallbackErr as Error)?.message ?? fallbackErr).slice(0, 300) });
      throw playerFacing(fallbackErr);
    }
  }
}

/** Whether the fallback is currently carrying the game, for the admin panel. */
export const llmFallbackActive = () => Date.now() < skipGmiUntil;
