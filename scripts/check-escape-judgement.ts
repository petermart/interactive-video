/**
 * Runs LLM 1 (the diagnostic) on scenarios where the verdict has gone wrong before, and reports what the game
 * would play for each: rejected, fail, success, or escaped. Uses the live model, so it costs a few tenths of a
 * cent and is not deterministic - run it a couple of times when changing the prompt.
 *
 *   bun scripts/check-escape-judgement.ts            (vibes, the analysis model from settings)
 *   bun scripts/check-escape-judgement.ts hybrid
 *
 * Mirrors the context runPipeline builds and the isFinal rule it applies.
 */

import { getSettings, type Settings } from "../src/server/config";
import type { OutcomeMode } from "../src/server/constants";
import { chatJSON } from "../src/server/llm";
import type { Diagnosis } from "../src/server/pipeline";
import { diagnosticSystem } from "../src/server/prompts";

const mode = (process.argv[2] as OutcomeMode | undefined) ?? "vibes";
const settings: Settings = { ...getSettings(), outcomeMode: mode, promptsTillSuccess: 4 };

type Expect = "rejected" | "fail" | "success" | "escaped" | "not-escaped" | "allowed";
type Case = { direction: string; depth: number; env: string; story: string[]; expect: Expect; why: string };

const dayOne = ["Sloppy Joe wakes in his cell in cell block A. A guard patrols the corridor outside the bars."];
const nearExit = [
  ...dayOne,
  'Viewer: "fake being sick" -> He is escorted to the infirmary and palms a scalpel.',
  'Viewer: "crawl into the vent above the bed" -> He squeezes into the air vents and crawls toward the roof.',
  'Viewer: "pop the rooftop hatch" -> He pushes the hatch open onto the rooftop at night. A searchlight sweeps the perimeter fence below.',
];
const blackout = [
  ...dayOne,
  'Viewer: "short the light socket with the wet towel" -> Sparks fly and the whole block loses power. The corridor is pitch black and the guards are shouting for flashlights.',
];

const CASES: Case[] = [
  { direction: "stay extra hydrated", depth: 3, env: "rooftop", story: nearExit, expect: "not-escaped", why: "everyday action on the final step" },
  { direction: "read the quran", depth: 3, env: "rooftop", story: nearExit, expect: "not-escaped", why: "everyday action on the final step" },
  {
    direction: "sew my excess hair, sheets and spare clothes into a gorilla suit, then leap out roaring to scare the guards off and climb the fence while they flee",
    depth: 3, env: "rooftop", story: nearExit, expect: "escaped", why: "creative, specific escape at the exit",
  },
  { direction: "run", depth: 0, env: "cell-block-a", story: dayOne, expect: "fail", why: "running with a guard right there" },
  { direction: "open door and leave", depth: 0, env: "cell-block-a", story: dayOne, expect: "fail", why: "reckless, should play as a failure, not be refused" },
  { direction: "escape", depth: 0, env: "cell-block-a", story: dayOne, expect: "fail", why: "vague, played literally and fails" },
  { direction: "punch the guard through the bars and grab his keys", depth: 0, env: "cell-block-a", story: dayOne, expect: "allowed", why: "reckless but possible: accept, however it goes" },
  { direction: "run down the corridor while it's dark", depth: 1, env: "cell-block-a", story: blackout, expect: "allowed", why: "running is set up by the blackout, so it may work" },
  { direction: "grow wings and fly over the wall", depth: 3, env: "rooftop", story: nearExit, expect: "rejected", why: "supernatural" },
];

const verdictOf = (d: Diagnosis, c: Case) => {
  if (!d.allowed) return "rejected";
  const success = Boolean(d.succeeds);
  const next = c.depth + 1;
  const isFinal = success && d.escapeAttempt === true && (next >= settings.promptsTillSuccess || (d.reachesExit && next >= 0.75 * settings.promptsTillSuccess));
  return !success ? "fail" : isFinal ? "escaped" : "success";
};
const meets = (got: string, want: Expect) =>
  want === "not-escaped" ? got !== "escaped" && got !== "rejected" : want === "allowed" ? got !== "rejected" : got === want;

console.log(`mode ${mode}, model ${settings.analysisModel}, promptsTillSuccess ${settings.promptsTillSuccess}\n`);
const results = await Promise.all(
  CASES.map(async c => {
    const context = JSON.stringify({
      direction: c.direction,
      currentEnvironment: c.env,
      stepsSucceeded: c.depth,
      promptsTillSuccess: settings.promptsTillSuccess,
      exitProximity: Number((c.depth / settings.promptsTillSuccess).toFixed(2)),
      successEscapesPrison: c.depth + 1 >= settings.promptsTillSuccess,
      ...(c.depth + 1 >= settings.promptsTillSuccess && {
        finale: `If this is an escape attempt and it succeeds, the game ends: successBeat must get him completely out of the prison, from ${c.env} through or past the last barrier to outside the walls, free. If it is not an escape attempt, it cannot end the game however well it goes.`,
      }),
      ...(mode === "hybrid" && { successProbability: settings.successProbability, creativityPoints: settings.creativityPoints }),
      storySoFar: c.story,
    });
    try {
      const d = await chatJSON<Diagnosis>(settings.analysisModel, diagnosticSystem(settings), context, "escape judgement check");
      return { c, d, got: verdictOf(d, c) };
    } catch (err) {
      // A malformed reply is the model's fault, not the prompt's verdict: report it without losing the other cases.
      const d = { allowed: false, rejectionReason: `call failed: ${(err as Error).message.slice(0, 120)}` } as Diagnosis;
      return { c, d, got: "error" };
    }
  }),
);

let misses = 0;
for (const { c, d, got } of results) {
  const ok = meets(got, c.expect);
  misses += ok ? 0 : 1;
  console.log(`${ok ? "ok  " : "MISS"} [step ${c.depth + 1}] "${c.direction.slice(0, 60)}${c.direction.length > 60 ? "…" : ""}"`);
  console.log(`     want ${c.expect} (${c.why}), got ${got}  · escapeAttempt=${d.escapeAttempt} reachesExit=${d.reachesExit}`);
  console.log(`     ${d.allowed ? d.verdictReason : `rejected: ${d.rejectionReason}`}\n`);
}
console.log(misses ? `${misses} of ${CASES.length} missed.` : `All ${CASES.length} judged as intended.`);
process.exit(0);
