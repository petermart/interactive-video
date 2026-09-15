import { useEffect, useRef, useState } from "react";
import { AdminPanel } from "./AdminPanel";
import { CreditsBanner } from "./CreditsBanner";
import { DownloadFilmButton } from "./DownloadFilmButton";
import { DebugPanel } from "./DebugPanel";
import { GeneratingHud } from "./GeneratingHud";
import { api, type Job, type StoryNode } from "./api";
import { HyperFrame } from "./HyperFrame";
import { PromptBar } from "./PromptBar";
import { SceneText } from "./SceneText";

const MUSIC_VOLUME = 0.35;

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

type Phase ="start" | "intro" | "idle" | "working" | "clip" | "scene" | "failed" | "escaped";

export function App() {
  const [phase, setPhase] = useState<Phase>("start");
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    api.session().then(async s => {
      setRoot(s.root);
      setCurrent(s.root);
      setMusic(s.music);
      setThinkingLoop(s.thinkingLoop);
      // A step was generating when the page was left: offer to pick it back up.
      const pending = readPending();
      if (pending) {
        const job = await api.job(pending.jobId).catch(() => null);
        if (job && job.status !== "rejected" && job.status !== "error") setResume(pending);
        else writePending(null);
      }
    });
  }, []);

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

  const playVideo = (src: string | null, loop: boolean) => {
    const v = videoRef.current;
    if (!v || !src) return;
    v.loop = loop;
    v.src = src;
    v.play().catch(() => {});
  };

  const start = async () => {
    if (!root) return;
    // Soundtrack sits under the clips' diegetic sound (clips are generated with "No music").
    if (musicRef.current) {
      musicRef.current.volume = MUSIC_VOLUME;
      musicRef.current.play().catch(() => {});
    }
    if (resume) {
      const [from, savedRoot] = await Promise.all([api.node(resume.fromNodeId), api.node(resume.rootId)]).catch(() => [null, null]);
      if (from) {
        if (savedRoot) setRoot(savedRoot);
        setCurrent(from);
        setPhase("working");
        playVideo(from.loopUrl ?? thinkingLoop, true);
        pollJob(resume.jobId);
        setResume(null);
        return;
      }
      writePending(null);
    }
    playIntro(root);
  };

  const playIntro = (node: StoryNode) => {
    setCurrent(node);
    setPlaying(node);
    setPhase("intro");
    // The intro is a seamless loop that doubles as the idle loop, so keep it looping while the viewer types.
    playVideo(node.clipUrl, node.loopUrl === node.clipUrl);
  };

  const goIdle = (node: StoryNode) => {
    setCurrent(node);
    setPhase("idle");
    // Steps without their own loop (e.g. no-video mode) idle on the silent "Larry thinking" macro loop.
    playVideo(node.loopUrl ?? thinkingLoop, true);
  };

  const onEnded = () => {
    // A non-looping intro can end while a direction is being processed; don't yank the viewer back to idle.
    if (!playing || phase === "working") return;
    if (playing.outcome === "fail") setPhase("failed");
    else if (playing.outcome === "escaped") setPhase("escaped");
    else goIdle(playing);
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
          setPlaying(job.node);
          if (job.node.clipUrl) {
            setPhase("clip");
            playVideo(job.node.clipUrl, false);
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
  const questionText = atStart ? "WHAT SHOULD LARRY DO?" : "WHAT SHOULD LARRY DO NEXT?";
  const placeholder = atStart ? "Larry's in his cell. What should Larry do?" : "What should Larry do next?";

  const failedBind = {
    subtitle: playing?.failType === "dead" ? "SUBJECT TERMINATED" : "SUBJECT RE-DETAINED",
  };

  return (
    <main className="relative h-full w-full select-none bg-cell">
      <video
        ref={videoRef}
        onEnded={onEnded}
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
      />
      {music && <audio ref={musicRef} src={music} loop />}

      {phase === "start" && (
        <div className="absolute inset-0 z-20 bg-black">
          <HyperFrame name="title" />
          <button
            onClick={start}
            disabled={!root}
            className="absolute bottom-16 left-1/2 z-10 -translate-x-1/2 rounded-md border border-sodium/60 bg-black/60 px-10 py-4 font-display text-xl font-bold tracking-[0.4em] text-sodium backdrop-blur transition hover:bg-sodium hover:text-black"
          >
            {resume ? "RESUME" : "BEGIN"}
          </button>
        </div>
      )}

      {phase === "intro" && <HyperFrame name="intro-title" className="z-10" />}

      {phase === "idle" && <HyperFrame name="prompt" className="z-10" bind={{ question: questionText }} />}

      {phase === "working" && <GeneratingHud status={status} />}

      {phase === "scene" && playing && <SceneText node={playing} onDone={onEnded} />}

      {phase === "failed" && (
        <div className="absolute inset-0 z-20">
          <HyperFrame name="failed" bind={failedBind} />
          <div className="absolute bottom-12 left-1/2 flex -translate-x-1/2 flex-col items-center gap-4">
            {playing && (
              <DownloadFilmButton
                nodeId={playing.id}
                outcome="failed"
                className="border-sodium/70 bg-black/70 text-sodium hover:bg-sodium hover:text-black"
              />
            )}
          <div className="flex gap-4">
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
          <div className="absolute bottom-12 left-1/2 flex -translate-x-1/2 items-start gap-4">
            {playing && (
              <DownloadFilmButton
                nodeId={playing.id}
                outcome="escaped"
                className="border-[#3dff7a] bg-[#3dff7a] text-black hover:bg-[#3dff7a]/80"
              />
            )}
            <button
              onClick={retryBeginning}
              className="rounded-md border border-[#3dff7a]/70 bg-black/70 px-8 py-3 font-display font-semibold tracking-[0.3em] text-[#3dff7a] backdrop-blur hover:bg-[#3dff7a] hover:text-black"
            >
              PLAY AGAIN
            </button>
          </div>
        </div>
      )}

      {phase !== "start" && (
        <div className="absolute left-5 top-5 z-30 font-mono text-xs tracking-widest text-white/50">
          ESCAPE PROGRESS · STEP {current?.depth ?? 0}
        </div>
      )}

      {toast && (
        <div className="absolute left-1/2 top-20 z-40 max-w-xl -translate-x-1/2 rounded-md border border-siren-red/50 bg-black/80 px-5 py-3 text-center font-mono text-sm text-white backdrop-blur">
          {toast}
        </div>
      )}

      <CreditsBanner forced={creditsExhausted} />
      <DebugPanel />
      <AdminPanel lastDebug={lastDebug} />

      {phase !== "start" && phase !== "failed" && phase !== "escaped" && (
        <PromptBar enabled={phase === "idle" || phase === "intro"} status={status} placeholder={placeholder} onSubmit={direct} />
      )}
    </main>
  );
}
