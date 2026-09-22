import { createHmac, timingSafeEqual } from "node:crypto";
import { logEvent } from "./db";
import type { Quote } from "./pricing";

/**
 * Stripe Checkout, spoken to over its REST API rather than through the SDK: two calls do not justify a
 * dependency. The flow is the hosted one, so card details never touch this server:
 *
 *   1. POST /api/checkout   -> we create a Checkout Session for the current offer and send the browser to it
 *   2. the player pays on stripe.com and comes back to /?purchase=success
 *   3. Stripe POSTs checkout.session.completed to /api/stripe/webhook -> we verify it and credit the account
 *
 * Crediting happens only in step 3. The return URL is just a page load: anyone can type it, so it grants
 * nothing.
 *
 * Needs STRIPE_SECRET_KEY (sk_test_... while testing) and STRIPE_WEBHOOK_SECRET (whsec_..., from the
 * webhook endpoint in the Stripe dashboard, or printed by `stripe listen` locally).
 */

const secretKey = () => process.env.STRIPE_SECRET_KEY?.trim() || null;
const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET?.trim() || null;

/** Both keys are needed: a checkout nobody is told about would take money and credit nothing. */
export const stripeEnabled = () => Boolean(secretKey() && webhookSecret());
export const stripeTestMode = () => secretKey()?.startsWith("sk_test_") ?? false;

/** Metadata carried through Stripe so the webhook knows whom to credit and with what. */
export type PurchaseMeta = { ledgerId: string; unit: "generations" | "games"; units: number };

export async function createCheckout(offer: Quote, meta: PurchaseMeta, origin: string) {
  const key = secretKey();
  if (!key) throw new Error("Stripe is not configured");
  const name = offer.mode === "games" ? `${offer.units} more ${offer.units === 1 ? "game" : "games"}` : `${offer.units} more generations`;
  const form = new URLSearchParams({
    mode: "payment",
    success_url: `${origin}/?purchase=success`,
    cancel_url: `${origin}/?purchase=cancelled`,
    client_reference_id: meta.ledgerId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    // The price is worked out at the moment of purchase, so it is sent inline instead of as a saved Price.
    "line_items[0][price_data][unit_amount]": String(Math.round(offer.priceUsd * 100)),
    "line_items[0][price_data][product_data][name]": `Escape from Slop Prison: ${name}`,
    "metadata[ledgerId]": meta.ledgerId,
    "metadata[unit]": meta.unit,
    "metadata[units]": String(meta.units),
  });
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !body.url) {
    logEvent({ kind: "error", label: "Stripe checkout failed", status: "error", response: body.error?.message ?? res.status });
    throw new Error(body.error?.message ?? `Stripe answered ${res.status}`);
  }
  return { id: body.id!, url: body.url };
}

/** How old a signed webhook may be before it is treated as a replay. Stripe's own libraries use 5 minutes. */
const TOLERANCE_SECS = 300;

/**
 * Checks the Stripe-Signature header: `t=<unix>,v1=<hex hmac>[,v1=...]`, where the HMAC is SHA-256 over
 * `${t}.${rawBody}` keyed with the webhook secret. Must be given the body exactly as received.
 */
export function verifyWebhook(rawBody: string, header: string | null): boolean {
  const secret = webhookSecret();
  if (!secret || !header) return false;
  const parts = header.split(",").map(p => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SECS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  return signatures.some(sig => {
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** The parts of a completed Checkout Session the webhook acts on. */
export type CompletedCheckout = {
  id: string;
  payment_status: string;
  amount_total: number | null;
  currency: string | null;
  metadata: Partial<Record<keyof PurchaseMeta, string>>;
};
