import { getSettings, type Settings } from "./config";
import { quoteBoth, type PurchaseMode, type Quote, type VideoProvider } from "./constants";

export { STRIPE_MIN_CHARGE_USD, type Quote } from "./constants";
import { db, tryQuery } from "./db";
import { FAL_H3_MAX_USD_PER_SEC } from "./falVideo";
import { falTurboUsdPerSec } from "./falTurboVideo";
import { GMI_H3_USD_PER_SEC } from "./gmiVideo";

/**
 * What a generation costs us, and so what a pack of them should sell for.
 *
 * The cost side is built from the same figures the rest of the server already records: the video provider's
 * list rate for one step (a list rate, not a trailing average, so a price change such as the fal turbo promo
 * ending shows up the day it happens), plus the measured LLM spend per step on GMI. The price itself is
 * worked out by quotePack in constants.ts, which the admin panel shares.
 */

/** Recent enough to reflect the current models and prompts, long enough to smooth out a quiet day. */
const WINDOW_DAYS = 14;
/** Used until there is enough history to measure. Roughly what LLM 1 + LLM 2 + the cache match cost. */
const FALLBACK_LLM_PER_STEP = 0.005;

/** List price of one generated step on each provider, at the clip lengths the pipeline asks for. */
export function videoCostPerStep(provider: VideoProvider, settings: Settings = getSettings()) {
  switch (provider) {
    case "fal-turbo":
      return 15 * falTurboUsdPerSec();
    case "fal-turbo-half":
      return 8 * falTurboUsdPerSec(); // generated as 8s at 2x, stretched on playback
    case "fal":
      return 15 * FAL_H3_MAX_USD_PER_SEC;
    case "gmi":
      return 15 * GMI_H3_USD_PER_SEC;
    case "machgen":
      return 15 * 0.05; // R2V with reference images
    case "masky":
      return 15 * (settings.maskyDraft ? 0.015 : 0.025);
  }
}

const since = () => new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

/** Average LLM spend per step that reached the model, over the recent window. */
function measuredLlmPerStep() {
  const row = tryQuery(
    () =>
      db
        .query<{ spent: number | null; steps: number }, [string]>(
          `SELECT SUM(cost_usd) AS spent, COUNT(DISTINCT job_id) AS steps
           FROM events WHERE kind = 'llm' AND cost_usd IS NOT NULL AND job_id IS NOT NULL AND ts >= ?`,
        )
        .get(since()),
    null,
    "llm cost per step",
  );
  if (!row || row.steps < 5 || row.spent === null) return { usd: FALLBACK_LLM_PER_STEP, measured: false, samples: row?.steps ?? 0 };
  return { usd: row.spent / row.steps, measured: true, samples: row.steps };
}

/** How many generated steps a finished game takes, measured: completed steps over endings (fails + escapes). */
function measuredStepsPerGame(settings: Settings) {
  const row = tryQuery(
    () =>
      db
        .query<{ steps: number; endings: number }, [string]>(
          `SELECT COUNT(*) AS steps,
                  SUM(json_extract(data, '$.node.outcome') IN ('fail', 'escaped')) AS endings
           FROM jobs WHERE status = 'done' AND json_extract(data, '$.node.outcome') IN ('success', 'fail', 'escaped') AND created_at >= ?`,
        )
        .get(since()),
    null,
    "steps per game",
  );
  // A full successful run is promptsTillSuccess steps; an average game ends sooner, but guessing long is the
  // safe side of a price.
  if (!row || (row.endings ?? 0) < 5) return { steps: settings.promptsTillSuccess, measured: false, samples: row?.endings ?? 0 };
  return { steps: row.steps / row.endings, measured: true, samples: row.endings };
}

/** The whole calculation, for the admin panel: every input, and the price it produces for each model. */
export function pricingReport(s: Settings = getSettings()) {
  const video = s.liveVideo ? videoCostPerStep(s.videoProvider, s) : 0;
  const llm = measuredLlmPerStep();
  const game = measuredStepsPerGame(s);
  const perGeneration = video + llm.usd;
  return {
    inputs: {
      provider: s.liveVideo ? s.videoProvider : "none (video off)",
      videoPerStepUsd: video,
      llmPerStepUsd: llm.usd,
      llmMeasured: llm.measured,
      llmSamples: llm.samples,
      costPerGenerationUsd: perGeneration,
      stepsPerGame: game.steps,
      stepsMeasured: game.measured,
      stepSamples: game.samples,
      windowDays: WINDOW_DAYS,
    },
    ...quoteBoth(perGeneration, game.steps, s),
  };
}

/** What is on sale right now, or null when purchasing is off. The price a player sees and is charged. */
export function currentOffer(s: Settings = getSettings()): Quote | null {
  if (s.purchaseMode === "off") return null;
  return pricingReport(s)[s.purchaseMode];
}
