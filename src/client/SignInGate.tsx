import { useEffect, useState } from "react";
import { apiFetch } from "./viewer";

export type Me = {
  signedIn: boolean;
  name: string | null;
  image: string | null;
  authEnabled: boolean;
  providers: string[];
  policy: string;
  used: { generations: number; games: number };
  canGenerate: boolean;
  blockedReason: string | null;
};

export const fetchMe = () => apiFetch("/api/me").then(r => r.json() as Promise<Me>);

const PROVIDER_LABELS: Record<string, string> = { google: "Google", facebook: "Facebook", apple: "Apple" };

/** Brand marks kept simple enough to read at 18px, matching the share icons' approach. */
const PROVIDER_MARKS: Record<string, string> = {
  google:
    "M21.35 11.1h-9.17v2.92h5.27c-.23 1.37-1.66 4.02-5.27 4.02-3.17 0-5.76-2.63-5.76-5.87s2.59-5.87 5.76-5.87c1.8 0 3.01.77 3.7 1.43l2.52-2.43C16.78 3.8 14.68 2.9 12.18 2.9 6.95 2.9 2.7 7.15 2.7 12.38s4.25 9.48 9.48 9.48c5.47 0 9.1-3.85 9.1-9.27 0-.62-.07-1.1-.16-1.49z",
  facebook: "M13.5 21v-7h2.4l.4-3h-2.8V9.1c0-.9.3-1.5 1.6-1.5h1.3V5c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4V11H7.7v3h2.5v7h3.3z",
  apple:
    "M16.4 12.8c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.4.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.1 9 .7 1.1 1.6 2.3 2.7 2.2 1.1 0 1.5-.7 2.8-.7s1.7.7 2.9.7c1.2 0 1.9-1.1 2.6-2.2.8-1.2 1.2-2.5 1.2-2.5s-2-.8-2-3.6zM14.3 6.3c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.6 1.3-.6.6-1.1 1.7-.9 2.6 1 .1 2-.5 2.6-1.2z",
};

/**
 * The sign-in gate, shown once a guest has used up whatever the current policy allows.
 *
 * Sign-in is handled by Better Auth's own endpoints: sending the browser to /api/auth/sign-in/social starts
 * the OAuth round trip and returns it here, so there is no token handling in the client at all.
 */
export function SignInGate({ me, onDismiss }: { me: Me; onDismiss?: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  /**
   * Better Auth's social sign-in is a POST that answers with the provider's authorisation URL; it is not a
   * redirect you can navigate to directly. So: ask for the URL, then send the browser there.
   */
  const signIn = async (provider: string) => {
    setBusy(provider);
    setError("");
    try {
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, callbackURL: location.pathname + location.search }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) throw new Error(body.message ?? body.error ?? `Sign-in unavailable (HTTP ${res.status})`);
      location.href = body.url;
    } catch (err) {
      setBusy("");
      setError((err as Error).message);
    }
  };

  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/80 p-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg border border-sodium/40 bg-[#0b0e13] p-6 text-center">
        <div className="font-display text-xs font-semibold tracking-[0.35em] text-teal">CHECKPOINT</div>
        <h2 className="mt-3 font-display text-2xl font-bold text-white">{me.blockedReason ?? "Sign in to keep playing"}</h2>
        <p className="mt-2 font-mono text-xs leading-relaxed text-white/50">
          Your escape so far is saved. Signing in keeps it, and lets you start a new one.
        </p>

        {me.authEnabled && me.providers.length > 0 ? (
          <div className="mt-5 flex flex-col gap-2">
            {me.providers.map(p => (
              <button
                key={p}
                onClick={() => void signIn(p)}
                disabled={Boolean(busy)}
                className="flex items-center justify-center gap-3 rounded-md border border-white/20 bg-white/5 px-4 py-3 font-semibold text-white transition hover:border-sodium hover:text-sodium disabled:opacity-50"
              >
                <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor" aria-hidden>
                  <path d={PROVIDER_MARKS[p] ?? ""} />
                </svg>
                {busy === p ? "Redirecting…" : `Continue with ${PROVIDER_LABELS[p] ?? p}`}
              </button>
            ))}
            {error && <div className="rounded border border-siren-red/40 bg-siren-red/10 p-2 text-xs text-siren-red">{error}</div>}
          </div>
        ) : (
          // Should not normally be reachable: the server stops enforcing sign-in when no provider works. Kept as
          // a safe fallback in player language, since this screen is seen by the public, not the operator.
          <p className="mt-5 rounded border border-white/15 bg-white/5 p-3 font-mono text-xs text-white/60">
            Sign-in is temporarily unavailable. Please try again in a little while.
          </p>
        )}

        {onDismiss && (
          <button onClick={onDismiss} className="mt-4 font-mono text-[11px] tracking-widest text-white/35 underline underline-offset-4 hover:text-white/70">
            NOT NOW
          </button>
        )}
      </div>
    </div>
  );
}

/** Small signed-in badge for the corner, so it is obvious the session took. */
export function SessionBadge({ me }: { me: Me }) {
  if (!me.signedIn) return null;
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] tracking-widest text-white/40">
      {me.image && <img src={me.image} alt="" className="size-5 rounded-full" referrerPolicy="no-referrer" />}
      <span>{me.name ?? "SIGNED IN"}</span>
      <button
        onClick={() => void apiFetch("/api/auth/sign-out", { method: "POST" }).then(() => location.reload())}
        className="text-white/30 underline underline-offset-2 hover:text-white/60"
      >
        sign out
      </button>
    </div>
  );
}

/** Keeps `me` fresh: re-fetched on mount and whenever `deps` change (e.g. after a step completes). */
export function useMe(deps: unknown[] = []) {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then(m => !cancelled && setMe(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [me, setMe] as const;
}
