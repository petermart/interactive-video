import type { Film } from "./films";

/**
 * Server-rendered admin pages: the sign-in form and the action-archive manager. Plain HTML plus a little inline
 * script, like the About and share pages, so they need no client bundle. They are only ever served to a signed-in
 * admin (see adminSession.ts); the archive page's data and actions come from admin APIs that check again.
 */

const STYLE = `
  :root { --sodium: #ff8a2a; --teal: #1fb5b0; --red: #ff2d3d; --green: #3dff7a; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: radial-gradient(ellipse at 50% 0%, #0d1418 0%, #07090c 70%);
    color: #fff; font: 14px/1.5 "JetBrains Mono", ui-monospace, monospace; }
  a { color: var(--sodium); }
  h1 { font: 700 22px "Chakra Petch", system-ui, sans-serif; letter-spacing: .08em; margin: 0; }
  .kicker { font-size: 11px; letter-spacing: .35em; color: var(--teal); }
  button, select, input { font: inherit; color: #fff; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.18);
    border-radius: 6px; padding: 6px 10px; }
  button { cursor: pointer; } button:hover { border-color: var(--sodium); color: var(--sodium); }
  button.danger:hover { border-color: var(--red); color: var(--red); }
  button:disabled { opacity: .4; cursor: default; }
  /* Native dropdown lists are drawn by the OS: without a dark scheme Windows renders them white, under white text. */
  :root { color-scheme: dark; }
  option, optgroup { background: #0b0e13; color: #fff; }
`;

const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=JetBrains+Mono:wght@400;600&display=swap" />`;

