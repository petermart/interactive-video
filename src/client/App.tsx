import { useEffect, useRef, useState } from "react";
import { AdminPanel } from "./AdminPanel";
import { api, type Job, type StoryNode } from "./api";
import { HyperFrame } from "./HyperFrame";
import { PromptBar } from "./PromptBar";

type Phase = "start" | "intro" | "idle" | "working" | "clip" | "failed" | "escaped";

export function App() {
  const [phase, setPhase] = useState<Phase>("start");
  const [root, setRoot] = useState<StoryNode | null>(null);
  const [music, setMusic] = useState<string | null>(null);
  /** Last node the viewer can direct from (intro or a success). */
  const [current, setCurrent] = useState<StoryNode | null>(null);
  /** Node whose clip is playing or just finished. */
  const [playing, setPlaying] = useState<StoryNode | null>(null);
  const [status, setStatus] = useState("");
  const [toast, setToast] = useState("");
  const [lastDebug, setLastDebug] = useState<Job["debug"] | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    api.session().then(s => {
      setRoot(s.root);
      setCurrent(s.root);
      setMusic(s.music);
    });
  }, []);

  const playVideo = (src: string, loop: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    v.loop = loop;
    v.src = src;
    v.play().catch(() => {});
  };

  const start = () => {
    if (!root) return;
    musicRef.current?.play().catch(() => {});
    playIntro(root);
  };

  const playIntro = (node: StoryNode) => {
    setCurrent(node);
    setPlaying(node);
    setPhase("intro");
    playVideo(node.clipUrl, false);
  };

  const goIdle = (node: StoryNode) => {
    setCurrent(node);
    setPhase("idle");
    playVideo(node.loopUrl ?? node.clipUrl, true);
  };

  const onEnded = () => {
    if (!playing) return;
    if (playing.outcome === "fail") setPhase("failed");
    else if (playing.outcome === "escaped") setPhase("escaped");
    else goIdle(playing);
  };

  const direct = async (direction: string) => {
    if (!current) return;
    setPhase("working");
    setStatus("Analyzing escape plan…");
    try {
      const { jobId } = await api.direct(current.id, direction);
      while (true) {
        await new Promise(r => setTimeout(r, 700));
        const job = await api.job(jobId);
        setStatus(job.message);
        if (job.debug) setLastDebug(job.debug);
        if (job.status === "rejected") {
          flash(job.message);
          setPhase("idle");
          return;
        }
        if (job.status === "error") throw new Error(job.message);
        if (job.status === "done" && job.node) {
          setPlaying(job.node);
          setPhase("clip");
          playVideo(job.node.clipUrl, false);
          return;
        }
      }
    } catch (err) {
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
            BEGIN
          </button>
        </div>
      )}

      {(phase === "idle" || phase === "working") && <HyperFrame name="prompt" className="z-10" />}

      {phase === "failed" && (
        <div className="absolute inset-0 z-20">
          <HyperFrame name="failed" bind={failedBind} />
          <div className="absolute bottom-28 left-1/2 flex -translate-x-1/2 gap-4">
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
      )}

      {phase === "escaped" && (
        <div className="absolute inset-0 z-20">
          <HyperFrame name="escaped" />
          <button
            onClick={retryBeginning}
            className="absolute bottom-28 left-1/2 -translate-x-1/2 rounded-md border border-teal/60 bg-black/70 px-6 py-3 font-display font-semibold tracking-widest text-teal backdrop-blur hover:bg-teal hover:text-black"
          >
            PLAY AGAIN
          </button>
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

      <AdminPanel lastDebug={lastDebug} />

      {phase !== "start" && phase !== "failed" && phase !== "escaped" && (
        <PromptBar enabled={phase === "idle"} status={status} onSubmit={direct} />
      )}
    </main>
  );
}
