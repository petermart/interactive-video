import { useEffect, useState } from "react";
import { SCENE_TEXT_SECS } from "../server/constants";
import type { StoryNode } from "./api";

/**
 * No-video mode: shows the shot writer's scene in place of the clip, then calls onDone.
 * Rendered as a lower-third panel so the looping video behind it stays visible.
 */
export function SceneText({ node, onDone }: { node: StoryNode; onDone: () => void }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const tick = setInterval(() => {
      const secs = (Date.now() - started) / 1000;
      setElapsed(secs);
      if (secs >= SCENE_TEXT_SECS) {
        clearInterval(tick);
        onDone();
      }
    }, 100);
    return () => clearInterval(tick);
  }, [node.id]);

  const shots = (node.scene?.shotPrompt ?? "").split(/(?=Shot \d+)/i).map(s => s.trim()).filter(Boolean);
  const failed = node.outcome === "fail";

  return (
    <div className="pointer-events-none absolute inset-x-6 bottom-24 z-20 flex justify-center">
      <div
        className={`pointer-events-auto w-full max-w-3xl border-l-4 bg-black/65 px-5 py-4 backdrop-blur-sm ${
          failed ? "border-siren-red" : "border-teal"
        }`}
      >
        <div className={`font-mono text-[11px] tracking-[0.3em] ${failed ? "text-siren-red" : "text-teal"}`}>
          SCENE · NO VIDEO MODE · {node.outcome.toUpperCase()}
          {node.direction && <span className="ml-3 tracking-normal text-white/50">&gt; {node.direction}</span>}
        </div>
        <p className="mt-1.5 font-display text-lg font-semibold leading-snug text-white">{node.scene?.summary}</p>
        {shots.length > 1 && (
          <ol className="mt-2 max-h-28 space-y-1 overflow-y-auto font-mono text-xs leading-relaxed text-white/60">
            {shots.map((shot, i) => (
              <li key={i}>{shot}</li>
            ))}
          </ol>
        )}
        <div className="mt-3 h-0.5 w-full overflow-hidden bg-white/10">
          <div className="h-full bg-sodium" style={{ width: `${Math.min(100, (elapsed / SCENE_TEXT_SECS) * 100)}%` }} />
        </div>
      </div>
    </div>
  );
}
