import { useEffect, useState } from "react";
import { apiFetch } from "./viewer";

type JobRow = {
  id: string;
  created_at: string;
  direction: string;
  status: string;
  events: number;
  cost_usd: number;
  errors: number;
};

type EventRow = {
  id: number;
  ts: string;
  job_id: string | null;
  kind: string;
  label: string;
  status: string;
  duration_ms: number | null;
  cost_usd: number | null;
  request: string | null;
  response: string | null;
};

const KIND_COLOR: Record<string, string> = {
  job: "text-white/60",
  llm: "text-teal",
  decision: "text-sodium",
  upload: "text-white/40",
  video: "text-[#3dff7a]",
  error: "text-siren-red",
};

/** ☰ debug drawer: prompt generation history and every server step, read from the SQLite debug DB. */
export function DebugPanel() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [other, setOther] = useState<EventRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      const data = await apiFetch("/api/debug/jobs").then(r => r.json());
      setJobs(data.jobs);
      setOther(data.other);
      if (selected) setEvents((await apiFetch(`/api/debug/jobs/${selected}`).then(r => r.json())).events);
    };
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [open, selected]);

  const totalCost = jobs.reduce((sum, j) => sum + (j.cost_usd ?? 0), 0);

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Debug history"
        className="absolute right-[4.25rem] top-4 z-40 grid size-11 place-items-center rounded-full border border-white/15 bg-black/50 text-white/80 backdrop-blur transition hover:text-teal"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      {open && (
        <aside className="absolute bottom-0 right-0 top-0 z-50 flex w-full max-w-xl select-text flex-col border-l border-white/10 bg-black/90 font-mono text-xs text-white/80 backdrop-blur-md">
          <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <div className="font-display text-sm font-semibold tracking-[0.3em] text-teal">DEBUG // UNDER THE HOOD</div>
              <div className="mt-0.5 text-white/40">
                {jobs.length} steps · ${totalCost.toFixed(2)} logged spend · data/debug.sqlite
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="px-2 text-lg text-white/60 hover:text-white" aria-label="Close debug">
              ×
            </button>
          </header>

          <div className="flex-1 overflow-y-auto">
            {jobs.map(job => (
              <div key={job.id} className="border-b border-white/5">
                <button
                  onClick={() => setSelected(s => (s === job.id ? null : job.id))}
                  className={`w-full px-4 py-2.5 text-left hover:bg-white/5 ${selected === job.id ? "bg-white/5" : ""}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-white">&gt; {job.direction}</span>
                    <span className={job.status === "error" ? "text-siren-red" : job.status === "done" ? "text-[#3dff7a]" : "text-sodium"}>
                      {job.status}
                    </span>
                  </div>
                  <div className="mt-0.5 flex gap-3 text-white/40">
                    <span>{new Date(job.created_at).toLocaleTimeString()}</span>
                    <span>{job.events} events</span>
                    {job.cost_usd > 0 && <span>${job.cost_usd.toFixed(2)}</span>}
                    {job.errors > 0 && <span className="text-siren-red">{job.errors} errors</span>}
                  </div>
                </button>
                {selected === job.id && (
                  <ol className="space-y-1 px-4 pb-3">
                    {events.map(e => (
                      <EventItem key={e.id} event={e} />
                    ))}
                  </ol>
                )}
              </div>
            ))}

            {other.length > 0 && (
              <div className="px-4 py-3">
                <div className="mb-1 text-white/40">Other events</div>
                <ol className="space-y-1">
                  {other.map(e => (
                    <EventItem key={e.id} event={e} />
                  ))}
                </ol>
              </div>
            )}
          </div>
        </aside>
      )}
    </>
  );
}

function EventItem({ event: e }: { event: EventRow }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = e.request || e.response;
  return (
    <li className="rounded border border-white/5 bg-white/[0.02]">
      <button
        onClick={() => hasDetail && setExpanded(x => !x)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/5"
      >
        <span className={`w-16 shrink-0 uppercase ${e.status === "error" ? "text-siren-red" : KIND_COLOR[e.kind] ?? ""}`}>{e.kind}</span>
        <span className="flex-1 truncate">{e.label}</span>
        {e.duration_ms != null && <span className="text-white/40">{(e.duration_ms / 1000).toFixed(1)}s</span>}
        {e.cost_usd != null && <span className="text-sodium">${e.cost_usd.toFixed(2)}</span>}
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-white/5 p-2">
          {e.request && <Json title="request" text={e.request} />}
          {e.response && <Json title="response" text={e.response} />}
        </div>
      )}
    </li>
  );
}

function Json({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  const copy = async () => {
    await navigator.clipboard.writeText(pretty);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <div className="flex items-center justify-between text-white/40">
        <span>{title}</span>
        <button onClick={copy} className="px-1 text-teal hover:underline">
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="mt-0.5 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded bg-black/60 p-2 text-[11px] text-white/70">
        {pretty}
      </pre>
    </div>
  );
}
