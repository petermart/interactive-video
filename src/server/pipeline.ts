import { clamp, getSettings, introMedia, world, type OutcomeMode, type Settings } from "./config";
import { chatJSON } from "./gmi";
import { generateVideo, lastFrame, MAX_IMAGE_REFS, uploadFile, type VideoRequest } from "./machgen";
import { diagnosticSystem, writerSystem } from "./prompts";

/** Step clips play out the viewer's action; loops idle on the protagonist's close-up. */
export const STEP_SECS = 15;
export const LOOP_SECS = 4;

export type Outcome = "intro" | "success" | "fail" | "escaped";

export type StoryNode = {
  id: string;
  parentId: string | null;
  depth: number; // successful steps so far
  environmentId: string;
  direction: string | null;
  outcome: Outcome;
  failType?: "redetained" | "dead";
  summary: string;
  clipUrl: string;
  loopUrl: string | null;
  lastFrameFile?: string;
};

export type Diagnosis = {
  allowed: boolean;
  rejectionReason: string;
  innovation: number;
  innovationNote: string;
  successBeat: string;
  failBeat: string;
  failType: "redetained" | "dead";
  reachesExit: boolean;
  /** vibes/hybrid modes: the LLM's verdict. Ignored in dice mode. */
  succeeds?: boolean;
  verdictReason?: string;
};

type ShotPlan = {
  shotPrompt: string;
  environmentId: string;
  characterIds: string[];
  summary: string;
  loopPrompt: string;
};

export type JobStatus = "diagnosing" | "writing" | "generating-clip" | "generating-loop" | "done" | "rejected" | "error";

export type Job = {
  id: string;
  status: JobStatus;
  message: string;
  node?: StoryNode;
  debug?: {
    mode: OutcomeMode;
    innovation: number;
    chance: number | null;
    roll: number | null;
    isFinal: boolean;
    diagnosis: Diagnosis;
    plan?: ShotPlan;
  };
};

const nodes = new Map<string, StoryNode>();
const jobs = new Map<string, Job>();

export function createSession() {
  const media = introMedia();
  const root: StoryNode = {
    id: crypto.randomUUID(),
    parentId: null,
    depth: 0,
    environmentId: world.startEnvironment,
    direction: null,
    outcome: "intro",
    summary: "The protagonist sits in his cell in Block A, planning his escape.",
    clipUrl: media.intro,
    loopUrl: media.introLoop,
  };
  nodes.set(root.id, root);
  return { root, music: media.music };
}

export const getNode = (id: string) => nodes.get(id);
export const getJob = (id: string) => jobs.get(id);

/** Starts the two-LLM + H3 pipeline for a direction. Returns immediately; poll the job. */
export function startDirection(fromNodeId: string, direction: string) {
  const from = nodes.get(fromNodeId);
  if (!from) throw new Error("Unknown node");
  const job: Job = { id: crypto.randomUUID(), status: "diagnosing", message: "Analyzing escape plan…" };
  jobs.set(job.id, job);
  runPipeline(job, from, direction.trim().slice(0, 500)).catch(err => {
    console.error("[pipeline]", err);
    job.status = "error";
    job.message = String(err?.message ?? err);
  });
  return job;
}

