import { useEffect, useRef } from "react";

type Props = {
  /** Folder name under /hyperframes, also the data-composition-id. */
  name: "title" | "intro-title" | "prompt" | "failed" | "escaped";
  /** Values for elements marked data-bind="key" inside the composition. */
  bind?: Record<string, string>;
  className?: string;
};

/**
 * Embeds a HyperFrames composition as a live HTML overlay. The composition registers a paused
 * GSAP timeline on window.__timelines[name]; we bind text into it and restart it on mount.
 */
export function HyperFrame({ name, bind, className = "" }: Props) {
  const ref = useRef<HTMLIFrameElement>(null);

  const play = () => {
    const win = ref.current?.contentWindow as (Window & { __timelines?: Record<string, { restart(): void }> }) | null;
    if (!win?.document) return;
    for (const [key, value] of Object.entries(bind ?? {})) {
      win.document.querySelectorAll(`[data-bind="${key}"]`).forEach(el => (el.textContent = value));
    }
    win.__timelines?.[name]?.restart();
  };

  useEffect(play, [bind && JSON.stringify(bind)]);

  return (
    <iframe
      ref={ref}
      src={`/hyperframes/${name}/index.html?embed=1`}
      onLoad={play}
      title={name}
      className={`pointer-events-none absolute inset-0 h-full w-full border-0 bg-transparent ${className}`}
      style={{ colorScheme: "normal" }}
    />
  );
}
