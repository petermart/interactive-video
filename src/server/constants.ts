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

/** No-video mode: how long the scene text stays up in place of a step clip (matches the 15s clips). */
export const SCENE_TEXT_SECS = 15;
