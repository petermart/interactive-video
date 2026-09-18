import { timingSafeEqual } from "node:crypto";
import { keys } from "./config";
import { libraryStats } from "./actionCache";
import type { VideoProvider } from "./constants";
import { db, logEvent, tryExec } from "./db";
import { storageUsage } from "./storage";
import { dbBytes } from "./retention";

/** Stop generating videos automatically once the active video provider drops below this balance. */
export const MIN_BALANCE_USD = 10;
/** Kept for existing callers. */
export const MACHGEN_MIN_BALANCE_USD = MIN_BALANCE_USD;

/**
 * GMI only exposes its credit balance on the web console (its billing API rejects API keys), so we estimate:
 * the balance read from the console at `at`, minus the spend logged since then (LLM calls from the debug
 * events, video generations from the durable ledger below).
 * Update this when you check https://console.gmicloud.ai/user-setting/credits-coupons.
 */
export const GMI_BALANCE_BASELINE = { usd: 300.0, at: "2026-09-18T03:30:00.000Z" };

/**
 * GMI video spend, kept apart from the debug events on purpose: those are pruned after a week, and a
 * $1.20 clip dropping out of the sum would quietly inflate the balance estimate the credit guard trusts.
 */
tryExec("gmi spend ledger", `
  CREATE TABLE IF NOT EXISTS gmi_spend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    kind TEXT NOT NULL,
    label TEXT,
    cost_usd REAL NOT NULL
  );
`);

export function recordGmiSpend(kind: string, costUsd: number, label?: string) {
  db.query(`INSERT INTO gmi_spend (kind, label, cost_usd) VALUES (?, ?, ?)`).run(kind, label ?? null, costUsd);
}

/**
 * The admin password, from ADMIN_PASSWORD when set.
 *
 * Without it the server falls back to the original hackathon password, whose value is public: the repo is
 * open source and it appears in the git history. That was tolerable when admin only showed balances, but
 * admin now controls paid generation, the sign-in gate and OAuth credentials, so the panel warns loudly
 * until a real one is set. Falling back rather than refusing keeps an existing deployment manageable.
 */
const LEGACY_ADMIN_PASSWORD_SHA256 = "a56f3dbc3053cc78282ebb4360025187945043453f94099157496b76530a404d";
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const ADMIN_PASSWORD_SHA256 = process.env.ADMIN_PASSWORD ? sha256(process.env.ADMIN_PASSWORD) : LEGACY_ADMIN_PASSWORD_SHA256;

/** True while the publicly known fallback password is still the one in force. */
export const adminPasswordIsPublicDefault = () => !process.env.ADMIN_PASSWORD;

export function checkAdminPassword(password: unknown) {
  if (typeof password !== "string") return false;
  const given = Buffer.from(sha256(password));
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

// ---------- fal ----------

type FalBalance = { balanceUsd: number | null; currency?: string; configured: boolean; error?: string };
let falCache: { at: number; value: FalBalance } | null = null;

/**
 * fal credit balance. fal only reveals it to an Admin-scope key (a normal key gets 403), so this needs the
 * optional `falAdmin` key; without one it reports "not configured" and fal generation is never paused.
 * Cached for 30s, like MachGen's.
 */
export async function falBalance(force = false): Promise<FalBalance> {
  if (!keys.falAdmin) return { balanceUsd: null, configured: false };
  if (!force && falCache && Date.now() - falCache.at < 30_000) return falCache.value;
  let value: FalBalance;
  try {
    const res = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
      headers: { Authorization: `Key ${keys.falAdmin}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json();
    if (!res.ok) throw new Error(`fal billing ${res.status}: ${body?.error?.message ?? ""}`.trim());
    value = { balanceUsd: Number(body.credits?.current_balance), currency: body.credits?.currency, configured: true };
  } catch (err) {
    // Unknown balance: keep generating rather than block play on a flaky billing call, but surface the error.
    value = { balanceUsd: null, configured: true, error: String((err as Error)?.message ?? err) };
  }
  falCache = { at: Date.now(), value };
  return value;
}

/** False once the provider is below the minimum: the pipeline then runs without generating videos. */
export async function videoGenerationAllowed(provider: VideoProvider = "machgen") {
  if (provider === "gmi") return gmiEstimate().estimatedUsd >= MIN_BALANCE_USD;
  if (provider === "fal" || provider === "fal-turbo") {
    const { balanceUsd } = await falBalance();
    return balanceUsd === null || balanceUsd >= MIN_BALANCE_USD;
  }
  // Masky has no balance API: topped up by hand, so there is nothing to check against.
  if (provider === "masky") return true;
  const { balanceUsd } = await machgenBalance();
  return balanceUsd === null || balanceUsd >= MIN_BALANCE_USD;
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
  const video = db
    .query<{ spent: number | null; clips: number }, [string]>(`SELECT SUM(cost_usd) AS spent, COUNT(*) AS clips FROM gmi_spend WHERE ts >= ?`)
    .get(GMI_BALANCE_BASELINE.at);
  const llmSpent = row?.spent ?? 0;
  const videoSpent = video?.spent ?? 0;
  const spent = llmSpent + videoSpent;
  const estimatedUsd = Math.max(0, GMI_BALANCE_BASELINE.usd - spent);
  return {
    estimatedUsd,
    baselineUsd: GMI_BALANCE_BASELINE.usd,
    baselineAt: GMI_BALANCE_BASELINE.at,
    spentSinceBaselineUsd: spent,
    llmSpentUsd: llmSpent,
    videoSpentUsd: videoSpent,
    videoClips: video?.clips ?? 0,
    costedCalls: row?.calls ?? 0,
    minBalanceUsd: MIN_BALANCE_USD,
    generationPaused: estimatedUsd < MIN_BALANCE_USD,
  };
}

export async function creditsReport() {
  const [machgen, fal] = await Promise.all([machgenBalance(true), falBalance(true)]);
  return {
    fal: {
      ...fal,
      minBalanceUsd: MIN_BALANCE_USD,
      generationPaused: fal.balanceUsd !== null && fal.balanceUsd < MIN_BALANCE_USD,
    },
    machgen: {
      ...machgen,
      minBalanceUsd: MACHGEN_MIN_BALANCE_USD,
      generationPaused: machgen.balanceUsd !== null && machgen.balanceUsd < MACHGEN_MIN_BALANCE_USD,
    },
    gmi: gmiEstimate(),
    library: libraryStats(),
    // Projected Cloudflare usage, always reported so the number is visible before it becomes a problem.
    storage: storageUsage(),
    publicDefaultPassword: adminPasswordIsPublicDefault(),
    dbBytes: dbBytes(),
  };
}
