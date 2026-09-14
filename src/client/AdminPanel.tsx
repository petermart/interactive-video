import { useEffect, useState } from "react";
import { CREATIVITY_POINT_OPTIONS, LLM_MODEL_OPTIONS, OUTCOME_MODES, type LlmModelId, type OutcomeMode } from "../server/constants";
import { api, type Job, type Settings } from "./api";

const MODE_HELP: Record<OutcomeMode, string> = {
  vibes: "LLM judges creativity + plausibility. Numbers below are ignored.",
  hybrid: "LLM decides, loosely guided by probability ± creativity points.",
  dice: "Server rolls: probability ± creativity points.",
};

export function AdminPanel({ lastDebug }: { lastDebug: Job["debug"] | null }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    api.settings().then(setSettings);
  }, []);

  const usesNumbers = settings?.outcomeMode !== "vibes";

  const save = async (patch: Partial<Settings>) => {
    setSettings(s => (s ? { ...s, ...patch } : s));
    setSettings(await api.saveSettings(patch));
  };

  return (
    <div className="absolute right-4 top-4 z-40 flex flex-col items-end gap-2">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Admin settings"
        className="grid size-11 place-items-center rounded-full border border-white/15 bg-black/50 text-white/80 backdrop-blur transition hover:rotate-45 hover:text-sodium"
      >
        <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
      </button>

      {open && settings && (
        <div className="w-80 rounded-lg border border-white/10 bg-black/80 p-4 font-mono text-sm backdrop-blur-md">
          <h2 className="mb-3 font-display text-xs font-semibold tracking-[0.3em] text-teal">ADMIN // CONTROL ROOM</h2>

          <div className="text-white/70">Success decided by</div>
          <div className="mt-1 grid grid-cols-3 overflow-hidden rounded border border-white/15">
            {OUTCOME_MODES.map(mode => (
              <button
                key={mode}
                onClick={() => save({ outcomeMode: mode })}
                className={`py-1.5 text-xs uppercase tracking-widest transition ${
                  settings.outcomeMode === mode ? "bg-sodium font-semibold text-black" : "text-white/60 hover:bg-white/10"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-white/40">{MODE_HELP[settings.outcomeMode]}</p>

          <div className={usesNumbers ? "" : "pointer-events-none opacity-35"}>
            <label className="mt-4 block">
              <div className="flex justify-between text-white/70">
                <span>General success probability</span>
                <span className="text-sodium">{settings.successProbability}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={settings.successProbability}
                onChange={e => save({ successProbability: Number(e.target.value) })}
                className="mt-1 w-full accent-sodium"
              />
            </label>

            <label className="mt-3 flex items-center justify-between text-white/70">
              <span>Creativity points (±)</span>
              <select
                value={settings.creativityPoints}
                onChange={e => save({ creativityPoints: Number(e.target.value) })}
                className="rounded border border-white/15 bg-black px-2 py-1 text-sodium"
              >
                {CREATIVITY_POINT_OPTIONS.map(p => (
                  <option key={p} value={p}>
                    ±{p}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-4 flex items-center justify-between text-white/70">
            <span>Prompts till success</span>
            <input
              type="number"
              min={1}
              max={20}
              value={settings.promptsTillSuccess}
              onChange={e => save({ promptsTillSuccess: Number(e.target.value) })}
              className="w-16 rounded border border-white/15 bg-white/5 px-2 py-1 text-right text-sodium"
            />
          </label>

          <div className="mt-4 space-y-2 border-t border-white/10 pt-3">
            <Toggle label="Live LLM (GMI)" checked={settings.liveLLM} onChange={v => save({ liveLLM: v })} />
            <Toggle
              label="No video generation (text only)"
              checked={!settings.liveVideo}
              onChange={v => save({ liveVideo: !v })}
            />
            <Toggle
              label="Constant think (reuse Larry macro loop)"
              checked={settings.constantThink}
              onChange={v => save({ constantThink: v })}
            />
            {settings.liveVideo && (
              <div className="text-xs text-siren-red">Video generation ON: each step spends MachGen credits.</div>
            )}
            <ModelSelect
              label="Analysis model (escape plan)"
              value={settings.analysisModel}
              onChange={id => save({ analysisModel: id })}
            />
            <ModelSelect
              label="Shot writer model (video prompt)"
              value={settings.writerModel}
              onChange={id => save({ writerModel: id })}
            />
          </div>

          {lastDebug && (
            <div className="mt-4 space-y-1 border-t border-white/10 pt-3 text-xs text-white/60">
              <div>
                <b className="uppercase text-sodium">{lastDebug.mode}</b> · innovation{" "}
                <b className="text-white">{lastDebug.innovation}</b>
                {lastDebug.chance !== null && (
                  <>
                    {" "}
                    · chance <b className="text-white">{lastDebug.chance}</b>
                  </>
                )}
                {lastDebug.roll !== null && (
                  <>
                    {" "}
                    · roll <b className="text-white">{lastDebug.roll}</b>
                  </>
                )}
                {lastDebug.isFinal && <b className="text-teal"> · FINAL</b>}
              </div>
              <div className="text-white/40">{lastDebug.diagnosis.innovationNote}</div>
              {lastDebug.diagnosis.verdictReason && lastDebug.mode !== "dice" && (
                <div className="text-white/40">verdict: {lastDebug.diagnosis.verdictReason}</div>
              )}
              {lastDebug.plan && <div className="line-clamp-4 text-white/40">{lastDebug.plan.shotPrompt}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelSelect(props: { label: string; value: LlmModelId; onChange: (id: LlmModelId) => void }) {
  return (
    <label className="block text-white/70">
      {props.label}
      <select
        value={props.value}
        onChange={e => props.onChange(e.target.value as LlmModelId)}
        className="mt-1 w-full rounded border border-white/15 bg-black px-2 py-1 text-white"
      >
        {LLM_MODEL_OPTIONS.map(m => (
          <option key={m.id} value={m.id}>
            {m.label} · {m.speed} · {m.reasoning} reasoning
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; danger?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-white/70">
      <span className={props.danger && props.checked ? "text-siren-red" : ""}>{props.label}</span>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={e => props.onChange(e.target.checked)}
        className={`size-4 ${props.danger ? "accent-siren-red" : "accent-teal"}`}
      />
    </label>
  );
}
