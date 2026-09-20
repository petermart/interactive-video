import { useEffect, useRef, useState } from "react";
import { AdminPanel } from "./AdminPanel";
import { CreditsBanner } from "./CreditsBanner";
import { ShareBar } from "./ShareBar";
import { DebugPanel } from "./DebugPanel";
import { GeneratingHud } from "./GeneratingHud";
import { api, ApiError, type Job, type StoryNode } from "./api";
import { HyperFrame } from "./HyperFrame";
import { PromptBar } from "./PromptBar";
import { SceneText } from "./SceneText";
import { musicVolume, onMusicVolume } from "./musicVolume";
import { fetchMe, SessionBadge, SignInGate, type Me } from "./SignInGate";
import { apiFetch } from "./viewer";

/** How long the YOU FAILED / ESCAPED graphic plays before the sign-in gate is allowed to cover it. */
const OUTCOME_GRAPHIC_MS = 7000;

/** The step being generated, remembered across reloads so leaving the page doesn't lose it. */
const PENDING_KEY = "prison-escape:pending-job";
type Pending = { jobId: string; fromNodeId: string; rootId: string };
/** Resolves once the tab is visible (immediately if it already is). */
const untilVisible = () =>
  new Promise<void>(resolve => {
    if (!document.hidden) return resolve();
    const onChange = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });

/** Sleeps, but wakes early when the tab becomes visible so a backgrounded tab catches up immediately. */
const nap = (ms: number) =>
  new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    document.addEventListener("visibilitychange", done);
  });

const readPending = (): Pending | null => {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
  } catch {
    return null;
  }
};
const writePending = (p: Pending | null) => {
  try {
    p ? localStorage.setItem(PENDING_KEY, JSON.stringify(p)) : localStorage.removeItem(PENDING_KEY);
  } catch {}
};

type Phase = "intro" | "idle" | "working" | "clip" | "scene" | "failed" | "escaped";

