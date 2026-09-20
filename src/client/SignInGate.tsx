import { useEffect, useState, type ReactNode } from "react";
import { ShareBar } from "./ShareBar";
import { apiFetch } from "./viewer";

export type Allowance = { mode: "unlimited" | "games" | "generations"; count: number };

export type Me = {
  signedIn: boolean;
  name: string | null;
  image: string | null;
  authEnabled: boolean;
  providers: string[];
  /** Email + password sign-up and sign-in are available. */
  emailPassword?: boolean;
  /** What this viewer's side of the sign-in line is allowed. */
  allowance: Allowance;
  used: { generations: number; games: number };
  /** Extra goes earned by sharing. */
  bonus: number;
  /** Left on the active axis; null when unlimited. */
  remaining: number | null;
  /** When the allowance refills; null when it never does. */
  resetsAt: string | null;
  canGenerate: boolean;
  /** Signing in is what would unblock them. False when they are a member who has used their allowance. */
  requiresSignIn: boolean;
  blockedReason: string | null;
  /** Sharing a finished run currently earns another go. */
  shareGrantsGame: boolean;
};

export const fetchMe = () => apiFetch("/api/me").then(r => r.json() as Promise<Me>);

const PROVIDER_LABELS: Record<string, string> = { google: "Google", apple: "Apple" };

/** Brand marks kept simple enough to read at 18px, matching the share icons' approach. */
const PROVIDER_MARKS: Record<string, string> = {
  google:
    "M21.35 11.1h-9.17v2.92h5.27c-.23 1.37-1.66 4.02-5.27 4.02-3.17 0-5.76-2.63-5.76-5.87s2.59-5.87 5.76-5.87c1.8 0 3.01.77 3.7 1.43l2.52-2.43C16.78 3.8 14.68 2.9 12.18 2.9 6.95 2.9 2.7 7.15 2.7 12.38s4.25 9.48 9.48 9.48c5.47 0 9.1-3.85 9.1-9.27 0-.62-.07-1.1-.16-1.49z",
  apple:
    "M16.4 12.8c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.4.8-.7 0-1.8-.8-2.9-.8-1.5 0-2.9.9-3.7 2.2-1.6 2.7-.4 6.8 1.1 9 .7 1.1 1.6 2.3 2.7 2.2 1.1 0 1.5-.7 2.8-.7s1.7.7 2.9.7c1.2 0 1.9-1.1 2.6-2.2.8-1.2 1.2-2.5 1.2-2.5s-2-.8-2-3.6zM14.3 6.3c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.6 1.3-.6.6-1.1 1.7-.9 2.6 1 .1 2-.5 2.6-1.2z",
};

/**
 * The sign-in gate, shown once a guest has used up whatever the current policy allows.
 *
 * Sign-in is handled by Better Auth's own endpoints: sending the browser to /api/auth/sign-in/social starts
 * the OAuth round trip and returns it here, so there is no token handling in the client at all.
 */
export function SignInGate({ me, onDismiss, nodeId, onEarned }: { me: Me; onDismiss?: () => void; nodeId?: string; onEarned?: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  // Out of goes with no sign-in to offer: a member who has used their allowance, or a server where signing
  // in buys nothing more. Showing them provider buttons would be a dead end, so they get their own panel.
  if (!me.requiresSignIn) {
    return (
      <Panel title={me.blockedReason ?? "That's your lot for now"} onDismiss={onDismiss}>
        <p className="mt-2 font-mono text-xs leading-relaxed text-white/50">
          {/* The film is saved server-side and its link works for anyone, signed in or not - never suggest otherwise. */}
          Your film is saved and its share link keeps working. {refillsIn(me.resetsAt) ?? "Come back later for more."}
        </p>
        {me.shareGrantsGame && nodeId && <ShareForMore nodeId={nodeId} onEarned={onEarned} />}
      </Panel>
    );
  }

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
    <Panel title={me.blockedReason ?? "Sign in to keep playing"} onDismiss={onDismiss}>
      <p className="mt-2 font-mono text-xs leading-relaxed text-white/50">
        {/* Never imply the game starts charging after sign-in: it does not, and people read a gate as a paywall. */}
        Free, no card, nothing to install.{" "}
        {played(me)
          ? "It gives you more to direct — the film you just made is saved either way, and its share link already works."
          : "One tap and you're directing."}
      </p>

      {me.authEnabled && (me.providers.length > 0 || me.emailPassword) ? (
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
            {me.emailPassword && (
              <>
                {me.providers.length > 0 && (
                  <div className="my-1 flex items-center gap-3 font-mono text-[10px] tracking-widest text-white/30">
                    <span className="h-px flex-1 bg-white/10" />
                    OR
                    <span className="h-px flex-1 bg-white/10" />
                  </div>
                )}
                <EmailForm disabled={Boolean(busy)} onError={setError} />
              </>
            )}
            {error && <div className="rounded border border-siren-red/40 bg-siren-red/10 p-2 text-xs text-siren-red">{error}</div>}
        </div>
      ) : (
        // Should not normally be reachable: the server stops enforcing sign-in when no provider works. Kept as
        // a safe fallback in player language, since this screen is seen by the public, not the operator.
        <p className="mt-5 rounded border border-white/15 bg-white/5 p-3 font-mono text-xs text-white/60">
          Sign-in is temporarily unavailable. Please try again in a little while.
        </p>
      )}

      {/* Nothing to share before they have played, so the offer only appears once there is a run. */}
      {me.shareGrantsGame && nodeId && played(me) && <ShareForMore nodeId={nodeId} onEarned={onEarned} or />}
    </Panel>
  );
}