export function adminLoginPage(error?: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Admin sign-in · Escape from Slop Prison</title>${FONTS}
<style>${STYLE}
  main { max-width: 360px; margin: 18vh auto 0; padding: 24px; border: 1px solid rgba(255,255,255,.12); border-radius: 10px; background: rgba(0,0,0,.4); }
  form { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
  .err { color: var(--red); font-size: 12px; }
</style></head>
<body><main>
  <div class="kicker">ADMIN</div>
  <h1>Sign in</h1>
  <form method="post" action="/admin/login">
    <input type="password" name="password" placeholder="Admin password" autocomplete="current-password" required autofocus />
    <button type="submit">SIGN IN</button>
    ${error ? `<div class="err">${error.replace(/[<>&]/g, "")}</div>` : ""}
  </form>
</main></body></html>`;
}

/** Providers offered for regeneration, with a rough 15s price so an admin knows what a click costs. */
export type ProviderOption = { id: string; price: string };

export function adminArchivePage(providers: ProviderOption[], environments: string[]) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Action archive · Admin</title>${FONTS}
<style>${STYLE}
  header { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
    padding: 14px 20px; background: rgba(7,9,12,.92); border-bottom: 1px solid rgba(255,255,255,.1); backdrop-filter: blur(6px); }
  header .grow { flex: 1; }
  .stats { color: rgba(255,255,255,.55); font-size: 12px; }
  main { padding: 16px 20px 60px; display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); }
  .card { border: 1px solid rgba(255,255,255,.12); border-radius: 10px; background: rgba(0,0,0,.35); overflow: hidden; display: flex; flex-direction: column; }
  video { width: 100%; aspect-ratio: 16/9; background: #000; display: block; }
  .noclip { aspect-ratio: 16/9; display: grid; place-items: center; background: rgba(255,45,61,.08); color: rgba(255,255,255,.5); padding: 16px; text-align: center; font-size: 12px; }
  .body { padding: 12px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .direction { font-size: 14px; color: #fff; }
  .meta { font-size: 11px; color: rgba(255,255,255,.5); display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .summary { font-size: 12px; color: rgba(255,255,255,.7); }
  .badge { font-size: 10px; letter-spacing: .12em; padding: 2px 7px; border-radius: 99px; border: 1px solid; text-transform: uppercase; }
  .success { color: var(--teal); } .escaped { color: var(--green); } .fail { color: var(--sodium); } .rejected { color: var(--red); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: auto; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.08); }
  .status { font-size: 11px; color: rgba(255,255,255,.6); width: 100%; }
  details summary { cursor: pointer; font-size: 11px; color: rgba(255,255,255,.45); }
  details pre { white-space: pre-wrap; font-size: 11px; color: rgba(255,255,255,.6); max-height: 220px; overflow: auto; }
  .edit { display: grid; gap: 8px; padding: 10px; border: 1px solid rgba(31,181,176,.35); border-radius: 8px; background: rgba(31,181,176,.05); }
  .edit label { display: grid; gap: 3px; font-size: 11px; color: rgba(255,255,255,.55); }
  .edit .row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  textarea { font: 12px/1.45 "JetBrains Mono", monospace; color: #fff; background: rgba(0,0,0,.4); border: 1px solid rgba(255,255,255,.18);
    border-radius: 6px; padding: 8px; resize: vertical; width: 100%; }
</style></head>
<body>
<header>
  <div><div class="kicker">ADMIN</div><h1>Action archive</h1></div>
  <input id="q" type="search" placeholder="Search actions, summaries…" />
  <select id="outcome"><option value="">All outcomes</option><option>success</option><option>escaped</option><option>fail</option><option>rejected</option></select>
  <select id="env"><option value="">All locations</option></select>
  <div class="grow stats" id="stats"></div>
  <a href="/">Game</a>
  <form method="post" action="/admin/logout" style="margin:0"><button type="submit">Sign out</button></form>
</header>
<main id="list"></main>
<script>
const PROVIDERS = ${JSON.stringify(providers)};
const ENVIRONMENTS = ${JSON.stringify(environments)};
let rows = [];
const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter(k => k != null)); return n; };

async function api(path, init) {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init && init.headers) } });
  if (res.status === 401) { location.href = "/admin"; throw new Error("signed out"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
  return body;
}

async function load() {
  rows = (await api("/api/admin/archive")).rows;
  const envs = [...new Set(rows.map(r => r.environment_id))].sort();
  const sel = $("#env"); const keep = sel.value;
  sel.replaceChildren(el("option", { value: "", textContent: "All locations" }), ...envs.map(e => el("option", { value: e, textContent: e })));
  sel.value = keep;
  render();
}

function render() {
  const q = $("#q").value.trim().toLowerCase(), outcome = $("#outcome").value, env = $("#env").value;
  const shown = rows.filter(r => (!outcome || r.outcome === outcome) && (!env || r.environment_id === env) &&
    (!q || (r.direction + " " + r.summary + " " + (r.intent_key || "")).toLowerCase().includes(q)));
  const by = o => rows.filter(r => r.outcome === o).length;
  $("#stats").textContent = shown.length + " shown of " + rows.length + " · " + by("success") + " success · " + by("escaped") + " escaped · " +
    by("fail") + " fail · " + by("rejected") + " rejected · " + rows.reduce((n, r) => n + r.uses, 0) + " reuses";
  $("#list").replaceChildren(...shown.map(card));
}

function card(r) {
  const media = r.clip_url
    ? el("video", { src: r.clip_url, controls: true, preload: "none", playsInline: true })
    : el("div", { className: "noclip", textContent: r.outcome === "rejected" ? "Rejected: " + (r.rejection_reason || r.summary) : "No clip" });
  const status = el("div", { className: "status" });
  const actions = el("div", { className: "actions" });

  if (r.clip_url && r.outcome !== "rejected") {
    const pick = el("select", {}, ...PROVIDERS.map(p => el("option", { value: p.id, textContent: p.id + " (" + p.price + ")" })));
    const regen = el("button", { textContent: "Regenerate" });
    regen.onclick = async () => {
      const p = PROVIDERS.find(x => x.id === pick.value);
      if (!confirm("Regenerate this clip with " + p.id + "? This spends about " + p.price + ". The verdict and outcome stay the same; only the footage is replaced.")) return;
      regen.disabled = true; status.textContent = "Starting…";
      try { await api("/api/admin/archive/" + r.id + "/regenerate", { method: "POST", body: JSON.stringify({ provider: p.id }) }); poll(r, status, regen); }
      catch (e) { status.textContent = "Failed: " + e.message; regen.disabled = false; }
    };
    actions.append(pick, regen);
  }
  const del = el("button", { className: "danger", textContent: "Delete" });
  del.onclick = async () => {
    if (!confirm("Delete this archive entry" + (r.clip_url ? " and its video" : "") + "? The next player who tries this gets a fresh judgement and generation.")) return;
    del.disabled = true;
    try { await api("/api/admin/archive/" + r.id, { method: "DELETE" }); rows = rows.filter(x => x.id !== r.id); render(); }
    catch (e) { status.textContent = "Failed: " + e.message; del.disabled = false; }
  };
  const edit = el("button", { textContent: "Edit" });
  actions.append(edit, del, status);
  const form = editor(r, status);
  form.hidden = true;
  edit.onclick = () => { form.hidden = !form.hidden; edit.textContent = form.hidden ? "Edit" : "Close editor"; };

  const move = r.environment_id === r.to_environment_id ? r.environment_id : r.environment_id + " → " + r.to_environment_id;
  return el("article", { className: "card" }, media,
    el("div", { className: "body" },
      el("div", { className: "direction", textContent: "“" + r.direction + "”" }),
      el("div", { className: "meta" },
        el("span", { className: "badge " + r.outcome, textContent: r.outcome + (r.fail_type ? " · " + r.fail_type : "") }),
        el("span", { textContent: move }),
        el("span", { textContent: r.uses + " reuse" + (r.uses === 1 ? "" : "s") }),
        el("span", { textContent: r.provider + (r.cost_usd ? " · $" + Number(r.cost_usd).toFixed(2) : "") }),
        el("span", { textContent: "#" + r.id + " · " + r.created_at.slice(0, 16).replace("T", " ") })),
      el("div", { className: "summary", textContent: r.summary }),
      r.shot_prompt ? el("details", {}, el("summary", { textContent: "Shot list" + (r.intent_key ? " · " + r.intent_key : "") }), el("pre", { textContent: r.shot_prompt })) : null,
      form,
      actions));
}

/** Edits what the next player who tries this action is told happened, and the shot list a regeneration films. */
function editor(r, status) {
  const option = (v, label, cur) => el("option", { value: v, textContent: label, selected: v === cur });
  const outcome = el("select", {}, ...[["success", "Accepted: success"], ["escaped", "Accepted: escaped (ends the game)"], ["fail", "Accepted: failed"], ["rejected", "Rejected"]].map(([v, l]) => option(v, l, r.outcome)));
  const failType = el("select", {}, option("redetained", "re-detained", r.fail_type || "redetained"), option("dead", "dead", r.fail_type));
  const next = el("select", {}, ...ENVIRONMENTS.map(e => option(e, e, r.to_environment_id)));
  const summary = el("textarea", { rows: 2, value: r.summary || "" });
  const shot = el("textarea", { rows: 10, value: r.shot_prompt || "" });
  const reason = el("textarea", { rows: 2, value: r.rejection_reason || "" });
  const failWrap = el("label", {}, "Fail type", failType);
  const reasonWrap = el("label", {}, "Rejection reason (shown to the player)", reason);
  const sync = () => { failWrap.hidden = outcome.value !== "fail"; reasonWrap.hidden = outcome.value !== "rejected"; };
  outcome.onchange = sync; sync();
  const save = el("button", { textContent: "Save changes" });
  save.onclick = async () => {
    save.disabled = true; status.textContent = "Saving…";
    try {
      const { row } = await api("/api/admin/archive/" + r.id, { method: "PATCH", body: JSON.stringify({
        outcome: outcome.value, fail_type: outcome.value === "fail" ? failType.value : null, to_environment_id: next.value,
        summary: summary.value, shot_prompt: shot.value, rejection_reason: outcome.value === "rejected" ? reason.value : null,
      }) });
      rows = rows.map(x => (x.id === r.id ? row : x)); render();
    } catch (e) { status.textContent = "Save failed: " + e.message; save.disabled = false; }
  };
  return el("div", { className: "edit" },
    el("div", { className: "row" }, el("label", {}, "Result", outcome), failWrap, el("label", {}, "Next location", next)),
    el("label", {}, "Summary (the story beat)", summary),
    reasonWrap,
    el("label", {}, "Shot prompt (what Regenerate films)", shot),
    el("div", {}, save, el("span", { style: "font-size:11px;color:rgba(255,255,255,.45);margin-left:8px",
      textContent: "Saving changes the result future players get. It does not re-film: use Regenerate for that." })));
}

async function poll(r, status, button) {
  for (;;) {
    await new Promise(res => setTimeout(res, 2500));
    const { row, regeneration } = await api("/api/admin/archive/" + r.id);
    if (!regeneration || regeneration.status === "running") { status.textContent = "Regenerating with " + (regeneration ? regeneration.provider : "…") + "…"; continue; }
    if (regeneration.status === "error") { status.textContent = "Failed: " + regeneration.error; button.disabled = false; return; }
    status.textContent = "Done" + (regeneration.costUsd ? " · $" + regeneration.costUsd.toFixed(2) : "");
    Object.assign(r, row); rows = rows.map(x => (x.id === r.id ? row : x)); render(); return;
  }
}

["#q", "#outcome", "#env"].forEach(s => $(s).addEventListener("input", render));
load().catch(e => { $("#list").textContent = "Could not load the archive: " + e.message; });
</script>
</body></html>`;
}

/**
 * Every stitched film, newest first: a playable grid with the facts about each one, filterable by ending and
 * by whether the file still exists. The list is embedded in the page, so it is one request however long it gets;
 * the videos themselves load only when played.
 */
export function adminFilmsPage(films: Film[]) {
  // Embedded as JSON inside a script tag: "<" is escaped so no value can close the tag early.
  const data = JSON.stringify(films).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Films · Escape from Slop Prison</title>${FONTS}
<style>${STYLE}
  main { max-width: 1400px; margin: 0 auto; padding: 24px 16px 64px; }
  header { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: 12px; }
  .stats { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 14px; color: rgba(255,255,255,.55); font-size: 12px; }
  .stats b { color: #fff; font-size: 16px; display: block; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 18px 0; }
  .filters button.on { background: var(--sodium); border-color: var(--sodium); color: #000; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: 14px; }
  .card { border: 1px solid rgba(255,255,255,.1); border-radius: 10px; overflow: hidden; background: rgba(0,0,0,.35); }
  .card video, .card .none { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; }
  .card .none { display: grid; place-items: center; color: rgba(255,255,255,.3); font-size: 12px; }
  .meta { padding: 10px 12px; font-size: 12px; color: rgba(255,255,255,.6); }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .tag { font-size: 10px; letter-spacing: .15em; padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; }
  .escaped { color: var(--green); } .fail { color: var(--red); } .other { color: rgba(255,255,255,.45); }
  .links { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .id { font-size: 10px; color: rgba(255,255,255,.3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: rgba(255,255,255,.4); padding: 40px 0; text-align: center; }
</style></head>
<body><main>
  <header>
    <div><div class="kicker">ADMIN</div><h1>Every stitched film</h1></div>
    <a href="/admin/archive">Action archive →</a>
  </header>
  <div class="stats" id="stats"></div>
  <div class="filters" id="filters"></div>
  <div class="grid" id="grid"></div>
  <div class="empty" id="empty" hidden>No films match.</div>
</main>
<script>
  const films = ${data};
  const FILTERS = {
    all: () => true,
    escaped: f => f.outcome === "escaped",
    fail: f => f.outcome === "fail",
    stored: f => f.stored !== "gone",
    gone: f => f.stored === "gone",
    members: f => f.owner === "member",
    guests: f => f.owner === "guest",
  };
  const LABELS = { all: "All", escaped: "Escaped", fail: "Caught", stored: "Still stored", gone: "File gone", members: "Signed in", guests: "Guests" };
  let active = "all";

  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids.filter(k => k != null)); return n; };
  const mins = s => s == null ? "?" : s >= 60 ? Math.floor(s / 60) + "m " + Math.round(s % 60) + "s" : Math.round(s) + "s";
  const size = b => b == null ? "" : b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB";
  const when = iso => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "unknown date";

  function stats() {
    const total = films.reduce((s, f) => s + (f.seconds || 0), 0);
    const bytes = films.reduce((s, f) => s + (f.stored !== "gone" ? f.bytes || 0 : 0), 0);
    const stat = (value, label) => el("div", {}, el("b", { textContent: value }), label);
    document.getElementById("stats").replaceChildren(
      stat(films.length, "films"),
      stat(films.filter(f => f.outcome === "escaped").length, "escapes"),
      stat(films.filter(f => f.stored !== "gone").length, "still stored"),
      stat(mins(total), "of footage"),
      stat(size(bytes) || "0 MB", "on storage"),
    );
  }

  function filters() {
    document.getElementById("filters").replaceChildren(...Object.keys(FILTERS).map(key => {
      const count = films.filter(FILTERS[key]).length;
      return el("button", { className: key === active ? "on" : "", textContent: LABELS[key] + " (" + count + ")", onclick: () => { active = key; render(); } });
    }));
  }

  function card(f) {
    const video = f.stored === "gone"
      ? el("div", { className: "none", textContent: "File no longer stored" })
      : el("video", { src: f.url, controls: true, preload: "none", playsInline: true, ...(f.thumbnail ? { poster: f.thumbnail } : {}) });
    const outcome = f.outcome === "escaped" ? ["ESCAPED", "escaped"] : f.outcome === "fail" ? ["CAUGHT", "fail"] : [(f.outcome || "unknown").toUpperCase(), "other"];
    const links = el("div", { className: "links" },
      el("a", { href: "/s/" + f.nodeId, target: "_blank", textContent: "Share page" }),
      f.stored !== "gone" ? el("a", { href: f.url, download: f.nodeId + ".mp4", textContent: "Download" }) : null,
      f.vertical ? el("a", { href: "/media/exports/" + f.nodeId + "-vertical.mp4", target: "_blank", textContent: "9:16 cut" }) : null,
    );
    const facts = [f.owner === "member" ? "signed in" : f.owner === "guest" ? "guest" : "", f.stored === "r2" ? "R2" : f.stored === "disk" ? "disk" : "", size(f.stored !== "gone" ? f.bytes : null)];
    return el("div", { className: "card" }, video, el("div", { className: "meta" },
      el("div", { className: "row" }, el("span", { textContent: when(f.createdAt) }), el("span", { className: "tag " + outcome[1], textContent: outcome[0] })),
      el("div", { className: "row" },
        el("span", { textContent: mins(f.seconds) + (f.clips != null ? " · " + f.clips + " clip" + (f.clips === 1 ? "" : "s") : "") }),
        el("span", { textContent: facts.filter(Boolean).join(" · ") })),
      links,
      el("div", { className: "id", textContent: f.nodeId, title: f.nodeId }),
    ));
  }

  function render() {
    filters();
    const shown = films.filter(FILTERS[active]);
    document.getElementById("grid").replaceChildren(...shown.map(card));
    document.getElementById("empty").hidden = shown.length > 0;
  }

  // Only one film plays at a time: starting another pauses the rest.
  document.addEventListener("play", e => document.querySelectorAll("video").forEach(v => v !== e.target && v.pause()), true);
  stats();
  render();
</script>
</body></html>`;
}
