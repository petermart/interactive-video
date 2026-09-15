import { useEffect, useState } from "react";
import { apiFetch } from "./viewer";

type Report = {
  machgen: { balanceUsd: number | null; minBalanceUsd: number; generationPaused: boolean; pendingTasks: number; runningTasks: number; error?: string };
  gmi: { estimatedUsd: number; baselineUsd: number; baselineAt: string; spentSinceBaselineUsd: number; costedCalls: number };
};

const PW_KEY = "prison-escape:admin-password";

/** Password-gated credit balances. The password is verified server-side against a stored hash. */
export function AdminCredits() {
  const [password, setPassword] = useState(() => {
    try {
      return sessionStorage.getItem(PW_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async (pw = password) => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/admin/credits", { method: "POST", body: JSON.stringify({ password: pw }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setReport(body);
      try {
        sessionStorage.setItem(PW_KEY, pw);
      } catch {}
    } catch (err) {
      setReport(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // Re-open with a remembered password: fetch balances straight away.
  useEffect(() => {
    if (password) load(password);
  }, []);

  if (!report) {
    return (
      <form
        onSubmit={e => {
          e.preventDefault();
          load();
        }}
        className="mb-4 border-b border-white/10 pb-3"
      >
        <div className="text-white/70">Credits (admin password)</div>
        <div className="mt-1 flex gap-2">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="password"
            className="min-w-0 flex-1 rounded border border-white/15 bg-white/5 px-2 py-1 text-white"
          />
          <button type="submit" disabled={loading || !password} className="rounded bg-teal px-3 py-1 font-semibold text-black disabled:opacity-40">
            {loading ? "…" : "UNLOCK"}
          </button>
        </div>
        {error && <div className="mt-1 text-xs text-siren-red">{error}</div>}
      </form>
    );
  }

  const { machgen, gmi } = report;
  return (
    <div className="mb-4 space-y-2 border-b border-white/10 pb-3">
      <div className="flex items-center justify-between text-white/70">
        <span>Credits</span>
        <button onClick={() => load()} className="text-xs text-teal hover:underline">
          {loading ? "refreshing…" : "refresh"}
        </button>
      </div>
      <div className="rounded border border-white/10 p-2">
        <div className="flex justify-between">
          <span>MachGen (video)</span>
          <b className={machgen.generationPaused ? "text-siren-red" : "text-[#3dff7a]"}>
            {machgen.balanceUsd === null ? "unknown" : `$${machgen.balanceUsd.toFixed(2)}`}
          </b>
        </div>
        <div className="text-xs text-white/40">
          {machgen.generationPaused
            ? `Below $${machgen.minBalanceUsd}: video generation paused`
            : `Auto-pauses video below $${machgen.minBalanceUsd}`}
          {machgen.runningTasks + machgen.pendingTasks > 0 && ` · ${machgen.runningTasks + machgen.pendingTasks} tasks in flight`}
          {machgen.error && ` · ${machgen.error}`}
        </div>
      </div>
      <div className="rounded border border-white/10 p-2">
        <div className="flex justify-between">
          <span>GMI Cloud (LLM)</span>
          <b className="text-sodium">≈ ${gmi.estimatedUsd.toFixed(2)}</b>
        </div>
        <div className="text-xs text-white/40">
          Estimate: ${gmi.baselineUsd.toFixed(2)} console balance − ${gmi.spentSinceBaselineUsd.toFixed(4)} logged across {gmi.costedCalls}{" "}
          calls (GMI's balance API needs a console login)
        </div>
      </div>
    </div>
  );
}
