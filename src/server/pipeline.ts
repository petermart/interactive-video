import { CACHE_DIR, clamp, getSettings, introMedia, mediaPath, ROOT, world, type OutcomeMode, type Settings } from "./config";
import { findByIntent, findReusableClip, getArchived, markClipUsed, rememberClip, replaceArchivedClip, type CachedClip } from "./actionCache";
import type { VideoProvider } from "./constants";
import { MIN_BALANCE_USD, videoGenerationAllowed } from "./credits";
import { jobContext, loadJob, loadNode, logEvent, saveJob, saveNode } from "./db";
import { chatJSON } from "./llm";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import * as falTurboHalfVideo from "./falTurboHalfVideo";
import * as falTurboVideo from "./falTurboVideo";
import * as falVideo from "./falVideo";
import * as gmiVideo from "./gmiVideo";
import * as machgen from "./machgen";
import { hasAsset, lastFrame, MAX_IMAGE_REFS, type VideoRequest } from "./machgen";
import { fetchTo, isGeneratedUrl, keyForMediaUrl, objectExists, putFile, r2Enabled, releaseLocalCopy } from "./storage";
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
  /**
   * Seconds to skip at the start of clipUrl. Only set while clipUrl is a provider's CDN link for a clip that opens
   * on a reference sheet (fal turbo); the stored copy is trimmed, so this goes back to 0 once it replaces the link.
   */
  clipStartSecs?: number;
  /** Playback speed for clipUrl while it is a provider link (Turbo Half streams its 2x clip at 0.5); cleared after. */
  clipPlaybackRate?: number;
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
  /**
   * The direction is itself an attempt to get out. Only such an attempt can end the game: an everyday action
   * on the last step ("stay hydrated") succeeds as an ordinary beat and the story goes on.
   */
  escapeAttempt?: boolean;
  /** Canonical "verb:tool:target:destination" form of the attempt; matches archived clips exactly. */
  intentKey?: string;
  /** vibes/hybrid modes: the LLM's verdict. Ignored in dice mode. */
  succeeds?: boolean;
  verdictReason?: string;
};

