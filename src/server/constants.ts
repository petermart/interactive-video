// Shared with the client bundle: keep this file free of server-only imports.

/**
 * How success is decided:
 * - vibes:  the LLM decides purely on creativity and plausibility; probability settings are ignored.
 * - hybrid: the LLM decides, using the probability and creativity points as a rough guide.
 * - dice:   the server rolls against the probability, adjusted by creativity points.
 */
export const OUTCOME_MODES = ["vibes", "hybrid", "dice"] as const;
export type OutcomeMode = (typeof OUTCOME_MODES)[number];

/** Max points creativity can add (innovation 100) or remove (innovation 0) from the success chance. */
export const CREATIVITY_POINT_OPTIONS = [0, 5, 10, 15, 20, 25, 30, 40, 50] as const;

/**
 * Which service generates step clips.
 * - machgen: MiniMax H3 with up to 9 reference images ($0.05/s at 480p), best character/location consistency.
 * - masky:   Masky videos ($0.025/s at 720p, $0.015 draft); no reference images, continuity comes from
 *            starting each clip on the previous clip's last frame.
 */
export const VIDEO_PROVIDERS = ["fal-turbo", "fal-turbo-half", "fal", "machgen", "gmi", "masky"] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

/** No-video mode: how long the scene text stays up in place of a step clip (matches the 15s clips). */
export const SCENE_TEXT_SECS = 15;

/**
 * How much one visitor may do, counted either in finished games or in generated steps.
 *
 * Two of these are configured: one for guests (where running out means "sign in") and one for signed-in
 * members (where running out means "that's your lot for now"). Games and generations are alternatives, not
 * both: when the mode is "games" the generation number is ignored entirely, which is what makes "one full
 * story, however many steps it takes" expressible.
 */
export const ALLOWANCE_MODES = ["unlimited", "games", "generations"] as const;
export type AllowanceMode = (typeof ALLOWANCE_MODES)[number];
export type Allowance = {
  mode: AllowanceMode;
  count: number;
  /**
   * Days before the allowance refills. The clock starts at the viewer's first move of a window, so it is a
   * rolling window per person, not a global reset hour that everyone races. 0 means it never refills.
   */
  resetDays: number;
};

/** Sanity cap for the admin inputs. Not a business rule - just keeps a typo from reading as unlimited. */
export const ALLOWANCE_MAX = 99;
export const RESET_DAYS_MAX = 365;
export const SHARE_BONUS_MAX = 20;
export const NETWORK_TOLERANCE_MAX = 100;

export const ALLOWANCE_MODE_LABELS: Record<AllowanceMode, string> = {
  unlimited: "Unlimited",
  games: "Finished games",
  generations: "Generated steps",
};

/** One line of plain English for the admin panel and the player-facing gate. */
export function describeAllowance({ mode, count, resetDays }: Allowance) {
  if (mode === "unlimited") return "as much as they like";
  const unit = mode === "games" ? "game" : "generation";
  if (count === 0) return `nothing (blocked before the first ${unit})`;
  const every = resetDays > 0 ? ` every ${resetDays === 1 ? "day" : `${resetDays} days`}` : " ever";
  return `${count} ${unit}${count === 1 ? "" : "s"}${every}`;
}

/**
 * What one earned go is worth. A share buys a whole go, not a single step: in games mode that is one more
 * story, and in generations mode a fresh allowance of steps - so someone on "3 generations" who shares gets
 * 3 more, not 1. Anything less would be a worse deal than the wording promises.
 */
export const goSize = ({ mode, count }: Allowance) => (mode === "games" ? 1 : Math.max(1, count));

/**
 * LLM choices for the admin dropdowns. Speeds measured 2026-09-13 on GMI with the real diagnostic prompt
 * (~2.2k tokens in); the shot writer returns longer output, so expect it to take somewhat longer.
 */
export const LLM_MODEL_OPTIONS = [
  { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash-Lite", speed: "~2s", reasoning: "light" },
  { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", speed: "~2s", reasoning: "light+" },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", speed: "~6s", reasoning: "deep" },
] as const;
export type LlmModelId = (typeof LLM_MODEL_OPTIONS)[number]["id"];
