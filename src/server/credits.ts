import { timingSafeEqual } from "node:crypto";
import { keys } from "./config";
import { db, logEvent } from "./db";

/** Stop generating videos automatically once MachGen drops below this balance. */
export const MACHGEN_MIN_BALANCE_USD = 10;

/**
 * GMI only exposes its credit balance on the web console (its billing API rejects API keys), so we estimate:
 * the balance read from the console at `at`, minus the LLM spend logged to the debug DB since then.
 * Update this when you check https://console.gmicloud.ai/user-setting/credits-coupons.
 */
export const GMI_BALANCE_BASELINE = { usd: 9.0, at: "2026-09-14T00:00:00.000Z" };

/** SHA-256 of the admin password ("hackathon"). Only the hash is stored. */
const ADMIN_PASSWORD_SHA256 = "a56f3dbc3053cc78282ebb4360025187945043453f94099157496b76530a404d";

export function checkAdminPassword(password: unknown) {
  if (typeof password !== "string") return false;
  const given = Buffer.from(new Bun.CryptoHasher("sha256").update(password).digest("hex"));
  const expected = Buffer.from(ADMIN_PASSWORD_SHA256);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------- MachGen ----------

let machgenCache: { at: number; value: MachgenBalance } | null = null;
type MachgenBalance = { balanceUsd: number | null; pendingTasks: number; runningTasks: number; error?: string };

/** Live MachGen balance, cached for 30s so the public status endpoint can't hammer the billing API. */
export async function machgenBalance(force = false): Promise<MachgenBalance> {
  if (!force && machgenCache && Date.now() - machgenCache.at < 30_000) return machgenCache.value;
  let value: MachgenBalance;
  try {
    const res = await fetch("https://api.machgen.ai/api/v0/billing/account", {
      headers: { Authorization: `Bearer ${keys.machgen}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json();
    if (!res.ok) throw new Error(`MachGen billing ${res.status}`);
    value = { balanceUsd: body.balance_micros / 1e6, pendingTasks: body.pending_tasks ?? 0, runningTasks: body.running_tasks ?? 0 };
  } catch (err) {
    // Unknown balance: keep generating (don't block the demo on a flaky billing call) but surface the error.
    value = { balanceUsd: null, pendingTasks: 0, runningTasks: 0, error: String((err as Error)?.message ?? err) };
  }
  machgenCache = { at: Date.now(), value };
  return value;
}

/** False once MachGen is below the minimum: the pipeline then runs without generating videos. */
export async function videoGenerationAllowed() {
  const { balanceUsd } = await machgenBalance();
  return balanceUsd === null || balanceUsd >= MACHGEN_MIN_BALANCE_USD;
}

// ---------- GMI ----------

let priceCache: { at: number; prices: Map<string, { prompt: number; completion: number }> } | null = null;

/** Per-token prices from GMI's public model list (cached for an hour). */
async function gmiPrices() {
  if (priceCache && Date.now() - priceCache.at < 3_600_000) return priceCache.prices;
  const res = await fetch("https://api.gmi-serving.com/v1/models", { headers: { Authorization: `Bearer ${keys.gmi}` } });
  const body: any = await res.json();
  const prices = new Map<string, { prompt: number; completion: number }>();
  for (const m of body.data ?? []) prices.set(m.id, { prompt: Number(m.pricing?.prompt ?? 0), completion: Number(m.pricing?.completion ?? 0) });
  priceCache = { at: Date.now(), prices };
  return prices;
}

/** USD cost of one chat completion from its token usage, or undefined if prices aren't loaded yet. */
export function gmiCallCost(model: string, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined) {
  const price = priceCache?.prices.get(model);
  if (!price || !usage) return undefined;
  return (usage.prompt_tokens ?? 0) * price.prompt + (usage.completion_tokens ?? 0) * price.completion;
}

/** Warm the price cache at startup so the first LLM calls are costed. */
gmiPrices().catch(err => logEvent({ kind: "error", label: "GMI price list failed", status: "error", response: String(err) }));

export function gmiEstimate() {
  const row = db
    .query<{ spent: number | null; calls: number }, [string]>(
      `SELECT SUM(cost_usd) AS spent, COUNT(*) AS calls FROM events WHERE kind = 'llm' AND status = 'ok' AND cost_usd IS NOT NULL AND ts >= ?`,
    )
    .get(GMI_BALANCE_BASELINE.at);
  const spent = row?.spent ?? 0;
  return {
    estimatedUsd: Math.max(0, GMI_BALANCE_BASELINE.usd - spent),
    baselineUsd: GMI_BALANCE_BASELINE.usd,
    baselineAt: GMI_BALANCE_BASELINE.at,
    spentSinceBaselineUsd: spent,
    costedCalls: row?.calls ?? 0,
  };
}

export async function creditsReport() {
  const machgen = await machgenBalance(true);
  return {
    machgen: {
      ...machgen,
      minBalanceUsd: MACHGEN_MIN_BALANCE_USD,
      generationPaused: machgen.balanceUsd !== null && machgen.balanceUsd < MACHGEN_MIN_BALANCE_USD,
    },
    gmi: gmiEstimate(),
  };
}
