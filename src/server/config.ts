import { existsSync, mkdirSync } from "node:fs";
import worldJson from "../../data/world.json";

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/** Committed, read-only media (intro, music, placeholder). */
export const MEDIA_DIR = `${ROOT}media`;

/**
 * Writable state. Locally it stays where it always was; in a container set STORAGE_DIR to a persistent volume
 * (e.g. /data) and generated clips, exports, settings and the debug DB all live there.
 */
export const STORAGE_DIR = process.env.STORAGE_DIR?.replace(/\/+$/, "");
export const CACHE_DIR = STORAGE_DIR ? `${STORAGE_DIR}/cache` : `${MEDIA_DIR}/cache`;
export const EXPORT_DIR = STORAGE_DIR ? `${STORAGE_DIR}/exports` : `${MEDIA_DIR}/exports`;
export const DB_FILE = STORAGE_DIR ? `${STORAGE_DIR}/debug.sqlite` : `${ROOT}data/debug.sqlite`;
/** Frames published for other services to fetch (Masky needs public http(s) image URLs). */
export const FRAMES_DIR = STORAGE_DIR ? `${STORAGE_DIR}/frames` : `${MEDIA_DIR}/frames`;
const SETTINGS_FILE = STORAGE_DIR ? `${STORAGE_DIR}/settings.json` : `${ROOT}data/settings.json`;
mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(EXPORT_DIR, { recursive: true });
mkdirSync(FRAMES_DIR, { recursive: true });

/** Maps a served /media/... URL to its file: generated clips and exports come from storage, the rest from media/. */
export function mediaPath(url: string | null) {
  if (!url?.startsWith("/media/")) return null;
  if (url.startsWith("/media/cache/")) return `${CACHE_DIR}/${url.slice("/media/cache/".length)}`;
  if (url.startsWith("/media/exports/")) return `${EXPORT_DIR}/${url.slice("/media/exports/".length)}`;
  if (url.startsWith("/media/frames/")) return `${FRAMES_DIR}/${url.slice("/media/frames/".length)}`;
  return `${MEDIA_DIR}/${url.slice("/media/".length)}`;
}

/** API keys: keys.json locally (gitignored); environment variables override it (used in deployment). */
const keysFile = `${ROOT}keys.json`;
const fileKeys: Record<string, string> = existsSync(keysFile) ? await Bun.file(keysFile).json() : {};
export const keys = {
  machgen: process.env.MACHGEN_API_KEY ?? fileKeys.machgen ?? "",
  masky: process.env.MASKY_API_KEY ?? fileKeys.masky ?? "",
  gmi: process.env.GMI_API_KEY ?? fileKeys.gmi ?? "",
  elevenlabs: process.env.ELEVENLABS_API_KEY ?? fileKeys.elevenlabs ?? "",
  fal: process.env.FAL_KEY ?? process.env.FAL_API_KEY ?? fileKeys.fal ?? "",
  /** Optional Admin-scope fal key: only used to read the credit balance, which a normal key can't. */
  falAdmin: process.env.FAL_ADMIN_KEY ?? fileKeys.falAdmin ?? "",
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? fileKeys.googleClientId ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? fileKeys.googleClientSecret ?? "",
  /** Public by design (it ships in every page's HTML); kept here so local and deploy use the same source. */
  cfAnalyticsToken: process.env.CF_ANALYTICS_TOKEN ?? fileKeys.cfAnalyticsToken ?? "",
};

/** Public origin of this server, used to hand out frame URLs other services can fetch. */
export const publicBaseUrl = () =>
  process.env.PUBLIC_BASE_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

/** Masky is only offered where a key is configured; deployments without one stay on MachGen. */
export const maskyAvailable = () => Boolean(keys.masky);

/** A video provider can only be used when its API key is present. */
export const providerAvailable = (provider: VideoProvider) =>
  Boolean({ "fal-turbo": keys.fal, "fal-turbo-half": keys.fal, fal: keys.fal, machgen: keys.machgen, gmi: keys.gmi, masky: keys.masky }[provider]);

