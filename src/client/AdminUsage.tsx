import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "./viewer";

type Report = {
  since: string | null;
  totals: {
    players: number;
    signedInPlayers: number;
    guestPlayers: number;
    sessionOnlyPlayers: number;
    directions: number;
    generated: number;
    reused: number;
    rejected: number;
    textOnly: number;
    errors: number;
    escapes: number;
    fails: number;
    directionsPerPlayer: number;
    generationsPerPlayer: number;
    reuseRate: number;
  };
  perDay: { day: string; players: number; directions: number; generated: number; reused: number }[];
  distribution: { label: string; players: number }[];
  topPlayers: {
    player: string;
    directions: number;
    generated: number;
    reused: number;
    rejected: number;
    escapes: number;
    firstSeen: string;
    lastSeen: string;
  }[];
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Headline player numbers in the admin panel, with the full breakdown one click away. */
export function AdminUsage({ password }: { password: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const load = async () => {
    setError("");
    try {
      const res = await apiFetch("/api/admin/usage", { method: "POST", body: JSON.stringify({ password }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setReport(body);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (password) load();
  }, [password]);

  if (error) return <div className="rounded border border-white/10 p-2 text-xs text-siren-red">Usage: {error}</div>;
  if (!report) return null;
  const t = report.totals;

  return (
    <div className="rounded border border-white/10 p-2">
      <div className="flex justify-between">
        <span>Players</span>
        <b className="text-teal">{t.players}</b>
      </div>
      <div className="text-xs text-white/40">
        {t.directions} directions · {t.generated} generated · {t.reused} reused ({pct(t.reuseRate)}) ·{" "}
        {t.generationsPerPlayer.toFixed(1)} generations/player
      </div>
      <button
        onClick={() => {
          load();
          setOpen(true);
        }}
        className="mt-1 text-xs text-teal hover:underline"
      >
        full usage report →
      </button>
      {open && createPortal(<UsageOverlay report={report} onClose={() => setOpen(false)} />, document.body)}
    </div>
  );
}

function UsageOverlay({ report, onClose }: { report: Report; onClose: () => void }) {
  const t = report.totals;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const stats: [string, string | number][] = [
    ["Players", t.players],
    ["Signed in", t.signedInPlayers],
    ["Guests (cookie)", t.guestPlayers],
    ["Tab session only", t.sessionOnlyPlayers],
    ["Directions", t.directions],
    ["Per player", t.directionsPerPlayer.toFixed(1)],
    ["Generated", t.generated],
    ["Generations / player", t.generationsPerPlayer.toFixed(2)],
    ["Reused from archive", `${t.reused} (${pct(t.reuseRate)})`],
    ["Rejected", t.rejected],
    ["Escapes", t.escapes],
    ["Fails", t.fails],
  ];
  const maxBucket = Math.max(1, ...report.distribution.map(b => b.players));

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-black/90 p-4 font-mono text-sm text-white/80 backdrop-blur-sm">
      <div className="mx-auto max-w-4xl select-text">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xs font-semibold tracking-[0.3em] text-teal">USAGE REPORT</h2>
          <button onClick={onClose} aria-label="Close" className="px-2 text-xl leading-none text-white/50 hover:text-white">
            ×
          </button>
        </div>
        <p className="mt-1 text-xs text-white/40">
          Since {report.since?.slice(0, 10) ?? "—"}. A player is a signed-in account, else the one-year guest cookie. Steps from
          before that attribution existed only know their browser tab, so "tab session only" over-counts people.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.map(([label, value]) => (
            <div key={label} className="rounded border border-white/10 p-2">
              <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
              <div className="text-lg text-white">{value}</div>
            </div>
          ))}
        </div>

        <h3 className="mt-6 text-[10px] uppercase tracking-[0.2em] text-white/40">Paid generations per player</h3>
        <div className="mt-2 space-y-1">
          {report.distribution.map(b => (
            <div key={b.label} className="flex items-center gap-2 text-xs">
              <span className="w-10 text-right text-white/50">{b.label}</span>
              <div className="h-3 flex-1 rounded bg-white/5">
                <div className="h-full rounded bg-teal" style={{ width: `${(b.players / maxBucket) * 100}%` }} />
              </div>
              <span className="w-8 text-white/70">{b.players}</span>
            </div>
          ))}
        </div>

        <h3 className="mt-6 text-[10px] uppercase tracking-[0.2em] text-white/40">By day (last 30)</h3>
        <Table
          head={["Day", "Players", "Directions", "Generated", "Reused"]}
          rows={report.perDay.map(d => [d.day, d.players, d.directions, d.generated, d.reused])}
        />

        <h3 className="mt-6 text-[10px] uppercase tracking-[0.2em] text-white/40">Top players (by generations)</h3>
        <Table
          head={["Player", "Directions", "Generated", "Reused", "Rejected", "Escapes", "Last seen"]}
          rows={report.topPlayers.map(p => [p.player, p.directions, p.generated, p.reused, p.rejected, p.escapes, p.lastSeen.slice(0, 16).replace("T", " ")])}
        />
      </div>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-white/40">
          <tr>
            {head.map(h => (
              <th key={h} className="border-b border-white/10 px-2 py-1 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-white/5">
              {r.map((c, j) => (
                <td key={j} className={`px-2 py-1 ${j === 0 ? "text-white/70" : "tabular-nums text-white"}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