async function runPipeline(job: Job, from: StoryNode, direction: string) {
  const settings = getSettings();
  const story = storySoFar(from);
  const context = JSON.stringify({
    direction,
    currentEnvironment: from.environmentId,
    stepsSucceeded: from.depth,
    promptsTillSuccess: settings.promptsTillSuccess,
    exitProximity: Number((from.depth / settings.promptsTillSuccess).toFixed(2)),
    ...(settings.outcomeMode === "hybrid" && {
      successProbability: settings.successProbability,
      creativityPoints: settings.creativityPoints,
    }),
    storySoFar: story,
  });

  // LLM 1: diagnostic
  const diagnosis = settings.liveLLM
    ? await chatJSON<Diagnosis>(diagnosticSystem(settings), context)
    : mockDiagnosis(direction, settings);
  if (!diagnosis.allowed) {
    job.status = "rejected";
    job.message = diagnosis.rejectionReason || "That can't happen here. Try something else.";
    return;
  }

  const { success, chance, roll } = decideOutcome(settings, diagnosis);
  const nextDepth = from.depth + 1;
  const isFinal =
    success &&
    (nextDepth >= settings.promptsTillSuccess ||
      (diagnosis.reachesExit && nextDepth >= 0.75 * settings.promptsTillSuccess));
  const outcome: Outcome = !success ? "fail" : isFinal ? "escaped" : "success";
  job.debug = { mode: settings.outcomeMode, innovation: diagnosis.innovation, chance, roll, isFinal, diagnosis };

  // LLM 2: shot writer
  job.status = "writing";
  job.message = "Planning the shot…";
  const beat = success ? diagnosis.successBeat : diagnosis.failBeat;
  const writerInput = JSON.stringify({
    outcome: outcome === "fail" ? `FAILURE (${diagnosis.failType})` : outcome === "escaped" ? "FINAL ESCAPE" : "SUCCESS",
    beat,
    direction,
    currentEnvironment: from.environmentId,
    storySoFar: story,
  });
  const plan = settings.liveLLM ? await chatJSON<ShotPlan>(writerSystem(), writerInput) : mockPlan(from, beat, outcome);
  job.debug.plan = plan;

  // H3 clip
  job.status = "generating-clip";
  job.message = "Rolling camera…";
  const node: StoryNode = {
    id: crypto.randomUUID(),
    parentId: from.id,
    depth: success ? nextDepth : from.depth,
    environmentId: world.environments.some(e => e.id === plan.environmentId) ? plan.environmentId : from.environmentId,
    direction,
    outcome,
    failType: success ? undefined : diagnosis.failType,
    summary: plan.summary,
    clipUrl: "/media/placeholder.mp4",
    loopUrl: null,
  };

  if (settings.liveVideo) {
    const clip = await generateVideo(await buildClipRequest(plan, from));
    node.clipUrl = clip.url;
    node.lastFrameFile = await lastFrame(clip.file);
  }

  // Idle loop on the closing close-up (success only)
  if (outcome === "success") {
    job.status = "generating-loop";
    job.message = "Finding his next move…";
    if (settings.liveVideo && node.lastFrameFile) {
      const frame = await uploadFile(node.lastFrameFile);
      const loop = await generateVideo({
        task_type: "I2V",
        prompt: plan.loopPrompt,
        src_image_urls: [frame, frame],
        keyframe_indices: [0, -1],
        durationSecs: LOOP_SECS,
      });
      node.loopUrl = loop.url;
    } else {
      node.loopUrl = "/media/placeholder.mp4";
    }
  }

  nodes.set(node.id, node);
  job.node = node;
  job.status = "done";
  job.message = "";
}

/**
 * Picks at most 9 reference images, in priority order:
 * 1. the environment plate (always), 2. the protagonist sheet, 3. the previous clip's last frame (continuity),
 * 4. other characters in the order the writer ranked them.
 */
export function selectReferences(plan: ShotPlan, hasPreviousFrame: boolean) {
  const refs: { label: string; image: string }[] = [];
  const env = world.environments.find(e => e.id === plan.environmentId);
  if (env?.image) refs.push({ label: `environment plate of ${env.id}`, image: env.image });

  const protagonist = world.characters.find(c => c.id === "protagonist");
  if (protagonist?.image) refs.push({ label: "character sheet of the protagonist (red jumpsuit)", image: protagonist.image });

  const slotsForCast = MAX_IMAGE_REFS - refs.length - (hasPreviousFrame ? 1 : 0);
  const cast = plan.characterIds
    .filter(id => id !== "protagonist")
    .map(id => world.characters.find(c => c.id === id))
    .filter(c => c?.image)
    .slice(0, Math.max(0, slotsForCast))
    .map(c => ({ label: `character sheet of ${c!.id} (${c!.role})`, image: c!.image! }));

  return { refs, cast };
}

