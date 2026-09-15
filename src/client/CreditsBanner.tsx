import { useEffect, useState } from "react";
import { apiFetch } from "./viewer";

/** Tiny top banner shown when MachGen is below the minimum balance and steps run without video. */
export function CreditsBanner({ forced }: { forced: boolean }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const check = () =>
      apiFetch("/api/status")
        .then(r => r.json())
        .then(s => setPaused(Boolean(s.generationPaused)))
        .catch(() => {});
    check();
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);

  if (!paused && !forced) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-50 bg-siren-red/90 px-3 py-1 text-center font-mono text-[11px] tracking-wide text-white">
      Administrator has run out of generation credits, using without generating videos. Please notify administrator.
    </div>
  );
}
