/** Non-blocking "working" indicator: a small HUD chip above the prompt bar so the video stays visible. */
export function GeneratingHud({ status }: { status: string }) {
  return (
    <div className="pointer-events-none absolute bottom-24 left-6 z-30 flex items-center gap-3 rounded border border-sodium/40 bg-black/60 px-4 py-2 font-mono text-xs tracking-[0.2em] text-sodium backdrop-blur-sm">
      <span className="flex h-4 items-end gap-0.5" aria-hidden>
        {[0, 1, 2, 3].map(i => (
          <span
            key={i}
            className="w-1 animate-pulse rounded-sm bg-sodium"
            style={{ height: `${40 + ((i * 23) % 60)}%`, animationDelay: `${i * 150}ms`, animationDuration: "700ms" }}
          />
        ))}
      </span>
      <span className="uppercase">Generating</span>
      {status && <span className="normal-case tracking-normal text-white/70">{status}</span>}
    </div>
  );
}
