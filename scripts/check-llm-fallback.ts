/**
 * Exercises the LLM fallback: one tiny prompt through chatJSON, then a second to prove the cooldown sends
 * the next call straight to fal instead of paying the round trip to a provider we know is down.
 *
 *   bun scripts/check-llm-fallback.ts
 *
 * Costs a fraction of a cent on fal when GMI is unavailable, and nothing at all when GMI is healthy.
 */
import { getSettings } from "../src/server/config";
import { db } from "../src/server/db";
import { chatJSON, llmFallbackActive } from "../src/server/llm";

const SYSTEM = 'You answer with JSON only, in the form {"ok":true,"who":"<one word naming the model family>"}.';
const USER = "Reply with the JSON object and nothing else.";

const since = (db.query<{ id: number }, []>(`SELECT COALESCE(MAX(id), 0) AS id FROM events`).get()?.id ?? 0) as number;
const model = getSettings().analysisModel;

const time = async (label: string) => {
  const t0 = performance.now();
  try {
    const out = await chatJSON<{ ok: boolean; who: string }>(model, SYSTEM, USER, label);
    return { secs: ((performance.now() - t0) / 1000).toFixed(2), out };
  } catch (err) {
    return { secs: ((performance.now() - t0) / 1000).toFixed(2), error: String((err as Error)?.message ?? err) };
  }
};

console.log(`asking for ${model} …`);
console.log("first call: ", JSON.stringify(await time("fallback check 1")));
console.log("fallback engaged:", llmFallbackActive());
console.log("second call:", JSON.stringify(await time("fallback check 2")));

console.log("\nwhat the debug log recorded:");
for (const e of db
  .query<{ kind: string; label: string; status: string; duration_ms: number | null; cost_usd: number | null; response: string | null }, [number]>(
    `SELECT kind, label, status, duration_ms, cost_usd, response FROM events WHERE id > ? ORDER BY id`,
  )
  .all(since)) {
  const cost = e.cost_usd ? ` $${e.cost_usd}` : "";
  console.log(` [${e.status}] ${e.label} (${e.duration_ms ?? "-"}ms)${cost}  ${String(e.response ?? "").slice(0, 120)}`);
}
process.exit(0);