/**
 * Default video provider: the first one with a key, in order of preference. fal turbo (H3 Max turbo with a
 * labeled reference sheet as its first frame: cheapest and fastest), fal (H3 Max with real reference images),
 * then MachGen (H3 480p), then GMI Cloud (H3 at 768P only, slowest). Masky is never a default.
 */
export function preferredVideoProvider(): VideoProvider {
  for (const provider of ["fal-turbo", "fal", "machgen", "gmi"] as const) if (providerAvailable(provider)) return provider;
  return "machgen";
}

export type Character = { id: string; role: string; description: string; image: string | null };
export type Environment = {
  id: string;
  description: string;
  neighbors: string[];
  image: string | null;
};
export type World = {
  style: string;
  shotRules: string[];
  startEnvironment: string;
  exitEnvironments: string[];
  characters: Character[];
  environments: Environment[];
};
export const world = worldJson as World;

import { ALLOWANCE_MAX, ALLOWANCE_MODES, NETWORK_TOLERANCE_MAX, PACK_MAX, PURCHASE_MODES, type PurchaseMode, RESET_DAYS_MAX, SHARE_BONUS_MAX, CREATIVITY_POINT_OPTIONS, LLM_MODEL_OPTIONS, OUTCOME_MODES, VIDEO_PROVIDERS, type Allowance, type AllowanceMode, type LlmModelId, type OutcomeMode, type VideoProvider } from "./constants";
export { CREATIVITY_POINT_OPTIONS, OUTCOME_MODES, type OutcomeMode };

export type Settings = {
  outcomeMode: OutcomeMode;
  successProbability: number; // 0-100
  creativityPoints: number; // one of CREATIVITY_POINT_OPTIONS
  promptsTillSuccess: number; // 1-20
  liveLLM: boolean;
  liveVideo: boolean;
  /** Which service generates step clips. */
  videoProvider: VideoProvider;
  /** Masky only: draft quality (cheaper, lower quality). */
  maskyDraft: boolean;
  /** Reuse clips other viewers generated for the same action in the same place. */
  reuseActions: boolean;
  /** Show a CACHED / GENERATED badge on each step, for demos and debugging. */
  showClipSource: boolean;
  /**
   * Show what each step cost in the debug drawer. Off in public: the drawer is open to everyone and the dollar
   * figures are operating costs, not part of the film. An admin (one who has entered the password in this
   * browser) still sees them either way.
   */
  showDebugSpend: boolean;
  /** Lite model that decides whether a new action matches an archived one. */
  matchModel: string;
  /** Skip generating a per-step idle loop; always idle on the pre-made "Sloppy Joe thinking" ultra macro loop. */
  constantThink: boolean;
  /** LLM 1 ("Analyzing escape plan"): speed matters most. */
  analysisModel: LlmModelId;
  /** LLM 2 (shot writer): quality of the H3 prompt matters more. */
  writerModel: LlmModelId;
  /** What a visitor who has not signed in may do before the gate falls. */
  guestAllowance: Allowance;
  /** What a signed-in member may do. Unlimited by default: signing in should feel like the generous side. */
  memberAllowance: Allowance;
  /**
   * How many times sharing a finished run can earn one more go, per allowance window (it resets when the
   * allowance refills). 0 turns the offer off. Each share is worth a whole game, or a whole allowance of steps.
   */
  shareBonusMax: number;
  /**
   * How many times over a guest's allowance one network (IP) may use before guests on it are blocked too.
   * Stops clearing cookies from being a reset button without blocking a room on shared wifi. 0 turns it off.
   */
  networkTolerance: number;
  /** Whether players can buy more once their allowance runs out, and in what unit. */
  purchaseMode: PurchaseMode;
  /** Generations in one purchase. Bigger packs spread Stripe's fixed fee thinner. */
  packGenerations: number;
  /** Games in one purchase. */
  packGames: number;
  /**
   * Profit (or, negative, loss) wanted on each generation after every cost, Stripe's fee included. A game is
   * priced at this times the measured steps per game. The price follows from it; see pricing.ts.
   */
  profitPerGenerationUsd: number;
  /** Stripe's card fee: a percentage of the charge plus a fixed amount per charge. */
  stripeFeePercent: number;
  stripeFeeFixedUsd: number;
};

