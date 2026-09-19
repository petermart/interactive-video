import { useState } from "react";

type Props = {
  enabled: boolean;
  status: string;
  placeholder: string;
  onSubmit: (direction: string) => void;
};

export function PromptBar({ enabled, status, placeholder, onSubmit }: Props) {
  const [text, setText] = useState("");
  // Phone screens truncate the long prompt, so ask the short version there.
  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  const hint = narrow ? "What should Sloppy Joe do?" : placeholder;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!enabled || !text.trim()) return;
    onSubmit(text.trim());
    setText("");
  };

  return (
    <form
      onSubmit={submit}
      // The gradient reaches ~140px up the screen, which is over anything sitting just above the bar (the ABOUT
      // link, the RESUME button). It is decoration, so it lets clicks through; the controls take their own.
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-center gap-3 bg-gradient-to-t from-black via-black/80 to-transparent px-6 pb-6 pt-16"
    >
      {/*
        Now that the film plays behind it from the first second, a faint outlined box reads as part of the
        artwork. So it looks like something to type in: a solid dark field, a brighter border, a caret glyph
        and a ring that lights up on hover as well as focus.
      */}
      <div className="pointer-events-auto relative flex-1">
        <span aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-mono text-base text-sodium/80">
          &gt;
        </span>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          disabled={!enabled}
          maxLength={500}
          placeholder={enabled ? hint : status || "…"}
          className="w-full cursor-text rounded-md border-2 border-white/35 bg-black/70 py-3 pl-9 pr-4 font-mono text-base text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] placeholder-white/55 outline-none backdrop-blur transition hover:border-white/55 focus:border-sodium focus:ring-2 focus:ring-sodium/40 disabled:opacity-60"
        />
        {!enabled && status && (
          <span className="absolute right-4 top-1/2 size-2 -translate-y-1/2 animate-ping rounded-full bg-sodium" />
        )}
      </div>
      <button
        type="submit"
        disabled={!enabled || !text.trim()}
        className="pointer-events-auto rounded-md bg-sodium px-4 py-3 font-display text-sm font-bold tracking-widest text-black transition hover:bg-orange-300 disabled:cursor-not-allowed disabled:opacity-40 sm:px-6 sm:text-base"
      >
        PROMPT
      </button>
    </form>
  );
}