type ShotPlan = {
  shotPrompt: string;
  environmentId: string;
  /** He got there by going along with the prison day (meals, yard, showers, ...): may skip adjacency. */
  scheduledMove?: boolean;
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
    // Known before the verdict: if this step succeeds, the game ends. LLM 1 has to write the success beat as the
    // escape itself, or the finale plays a small step inside the walls with a "you escaped" screen after it.
    successEscapesPrison: from.depth + 1 >= settings.promptsTillSuccess,
    ...(from.depth + 1 >= settings.promptsTillSuccess && {
      finale: `If this is an escape attempt and it succeeds, the game ends: successBeat must get him completely out of the prison, from ${from.environmentId} through or past the last barrier to outside the walls, free. If it is not an escape attempt, it cannot end the game however well it goes.`,
    }),
    ...(settings.outcomeMode === "hybrid" && {
      successProbability: settings.successProbability,
      creativityPoints: settings.creativityPoints,
    }),
    storySoFar: story,
  });

  // LLM 1 (diagnostic) starts straight away, alongside the archive lookup rather than after it: on a miss
  // (most fresh actions) that saves the whole lookup, up to ~2.6s. On a hit the diagnosis is simply discarded,
  // which wastes one flash-lite call (~$0.0005) in exchange for never making a miss wait.
  const diagnosing: Promise<Diagnosis> = settings.liveLLM
    ? chatJSON<Diagnosis>(settings.analysisModel, diagnosticSystem(settings), context, "LLM 1 diagnostic")
    : Promise.resolve().then(() => {
        const mock = mockDiagnosis(direction, settings);
        logEvent({ kind: "llm", label: "LLM 1 diagnostic · mock", request: context, response: mock });
        return mock;
      });
  diagnosing.catch(() => {}); // a hit never awaits it; don't let its failure surface as unhandled

  // Archive: a move already filmed in this location replays with its stored verdict, destination and clip,
  // so neither the shot writer nor a generation is needed. Wording/Gemma only, since the intent key needs LLM 1.
  if (settings.reuseActions) {
    const known = await findReusableClip({
      environmentId: from.environmentId,
      direction,
      model: settings.matchModel,
      liveLLM: settings.liveLLM,
    });
    if (known && replayArchived(job, from, direction, known)) {
      logEvent({ kind: "job", label: "parallel LLM 1 discarded (archive hit)" });
      return;
    }
  }

  const diagnosis = await diagnosing;
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
  // Only a real escape attempt can end the game. Enough successful steps opens the door; it does not push
  // him through it - "read a book" on the last step is a quiet success, and the next direction is the finale.
  const isFinal =
    success &&
    diagnosis.escapeAttempt === true &&
    (nextDepth >= settings.promptsTillSuccess ||
      (diagnosis.reachesExit && nextDepth >= 0.75 * settings.promptsTillSuccess));
  const outcome: Outcome = !success ? "fail" : isFinal ? "escaped" : "success";
  job.debug = { mode: settings.outcomeMode, innovation: diagnosis.innovation, chance, roll, isFinal, diagnosis };
  logEvent({
    kind: "decision",
    label: `outcome → ${outcome}`,
    request: { mode: settings.outcomeMode, innovation: diagnosis.innovation, succeeds: diagnosis.succeeds, escapeAttempt: diagnosis.escapeAttempt, chance, roll, depth: from.depth, promptsTillSuccess: settings.promptsTillSuccess },
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
    ...(outcome === "escaped" && {
      exitCandidates: world.exitEnvironments,
      // Spelled out in the input as well as the system prompt: the fast writer follows input far more reliably,
      // and without this it would play the beat inside the walls and end on a corridor close-up.
      finale:
        `This clip is the END OF THE GAME. He must get COMPLETELY OUT of the prison in this clip: start from the beat, ` +
        `then keep going through or past the last barrier (wall, fence, gate, roof, drain or vehicle) and out. The last shot ` +
        `must be a triumphant WIDE shot OUTSIDE the prison walls, him free, the prison behind him. Do not end inside the ` +
        `prison and do not end on a close-up. environmentId is the exit he leaves through: ${nearestExit(from.environmentId)} ` +
        `is the nearest from here (any of exitCandidates is fine if the story fits one better).`,
    }),
    storySoFar: story,
  });
  let plan: ShotPlan;
  if (settings.liveLLM) {
    plan = await chatJSON<ShotPlan>(settings.writerModel, writerSystem(), writerInput, "LLM 2 shot writer");
  } else {
    plan = mockPlan(from, beat, outcome);
    logEvent({ kind: "llm", label: "LLM 2 shot writer · mock", request: writerInput, response: plan });
  }
  plan.environmentId = destinationFor(from, plan.environmentId, Boolean(plan.scheduledMove), outcome === "escaped");
  job.debug.plan = plan;

  // H3 clip
  // Credit guard: below the provider's minimum, run this step without generating video (text scene instead).
  let makeVideo = settings.liveVideo;
  if (makeVideo && !(await videoGenerationAllowed(settings.videoProvider))) {
    makeVideo = false;
    job.creditsExhausted = true;
    logEvent({ kind: "error", label: `video skipped: ${settings.videoProvider} balance below $${MIN_BALANCE_USD}`, status: "error" });
  }
  const api = videoApi(settings.videoProvider);
  if (makeVideo) setJob(job, "generating-clip", "Rolling camera…");
  const node: StoryNode = {
    id: crypto.randomUUID(),
    parentId: from.id,
    depth: success ? nextDepth : from.depth,
    environmentId: plan.environmentId, // already checked by destinationFor
    direction,
    outcome,
    failType: success ? undefined : diagnosis.failType,
    summary: plan.summary,
    clipUrl: null,
    loopUrl: null,
    scene: { summary: plan.summary, shotPrompt: plan.shotPrompt },
  };

  if (makeVideo) {
    // The previous step may still be storing its clip in the background, and its last frame is this clip's
    // continuity reference. It has had the whole LLM round to finish, so this rarely waits.
    await whenFinalized(from.id);
    const clip =
      settings.videoProvider === "masky"
        ? await generateMaskyVideo({
            prompt: plan.shotPrompt,
            // Continuity without reference images: this clip opens on the previous clip's final frame.
            firstFrameFile: await firstFrameFor(from),
            durationSecs: STEP_SECS,
            draft: settings.maskyDraft,
          })
        : await api.generateVideo(await buildClipRequest(plan, from, api));
    const costUsd = "creditCost" in clip ? (clip as { creditCost?: number }).creditCost : undefined;

    /** Points the node at the stored clip, reads its last frame and archives it for reuse. */
    const store = async (file: string, url: string) => {
      node.clipUrl = url;
      // ffmpeg needs the clip on disk; once its last frame is out, the local copy has served its purpose.
      node.lastFrameFile = await lastFrame(file);
      await keepFrame(node.lastFrameFile);
      await releaseLocalCopy(file, url);
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
          clipUrl: url,
          lastFrameFile: node.lastFrameFile,
          provider: settings.videoProvider,
          costUsd,
          characterIds: plan.characterIds,
        });
      }
    };

    if ("finalize" in clip) {
      // Play straight from the provider's CDN: the player starts watching now, while the download, the copy
      // to R2, the last frame and the archive entry happen in the background (~2-4s saved per step).
      node.clipUrl = clip.url;
      node.clipStartSecs = clip.clipStartSecs || undefined;
      const rate = (clip as { playbackRate?: number }).playbackRate;
      node.clipPlaybackRate = rate && rate !== 1 ? rate : undefined;
      const finalize = clip.finalize;
      trackFinalize(
        node,
        (async () => {
          const local = await finalize();
          node.clipStartSecs = undefined; // the stored copy is already trimmed
          node.clipPlaybackRate = undefined; // ...and already slowed
          await store(local.file, local.url);
          putNode(node); // persist the stable /media URL in place of the CDN link
        })(),
      );
    } else {
      await store(clip.file, clip.url);
    }
  }

  // Idle loop on the closing close-up (success only)
  // Constant think: no per-step loop; the client idles on the fixed "Sloppy Joe thinking" macro loop instead.
  if (outcome === "success" && makeVideo && settings.constantThink) {
    logEvent({ kind: "job", label: "idle loop skipped (constant think)", response: { saved: "~$0.14 and ~9s" } });
  }
  // A per-step idle loop opens on this clip's last frame, which a background finalize may still be producing.
  if (outcome === "success" && makeVideo && !settings.constantThink) await whenFinalized(node.id);
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
          : await api.generateVideo({
              task_type: "I2V",
              prompt: plan.loopPrompt,
              src_image_urls: [await api.uploadFile(node.lastFrameFile), await api.uploadFile(node.lastFrameFile)],
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
  /**
   * Rejections are judged fresh every time rather than replayed. A stored one would outlive any change to what
   * counts as rejectable (reckless moves used to be refused where they now play as failures), and replaying
   * saves nothing: LLM 1 is already running alongside the archive lookup.
   */
  if (known.outcome === "rejected") return false;
  if (!known.clip_url) return false;
  // An escape ends the game, so it only replays for someone on their final step. Earlier in a run, the same
  // move is judged fresh against where they actually are.
  if (known.outcome === "escaped") {
    const { promptsTillSuccess } = getSettings();
    if (from.depth + 1 < promptsTillSuccess) return false;
  }

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
/**
 * Places the normal prison day takes inmates to, under escort. A move that happens by going along with the
 * schedule ("wait until lunchtime") may reach one of these from anywhere, not just from a neighboring room.
 * Solitary is deliberately absent: it is a punishment, not part of the day.
 */
const SCHEDULE_DESTINATIONS = new Set([
  "cafeteria", "yard", "showers", "library", "chapel", "visitation", "infirmary",
  "laundry", "kitchen", "workshop", "cell-block-a", "cell-block-tier",
]);

/**
 * Where the protagonist really ends up. The writer names it, but only the current environment, one of its
 * neighbors, or (for a scheduled move) a place on the prison's daily routine is reachable in one step. Anything
 * else (an unknown id, or a room two doors away) keeps him where he is rather than teleporting him, and is logged
 * so a bad pattern in the writer shows up in the debug history.
 */
function destinationFor(from: StoryNode, proposed: string, scheduled = false, escaping = false) {
  // The finale: he leaves through an exit, which is rarely next door, and the game ends so nothing follows on. A
  // room inside the walls can't be where an escape ends, so the nearest exit stands in for it.
  if (escaping) return world.exitEnvironments.includes(proposed) ? proposed : nearestExit(from.environmentId);
  if (proposed === from.environmentId) return proposed;
  if (!world.environments.some(e => e.id === proposed)) return staying(from, proposed, "unknown environment");
  const here = world.environments.find(e => e.id === from.environmentId);
  if (here?.neighbors.includes(proposed)) return proposed;
  if (scheduled && SCHEDULE_DESTINATIONS.has(proposed)) {
    logEvent({ kind: "decision", label: "scheduled move", response: { from: from.environmentId, to: proposed } });
    return proposed;
  }
  return staying(from, proposed, scheduled ? "not a place the daily schedule goes" : "not a neighboring environment");
}

/** The exit environment fewest rooms away from `start` on the map (breadth-first over neighbors). */
function nearestExit(start: string) {
  const exits = new Set(world.exitEnvironments);
  const seen = new Set([start]);
  let frontier = [start];
  while (frontier.length) {
    const hit = frontier.find(id => exits.has(id));
    if (hit) return hit;
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of world.environments.find(e => e.id === id)?.neighbors ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return world.exitEnvironments[0] ?? start;
}

function staying(from: StoryNode, proposed: string, reason: string) {
  const here = world.environments.find(e => e.id === from.environmentId);
  logEvent({
    kind: "decision",
    label: "destination not reachable, staying put",
    status: "error",
    response: { from: from.environmentId, proposed, reason, neighbors: here?.neighbors ?? [] },
  });
  return from.environmentId;
}

/** First sentence of a description: enough to tell a sheet's characters apart without a paragraph each. */
const firstSentence = (text: string) => (text.split(/(?<=[.!?])\s/)[0] ?? text).slice(0, 140);

type Reference = { label: string; image: string; kind: "environment" | "location" | "character"; sheetLabel: string; note: string };

/**
 * `startEnvironmentId` is where the clip opens. When the protagonist moves (plan.environmentId, the destination,
 * differs), both plates are attached: the clip has to show where he starts and where he ends up. The environment
 * he starts in stays first, so on a turbo sheet it gets the big panel.
 */
export function selectReferences(plan: ShotPlan, hasPreviousFrame: boolean, startEnvironmentId = plan.environmentId) {
  const refs: Reference[] = [];
  const start = world.environments.find(e => e.id === startEnvironmentId);
  const destination = world.environments.find(e => e.id === plan.environmentId);
  const moves = Boolean(start && destination && start.id !== destination.id);
  if (start?.image) {
    refs.push({
      label: moves ? `environment plate of ${start.id} (where the clip starts)` : `environment plate of ${start.id}`,
      image: start.image,
      kind: "environment",
      sheetLabel: moves ? `ENVIRONMENT - ${start.id} (start)` : `ENVIRONMENT - ${start.id}`,
      note: moves ? "where this clip starts" : "the location this clip takes place in",
    });
  }
  if (moves && destination?.image) {
    refs.push({
      label: `environment plate of ${destination.id} (where the clip ends)`,
      image: destination.image,
      kind: "location",
      sheetLabel: `${destination.id.toUpperCase()} (end)`,
      note: "where the protagonist ends up by the end of this clip",
    });
  }

  const protagonist = world.characters.find(c => c.id === "protagonist");
  if (protagonist?.image) {
    refs.push({
      label: "character sheet of the protagonist (red jumpsuit)",
      image: protagonist.image,
      kind: "character",
      sheetLabel: "PROTAGONIST - Sloppy Joe (red jumpsuit)",
      note: "the protagonist, always in his red jumpsuit",
    });
  }

  const slotsForCast = MAX_IMAGE_REFS - refs.length - (hasPreviousFrame ? 1 : 0);
  const cast = plan.characterIds
    .filter(id => id !== "protagonist")
    .map(id => world.characters.find(c => c.id === id))
    .filter(c => c?.image)
    .slice(0, Math.max(0, slotsForCast))
    .map(
      (c): Reference => ({
        label: `character sheet of ${c!.id} (${c!.role})`,
        image: c!.image!,
        kind: "character",
        sheetLabel: c!.id.toUpperCase(),
        note: `${c!.role}: ${firstSentence(c!.description)}`,
      }),
    );

  return { refs, cast };
}

/** The intro starts and ends on this keyframe, so it stands in for the intro's last frame. */
const INTRO_LAST_FRAME = "common-generated-assets/videos/intro-keyframe.png";
const INTRO_LAST_FRAME_JPEG = "media/refs/common-generated-assets__videos__intro-keyframe.jpg";

/**
 * Last frames are what the next clip continues from, so they are kept in R2 beside the clips (same key layout:
 * `cache/<clip>-last.png`). The local PNG is only a working copy: the container disk is cleared by migrations and
 * redeploys, which is how archived clips ended up pointing at frames that no longer existed and crashed the step
 * after every cache hit.
 */
async function keepFrame(file: string) {
  if (!r2Enabled()) return;
  try {
    await putFile(`cache/${file.split(/[\\/]/).pop()}`, file);
  } catch (err) {
    logEvent({ kind: "error", label: "last frame not stored in R2", status: "error", response: String(err) });
  }
}

/**
 * A local copy of a node's last frame, or null. Tries, in order: the file on disk, the copy in R2, and finally
 * re-extracting it from the node's clip. Never throws: a missing continuity frame costs the next clip its
 * opening reference, not the whole step.
 */
async function ensureLastFrame(node: StoryNode): Promise<string | null> {
  try {
    if (node.lastFrameFile && existsSync(node.lastFrameFile)) return node.lastFrameFile;
    mkdirSync(CACHE_DIR, { recursive: true });
    const name = node.lastFrameFile?.split(/[\\/]/).pop();
    if (name && r2Enabled() && (await objectExists(`cache/${name}`))) {
      node.lastFrameFile = await fetchTo(`cache/${name}`, CACHE_DIR);
      return node.lastFrameFile;
    }
    // Rebuild from the clip itself: from R2, or straight from the provider's CDN link. Only generated clips: the
    // intro is committed media with its own keyframe (INTRO_LAST_FRAME), and a rebuild would write into the repo.
    const url = node.clipUrl;
    if (!url || !(isGeneratedUrl(url) || /^https?:/.test(url))) return null;
    let clip: string | null = null;
    /** Set when the clip was downloaded just for this: deleted again once the frame is out. */
    let temporary = false;
    if (r2Enabled() && isGeneratedUrl(url)) {
      const key = keyForMediaUrl(url);
      if (key && (await objectExists(key))) {
        clip = await fetchTo(key, CACHE_DIR);
        temporary = true;
      }
    } else if (/^https?:/.test(url)) {
      clip = `${CACHE_DIR}/rebuild-${node.id}.mp4`;
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) return null;
      await Bun.write(clip, await res.arrayBuffer());
      temporary = true;
    } else {
      const local = mediaPath(url);
      if (local && existsSync(local)) clip = local;
    }
    if (!clip) return null;
    try {
      node.lastFrameFile = await lastFrame(clip);
    } finally {
      // Only the frame is needed; a whole clip left behind per rebuild would slowly fill the disk.
      if (temporary) rmSync(clip, { force: true });
    }
    await keepFrame(node.lastFrameFile);
    putNode(node);
    logEvent({ kind: "job", label: "last frame rebuilt from clip", response: { nodeId: node.id, clipUrl: url } });
    return node.lastFrameFile;
  } catch (err) {
    logEvent({ kind: "error", label: "no continuity frame", status: "error", response: { nodeId: node.id, error: String(err) } });
    return null;
  }
}

/** Local image file a Masky clip should open on: the previous clip's last frame, or the intro's keyframe. */
async function firstFrameFor(from: StoryNode) {
  const frame = await ensureLastFrame(from);
  if (frame) return frame;
  for (const candidate of [INTRO_LAST_FRAME, INTRO_LAST_FRAME_JPEG]) {
    if (existsSync(`${ROOT}${candidate}`)) return `${ROOT}${candidate}`;
  }
  return null;
}

/**
 * The H3 client for a provider. MachGen and GMI take the same request and differ only in how references
 * are hosted (MachGen uploads, GMI fetches public URLs), which each module handles itself.
 */
export const videoApi = (provider: VideoProvider) =>
  provider === "fal-turbo" ? falTurboVideo : provider === "fal-turbo-half" ? falTurboHalfVideo : provider === "fal" ? falVideo : provider === "gmi" ? gmiVideo : machgen;

/**
 * Clips handed to the player as a provider CDN link are stored afterwards. Anything that needs the stored
 * copy — the next step's continuity frame, a per-step idle loop, a film export — waits on this first.
 */
const finalizing = new Map<string, Promise<void>>();

function trackFinalize(node: StoryNode, work: Promise<void>) {
  const tracked = work
    .catch(err => {
      // The CDN link keeps playing; the step just misses its stored copy, last frame and archive entry.
      logEvent({ kind: "error", label: "clip finalize failed", status: "error", response: String((err as Error)?.stack ?? err) });
    })
    .finally(() => finalizing.delete(node.id));
  finalizing.set(node.id, tracked);
}

/** Resolves once a node's clip has been stored (immediately when nothing is pending). */
export const whenFinalized = (nodeId: string) => finalizing.get(nodeId) ?? Promise.resolve();

export async function buildClipRequest(plan: ShotPlan, from: StoryNode, api: ReturnType<typeof videoApi> = machgen): Promise<VideoRequest> {
  const { uploadAsset, uploadFile } = api;
  const frameFile = await ensureLastFrame(from);
  const previousFrame = frameFile
    ? await uploadFile(frameFile).catch(err => {
        logEvent({ kind: "error", label: "continuity frame not sent", status: "error", response: String(err) });
        return null;
      })
    : from.parentId === null && hasAsset(INTRO_LAST_FRAME)
      ? await uploadAsset(INTRO_LAST_FRAME)
      : null;
  const { refs, cast } = selectReferences(plan, Boolean(previousFrame), from.environmentId);
  const durationSecs = STEP_SECS;

  if (refs.length + cast.length > 0) {
    // Order: environment, protagonist, previous frame (continuity), then ranked cast; max 9.
    const entries = [
      ...refs.map(r => ({ ...r, ref: uploadAsset(r.image) })),
      ...(previousFrame
        ? [
            {
              label: "the previous shot's final frame (continuity)",
              ref: Promise.resolve(previousFrame),
              kind: "frame" as const,
              sheetLabel: "PREVIOUS SHOT",
              note: "where the last clip ended: continue from this moment",
            },
          ]
        : []),
      ...cast.map(r => ({ ...r, ref: uploadAsset(r.image) })),
    ].slice(0, MAX_IMAGE_REFS);
    const legend = entries.map((r, i) => `Image ${i + 1}: ${r.label}.`).join(" ");
    return {
      task_type: "R2V",
      prompt: `${legend}\n\n${plan.shotPrompt}`,
      src_image_urls: await Promise.all(entries.map(r => r.ref)),
      refs: entries.map(({ kind, sheetLabel, note }) => ({ kind, sheetLabel, note })),
      shotPrompt: plan.shotPrompt,
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
    escapeAttempt: /(escape|break|climb|dig|sneak|flee|run|disguise|tunnel|out)/i.test(direction),
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

// ---------- Admin: regenerate an archived clip ----------

export type Regeneration = { status: "running" | "done" | "error"; provider: VideoProvider; startedAt: string; finishedAt?: string; error?: string; costUsd?: number };
/** In-memory only: a regeneration is minutes of work at most, and the archive row itself is the durable result. */
const regenerations = new Map<number, Regeneration>();
export const regenerationStatus = (id: number) => regenerations.get(id);

/**
 * Re-shoots an archived action from its stored shot list with the chosen video provider, then points the archive
 * row at the new clip (the old video is deleted once nothing else refers to it). The verdict, outcome, destination
 * and summary stay as they were: this replaces the footage, not the decision. Spends that provider's credits.
 */
export function regenerateArchived(id: number, provider: VideoProvider) {
  const row = getArchived(id);
  if (!row) throw new Error("No such archive entry");
  if (row.outcome === "rejected" || !row.clip_url) throw new Error("Rejected actions have no clip to regenerate");
  if (provider === "masky") throw new Error("Masky can't regenerate archived clips (it needs a first frame, not references)");
  if (regenerations.get(id)?.status === "running") throw new Error("Already regenerating");
  const job: Regeneration = { status: "running", provider, startedAt: new Date().toISOString() };
  regenerations.set(id, job);

  void jobContext.run({ jobId: `regenerate-${id}` }, async () => {
    try {
      const characterIds: string[] = row.character_ids ? JSON.parse(row.character_ids) : ["protagonist"];
      const plan: ShotPlan = {
        shotPrompt: row.shot_prompt,
        environmentId: row.to_environment_id,
        characterIds,
        summary: row.summary,
        loopPrompt: "",
      };
      // Where the original clip started. No previous shot to continue from: an archived clip is reused from many
      // different stories, so it should stand on its own.
      const start: StoryNode = {
        id: `archive-${id}`,
        parentId: "archive",
        depth: 0,
        environmentId: row.environment_id,
        direction: row.direction,
        outcome: row.outcome as Outcome,
        summary: row.summary,
        clipUrl: null,
        loopUrl: null,
      };
      const api = videoApi(provider);
      const clip = await api.generateVideo(await buildClipRequest(plan, start, api));
      const local = "finalize" in clip ? await clip.finalize() : { file: clip.file, url: clip.url };
      const frame = await lastFrame(local.file);
      await keepFrame(frame);
      await releaseLocalCopy(local.file, local.url);
      job.costUsd = "creditCost" in clip ? (clip as { creditCost?: number }).creditCost : undefined;
      replaceArchivedClip(id, { clipUrl: local.url, lastFrameFile: frame, provider, costUsd: job.costUsd });
      job.status = "done";
    } catch (err) {
      job.status = "error";
      job.error = String((err as Error)?.message ?? err);
      logEvent({ kind: "error", label: "archive regeneration failed", status: "error", response: { id, provider, error: job.error } });
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  });
  return job;
}
