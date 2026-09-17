import { useEffect, useState } from "react";
import { useAdminPassword } from "./AdminCredits";
import { apiFetch } from "./viewer";

type Provider = {
  id: string;
  clientId: string;
  hasSecret: boolean;
  configured: boolean;
  pinnedByEnv: boolean;
  callbackUrl: string;
};
type AuthReport = { providers: Provider[]; enabled: boolean; baseUrl: string; weakSecret: boolean };

const LABELS: Record<string, string> = { google: "Google", facebook: "Facebook" };
const CONSOLES: Record<string, string> = {
  google: "console.cloud.google.com → Credentials → OAuth client ID (Web)",
  facebook: "developers.facebook.com → your app → Facebook Login → Settings",
};

/**
 * Sign-in provider setup, behind the same admin password as the credit balances.
 *
 * Lets OAuth be finished on a running server: without this the only way to configure providers is
 * environment variables, which on Railway means a redeploy, and locally means a restart. Secrets are
 * write-only — the server reports whether one exists but never sends it back — so the field is left blank
 * on an already-configured provider and submitting it blank keeps the stored secret.
 */
export function AdminAuth() {
  const password = useAdminPassword();
  const [report, setReport] = useState<AuthReport | null>(null);
  const [draft, setDraft] = useState<Record<string, { clientId: string; clientSecret: string }>>({});
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  const load = async (extra: Record<string, unknown> = {}) => {
    if (!password) return;
    const res = await apiFetch("/api/admin/auth", { method: "POST", body: JSON.stringify({ password, ...extra }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setReport(body);
    return body as AuthReport;
  };

  useEffect(() => {
    if (open && password) load().catch(err => setNote((err as Error).message));
  }, [open, password]);

  const save = async (id: string) => {
    setBusy(id);
    setNote("");
    try {
      const d = draft[id] ?? { clientId: "", clientSecret: "" };
      await load({ provider: id, clientId: d.clientId, clientSecret: d.clientSecret });
      // Secrets are never echoed back, so clear the field rather than leave a value that isn't real.
      setDraft(s => ({ ...s, [id]: { clientId: d.clientId, clientSecret: "" } }));
      setNote(`${LABELS[id] ?? id} saved — sign-in reloaded, no restart needed.`);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="mb-4 border-b border-white/10 pb-3">
      <button onClick={() => setOpen(o => !o)} className="flex w-full items-center justify-between text-white/70 hover:text-white">
        <span>Sign-in providers</span>
        <span className="font-mono text-xs text-teal">
          {!password ? "locked" : report ? (report.enabled ? `${report.providers.filter(p => p.configured).length} active` : "none") : "…"}{" "}
          {open ? "▾" : "▸"}
        </span>
      </button>

      {/*
        Shown even while locked. Hiding the section entirely meant nobody could discover that sign-in is
        configurable at all — the gate would just say "not configured" with no route to fixing it.
      */}
      {open && !password && (
        <div className="mt-2 rounded border border-white/10 p-2 text-xs text-white/50">
          Enter the admin password above to configure Google and Facebook sign-in.
        </div>
      )}

      {open && password && report && (
        <div className="mt-2 space-y-3">
          {report.weakSecret && (
            <div className="rounded border border-siren-red/50 bg-siren-red/10 p-2 text-xs text-siren-red">
              <b>AUTH_SECRET is weak or unset.</b> Sessions are forgeable until it is set to a random 32+ character value.
            </div>
          )}

          {report.providers.map(p => (
            <div key={p.id} className="rounded border border-white/10 p-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{LABELS[p.id] ?? p.id}</span>
                <span className={`font-mono text-xs ${p.configured ? "text-[#3dff7a]" : "text-white/30"}`}>
                  {p.configured ? "configured" : "not set"}
                </span>
              </div>

              {p.pinnedByEnv ? (
                <div className="mt-1 text-xs text-white/40">Set by environment variables on this deployment, so it can't be edited here.</div>
              ) : (
                <>
                  <div className="mt-1 text-[11px] text-white/35">{CONSOLES[p.id]}</div>
                  {/* The single most common setup mistake is a redirect URI that doesn't match exactly. */}
                  <div className="mt-1 text-[11px] text-white/35">
                    Redirect URI:{" "}
                    <code
                      className="cursor-pointer break-all text-teal underline decoration-dotted"
                      onClick={() => void navigator.clipboard.writeText(p.callbackUrl).then(() => setNote("Redirect URI copied"))}
                      title="Click to copy"
                    >
                      {p.callbackUrl}
                    </code>
                  </div>
                  <input
                    value={draft[p.id]?.clientId ?? p.clientId}
                    onChange={e => setDraft(s => ({ ...s, [p.id]: { clientId: e.target.value, clientSecret: s[p.id]?.clientSecret ?? "" } }))}
                    placeholder="Client ID"
                    className="mt-2 w-full rounded border border-white/15 bg-white/5 px-2 py-1 text-white"
                  />
                  <input
                    type="password"
                    value={draft[p.id]?.clientSecret ?? ""}
                    onChange={e =>
                      setDraft(s => ({ ...s, [p.id]: { clientId: s[p.id]?.clientId ?? p.clientId, clientSecret: e.target.value } }))
                    }
                    placeholder={p.hasSecret ? "Client secret (saved — leave blank to keep)" : "Client secret"}
                    className="mt-1 w-full rounded border border-white/15 bg-white/5 px-2 py-1 text-white"
                  />
                  <button
                    onClick={() => void save(p.id)}
                    disabled={busy === p.id}
                    className="mt-2 rounded bg-teal px-3 py-1 font-semibold text-black disabled:opacity-40"
                  >
                    {busy === p.id ? "…" : "SAVE"}
                  </button>
                </>
              )}
            </div>
          ))}

          {note && <div className="text-xs text-teal">{note}</div>}
          <div className="text-[11px] text-white/30">
            Apple needs a paid Apple Developer account ($99/yr) and isn't wired up.
          </div>
        </div>
      )}
    </div>
  );
}