const defaults: Settings = {
  outcomeMode: "vibes",
  successProbability: 60,
  creativityPoints: 30,
  promptsTillSuccess: 6,
  liveLLM: true,
  liveVideo: false,
  videoProvider: preferredVideoProvider(),
  maskyDraft: false,
  constantThink: true,
  reuseActions: true,
  showClipSource: false,
  showDebugSpend: true, // existing deployments keep showing it until it is deliberately turned off
  matchModel: "google/gemma-4-26b-a4b-it",
  analysisModel: "google/gemini-3.5-flash-lite",
  writerModel: "google/gemini-3.5-flash-lite",
  // Existing deployments keep behaving as they did until this is deliberately tightened.
  // Windows are set even while the modes are unlimited, so turning a limit on later behaves sensibly at once:
  // a guest's allowance refills slowly (they are strangers), a member's daily (they came back).
  guestAllowance: { mode: "unlimited", count: 0, resetDays: 10 },
  memberAllowance: { mode: "unlimited", count: 0, resetDays: 1 },
  shareBonusMax: 0,
  networkTolerance: 5,
  purchaseMode: "off",
  packGenerations: 10,
  packGames: 1,
  profitPerGenerationUsd: 0.05,
  // Stripe's standard US online card rate.
  stripeFeePercent: 2.9,
  stripeFeeFixedUsd: 0.3,
};

/** Settings saved before allowances were numbers. Read once, then written back in the new shape. */
const LEGACY_GUEST_POLICIES: Record<string, Omit<Allowance, "resetDays">> = {
  unlimited: { mode: "unlimited", count: 0 },
  "one-game": { mode: "games", count: 1 },
  "one-generation": { mode: "generations", count: 1 },
  none: { mode: "generations", count: 0 },
};

const readAllowance = (value: unknown, fallback: Allowance): Allowance => {
  if (!value || typeof value !== "object") return fallback;
  const { mode, count, resetDays } = value as Partial<Allowance>;
  if (!ALLOWANCE_MODES.includes(mode as AllowanceMode)) return fallback;
  const whole = (n: unknown, max: number, missing: number) =>
    n === undefined ? missing : Math.min(max, Math.max(0, Math.round(Number(n) || 0)));
  return {
    mode: mode as AllowanceMode,
    count: whole(count, ALLOWANCE_MAX, 0),
    // A settings file written before windows existed keeps the default rather than becoming "never refills".
    resetDays: whole(resetDays, RESET_DAYS_MAX, fallback.resetDays),
  };
};

/**
 * Live settings, parked on globalThis like the database handle.
 *
 * `bun --hot` keeps older copies of this module alive, each with its own `settings` binding. Without a
 * shared home, a write from a stale copy re-saves ITS values over the file, silently resurrecting a
 * setting someone had just changed - which is how a guest allowance of "none" turned back into "one free
 * game" mid-session here, and let a generation through that should have been gated.
 */
const live = globalThis as unknown as { __prisonSettings?: Settings };

let settings: Settings = defaults;
if (existsSync(SETTINGS_FILE)) {
  const { llmModel: _legacy, guestPolicy, shareGrantsGame, ...saved } = await Bun.file(SETTINGS_FILE).json();
  settings = { ...defaults, ...saved };
  // Sharing used to be an on/off switch with no cap; a deployment that had it on keeps it, capped at one.
  if (saved.shareBonusMax === undefined && shareGrantsGame) settings.shareBonusMax = 1;
  // A deployment configured under the old named policies keeps the same gate, expressed as numbers.
  if (guestPolicy && !saved.guestAllowance) {
    const legacy = LEGACY_GUEST_POLICIES[guestPolicy];
    settings.guestAllowance = legacy ? { ...legacy, resetDays: defaults.guestAllowance.resetDays } : defaults.guestAllowance;
  }
  settings.guestAllowance = readAllowance(settings.guestAllowance, defaults.guestAllowance);
  settings.memberAllowance = readAllowance(settings.memberAllowance, defaults.memberAllowance);
}

// Whatever this module read from disk only counts if nothing else has settings in hand already.
live.__prisonSettings ??= settings;

