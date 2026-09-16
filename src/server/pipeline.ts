import { clamp, getSettings, introMedia, ROOT, world, type OutcomeMode, type Settings } from "./config";
import { findByIntent, findReusableClip, markClipUsed, rememberClip, type CachedClip } from "./actionCache";
import { MACHGEN_MIN_BALANCE_USD, videoGenerationAllowed } from "./credits";
import { jobContext, loadJob, loadNode, logEvent, saveJob, saveNode } from "./db";
import { chatJSON } from "./gmi";
import { existsSync } from "node:fs";
import { generateVideo, hasAsset, lastFrame, MAX_IMAGE_REFS, uploadAsset, uploadFile, type VideoRequest } from "./machgen";
import { generateMaskyVideo } from "./masky";
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
  /** null in no-video mode: the client shows the scene text instead. */
  clipUrl: string | null;
  loopUrl: string | null;
  /** What the shot writer planned; shown as text in no-video mode. */
  scene?: { summary: string; shotPrompt: string };
  /** Set when this step replayed a clip another viewer generated for the same action here. */
  reusedFrom?: string;
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
  /** Canonical "verb:tool:target:destination" form of the attempt; matches archived clips exactly. */
  intentKey?: string;
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
  /** Browser-session UUID of the viewer who started this step (scopes the debug history). */
  viewerId?: string;
  fromNodeId: string;
  direction: string;
  status: JobStatus;
  message: string;
  /** Set when video generation was requested but MachGen is below the minimum balance. */
  creditsExhausted?: boolean;
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

// Kept on globalThis so `bun --hot` reloads don't drop in-flight jobs, and mirrored to SQLite so a
// server restart or page reload can still find finished steps.
const state = ((globalThis as any).__prisonState ??= { nodes: new Map<string, StoryNode>(), jobs: new Map<string, Job>() }) as {
  nodes: Map<string, StoryNode>;
  jobs: Map<string, Job>;
};
const { nodes, jobs } = state;

function putNode(node: StoryNode) {
  nodes.set(node.id, node);
  saveNode(node);
}

function setJob(job: Job, status: JobStatus, message: string) {
  job.status = status;
  job.message = message;
  saveJob(job, job.fromNodeId, job.direction);
  logEvent({ kind: "job", label: `status → ${status}`, response: message || undefined });
}

export function createSession(viewerId?: string) {
  return jobContext.run({ viewerId }, () => createSessionFor());
}

function createSessionFor() {
  const media = introMedia();
  const root: StoryNode = {
    id: crypto.randomUUID(),
    parentId: null,
    depth: 0,
    environmentId: world.startEnvironment,
    direction: null,
    outcome: "intro",
    summary: "Sloppy Joe sits in his cell in Block A, planning his escape.",
    clipUrl: media.intro,
    loopUrl: media.introLoop,
  };
  putNode(root);
  logEvent({ kind: "job", label: "session started", response: { rootId: root.id, intro: root.clipUrl } });
  return { root, music: media.music, thinkingLoop: media.thinkingLoop };
}

export function getNode(id: string) {
  const node = nodes.get(id) ?? loadNode<StoryNode>(id);
  if (node) nodes.set(id, node);
  return node;
}

export function getJob(id: string) {
  const live = jobs.get(id);
  if (live) return live;
  const saved = loadJob<Job>(id);
  // A job that was mid-flight when the server process died can't resume; report it instead of polling forever.
  if (saved && !["done", "rejected", "error"].includes(saved.status)) {
    saved.status = "error";
    saved.message = "The server restarted while this step was generating. Please try again.";
  }
  return saved;
}

