/**
 * Proves the R2 credentials and bucket actually work, end to end, before anything depends on them.
 *
 *   bun scripts/check-r2.ts
 *
 * Writes a tiny object, confirms it exists, signs a URL, fetches it back over plain HTTPS, then deletes it.
 * The fetch is the part that matters: it is exactly what a viewer's browser does after the 302 redirect,
 * so a pass here means playback works rather than merely that the credentials parse.
 *
 * Never prints the secret.
 */

import { deleteObject, objectExists, presignGet, putBytes, r2Enabled } from "../src/server/storage";

const show = (label: string, ok: boolean, extra = "") => console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);

if (!r2Enabled()) {
  console.error("R2 is not configured: check R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.");
  process.exit(1);
}
console.log(`bucket: ${process.env.R2_BUCKET}\naccount: ${process.env.R2_ACCOUNT_ID}\n`);

const key = `healthcheck/${crypto.randomUUID()}.txt`;
const body = new TextEncoder().encode(`slop-prison r2 check ${new Date().toISOString()}`);
let failed = false;

try {
  await putBytes(key, body);
  show("upload (Class A write)", true, key);

  const exists = await objectExists(key);
  show("exists (HeadObject)", exists);
  failed ||= !exists;

  const url = presignGet(key, 120);
  show("presign", Boolean(url), url ? `${url.slice(0, 60)}…` : "no url");

  // The real test: fetch it as an unauthenticated client would, following the signature only.
  const res = await fetch(url!);
  const text = await res.text();
  const roundTripped = res.ok && text === new TextDecoder().decode(body);
  show("signed GET round-trip", roundTripped, `HTTP ${res.status}`);
  failed ||= !roundTripped;

  // A private bucket must refuse the same object without a signature.
  const naked = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${key}`;
  const unsigned = await fetch(naked).catch(() => null);
  const isPrivate = !unsigned || !unsigned.ok;
  show("unsigned GET refused (bucket is private)", isPrivate, unsigned ? `HTTP ${unsigned.status}` : "request failed");
  failed ||= !isPrivate;
} catch (err) {
  console.error(`\nthrew: ${String(err)}`);
  failed = true;
} finally {
  await deleteObject(key);
  show("cleanup delete", true);
}

console.log(failed ? "\nSomething is wrong — see above." : "\nAll good: uploads, signed playback and privacy all work.");
process.exit(failed ? 1 : 0);