export function App() {
  /**
   * There is no separate title screen any more: the film opens on the intro loop with the title graphics over it
   * and the prompt bar already live, so the first thing a visitor sees is the thing they are asked to do.
   * Autoplay rules mean that opening is muted; the first tap or keypress turns the sound on (see `unlock`).
   */
  const [phase, setPhase] = useState<Phase>("intro");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [root, setRoot] = useState<StoryNode | null>(null);
  const [music, setMusic] = useState<string | null>(null);
  const [thinkingLoop, setThinkingLoop] = useState<string | null>(null);
  /** Last node the viewer can direct from (intro or a success). */
  const [current, setCurrent] = useState<StoryNode | null>(null);
  /** Node whose clip is playing or just finished. */
  const [playing, setPlaying] = useState<StoryNode | null>(null);
  const [status, setStatus] = useState("");
  const [toast, setToast] = useState("");
  /** A step came back without video because MachGen is out of credits. */
  const [creditsExhausted, setCreditsExhausted] = useState(false);
  const [lastDebug, setLastDebug] = useState<Job["debug"] | null>(null);
  const [resume, setResume] = useState<Pending | null>(null);
  /** Who the viewer is and what they have left under the current guest policy. */
  const [me, setMe] = useState<Me | null>(null);
  /** Lets someone dismiss the gate to watch their finished film before signing in. */
  const [gateDismissed, setGateDismissed] = useState(false);
  /** The sign-in gate waits for a good moment: never over a clip, and never on top of the outcome graphic. */
  const [gateArmed, setGateArmed] = useState(false);
  const [showClipSource, setShowClipSource] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const musicGain = useRef<AudioContext | null>(null);
  const musicGainNode = useRef<GainNode | null>(null);
  const musicWanted = useRef(false);

  // The badge is an admin display option, so re-read it whenever a step finishes.
  const refreshDisplaySettings = () => api.settings().then(s => setShowClipSource(s.showClipSource)).catch(() => {});
  useEffect(() => {
    refreshDisplaySettings();
    // Also establishes the guest cookie, so the allowance is tracked from the first visit rather than
    // from the first generation.
    fetchMe().then(setMe).catch(() => {});
  }, []);

  useEffect(() => {
    api.session().then(async s => {
      setRoot(s.root);
      setCurrent(s.root);
      setMusic(s.music);
      setThinkingLoop(s.thinkingLoop);
      // The intro loop is the backdrop of the first prompt, so it starts on its own (muted until a gesture).
      playIntro(s.root);
      // A step was generating when the page was left: offer to pick it back up.
      const pending = readPending();
      if (pending) {
        const job = await api.job(pending.jobId).catch(() => null);
        if (job && job.status !== "rejected" && job.status !== "error") setResume(pending);
        else writePending(null);
      }
    });
  }, []);

  /**
   * Sound needs a gesture. With no BEGIN button to provide one, the film opens muted and the first tap, click or
   * keypress anywhere (typing a direction counts) turns the clip's sound on and starts the soundtrack.
   */
  const unlocked = useRef(false);
  useEffect(() => {
    const unlock = () => {
      if (unlocked.current) return;
      unlocked.current = true;
      if (videoRef.current) videoRef.current.muted = false;
      startMusic();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  /**
   * When the gate may appear. Asking mid-clip covers the film, and asking the instant a run ends covers the YOU
   * FAILED / ESCAPED animation, which is the payoff for the play they just spent. So: while the viewer is idle at
   * the prompt (where signing in is the next step anyway) it shows at once; on an outcome screen it waits for the
   * graphic to finish; during the intro, a clip, the scene text or a generation it stays away entirely.
   */
  useEffect(() => {
    if (phase === "idle") {
      setGateArmed(true);
      return;
    }
    setGateArmed(false);
    if (phase !== "failed" && phase !== "escaped") return;
    const timer = setTimeout(() => setGateArmed(true), OUTCOME_GRAPHIC_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Browsers pause or defer media in background tabs; restart whatever should be playing when the viewer returns.
  useEffect(() => {
    const onVisible = () => {
      const v = videoRef.current;
      if (document.hidden || !v || !v.src || !v.paused || v.ended) return;
      if (["intro", "idle", "working", "clip", "scene"].includes(phaseRef.current)) v.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  /**
   * Starts the soundtrack under the clips' diegetic sound (clips are generated with "No music").
   * iOS ignores HTMLMediaElement.volume, so there the level has to come from a Web Audio gain node;
   * everywhere else the plain element path is left alone.
   */
  const applyMusicVolume = (level: number) => {
    const el = musicRef.current;
    if (!el) return;
    el.volume = level;
    musicGainNode.current?.gain.setValueAtTime(level, musicGain.current?.currentTime ?? 0);
    // iOS leaves element.volume at 1 however it is set, so the level has to come from a gain node instead.
    if (Math.abs(el.volume - level) > 0.01 && !musicGain.current) {
      try {
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        gain.gain.value = level;
        ctx.createMediaElementSource(el).connect(gain).connect(ctx.destination);
        musicGain.current = ctx;
        musicGainNode.current = gain;
      } catch {
        /* no Web Audio: fall back to the element at its own level */
      }
    }
  };

  const startMusic = () => {
    // Wanted first: the gesture can land before the session response has given us a soundtrack to load, and the
    // ticker below starts it as soon as the element exists.
    musicWanted.current = true;
    const el = musicRef.current;
    if (!el) return;
    applyMusicVolume(musicVolume());
    musicGain.current?.resume().catch(() => {});
    if (musicVolume() > 0) el.play().catch(() => {});
  };

  // The viewer's own volume slider (settings panel). Silence pauses the track rather than playing it at zero.
  useEffect(
    () =>
      onMusicVolume(level => {
        applyMusicVolume(level);
        const el = musicRef.current;
        if (!el) return;
        if (level === 0) el.pause();
        else if (musicWanted.current && el.paused && !document.hidden) el.play().catch(() => {});
      }),
    [],
  );

  // iOS hands the audio session to a <video> that starts playing, which pauses the soundtrack; browsers also
  // stall media in background tabs. Pick it back up on the next tap or when the page comes back.
  useEffect(() => {
    const resume = () => {
      const el = musicRef.current;
      if (!musicWanted.current || !el || document.hidden || musicVolume() === 0) return;
      musicGain.current?.resume().catch(() => {});
      if (el.paused) el.play().catch(() => {});
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pointerdown", resume);
    const tick = setInterval(resume, 4000);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pointerdown", resume);
      clearInterval(tick);
    };
  }, [music]);

  /**
   * `startAt` skips the opening of a clip that begins on a reference sheet (fal turbo). It is only non-zero while
   * the node still points at fal's link: the stored copy is trimmed, so replays, stitched films and shares start clean.
   */
  const playVideo = (src: string | null, loop: boolean, startAt = 0, rate = 1) => {
    const v = videoRef.current;
    if (!v || !src) return;
    v.loop = loop;
    // Before the first gesture the browser will only autoplay a muted video; after it, every clip has its sound.
    v.muted = !unlocked.current;
    // Turbo Half streams its 2x-speed provider clip at 0.5 until the slowed copy exists; everything else plays at 1.
    // Set both, because loading a new source resets playbackRate to defaultPlaybackRate.
    v.defaultPlaybackRate = rate;
    v.playbackRate = rate;
    if (rate !== 1) {
      // Some browsers (older Safari especially) reset the rate when the new source loads or starts playing;
      // put it back at both points so a half-speed clip can never slip into playing at full speed.
      const keepRate = () => {
        if (v.playbackRate !== rate) v.playbackRate = rate;
      };
      v.addEventListener("loadedmetadata", keepRate, { once: true });
      v.addEventListener("playing", keepRate, { once: true });
    }
    // The #t= media fragment makes the browser start there before painting anything; the seek below backs it up.
    v.src = startAt > 0 ? `${src}#t=${startAt}` : src;
    if (startAt > 0) {
      v.addEventListener(
        "loadedmetadata",
        () => {
          v.currentTime = startAt;
        },
        { once: true },
      );
    }
    v.play().catch(() => {});
  };

  /** Picks a half-finished step back up: the offer that used to live behind RESUME on the title screen. */
  const resumePending = async () => {
    if (!resume) return;
    const [from, savedRoot] = await Promise.all([api.node(resume.fromNodeId), api.node(resume.rootId)]).catch(() => [null, null]);
    setResume(null);
    if (!from) {
      writePending(null);
      return;
    }
    if (savedRoot) setRoot(savedRoot);
    setCurrent(from);
    setPhase("working");
    playVideo(from.loopUrl ?? thinkingLoop, true);
    pollJob(resume.jobId);
  };

  const playIntro = (node: StoryNode) => {
    setCurrent(node);
    setPlaying(node);
    setPhase("intro");
    // The intro is a seamless loop that doubles as the idle loop, so keep it looping while the viewer types.
    playVideo(node.clipUrl, node.loopUrl === node.clipUrl, node.clipStartSecs, node.clipPlaybackRate);
  };

  const goIdle = (node: StoryNode) => {
    setCurrent(node);
    setPhase("idle");
    // Steps without their own loop (e.g. no-video mode) idle on the silent "Sloppy Joe thinking" macro loop.
    playVideo(node.loopUrl ?? thinkingLoop, true);
  };

  /**
   * Replays the last step from the beginning. onEnded then routes back to the outcome screen, which remounts
   * the HyperFrames overlay, so "YOU FAILED" / "ESCAPED" animate again with their normal timing.
   */
  const rewatchLast = () => {
    if (!playing || playing.outcome === "intro") return;
    if (playing.clipUrl) {
      setPhase("clip");
      playVideo(playing.clipUrl, false, playing.clipStartSecs, playing.clipPlaybackRate);
    } else if (playing.scene) {
      setPhase("scene");
    }
  };

  const canRewatch = Boolean(playing && playing.outcome !== "intro" && (playing.clipUrl || playing.scene));

  const onEnded = () => {
    // A non-looping intro can end while a direction is being processed; don't yank the viewer back to idle.
    if (!playing || phase === "working") return;
    if (playing.outcome === "fail" || playing.outcome === "escaped") {
      // The story is over either way; that is what "one full game" counts.
      setPhase(playing.outcome === "fail" ? "failed" : "escaped");
      void apiFetch("/api/game-complete", { method: "POST" })
        .then(() => fetchMe())
        .then(setMe)
        .catch(() => {});
    } else goIdle(playing);
  };

  const direct = async (direction: string) => {
    if (!current || !root) return;
    setPhase("working");
    setStatus("Analyzing escape plan…");
    try {
      const { jobId } = await api.direct(current.id, direction);
      writePending({ jobId, fromNodeId: current.id, rootId: root.id });
      await pollJob(jobId);
    } catch (err) {
      // 401 from the gate is not a failure: it means this viewer needs to sign in to continue.
      const blocked = err instanceof ApiError && err.status === 401;
      if (blocked) {
        setPhase("idle");
        void fetchMe().then(setMe).catch(() => {});
        return;
      }
      flash(`Something broke: ${(err as Error).message}`);
      setPhase("idle");
    }
  };

  /** Polls a job until it resolves. Tolerates brief network drops (e.g. the dev server hot-reloading). */
  const pollJob = async (jobId: string) => {
    let misses = 0;
    try {
      while (true) {
        await nap(700);
        let job: Job;
        try {
          job = await api.job(jobId);
          misses = 0;
        } catch (err) {
          if (++misses > 60) throw err;
          continue;
        }
        setStatus(job.message);
        if (job.debug) setLastDebug(job.debug);
        if (job.creditsExhausted) setCreditsExhausted(true);
        // The server keeps generating while the tab is in the background; hold the result until the
        // viewer is back so the clip (or the 15s scene text) isn't played to an empty, throttled tab.
        if (["rejected", "error", "done"].includes(job.status)) await untilVisible();
        if (job.status === "rejected") {
          writePending(null);
          flash(job.message);
          setPhase("idle");
          return;
        }
        if (job.status === "error") throw new Error(job.message);
        if (job.status === "done" && job.node) {
          writePending(null);
          refreshDisplaySettings();
          setPlaying(job.node);
          if (job.node.clipUrl) {
            setPhase("clip");
            playVideo(job.node.clipUrl, false, job.node.clipStartSecs, job.node.clipPlaybackRate);
          } else {
            setPhase("scene");
          }
          return;
        }
      }
    } catch (err) {
      writePending(null);
      flash(`Something broke: ${(err as Error).message}`);
      setPhase("idle");
    }
  };

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 5000);
  };

  const retryLastStep = () => current && goIdle(current);
  const retryBeginning = () => root && playIntro(root);

  const atStart = current?.parentId === null;
  const questionText = atStart ? "WHAT SHOULD SLOPPY JOE DO?" : "WHAT SHOULD SLOPPY JOE DO NEXT?";
  const placeholder = atStart ? "Sloppy Joe's in his cell. What should Sloppy Joe do?" : "What should Sloppy Joe do next?";

  const failedBind = {
    subtitle: playing?.failType === "dead" ? "SUBJECT TERMINATED" : "SUBJECT RE-DETAINED",
  };

  const gateUp = Boolean(me && !me.canGenerate && gateArmed && !gateDismissed);

  return (
    <main className="relative h-full w-full select-none bg-cell">
      <video
        ref={videoRef}
        onEnded={onEnded}
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
      />
      {music && <audio ref={musicRef} src={music} loop />}

      {/*
        The opening page: the title card that used to be its own screen, now playing over the intro loop with the
        prompt bar live underneath it. Same graphics, same taglines, one less click.
      */}
      {phase === "intro" && (
        <>
          <HyperFrame name="title" className="z-10" />
          {resume && (
            <button
              onClick={resumePending}
              className="absolute bottom-28 left-1/2 z-40 -translate-x-1/2 rounded-md border border-sodium/60 bg-black/70 px-8 py-3 font-display text-base font-bold tracking-[0.35em] text-sodium backdrop-blur transition hover:bg-sodium hover:text-black sm:bottom-32"
            >
              RESUME LAST STEP
            </button>
          )}
        </>
      )}

      {/*
        ABOUT stays reachable while the sign-in gate is up (z-[55] clears the gate's z-50 backdrop): someone
        being asked to sign in is exactly the person who wants to know whose site this is first. It is also
        shown whenever the gate is up, not just on the opening page, so the question can always be answered.
        Opens in its own tab: navigating away would drop an offered RESUME and stop the loop.
      */}
      {(phase === "intro" || gateUp) && (
        <a
          href="/about"
          target="_blank"
          rel="noreferrer"
          className="absolute bottom-24 right-6 z-[55] font-mono text-xs tracking-[0.3em] text-white/70 underline decoration-white/25 underline-offset-4 transition hover:text-teal hover:decoration-teal sm:bottom-28"
        >
          ABOUT
        </a>
      )}

      {phase === "idle" && <HyperFrame name="prompt" className="z-10" bind={{ question: questionText }} />}

      {phase === "working" && <GeneratingHud status={status} />}

      {phase === "scene" && playing && <SceneText node={playing} onDone={onEnded} />}

      {phase === "failed" && (
        <div className="absolute inset-0 z-20 bg-black/60">
          <HyperFrame name="failed" bind={failedBind} />
          <div className="absolute bottom-12 left-1/2 flex -translate-x-1/2 flex-col items-center gap-4">
            {playing && <ShareBar nodeId={playing.id} outcome="failed" accent="border-sodium/70 bg-black/70 text-sodium hover:bg-sodium hover:text-black" />}
          <div className="flex flex-wrap justify-center gap-3">
            <button
              onClick={rewatchLast}
              className="rounded-md border border-white/20 bg-black/70 px-6 py-3 font-display font-semibold tracking-widest text-white backdrop-blur hover:border-teal hover:text-teal"
            >
              REWATCH
            </button>
            <button
              onClick={retryLastStep}
              className="rounded-md border border-white/20 bg-black/70 px-6 py-3 font-display font-semibold tracking-widest text-white backdrop-blur hover:border-sodium hover:text-sodium"
            >
              TRY AGAIN FROM LAST STEP
            </button>
            <button
              onClick={retryBeginning}
              className="rounded-md border border-white/20 bg-black/70 px-6 py-3 font-display font-semibold tracking-widest text-white backdrop-blur hover:border-siren-red hover:text-siren-red"
            >
              TRY AGAIN FROM BEGINNING
            </button>
          </div>
          </div>
        </div>
      )}

      {phase === "escaped" && (
        <div className="absolute inset-0 z-20 bg-black/40">
          <HyperFrame name="escaped" />
          <div className="absolute bottom-10 left-1/2 flex -translate-x-1/2 flex-col items-center gap-4">
            {playing && <ShareBar nodeId={playing.id} outcome="escaped" accent="border-[#3dff7a] bg-[#3dff7a] text-black hover:bg-[#3dff7a]/80" />}
            <button
              onClick={rewatchLast}
              className="rounded-md border border-white/30 bg-black/70 px-6 py-3 font-display font-semibold tracking-[0.3em] text-white backdrop-blur hover:border-[#3dff7a] hover:text-[#3dff7a]"
            >
              REWATCH
            </button>
            <button
              onClick={retryBeginning}
              className="rounded-md border border-[#3dff7a]/70 bg-black/70 px-8 py-3 font-display font-semibold tracking-[0.3em] text-[#3dff7a] backdrop-blur hover:bg-[#3dff7a] hover:text-black"
            >
              PLAY AGAIN
            </button>
          </div>
        </div>
      )}

      <div className="absolute left-5 top-5 z-30 flex items-center gap-3 font-mono text-xs tracking-widest text-white/50">
          <span>ESCAPE PROGRESS · STEP {current?.depth ?? 0}</span>
          {showClipSource && playing && playing.outcome !== "intro" && (
            <span
              className={`rounded border px-2 py-1 ${
                playing.reusedFrom ? "border-teal/50 text-teal" : "border-sodium/50 text-sodium"
              }`}
              title={playing.reusedFrom ? `Archived clip, first filmed for: ${playing.reusedFrom}` : "Generated for this run"}
            >
              {playing.reusedFrom ? "CACHED" : "GENERATED"}
            </span>
          )}
          {phase === "idle" && canRewatch && (
            <button onClick={rewatchLast} className="rounded border border-white/20 px-2 py-1 text-white/70 hover:border-teal hover:text-teal">
              ↺ REWATCH LAST CLIP
            </button>
          )}
      </div>

      {toast && (
        <div className="absolute left-1/2 top-20 z-40 max-w-xl -translate-x-1/2 rounded-md border border-siren-red/50 bg-black/80 px-5 py-3 text-center font-mono text-sm text-white backdrop-blur">
          {toast}
        </div>
      )}

      {me?.signedIn && (
        <div className="absolute bottom-4 left-5 z-30">
          <SessionBadge me={me} />
        </div>
      )}

      <CreditsBanner forced={creditsExhausted} />
      <DebugPanel />
      <AdminPanel lastDebug={lastDebug} />

      {phase !== "failed" && phase !== "escaped" && (
        <PromptBar enabled={phase === "idle" || phase === "intro"} status={status} placeholder={placeholder} onSubmit={direct} />
      )}

      {/*
        The sign-in gate. Held back on the opening page so the title card is never the first thing gated,
        and dismissible on an ending so someone can watch and download the film they just made before
        deciding to sign up.
      */}
      {gateUp && me && (
        <SignInGate
          me={me}
          onDismiss={phase === "failed" || phase === "escaped" ? () => setGateDismissed(true) : undefined}
          // The run they just finished is what they would be sharing for another go.
          nodeId={playing?.id ?? current?.id}
          onEarned={() => void fetchMe().then(setMe).catch(() => {})}
        />
      )}
    </main>
  );
}
