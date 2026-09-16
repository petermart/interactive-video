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
export const VIDEO_PROVIDERS = ["machgen", "masky"] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

/** No-video mode: how long the scene text stays up in place of a step clip (matches the 15s clips). */
export const SCENE_TEXT_SECS = 15;

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
