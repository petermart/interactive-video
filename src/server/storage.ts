import { S3Client } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { db, logEvent } from "./db";

/**
 * Object storage for everything this server generates: step clips, stitched exports, share thumbnails and
 * the frames external generators fetch by URL.
 *
 * Why: the deploy container's disk is small and every generated clip used to stay on it forever (the action
 * archive pruned its database rows but never the mp4s), so a busy day filled the volume and ffmpeg started
 * failing. Generated media now lives in R2 and the container keeps only what ffmpeg is actively working on.
 *
 * Credentials are server-side only and are never handed to the browser: the client keeps using the same
 * stable `/media/...` URLs it always did, and the server redirects each one to a freshly signed, short-lived
 * R2 URL. Nothing in the bucket is publicly readable.
 *
 * With no R2 configured (local dev) every helper reports "not enabled" and callers keep using the disk,
 * so `bun dev` still runs without Cloudflare credentials.
 */

const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? "";
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "";
const bucket = process.env.R2_BUCKET ?? "";
/** Either the full endpoint, or just the account id we expand into one. */
const endpoint =
  process.env.R2_ENDPOINT ??
  (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");

const configured = Boolean(accessKeyId && secretAccessKey && bucket && endpoint);

/** R2 speaks S3; Bun ships the client, so this costs no extra dependency. */
const client = configured
  ? new S3Client({ accessKeyId, secretAccessKey, bucket, endpoint, region: "auto" })
  : null;

export const r2Enabled = () => client !== null;

/**
 * How long a signed URL stays valid. These are handed out behind a redirect from a stable app URL, so the
 * link a viewer shares never expires: only the signature it bounces through does, and a reload mints another.
 *
 * Long enough to watch a film without the URL dying mid-playback (browsers re-request ranges while seeking),
 * short enough that a leaked signature is worthless by the time anyone finds it.
 */
export const PRESIGN_TTL_SECONDS = 60 * 60;

/**
 * Local ledger of what we believe is in the bucket.
 *
 * Cloudflare's own dashboard is authoritative but is not something the running server can cheaply ask on
 * every upload, so each write and delete is mirrored here. Summing this table gives a projected bill and a
 * cap that can be enforced synchronously, before a byte is sent.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS stored_objects (
    key TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS stored_objects_kind ON stored_objects(kind);
`);

/** R2 standard storage, USD per GB-month. Egress is free, which is why it is absent from this projection. */
export const R2_USD_PER_GB_MONTH = 0.015;
/** Cloudflare's free allowance. Staying under it means the projected bill is zero. */
export const R2_FREE_TIER_GB = 10;
/** Hard ceiling for uploads. Defaults to the free tier so the bucket cannot grow into a billable month. */
const CAP_GB = Number(process.env.R2_MAX_GB ?? R2_FREE_TIER_GB);
const CAP_BYTES = CAP_GB * 1e9;

/** What one stored object is projected to cost per month at R2's storage rate. */
export const objectCostUsdPerMonth = (bytes: number) => (bytes / 1e9) * R2_USD_PER_GB_MONTH;

const insertObject = db.prepare(
  `INSERT INTO stored_objects (key, bytes, kind) VALUES ($key, $bytes, $kind)
   ON CONFLICT(key) DO UPDATE SET bytes = $bytes`,
);

/** Top-level prefix ("cache", "exports", "frames") so usage can be broken down by what produced it. */
const kindOf = (key: string) => key.split("/")[0] ?? "other";

const recordObject = (key: string, bytes: number) => insertObject.run({ $key: key, $bytes: bytes, $kind: kindOf(key) });
const forgetObject = (key: string) => db.query(`DELETE FROM stored_objects WHERE key = ?`).run(key);

export type StorageUsage = ReturnType<typeof storageUsage>;

/** Projected bucket usage and what it would cost, from the ledger rather than a live API call. */
export function storageUsage() {
  const total = db.query<{ bytes: number | null; objects: number }, []>(
    `SELECT SUM(bytes) AS bytes, COUNT(*) AS objects FROM stored_objects`,
  ).get();
  const byKind = db.query<{ kind: string; bytes: number; objects: number }, []>(
    `SELECT kind, SUM(bytes) AS bytes, COUNT(*) AS objects FROM stored_objects GROUP BY kind ORDER BY bytes DESC`,
  ).all();

  const bytes = total?.bytes ?? 0;
  const gb = bytes / 1e9;
  // Only the part above the free allowance is billable; below it the projection is genuinely zero.
  const billableGb = Math.max(0, gb - R2_FREE_TIER_GB);
  return {
    enabled: r2Enabled(),
    bytes,
    gb: Number(gb.toFixed(3)),
    objects: total?.objects ?? 0,
    freeTierGb: R2_FREE_TIER_GB,
    capGb: CAP_GB,
    percentOfCap: Number(((bytes / CAP_BYTES) * 100).toFixed(1)),
    projectedMonthlyUsd: Number((billableGb * R2_USD_PER_GB_MONTH).toFixed(2)),
    /** What the whole bucket would cost per month if the free tier did not exist, for a sense of scale. */
    grossMonthlyUsd: Number((gb * R2_USD_PER_GB_MONTH).toFixed(2)),
    overCap: bytes >= CAP_BYTES,
    byKind: byKind.map(k => ({ ...k, gb: Number((k.bytes / 1e9).toFixed(3)), monthlyUsd: Number(objectCostUsdPerMonth(k.bytes).toFixed(2)) })),
  };
}

/** True once the ledger says the bucket has hit its ceiling; new uploads are refused past this point. */
export const storageFull = () => storageUsage().bytes >= CAP_BYTES;

let warnedFull = false;
/** Refuses an upload once the cap is reached, logging the first refusal loudly rather than every one. */
function allowUpload(key: string, bytes: number) {
  if (!storageFull()) {
    warnedFull = false;
    return true;
  }
  if (!warnedFull) {
    warnedFull = true;
    logEvent({
      kind: "error",
      label: "R2 storage cap reached — new uploads blocked",
      status: "error",
      response: { capGb: CAP_GB, usage: storageUsage().gb, blockedKey: key, blockedBytes: bytes },
    });
  }
  return false;
}

const contentTypeOf = (key: string) =>
  key.endsWith(".mp4") ? "video/mp4"
  : key.endsWith(".jpg") || key.endsWith(".jpeg") ? "image/jpeg"
  : key.endsWith(".png") ? "image/png"
  : key.endsWith(".mp3") ? "audio/mpeg"
  : "application/octet-stream";

/** Signed GET URL for one object, or null when R2 is not configured. */
export function presignGet(key: string, expiresIn = PRESIGN_TTL_SECONDS) {
  if (!client) return null;
  return client.file(key).presign({ method: "GET", expiresIn });
}

export async function objectExists(key: string) {
  if (!client) return false;
  return client.file(key).exists();
}

/**
 * Uploads bytes under `key`. Content type is inferred from the extension so browsers play rather than download.
 * Returns false when the cap is reached, which tells the caller to keep its own copy instead.
 */
export async function putBytes(key: string, bytes: ArrayBuffer | Uint8Array) {
  if (!client) return false;
  const size = bytes.byteLength;
  if (!allowUpload(key, size)) return false;
  await client.write(key, bytes, { type: contentTypeOf(key) });
  recordObject(key, size);
  return true;
}

/** Uploads a file already on disk. Returns false when the cap is reached. */
export async function putFile(key: string, localPath: string) {
  if (!client) return false;
  const size = Bun.file(localPath).size;
  if (!allowUpload(key, size)) return false;
  await client.write(key, Bun.file(localPath), { type: contentTypeOf(key) });
  recordObject(key, size);
  return true;
}

/**
 * Uploads a local file and removes it, so the container keeps no copy. Returns false when R2 is not
 * configured or the cap is reached, which tells the caller to leave the file where it is.
 */
export async function offload(key: string, localPath: string) {
  if (!client) return false;
  if (!(await putFile(key, localPath))) return false;
  rmSync(localPath, { force: true });
  return true;
}

export async function deleteObject(key: string) {
  if (!client) return;
  // A clip whose row is being pruned may already be gone; that is not an error worth surfacing.
  await client.file(key).delete().catch(() => {});
  // Drop it from the ledger either way: a missing object occupies no space.
  forgetObject(key);
}

/**
 * Downloads `key` into `intoDir` so ffmpeg can work on it. Stitching an export needs real local files, so
 * clips come back from R2 for the length of the render and are thrown away with the directory afterwards.
 */
export async function fetchTo(key: string, intoDir: string) {
  if (!client) throw new Error("R2 is not configured");
  const local = `${intoDir}/${key.split("/").pop()}`;
  await Bun.write(local, client.file(key));
  return local;
}

/** A scratch directory that deletes itself once `fn` settles, however it settles. */
export async function withTempDir<T>(label: string, fn: (dir: string) => Promise<T>) {
  const dir = `${tmpdir()}/slop-${label}-${crypto.randomUUID().slice(0, 8)}`;
  mkdirSync(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Object keys mirror the `/media/...` URL layout, so a URL and its key are mechanically interchangeable and
 * the existing links in the database keep resolving after the migration.
 */
export const keyForMediaUrl = (url: string) => (url.startsWith("/media/") ? url.slice("/media/".length) : null);
export const mediaUrlForKey = (key: string) => `/media/${key}`;

/**
 * Which `/media/...` paths this server generates, and therefore keeps in R2. Everything else (the intro, the
 * think loop, the soundtrack, reference stills) is committed to the repo and ships inside the image, so it is
 * always read from disk — those are the assets deliberately kept local.
 */
const GENERATED_PREFIXES = ["/media/cache/", "/media/exports/", "/media/frames/"];
export const isGeneratedUrl = (url: string) => GENERATED_PREFIXES.some(p => url.startsWith(p));
