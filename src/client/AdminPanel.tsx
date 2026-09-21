import { useEffect, useState } from "react";
import { ALLOWANCE_MAX, ALLOWANCE_MODE_LABELS, ALLOWANCE_MODES, NETWORK_TOLERANCE_MAX, RESET_DAYS_MAX, SHARE_BONUS_MAX, CREATIVITY_POINT_OPTIONS, describeAllowance, LLM_MODEL_OPTIONS, OUTCOME_MODES, VIDEO_PROVIDERS, type Allowance, type AllowanceMode, type LlmModelId, type OutcomeMode, type VideoProvider } from "../server/constants";
import { AdminAuth } from "./AdminAuth";
import { AdminCredits, useAdminPassword } from "./AdminCredits";
import { api, type Job, type Settings, type SettingsView } from "./api";
import { DEFAULT_MUSIC_VOLUME, useMusicVolume } from "./musicVolume";

const PROVIDER_LABELS: Record<VideoProvider, string> = {
  "fal-turbo": "fal Turbo (H3 Max turbo)",
  "fal-turbo-half": "fal Turbo Half (8s at 2x, played at 0.65x)",
  fal: "fal (H3 Max, real references)",
  machgen: "MachGen (H3 480p)",
  gmi: "GMI Cloud (H3 768P)",
  masky: "Masky",
};

const PROVIDER_HELP: Record<VideoProvider, string> = {
  "fal-turbo": "MiniMax H3 Max turbo 480P on fal. References go in as one labeled first frame that is cut off. ~$0.19 per 15s step until Sept 30, ~$0.38 after. ~4s per clip.",
  "fal-turbo-half": "Turbo Half: 8s generated as a 2x fast-forward, played at 0.65x (~12s clip, ~15.6 real fps, no interpolation). ~$0.10 per step until Sept 30, ~$0.20 after.",
  fal: "MiniMax H3 Max 480P on fal.ai, 9 reference images, ~$0.75 per 15s step. Fastest: ~9s per clip, and the clip starts playing before it is stored.",
  gmi: "MiniMax H3 768P on GMI Cloud, 9 reference images, ~$1.20 per 15s step (GMI has no 480p).",
  machgen: "MiniMax H3 480p, 9 reference images, ~$0.75 per 15s step.",
  masky: "Masky 720p, continuity from the previous clip's last frame, ~$0.38 per 15s step.",
};

const MODE_HELP: Record<OutcomeMode, string> = {
  vibes: "LLM judges creativity + plausibility. Numbers below are ignored.",
  hybrid: "LLM decides, loosely guided by probability ± creativity points.",
  dice: "Server rolls: probability ± creativity points.",
};

/**
 * One side of the gate: unlimited, N finished games, or N generated steps. The number is hidden when the
 * mode is unlimited, because a count that does nothing invites the operator to set it and wonder why.
 */
function AllowanceField({ label, value, onChange }: { label: string; value: Allowance; onChange: (v: Allowance) => void }) {
  const whole = (raw: string, max: number) => Math.max(0, Math.min(max, Math.round(Number(raw) || 0)));
  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-[11px] leading-tight text-white/50">{label}</span>
        <select
          value={value.mode}
          onChange={e => onChange({ ...value, mode: e.target.value as AllowanceMode, count: value.count || 1 })}
          className="w-0 min-w-0 flex-1 rounded border border-white/15 bg-white/5 px-2 py-1 text-xs text-white"
        >
          {ALLOWANCE_MODES.map(m => (
            <option key={m} value={m} className="bg-black">
              {ALLOWANCE_MODE_LABELS[m]}
            </option>
          ))}
        </select>
        {value.mode !== "unlimited" && (
          <input
            type="number"
            min={0}
            max={ALLOWANCE_MAX}
            value={value.count}
            onChange={e => onChange({ ...value, count: whole(e.target.value, ALLOWANCE_MAX) })}
            aria-label={`${label} allowance`}
            className="w-12 shrink-0 rounded border border-white/15 bg-white/5 px-1.5 py-1 text-right text-xs text-white"
          />
        )}
      </div>
      {/* The refill clock is per person and starts at their first move, so it is not a global reset hour. */}
      {value.mode !== "unlimited" && (
        <div className="mt-1 flex items-center gap-2 pl-[5.5rem] text-[11px] text-white/40">
          <span>refills every</span>
          <input
            type="number"
            min={0}
            max={RESET_DAYS_MAX}
            value={value.resetDays}
            onChange={e => onChange({ ...value, resetDays: whole(e.target.value, RESET_DAYS_MAX) })}
            aria-label={`${label} reset days`}
            className="w-12 shrink-0 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-right text-white"
          />
          <span>{value.resetDays === 0 ? "days (never)" : value.resetDays === 1 ? "day" : "days"}</span>
        </div>
      )}
    </div>
  );
}