/** The one live settings object, however many copies of this module are in memory. */
const current = () => live.__prisonSettings ?? settings;

export const getSettings = (): Settings => {
  const now = current();
  return providerAvailable(now.videoProvider) ? now : { ...now, videoProvider: preferredVideoProvider() };
};

export async function updateSettings(patch: Partial<Settings>) {
  // Merged onto the live object, never onto this module's own stale copy.
  const settings = current();
  const next = { ...settings, ...patch };
  if (!OUTCOME_MODES.includes(next.outcomeMode)) next.outcomeMode = settings.outcomeMode;
  const validModel = (id: string) => LLM_MODEL_OPTIONS.some(m => m.id === id);
  if (!validModel(next.analysisModel)) next.analysisModel = settings.analysisModel;
  if (!validModel(next.writerModel)) next.writerModel = settings.writerModel;
  if (!CREATIVITY_POINT_OPTIONS.includes(next.creativityPoints as never)) next.creativityPoints = settings.creativityPoints;
  next.successProbability = clamp(Math.round(Number(next.successProbability)), 0, 100);
  next.promptsTillSuccess = clamp(Math.round(Number(next.promptsTillSuccess)), 1, 20);
  next.liveLLM = Boolean(next.liveLLM);
  next.liveVideo = Boolean(next.liveVideo);
  next.constantThink = Boolean(next.constantThink);
  next.reuseActions = Boolean(next.reuseActions);
  next.showClipSource = Boolean(next.showClipSource);
  next.showDebugSpend = Boolean(next.showDebugSpend);
  next.guestAllowance = readAllowance(next.guestAllowance, settings.guestAllowance);
  next.memberAllowance = readAllowance(next.memberAllowance, settings.memberAllowance);
  next.shareBonusMax = clamp(Math.round(Number(next.shareBonusMax) || 0), 0, SHARE_BONUS_MAX);
  if (!PURCHASE_MODES.includes(next.purchaseMode)) next.purchaseMode = settings.purchaseMode;
  next.packGenerations = clamp(Math.round(Number(next.packGenerations) || 1), 1, PACK_MAX);
  next.packGames = clamp(Math.round(Number(next.packGames) || 1), 1, PACK_MAX);
  const cents = (n: unknown, fallback: number) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : fallback);
  next.profitPerGenerationUsd = clamp(cents(next.profitPerGenerationUsd, settings.profitPerGenerationUsd), -10, 10);
  next.stripeFeePercent = clamp(Math.round(Number(next.stripeFeePercent) * 100) / 100 || 0, 0, 20);
  next.stripeFeeFixedUsd = clamp(cents(next.stripeFeeFixedUsd, settings.stripeFeeFixedUsd), 0, 5);
  next.networkTolerance = clamp(Math.round(Number(next.networkTolerance) || 0), 0, NETWORK_TOLERANCE_MAX);
  if (!VIDEO_PROVIDERS.includes(next.videoProvider)) next.videoProvider = settings.videoProvider;
  if (!providerAvailable(next.videoProvider)) next.videoProvider = preferredVideoProvider();
  next.maskyDraft = Boolean(next.maskyDraft);
  live.__prisonSettings = next;
  await Bun.write(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Intro assets fall back to the placeholder clip until the real ones are generated. */
export function introMedia() {
  const pick = (path: string) => (existsSync(`${MEDIA_DIR}/${path}`) ? `/media/${path}` : "/media/placeholder.mp4");
  const intro = pick("intro/intro.mp4");
  return {
    intro,
    // The intro is generated as a seamless loop, so it doubles as its own idle loop.
    introLoop: existsSync(`${MEDIA_DIR}/intro/intro-loop.mp4`) ? "/media/intro/intro-loop.mp4" : intro,
    // Silent macro loop of Sloppy Joe deliberating; the idle background whenever a step has no loop of its own.
    thinkingLoop: existsSync(`${MEDIA_DIR}/intro/sloppy-joe-thinking.mp4`) ? "/media/intro/sloppy-joe-thinking.mp4" : intro,
    music: existsSync(`${MEDIA_DIR}/music/loop.mp3`) ? "/media/music/loop.mp3" : null,
  };
}
