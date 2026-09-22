import { useEffect, useRef, useState } from "react";
import { PACK_MAX, PURCHASE_MODES, quoteBoth, type PriceSettings, type PurchaseMode, type Quote } from "../server/constants";
import type { Settings } from "./api";
import { apiFetch } from "./viewer";

type Report = {
  inputs: {
    provider: string;
    videoPerStepUsd: number;
    llmPerStepUsd: number;
    llmMeasured: boolean;
    llmSamples: number;
    costPerGenerationUsd: number;
    stepsPerGame: number;
    stepsMeasured: boolean;
    stepSamples: number;
    windowDays: number;
  };
  stripe: { enabled: boolean; testMode: boolean; hasSecretKey: boolean; hasWebhookSecret: boolean };
  sales: { purchases: number; revenue_cents: number | null; buyers: number } | null;
};

const MODE_LABELS: Record<PurchaseMode, string> = { off: "Off", generations: "Per gen", games: "Per game" };

/** Sub-cent LLM costs need more places than a price does. */
const usd = (n: number, places = 2) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(places)}`;

/** The fields typed into here, kept as text while editing so "-" and "0." survive on the way to "-0.05". */
type Draft = Record<keyof PriceSettings, string>;
const PRICE_FIELDS: (keyof PriceSettings)[] = ["packGenerations", "packGames", "profitPerGenerationUsd", "stripeFeePercent", "stripeFeeFixedUsd"];
const toDraft = (s: Settings): Draft => Object.fromEntries(PRICE_FIELDS.map(k => [k, String(s[k])])) as Draft;

/**
 * Paid top-ups: which model is on sale, and what it costs. The price is never typed in - it is worked out from
 * the profit wanted per generation, over the measured cost of a generation and Stripe's fee, and the
 * breakdown underneath shows every number that went into it so a loss is visible before it is charged.
 *
 * The breakdown is repriced in the browser on every keystroke, with the same quotePack the server charges by;
 * only the costs come from the server, and those change with the provider, not with these fields.
 */
export function AdminPricing({ settings, password, save }: { settings: Settings; password: string; save: (patch: Partial<Settings>) => void }) {
  const [costs, setCosts] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  /** Saves waiting for typing to pause, one per field, so moving to the next field never cancels the last. */
  const pending = useRef(new Map<keyof PriceSettings, ReturnType<typeof setTimeout>>());

  // What the server now holds replaces the draft - unless a save of the draft is still waiting to go.
  useEffect(() => {
    if (!pending.current.size) setDraft(toDraft(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, PRICE_FIELDS.map(k => settings[k]));

  useEffect(() => {
    apiFetch("/api/admin/pricing", { method: "POST", body: JSON.stringify({ password }) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(r => {
        setCosts(r);
        setError("");
      })
      .catch(err => setError((err as Error).message));
  }, [password, settings.videoProvider, settings.liveVideo, settings.maskyDraft, settings.promptsTillSuccess, settings.purchaseMode]);

  /** A typed value as a number, or the saved one while the text is not a number yet ("-", ""). */
  const numberOf = (key: keyof PriceSettings) => {
    const n = Number(draft[key]);
    return draft[key].trim() !== "" && Number.isFinite(n) ? n : settings[key];
  };
  const live: PriceSettings = {
    packGenerations: Math.max(1, Math.round(numberOf("packGenerations"))),
    packGames: Math.max(1, Math.round(numberOf("packGames"))),
    profitPerGenerationUsd: numberOf("profitPerGenerationUsd"),
    stripeFeePercent: Math.min(99, Math.max(0, numberOf("stripeFeePercent"))),
    stripeFeeFixedUsd: Math.max(0, numberOf("stripeFeeFixedUsd")),
  };

  const edit = (key: keyof PriceSettings, text: string) => {
    const next = { ...draft, [key]: text };
    setDraft(next);
    // Saved once typing pauses, not per keystroke: each save is a request and a settings-file write.
    clearTimeout(pending.current.get(key));
    pending.current.set(
      key,
      setTimeout(() => {
        pending.current.delete(key);
        const n = Number(text);
        if (text.trim() !== "" && Number.isFinite(n) && n !== settings[key]) save({ [key]: n });
      }, 600),
    );
  };

  const number = (key: keyof PriceSettings, opts: { step: number; min?: number; max?: number; width?: string; label: string }) => (
    <input
      type="number"
      step={opts.step}
      min={opts.min}
      max={opts.max}
      value={draft[key]}
      aria-label={opts.label}
      onChange={e => edit(key, e.target.value)}
      className={`${opts.width ?? "w-16"} rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-right text-xs text-white`}
    />
  );

  const row = (label: string, control: React.ReactNode) => (
    <label className="mt-1 flex items-center justify-between gap-3 text-xs text-white/60">
      <span>{label}</span>
      {control}
    </label>
  );

  return (
    <div className="mb-3">
      <div className="text-white/70">Paid top-ups (Stripe)</div>
      <div className="mt-1 grid grid-cols-3 overflow-hidden rounded border border-white/15">
        {PURCHASE_MODES.map(mode => (
          <button
            key={mode}
            onClick={() => save({ purchaseMode: mode })}
            className={`py-1.5 text-xs uppercase tracking-widest transition ${
              settings.purchaseMode === mode ? "bg-sodium font-semibold text-black" : "text-white/60 hover:bg-white/10"
            }`}
          >
            {MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      {row("Generations per purchase", number("packGenerations", { step: 1, min: 1, max: PACK_MAX, label: "Generations per purchase" }))}
      {row("Games per purchase", number("packGames", { step: 1, min: 1, max: PACK_MAX, label: "Games per purchase" }))}
      {row("Profit per generation ($, − = loss)", number("profitPerGenerationUsd", { step: 0.01, label: "Profit per generation" }))}
      {row(
        "Stripe fee",
        <span className="flex items-center gap-1 text-[11px] text-white/40">
          {number("stripeFeePercent", { step: 0.1, min: 0, max: 20, width: "w-12", label: "Stripe percent fee" })}% +
          {number("stripeFeeFixedUsd", { step: 0.01, min: 0, max: 5, width: "w-12", label: "Stripe fixed fee" })}
        </span>,
      )}

      {error && <div className="mt-2 text-xs text-siren-red">Couldn't price: {error}</div>}
      {costs && (
        <Breakdown report={costs} quotes={quoteBoth(costs.inputs.costPerGenerationUsd, costs.inputs.stepsPerGame, live)} active={settings.purchaseMode} />
      )}
    </div>
  );
}

function Breakdown({ report, quotes, active }: { report: Report; quotes: ReturnType<typeof quoteBoth>; active: PurchaseMode }) {
  const { inputs, stripe, sales } = report;
  const line = (label: string, value: string, tone = "text-white/70") => (
    <div className="flex justify-between gap-2">
      <span className="text-white/40">{label}</span>
      <span className={tone}>{value}</span>
    </div>
  );
  const quote = (title: string, q: Quote, unit: string, on: boolean) => {
    const tone = q.profitUsd < 0 ? "text-siren-red" : "text-teal";
    return (
      <div className={`rounded border p-2 ${on ? "border-sodium/60 bg-sodium/5" : "border-white/10"}`}>
        <div className="mb-1 flex justify-between text-[11px]">
          <span className={on ? "font-semibold text-sodium" : "text-white/60"}>{title}</span>
          <span className="text-white">{usd(q.priceUsd)}</span>
        </div>
        {line("Stripe fee", `−${usd(q.stripeFeeUsd)}`)}
        {line("Generation cost", `−${usd(q.costUsd)}`)}
        {line(q.profitUsd < 0 ? "Loss per purchase" : "Profit per purchase", usd(q.profitUsd), tone)}
        {line(`… per ${unit}`, usd(q.profitPerUnitUsd), tone)}
        {unit !== "generation" && line("… per generation", usd(q.profitPerGenerationUsd, 3), tone)}
      </div>
    );
  };

  return (
    <div className="mt-2 space-y-2 font-mono text-[10px]">
      <div className="rounded border border-white/10 p-2">
        <div className="mb-1 text-[11px] text-white/60">Cost of one generation</div>
        {line(`Video (${inputs.provider}, list rate)`, usd(inputs.videoPerStepUsd, 3))}
        {line(`LLM on GMI (${inputs.llmMeasured ? `avg of ${inputs.llmSamples} steps, ${inputs.windowDays}d` : "estimate, too few steps"})`, usd(inputs.llmPerStepUsd, 4))}
        {line("Total per generation", usd(inputs.costPerGenerationUsd, 3), "text-white")}
        {line(
          `Steps per game (${inputs.stepsMeasured ? `avg of ${inputs.stepSamples} endings` : "full run, too few endings"})`,
          inputs.stepsPerGame.toFixed(1),
        )}
      </div>
      {quote(`${quotes.generations.units} generation${quotes.generations.units === 1 ? "" : "s"}`, quotes.generations, "generation", active === "generations")}
      {quote(`${quotes.games.units} game${quotes.games.units === 1 ? "" : "s"}`, quotes.games, "game", active === "games")}
      <p className="leading-relaxed text-white/35">
        Price = (units × (cost + profit) + fixed fee) ÷ (1 − % fee), rounded up to the cent, $0.50 minimum. Archive
        reuse is not counted as a saving, so real margins run a little higher.
      </p>
      {!stripe.enabled ? (
        <div className="rounded border border-sodium/40 bg-sodium/10 p-2 text-sodium">
          <b>Not on sale yet.</b> Set {[!stripe.hasSecretKey && "STRIPE_SECRET_KEY", !stripe.hasWebhookSecret && "STRIPE_WEBHOOK_SECRET"].filter(Boolean).join(" and ")} on the
          server. Players see no offer until both are set.
        </div>
      ) : (
        line("Stripe", stripe.testMode ? "connected (test mode)" : "connected (live)", stripe.testMode ? "text-sodium" : "text-teal")
      )}
      {sales && sales.purchases > 0 && line("Sales so far", `${sales.purchases} from ${sales.buyers} buyer${sales.buyers === 1 ? "" : "s"} · ${usd((sales.revenue_cents ?? 0) / 100)}`)}
    </div>
  );
}