async function buildClipRequest(plan: ShotPlan, from: StoryNode): Promise<VideoRequest> {
  const previousFrame = from.lastFrameFile ? await uploadFile(from.lastFrameFile) : null;
  const { refs, cast } = selectReferences(plan, Boolean(previousFrame));
  const durationSecs = STEP_SECS;

  if (refs.length + cast.length > 0) {
    // TODO: asset images must be public URLs or uploaded @input refs once they exist.
    const all = [...refs, ...(previousFrame ? [{ label: "the previous shot's final frame (continuity)", image: previousFrame }] : []), ...cast];
    const legend = all.map((r, i) => `Image ${i + 1}: ${r.label}.`).join(" ");
    return {
      task_type: "R2V",
      prompt: `${legend}\n\n${plan.shotPrompt}`,
      src_image_urls: all.map(r => r.image).slice(0, MAX_IMAGE_REFS),
      durationSecs,
    };
  }
  if (previousFrame) {
    return { task_type: "I2V", prompt: plan.shotPrompt, src_image_urls: [previousFrame], keyframe_indices: [0], durationSecs };
  }
  return { task_type: "T2V", prompt: plan.shotPrompt, durationSecs };
}

/**
 * Success chance for dice mode (and the guide shown to the LLM in hybrid mode):
 * base probability, plus up to +creativityPoints for innovation 100, down to −creativityPoints for innovation 0.
 */
export function successChance(settings: Settings, innovation: number) {
  const base = settings.successProbability;
  if (base <= 0) return 0;
  if (base >= 100) return 100;
  return clamp(Math.round(base + ((innovation - 50) / 50) * settings.creativityPoints), 0, 100);
}

function decideOutcome(settings: Settings, diagnosis: Diagnosis) {
  const chance = successChance(settings, diagnosis.innovation);
  if (settings.outcomeMode === "dice") {
    const roll = Math.round(Math.random() * 100);
    return { success: roll < chance, chance, roll };
  }
  // vibes and hybrid: the LLM's verdict stands.
  return { success: Boolean(diagnosis.succeeds), chance: settings.outcomeMode === "hybrid" ? chance : null, roll: null };
}

function storySoFar(node: StoryNode) {
  const chain: string[] = [];
  for (let n: StoryNode | undefined = node; n; n = n.parentId ? nodes.get(n.parentId) : undefined) {
    chain.unshift(n.direction ? `Viewer: "${n.direction}" -> ${n.summary}` : n.summary);
  }
  return chain;
}

// ---------- Mocks (Live LLM off) ----------

const REJECT = /\b(wings?|fly|flies|teleport|magic|spell|portal|superpower|laser eyes|invisible|telekines|guards? (decide|let)|earthquake|meteor|god)\b/i;

function mockDiagnosis(direction: string, settings: Settings): Diagnosis {
  if (REJECT.test(direction)) {
    return {
      allowed: false,
      rejectionReason: "[mock] That's beyond what one prisoner can do. Stick to his own hands and wits.",
      innovation: 0,
      innovationNote: "",
      successBeat: "",
      failBeat: "",
      failType: "redetained",
      reachesExit: false,
    };
  }
  const words = direction.split(/\s+/).length;
  const innovation = clamp(25 + words * 4, 0, 95);
  // Mock verdicts: vibes succeeds on innovation alone; hybrid leans on the computed chance.
  const succeeds =
    settings.outcomeMode === "hybrid" ? Math.random() * 100 < successChance(settings, innovation) : innovation >= 50;
  return {
    allowed: true,
    rejectionReason: "",
    innovation,
    innovationNote: "[mock] longer = more innovative",
    succeeds,
    verdictReason: `[mock] ${settings.outcomeMode} verdict`,
    successBeat: `[mock] It works: ${direction}`,
    failBeat: `[mock] It goes wrong: ${direction}`,
    failType: Math.random() < 0.5 ? "redetained" : "dead",
    reachesExit: false,
  };
}

function mockPlan(from: StoryNode, beat: string, outcome: Outcome): ShotPlan {
  const env = world.environments.find(e => e.id === from.environmentId);
  const next = outcome === "success" && env ? env.neighbors[Math.floor(Math.random() * env.neighbors.length)]! : from.environmentId;
  return {
    shotPrompt: `[mock] ${beat}`,
    environmentId: next,
    characterIds: ["protagonist"],
    summary: `[mock] ${beat} (now in ${next})`,
    loopPrompt: "[mock] close-up idle loop",
  };
}
