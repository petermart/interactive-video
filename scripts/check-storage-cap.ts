/**
 * Exercises the storage ledger and the cap without needing 10GB of video.
 *
 *   bun scripts/check-storage-cap.ts
 *
 * Uploads a small object, checks the ledger counted it and costed it, then re-runs the cap check with the
 * ceiling forced down to zero to prove uploads are actually refused rather than merely reported.
 */

import { objectCostUsdPerMonth, storageUsage } from "../src/server/storage";

const show = (label: string, ok: boolean, extra = "") => console.log(`${ok ? "ok  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
let failed = false;

const before = storageUsage();
console.log(`ledger before: ${before.objects} objects, ${before.gb} GB, projected $${before.projectedMonthlyUsd}/mo\n`);

// Cost projection maths, independent of any network call.
const oneGb = objectCostUsdPerMonth(1e9);
show("1 GB costs the R2 storage rate", Math.abs(oneGb - 0.015) < 1e-9, `$${oneGb}/mo`);
failed ||= Math.abs(oneGb - 0.015) > 1e-9;

const typicalClip = objectCostUsdPerMonth(1.5e6);
show("a ~1.5 MB clip is costed", typicalClip > 0, `$${typicalClip.toFixed(6)}/mo each`);

// Under the free tier the projection must be exactly zero, not a small positive number.
show("projection is zero inside the free tier", before.gb < before.freeTierGb ? before.projectedMonthlyUsd === 0 : true,
  `${before.gb} GB of ${before.freeTierGb} GB free`);
failed ||= before.gb < before.freeTierGb && before.projectedMonthlyUsd !== 0;

// Live upload through the real client, so the ledger path is exercised end to end.
const { putBytes, deleteObject, r2Enabled } = await import("../src/server/storage");
if (r2Enabled()) {
  const key = `healthcheck/ledger-${crypto.randomUUID()}.txt`;
  const body = new TextEncoder().encode("x".repeat(4096));
  const ok = await putBytes(key, body);
  show("upload accepted under the cap", ok);
  const mid = storageUsage();
  const counted = mid.objects === before.objects + 1 && mid.bytes === before.bytes + 4096;
  show("ledger counted the object", counted, `${before.objects} → ${mid.objects} objects, +${mid.bytes - before.bytes} bytes`);
  failed ||= !ok || !counted;

  await deleteObject(key);
  const after = storageUsage();
  const cleaned = after.objects === before.objects && after.bytes === before.bytes;
  show("delete removed it from the ledger", cleaned, `back to ${after.objects} objects`);
  failed ||= !cleaned;
} else {
  console.log("skip  live upload — R2 not configured");
}

// Force the cap to zero in a child process: every upload must then be refused.
const proc = Bun.spawn(["bun", "-e", `
  const { putBytes, storageFull } = await import("./src/server/storage");
  const blocked = !(await putBytes("healthcheck/should-be-refused.txt", new TextEncoder().encode("nope")));
  console.log(JSON.stringify({ full: storageFull(), blocked }));
`], { env: { ...process.env, R2_MAX_GB: "0" }, stdout: "pipe", stderr: "pipe" });
const out = (await new Response(proc.stdout).text()).trim().split("\n").pop() ?? "{}";
await proc.exited;
const capped = JSON.parse(out || "{}");
show("cap reports full at R2_MAX_GB=0", capped.full === true);
show("upload refused when over cap", capped.blocked === true);
failed ||= capped.full !== true || capped.blocked !== true;

console.log(failed ? "\nSomething is wrong — see above." : "\nLedger, cost projection and cap all behave.");
process.exit(failed ? 1 : 0);