/** Starts the two-LLM + H3 pipeline for a direction. Returns immediately; poll the job. */
export function startDirection(fromNodeId: string, direction: string, viewerId?: string) {
  const from = getNode(fromNodeId);
  if (!from) throw new Error("Unknown node");
  const clean = direction.trim().slice(0, 500);
  const job: Job = { id: crypto.randomUUID(), viewerId, fromNodeId, direction: clean, status: "diagnosing", message: "Analyzing escape plan…" };
  jobs.set(job.id, job);
  jobContext.run({ jobId: job.id, viewerId }, () => {
    saveJob(job, fromNodeId, clean);
    logEvent({ kind: "job", label: "direction received", request: { direction: clean, fromNodeId, settings: getSettings() } });
    runPipeline(job, from, clean).catch(err => {
      console.error("[pipeline]", err);
      logEvent({ kind: "error", label: "pipeline failed", status: "error", response: String(err?.stack ?? err) });
      setJob(job, "error", String(err?.message ?? err));
    });
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

  // Archive first: a move already filmed in this location replays with its stored verdict, destination and clip,
  // so neither LLM call nor a generation is needed. Wording/Gemma only, since the intent key needs LLM 1.
  if (settings.reuseActions) {
    const known = await findReusableClip({
      environmentId: from.environmentId,
      direction,
      model: settings.matchModel,
      liveLLM: settings.liveLLM,
    });
    if (known && replayArchived(job, from, direction, known)) return;
  }

  // LLM 1: diagnostic
  let diagnosis: Diagnosis;
  if (settings.liveLLM) {
    diagnosis = await chatJSON<Diagnosis>(settings.analysisModel, diagnosticSystem(settings), context, "LLM 1 diagnostic");
  } else {
    diagnosis = mockDiagnosis(direction, settings);
    logEvent({ kind: "llm", label: "LLM 1 diagnostic · mock", request: context, response: diagnosis });
  }
  if (!diagnosis.allowed) {
    const reason = diagnosis.rejectionReason || "That can't happen here. Try something else.";
    if (settings.reuseActions) {
      rememberClip({
        environmentId: from.environmentId,
        outcome: "rejected",
        direction,
        intentKey: diagnosis.intentKey,
        summary: reason,
        shotPrompt: "",
        toEnvironmentId: from.environmentId,
        clipUrl: "",
        provider: "none",
        rejectionReason: reason,
      });
    }
    setJob(job, "rejected", reason);
    return;
  }

  // LLM 1 produced the canonical intent key: try the archive again now that we can match on meaning exactly.
  if (settings.reuseActions) {
    const known = findByIntent(from.environmentId, diagnosis.intentKey);
    if (known && replayArchived(job, from, direction, known)) return;
  }

  const { success, chance, roll } = decideOutcome(settings, diagnosis);
  const nextDepth = from.depth + 1;
  const isFinal =
    success &&
    (nextDepth >= settings.promptsTillSuccess ||
      (diagnosis.reachesExit && nextDepth >= 0.75 * settings.promptsTillSuccess));
  const outcome: Outcome = !success ? "fail" : isFinal ? "escaped" : "success";
  job.debug = { mode: settings.outcomeMode, innovation: diagnosis.innovation, chance, roll, isFinal, diagnosis };
  logEvent({
    kind: "decision",
    label: `outcome → ${outcome}`,
    request: { mode: settings.outcomeMode, innovation: diagnosis.innovation, succeeds: diagnosis.succeeds, chance, roll, depth: from.depth, promptsTillSuccess: settings.promptsTillSuccess },
    response: { outcome, isFinal, verdictReason: diagnosis.verdictReason },
  });

  // LLM 2: shot writer
  setJob(job, "writing", "Planning the shot…");
  const beat = success ? diagnosis.successBeat : diagnosis.failBeat;
  const writerInput = JSON.stringify({
    outcome: outcome === "fail" ? `FAILURE (${diagnosis.failType})` : outcome === "escaped" ? "FINAL ESCAPE" : "SUCCESS",
    beat,
    direction,
    currentEnvironment: from.environmentId,
    storySoFar: story,
  });
  let plan: ShotPlan;
  if (settings.liveLLM) {
    plan = await chatJSON<ShotPlan>(settings.writerModel, writerSystem(), writerInput, "LLM 2 shot writer");
  } else {
    plan = mockPlan(from, beat, outcome);
    logEvent({ kind: "llm", label: "LLM 2 shot writer · mock", request: writerInput, response: plan });
  }
  job.debug.plan = plan;

  // H3 clip
  // Credit guard: below the MachGen minimum, run this step without generating video (text scene instead).
  let makeVideo = settings.liveVideo;
  if (makeVideo && !(await videoGenerationAllowed())) {
    makeVideo = false;
    job.creditsExhausted = true;
    logEvent({ kind: "error", label: `video skipped: MachGen balance below ${MACHGEN_MIN_BALANCE_USD}`, status: "error" });
  }
  if (makeVideo) setJob(job, "generating-clip", "Rolling camera…");
  const node: StoryNode = {
    id: crypto.randomUUID(),
    parentId: from.id,
    depth: success ? nextDepth : from.depth,
    environmentId: world.environments.some(e => e.id === plan.environmentId) ? plan.environmentId : from.environmentId,
    direction,
    outcome,
    failType: success ? undefined : diagnosis.failType,
    summary: plan.summary,
    clipUrl: null,
    loopUrl: null,
    scene: { summary: plan.summary, shotPrompt: plan.shotPrompt },
  };

  if (makeVideo) {
    const clip =
      settings.videoProvider === "masky"
        ? await generateMaskyVideo({
            prompt: plan.shotPrompt,
            // Continuity without reference images: this clip opens on the previous clip's final frame.
            firstFrameFile: firstFrameFor(from),
            durationSecs: STEP_SECS,
            draft: settings.maskyDraft,
          })
        : await generateVideo(await buildClipRequest(plan, from));
    node.clipUrl = clip.url;
    node.lastFrameFile = await lastFrame(clip.file);
    if (settings.reuseActions) {
      rememberClip({
        environmentId: from.environmentId,
        outcome,
        direction,
        intentKey: diagnosis.intentKey,
        summary: plan.summary,
        shotPrompt: plan.shotPrompt,
        toEnvironmentId: node.environmentId,
        failType: node.failType,
        clipUrl: node.clipUrl,
        lastFrameFile: node.lastFrameFile,
        provider: settings.videoProvider,
        costUsd: "creditCost" in clip ? (clip as { creditCost?: number }).creditCost : undefined,
      });
    }
  }

  // Idle loop on the closing close-up (success only)
  // Constant think: no per-step loop; the client idles on the fixed "Sloppy Joe thinking" macro loop instead.
  if (outcome === "success" && makeVideo && settings.constantThink) {
    logEvent({ kind: "job", label: "idle loop skipped (constant think)", response: { saved: "~$0.14 and ~9s" } });
  }
  if (outcome === "success" && makeVideo && !settings.constantThink && node.lastFrameFile) {
    setJob(job, "generating-loop", "Finding his next move…");
    {
      const loop =
        settings.videoProvider === "masky"
          ? await generateMaskyVideo({
              prompt: plan.loopPrompt,
              firstFrameFile: node.lastFrameFile,
              lastFrameFile: node.lastFrameFile, // same opening and closing frame -> seamless loop
              durationSecs: LOOP_SECS,
              draft: settings.maskyDraft,
            })
          : await generateVideo({
              task_type: "I2V",
              prompt: plan.loopPrompt,
              src_image_urls: [await uploadFile(node.lastFrameFile), await uploadFile(node.lastFrameFile)],
              keyframe_indices: [0, -1],
              durationSecs: LOOP_SECS,
            });
      node.loopUrl = loop.url;
    }
  }

  putNode(node);
  job.node = node;
  setJob(job, "done", "");
}

/**
 * Replays an archived action: its stored verdict, destination, story beat and clip become this step, with no
 * LLM call and no generation. Returns false when the row has no usable clip (e.g. it was saved in text-only mode).
 */
function replayArchived(job: Job, from: StoryNode, direction: string, known: CachedClip) {
  if (known.outcome === "rejected") {
    markClipUsed(known.id);
    logEvent({ kind: "decision", label: "archived rejection replayed", response: { direction, reason: known.rejection_reason } });
    setJob(job, "rejected", known.rejection_reason || known.summary);
    return true;
  }
  if (!known.clip_url) return false;

  markClipUsed(known.id);
  const success = known.outcome !== "fail";
  const node: StoryNode = {
    id: crypto.randomUUID(),
    parentId: from.id,
    depth: success ? from.depth + 1 : from.depth,
    environmentId: known.to_environment_id,
    direction,
    outcome: known.outcome,
    failType: (known.fail_type as StoryNode["failType"]) ?? undefined,
    summary: known.summary,
    clipUrl: known.clip_url,
    loopUrl: null,
    scene: { summary: known.summary, shotPrompt: known.shot_prompt },
    lastFrameFile: known.last_frame_file ?? undefined,
    reusedFrom: known.direction,
  };
  putNode(node);
  job.node = node;
  job.debug = undefined;
  logEvent({
    kind: "decision",
    label: `archived action replayed → ${known.outcome}`,
    request: { direction },
    response: { matched: known.direction, environment: known.to_environment_id, savedLlmCalls: 2 },
  });
  setJob(job, "done", "");
  return true;
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

/** The intro starts and ends on this keyframe, so it stands in for the intro's last frame. */
const INTRO_LAST_FRAME = "common-generated-assets/videos/intro-keyframe.png";
const INTRO_LAST_FRAME_JPEG = "media/refs/common-generated-assets__videos__intro-keyframe.jpg";

/** Local image file a Masky clip should open on: the previous clip's last frame, or the intro's keyframe. */
function firstFrameFor(from: StoryNode) {
  if (from.lastFrameFile) return from.lastFrameFile;
  for (const candidate of [INTRO_LAST_FRAME, INTRO_LAST_FRAME_JPEG]) {
    if (existsSync(`${ROOT}${candidate}`)) return `${ROOT}${candidate}`;
  }
  return null;
}

export async function buildClipRequest(plan: ShotPlan, from: StoryNode): Promise<VideoRequest> {
  const previousFrame = from.lastFrameFile
    ? await uploadFile(from.lastFrameFile)
    : from.parentId === null && hasAsset(INTRO_LAST_FRAME)
      ? await uploadAsset(INTRO_LAST_FRAME)
      : null;
  const { refs, cast } = selectReferences(plan, Boolean(previousFrame));
  const durationSecs = STEP_SECS;

  if (refs.length + cast.length > 0) {
    // Order: environment, protagonist, previous frame (continuity), then ranked cast; max 9.
    const entries = [
      ...refs.map(r => ({ label: r.label, ref: uploadAsset(r.image) })),
      ...(previousFrame ? [{ label: "the previous shot's final frame (continuity)", ref: Promise.resolve(previousFrame) }] : []),
      ...cast.map(r => ({ label: r.label, ref: uploadAsset(r.image) })),
    ].slice(0, MAX_IMAGE_REFS);
    const legend = entries.map((r, i) => `Image ${i + 1}: ${r.label}.`).join(" ");
    return {
      task_type: "R2V",
      prompt: `${legend}\n\n${plan.shotPrompt}`,
      src_image_urls: await Promise.all(entries.map(r => r.ref)),
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
  for (let n: StoryNode | undefined = node; n; n = n.parentId ? getNode(n.parentId) : undefined) {
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
    intentKey: "",
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