/** Soundtrack level, remembered in this browser. Muting stops the track; the clips keep their own sound. */
function MusicVolume() {
  const [volume, setVolume] = useMusicVolume();
  const percent = Math.round(volume * 100);
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between text-white/70">
        <span>Music volume</span>
        <span className="text-white/40">{percent === 0 ? "muted" : `${percent}%`}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          onClick={() => setVolume(volume === 0 ? DEFAULT_MUSIC_VOLUME : 0)}
          aria-label={volume === 0 ? "Unmute music" : "Mute music"}
          className="rounded border border-white/15 px-2 py-0.5 text-xs text-white/70 hover:border-teal hover:text-teal"
        >
          {volume === 0 ? "♪" : "✕"}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={percent}
          onChange={e => setVolume(Number(e.target.value) / 100)}
          aria-label="Music volume"
          className="h-1 flex-1 cursor-pointer appearance-none rounded bg-white/20 accent-sodium"
        />
      </div>
    </div>
  );
}

export function AdminPanel({ lastDebug }: { lastDebug: Job["debug"] | null }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  /** Cap warning, from the public status endpoint: visible without unlocking, unlike the GB and the cost. */
  const [storageFull, setStorageFull] = useState(false);
  /** Settings are read-only until the admin password has been accepted. */
  const password = useAdminPassword();
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    api.settings().then(setSettings);
  }, []);

  // Re-checked each time the panel opens, so the warning reflects the cap now rather than at page load.
  useEffect(() => {
    if (!open) return;
    fetch("/api/status")
      .then(r => r.json())
      .then(s => setStorageFull(Boolean(s.storageFull)))
      .catch(() => {});
  }, [open]);

  const usesNumbers = settings?.outcomeMode !== "vibes";

  const save = async (patch: Partial<Settings>) => {
    if (!password) return setSaveError("Enter the admin password to change settings.");
    const previous = settings;
    setSettings(s => (s ? { ...s, ...patch } : s));
    try {
      setSettings(await api.saveSettings(patch, password));
      setSaveError("");
    } catch (err) {
      // Put the control back where it was: the server rejected the change, so the UI must not imply it stuck.
      setSettings(previous);
      setSaveError((err as Error).message);
    }
  };

  // Sits above the sign-in gate on purpose: setting the guest policy to "none" with no working provider
  // would otherwise cover the only control that can undo it, locking the operator out of their own server.
  return (
    <div className="absolute right-4 top-4 z-[60] flex flex-col items-end gap-2">
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
        // Capped to the viewport below the gear button and scrolled internally: the panel has outgrown a
        // laptop screen, and the page itself cannot scroll because the game fills it.
        <div className="max-h-[calc(100dvh-6rem)] w-80 overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-black/80 p-4 font-mono text-sm backdrop-blur-md">
          <h2 className="mb-3 font-display text-xs font-semibold tracking-[0.3em] text-teal">
            {password ? "ADMIN // CONTROL ROOM" : "SETTINGS"}
          </h2>

          {/* The viewer's own setting: no password, because it only changes what plays in their ears. */}
          <MusicVolume />
          {storageFull && (
            <div className="mb-3 rounded border border-siren-red/60 bg-siren-red/10 p-2 text-xs text-siren-red">
              <b>Cloudflare storage cap reached.</b> New clips and exports are no longer being uploaded; they stay on the
              container disk instead. Unlock below for usage, and free space before the volume fills.
            </div>
          )}
          <AdminCredits />
          {/* Everything past the password field is operator-only: hidden, not just disabled, until unlocked. */}
          {password && (
            <button
              onClick={async () => {
                // The archive page is server-rendered and checks a session cookie, so trade the password for one first.
                const tab = window.open("", "_blank");
                const res = await fetch("/api/admin/session", { method: "POST", body: JSON.stringify({ password }) });
                if (tab) tab.location.href = res.ok ? "/admin/archive" : "/admin";
              }}
              className="mb-3 w-full rounded border border-teal/50 px-2 py-1.5 text-left text-xs text-teal hover:bg-teal/10"
            >
              Action archive manager ↗
            </button>
          )}
          {password && <AdminAuth />}

          {saveError && <div className="mb-3 rounded border border-siren-red/50 bg-siren-red/10 p-2 text-xs text-siren-red">{saveError}</div>}

          {/*
            Everything below changes how the game spends money or who has to sign in. Players who don't have
            the password can't use any of it, so it is hidden until the password has been accepted.
          */}
          {password && (
          // min-w-0: a fieldset defaults to min-width:min-content, so without it the widest control inside
          // stretches the whole panel and gives it a horizontal scrollbar.
          <fieldset className="min-w-0">

          {/* The gate: how much each side of the sign-in line gets, counted in games or in generations. */}
          <div className="text-white/70">Allowance</div>
          <AllowanceField
            label="Not signed in"
            value={settings.guestAllowance}
            onChange={v => save({ guestAllowance: v })}
          />
          <AllowanceField
            label="Signed in"
            value={settings.memberAllowance}
            onChange={v => save({ memberAllowance: v })}
          />
          {/* Otherwise the operator believes guests are gated while every visitor walks straight through. */}
          {settings.guestAllowance.mode !== "unlimited" && !settings.authEnabled && (
            <div className="mt-1 rounded border border-sodium/40 bg-sodium/10 p-2 text-xs text-sodium">
              <b>Not enforced yet.</b> Sign-in isn't available yet, so guests play without limits until it is set
              up under Sign-in providers above. A signed-in limit still applies.
            </div>
          )}
          <CountField
            label="Share bonuses per refill"
            value={settings.shareBonusMax}
            max={SHARE_BONUS_MAX}
            unit={settings.shareBonusMax === 0 ? "off" : settings.shareBonusMax === 1 ? "go" : "goes"}
            onChange={v => save({ shareBonusMax: v })}
          />
          <CountField
            label="Guest limit per network"
            value={settings.networkTolerance}
            max={NETWORK_TOLERANCE_MAX}
            unit={settings.networkTolerance === 0 ? "off" : "× a guest's"}
            onChange={v => save({ networkTolerance: v })}
          />
          <div className="mb-3 mt-1 text-xs text-white/40">
            Guests get {describeAllowance(settings.guestAllowance)}; signed in, {describeAllowance(settings.memberAllowance)}.
            {" "}In games mode a story runs as long as it likes and the step count is ignored. Guests are counted per
            browser, with a looser limit per network so shared wifi isn't blocked by one person; signed-in play is
            counted per account. Each share bonus is a whole game (or a whole allowance of steps), one per finished
            run, and they reset when the allowance refills.
          </div>

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
            <div>
              <div className="text-white/70">Video provider</div>
              {/* A dropdown: only providers with an API key on this server, in order of preference. */}
              <select
                value={settings.videoProvider}
                onChange={e => save({ videoProvider: e.target.value as VideoProvider })}
                className="mt-1 w-full rounded border border-white/15 bg-black px-2 py-1.5 text-white"
              >
                {(settings.availableProviders ?? VIDEO_PROVIDERS).map(provider => (
                  <option key={provider} value={provider}>
                    {PROVIDER_LABELS[provider]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-white/40">{PROVIDER_HELP[settings.videoProvider]}</p>
            </div>
            {settings.maskyAvailable && settings.videoProvider === "masky" && (
              <Toggle label="Masky draft quality (cheaper)" checked={settings.maskyDraft} onChange={v => save({ maskyDraft: v })} />
            )}
            <Toggle
              label="Reuse archived actions (skip paid re-generation)"
              checked={settings.reuseActions}
              onChange={v => save({ reuseActions: v })}
            />
            <Toggle
              label="Display whether video is freshly generated or cached"
              checked={settings.showClipSource}
              onChange={v => save({ showClipSource: v })}
            />
            {/* The debug drawer is open to every visitor; this decides whether it shows them the bill. */}
            <Toggle
              label="Show spend in the debug drawer (admins always see it)"
              checked={settings.showDebugSpend}
              onChange={v => save({ showDebugSpend: v })}
            />
            <Toggle
              label="Constant think (reuse Sloppy Joe macro loop)"
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
          </fieldset>
          )}

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

/** A small whole number with a trailing unit; 0 reads as "off" wherever the caller says so. */
function CountField(props: { label: string; value: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="mt-1 flex items-center justify-between gap-3 text-white/70">
      <span>{props.label}</span>
      <span className="flex items-center gap-1.5 text-[11px] text-white/40">
        <input
          type="number"
          min={0}
          max={props.max}
          value={props.value}
          onChange={e => props.onChange(Math.max(0, Math.min(props.max, Math.round(Number(e.target.value) || 0))))}
          className="w-12 rounded border border-white/15 bg-white/5 px-1.5 py-0.5 text-right text-xs text-white"
        />
        <span className="w-16">{props.unit}</span>
      </span>
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
