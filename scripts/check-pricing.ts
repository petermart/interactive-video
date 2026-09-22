/**
 * Verifies the price calculation and the Stripe webhook signature check, with no network and no Stripe account.
 *
 *   bun scripts/check-pricing.ts
 */

import { createHmac } from "node:crypto";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_check_pricing";
process.env.STRIPE_SECRET_KEY = "sk_test_check_pricing";

const { getSettings } = await import("../src/server/config");
const { pricingReport, STRIPE_MIN_CHARGE_USD } = await import("../src/server/pricing");
const { verifyWebhook } = await import("../src/server/stripe");

let failed = false;
const check = (label: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  failed ||= !ok;
};
const near = (a: number, b: number, tolerance = 0.011) => Math.abs(a - b) <= tolerance;

const base = { ...getSettings(), liveVideo: true, videoProvider: "fal" as const, stripeFeePercent: 2.9, stripeFeeFixedUsd: 0.3 };

// The profit asked for is what is left after Stripe and the cost (rounding up to the cent can only add).
for (const profit of [0.1, 0, -0.2]) {
  const r = pricingReport({ ...base, packGenerations: 10, profitPerGenerationUsd: profit });
  const q = r.generations;
  check(`profit ${profit}: price leaves the asked-for profit per generation`, q.profitPerGenerationUsd >= profit - 1e-9 && near(q.profitPerGenerationUsd, profit), `got ${q.profitPerGenerationUsd.toFixed(4)} on a $${q.priceUsd} pack`);
  check(`profit ${profit}: Stripe's fee is taken on the final price`, near(q.stripeFeeUsd, q.priceUsd * 0.029 + 0.3, 1e-9));
}

// fal H3 Max is $0.75 a step, so ten of them at $0.10 profit must cover $7.50 + $1.00 + Stripe.
{
  const q = pricingReport({ ...base, packGenerations: 10, profitPerGenerationUsd: 0.1 }).generations;
  check("10 fal generations cost at least $7.50 to make", q.costUsd >= 7.5, `$${q.costUsd.toFixed(3)}`);
  check("and sell for more than cost plus profit plus fees", q.priceUsd > 8.5 + 0.3, `$${q.priceUsd}`);
}

// Stripe's fixed fee makes single cheap units a loss unless the price absorbs it - the price must always absorb it.
{
  const q = pricingReport({ ...base, liveVideo: false, packGenerations: 1, profitPerGenerationUsd: 0 }).generations;
  check("a one-generation text-only pack is raised to Stripe's minimum", q.priceUsd === STRIPE_MIN_CHARGE_USD, `$${q.priceUsd}`);
  check("and is not a loss at zero profit", q.profitUsd >= 0, `profit $${q.profitUsd.toFixed(3)}`);
}

// A game is priced as steps-per-game generations.
{
  const r = pricingReport({ ...base, packGames: 1, profitPerGenerationUsd: 0.1 });
  check("a game costs steps-per-game generations", near(r.games.costUsd, r.inputs.costPerGenerationUsd * r.inputs.stepsPerGame, 1e-9));
  check("and its profit per generation matches the setting", near(r.games.profitPerGenerationUsd, 0.1, 0.01), r.games.profitPerGenerationUsd.toFixed(4));
}

// Webhook signatures
{
  const body = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_test_1" } } });
  const sign = (t: number, payload = body, secret = process.env.STRIPE_WEBHOOK_SECRET!) =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  check("a correctly signed webhook is accepted", verifyWebhook(body, sign(now)));
  check("a tampered body is refused", !verifyWebhook(body.replace("cs_test_1", "cs_test_2"), sign(now)));
  check("the wrong secret is refused", !verifyWebhook(body, sign(now, body, "whsec_someone_else")));
  check("an old (replayed) signature is refused", !verifyWebhook(body, sign(now - 3600)));
  check("no signature is refused", !verifyWebhook(body, null));
}

console.log(failed ? "\nSomething is wrong — see above." : "\nPricing and webhooks behave.");
process.exit(failed ? 1 : 0);
