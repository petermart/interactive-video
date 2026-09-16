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
      className="absolute inset-x-0 bottom-0 z-30 flex items-center gap-3 bg-gradient-to-t from-black via-black/80 to-transparent px-6 pb-6 pt-16"
    >
      <div className="relative flex-1">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          disabled={!enabled}
          maxLength={500}
          placeholder={enabled ? hint : status || "…"}
          className="w-full rounded-md border border-white/15 bg-white/5 px-4 py-3 font-mono text-base text-white placeholder-white/40 outline-none backdrop-blur transition focus:border-sodium disabled:opacity-60"
        />
        {!enabled && status && (
          <span className="absolute right-4 top-1/2 size-2 -translate-y-1/2 animate-ping rounded-full bg-sodium" />
        )}
      </div>
      <button
        type="submit"
        disabled={!enabled || !text.trim()}
        className="rounded-md bg-sodium px-4 py-3 font-display text-sm font-bold tracking-widest text-black transition hover:bg-orange-300 disabled:cursor-not-allowed disabled:opacity-40 sm:px-6 sm:text-base"
      >
        PROMPT
      </button>
    </form>
  );
}
