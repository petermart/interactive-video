import { useState } from "react";
import { apiFetch } from "./viewer";

/** Stitches the viewer's run (intro + every generated clip + soundtrack) on the server, then downloads it. */
export function DownloadFilmButton({ nodeId, outcome, className = "" }: { nodeId: string; outcome: string; className?: string }) {
  const [state, setState] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState("");

  const download = async () => {
    setState("working");
    try {
      const res = await apiFetch("/api/export", { method: "POST", body: JSON.stringify({ nodeId }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const a = document.createElement("a");
      a.href = body.url;
      a.download = `prison-escape-larry-${outcome}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setState("idle");
    } catch (err) {
      setError((err as Error).message);
      setState("error");
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={download}
        disabled={state === "working"}
        className={`rounded-md border px-6 py-3 font-display font-semibold tracking-widest backdrop-blur transition disabled:cursor-wait disabled:opacity-60 ${className}`}
      >
        {state === "working" ? "STITCHING YOUR FILM…" : "DOWNLOAD YOUR FILM"}
      </button>
      {state === "error" && <span className="font-mono text-xs text-siren-red">{error}</span>}
    </div>
  );
}