/** Whether this viewer has anything of their own yet - a run to share, an escape worth saving. */
const played = (me: Me) => me.used.generations > 0 || me.used.games > 0;

/** "More tomorrow." / "More in 6 days." - or nothing, when the allowance never refills. */
function refillsIn(resetsAt: string | null) {
  if (!resetsAt) return null;
  const hours = (Date.parse(resetsAt) - Date.now()) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (hours < 1) return "More in a few minutes.";
  if (hours < 24) return `More in ${Math.round(hours)} ${Math.round(hours) === 1 ? "hour" : "hours"}.`;
  const days = Math.ceil(hours / 24);
  return days === 1 ? "More tomorrow." : `More in ${days} days.`;
}

/** The gate's frame: same card whether the answer is "sign in" or "come back later". */
function Panel({ title, children, onDismiss }: { title: string; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/80 p-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-lg border border-sodium/40 bg-[#0b0e13] p-6 text-center">
        <div className="font-display text-xs font-semibold tracking-[0.35em] text-teal">CHECKPOINT</div>
        <h2 className="mt-3 font-display text-2xl font-bold text-white">{title}</h2>
        {children}
        {onDismiss && (
          <button onClick={onDismiss} className="mt-4 font-mono text-[11px] tracking-widest text-white/35 underline underline-offset-4 hover:text-white/70">
            NOT NOW
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * "Share your run for another go."
 *
 * This is the same ShareBar the ending screens use, not a second, weaker share: on a phone that means the
 * OS sheet with the actual MP4 in it (the only keyless route to Instagram and TikTok), and on a desktop the
 * platform carousel and downloads. The credit is claimed from its onShared callback, so it is earned by a
 * real share - handing the film to a platform, the sheet or the clipboard - rather than by opening a menu.
 */
function ShareForMore({ nodeId, onEarned, or }: { nodeId: string; onEarned?: () => void; or?: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "already">("idle");

  const claim = async () => {
    if (state !== "idle") return;
    const res = await apiFetch("/api/share-credit", { method: "POST", body: JSON.stringify({ nodeId }) })
      .then(r => r.json())
      .catch(() => ({ granted: false }));
    setState(res.granted ? "done" : "already");
    // Leave the gate up for a beat so the reward is seen, then let App re-read the allowance and close it.
    if (res.granted) setTimeout(() => onEarned?.(), 1200);
  };

  return (
    <div className={or ? "mt-4" : "mt-4 border-t border-white/10 pt-4"}>
      {/* Offered alongside sign-in: make it read as the other way out, not as a second step. */}
      {or && (
        <div className="my-3 flex items-center gap-3 font-mono text-[10px] tracking-widest text-white/30">
          <span className="h-px flex-1 bg-white/10" />
          OR
          <span className="h-px flex-1 bg-white/10" />
        </div>
      )}
      <ShareBar
        nodeId={nodeId}
        outcome="run"
        label="SHARE FOR ANOTHER GO"
        accent="w-full border-teal/60 bg-teal/10 text-teal hover:bg-teal hover:text-black"
        onShared={() => void claim()}
      />
      <p className="mt-2 font-mono text-[10px] leading-relaxed text-white/35">
        {state === "done"
          ? "Nice — one more go unlocked."
          : state === "already"
            ? "This run has already earned its extra go. Finish another to share again."
            : "Share it anywhere and you get one more go."}
      </p>
    </div>
  );
}

/**
 * Username, email and password, via Better Auth's /sign-up/email and /sign-in/email endpoints. Both set the
 * session cookie on success (sign-up signs in straight away), so a reload is all the client has to do afterwards.
 *
 * The username is Better Auth's `name` field: display only, not unique, so two players can share one. Sign-in is
 * by email. Emails are not verified yet (no mail service), only checked for a plausible shape by Better Auth.
 */
function EmailForm({ disabled, onError }: { disabled: boolean; onError: (message: string) => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onError("");
    try {
      const body = mode === "sign-up" ? { name: name.trim(), email: email.trim(), password } : { email: email.trim(), password };
      const res = await fetch(`/api/auth/${mode}/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.message ?? out.error ?? `Couldn't ${mode === "sign-up" ? "create your account" : "sign you in"} (HTTP ${res.status})`);
      location.reload();
    } catch (err) {
      setBusy(false);
      onError((err as Error).message);
    }
  };

  const field = "w-full rounded-md border border-white/15 bg-white/5 px-3 py-2 font-mono text-sm text-white placeholder:text-white/30 focus:border-sodium focus:outline-none";
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 text-left">
      {mode === "sign-up" && (
        <input required value={name} onChange={e => setName(e.target.value)} placeholder="Username" autoComplete="username" className={field} />
      )}
      <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" autoComplete="email" className={field} />
      <input
        type="password"
        required
        minLength={8}
        value={password}
        onChange={e => setPassword(e.target.value)}
        placeholder={mode === "sign-up" ? "Password (8+ characters)" : "Password"}
        autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        className={field}
      />
      <button
        type="submit"
        disabled={disabled || busy}
        className="rounded-md border border-sodium/60 bg-sodium/10 px-4 py-3 font-semibold text-sodium transition hover:bg-sodium hover:text-black disabled:opacity-50"
      >
        {busy ? "…" : mode === "sign-up" ? "Create account" : "Sign in"}
      </button>
      <button
        type="button"
        onClick={() => setMode(m => (m === "sign-up" ? "sign-in" : "sign-up"))}
        className="text-center font-mono text-[11px] text-white/40 underline underline-offset-4 hover:text-white/70"
      >
        {mode === "sign-up" ? "Already have an account? Sign in" : "New here? Create an account"}
      </button>
    </form>
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
