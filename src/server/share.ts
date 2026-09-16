import { existsSync } from "node:fs";
import { EXPORT_DIR, publicBaseUrl } from "./config";
import { logEvent } from "./db";
import { exportFilm, exportVertical } from "./export";
import { getNode, type StoryNode } from "./pipeline";

/** Tags asked for by the hackathon submission, used as default share text. */
const TAGS = "@multimodalsoc @MachgenAI @gmi_cloud @ElevenLabs";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Poster frame for the share card, pulled from near the end of the film. */
async function ensureThumbnail(nodeId: string) {
  const mp4 = `${EXPORT_DIR}/${nodeId}.mp4`;
  const jpg = `${EXPORT_DIR}/${nodeId}.jpg`;
  if (existsSync(jpg)) return jpg;
  const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-sseof", "-2", "-i", mp4, "-frames:v", "1", "-update", "1", "-vf", "scale=1280:-2", jpg]);
  if ((await proc.exited) !== 0) throw new Error("ffmpeg failed making the share thumbnail");
  return jpg;
}

function headline(node: StoryNode) {
  if (node.outcome === "escaped") return `Larry escaped in ${node.depth} move${node.depth === 1 ? "" : "s"}`;
  if (node.outcome === "fail") return node.failType === "dead" ? "Larry didn't make it out alive" : "Larry got caught";
  return "Larry is planning his escape";
}

/** Everything the share page and the share buttons need for one ending. */
export async function shareInfo(nodeId: string, requestOrigin: string, opts: { vertical?: boolean } = {}) {
  const node = getNode(nodeId);
  if (!node) throw new Error("Unknown node");
  const film = await exportFilm(nodeId);
  await ensureThumbnail(node.id);
  // Instagram/TikTok want 9:16; built on request so landscape-only shares don't pay for it.
  const vertical = opts.vertical ? await exportVertical(nodeId) : null;

  // Social platforms fetch these URLs themselves, so they must be public: on localhost they only work locally.
  const base = publicBaseUrl() ?? requestOrigin;
  const title = headline(node);
  const description = node.direction
    ? `"${node.direction}" — an interactive AI film where you direct the prison break.`
    : "An interactive AI film where you direct the prison break.";

  return {
    nodeId: node.id,
    outcome: node.outcome,
    title,
    description,
    text: `${title}. ${node.direction ? `My move: "${node.direction}". ` : ""}Direct your own AI prison break ${TAGS}`,
    pageUrl: `${base}/s/${node.id}`,
    videoUrl: `${base}${film.url}`,
    verticalUrl: vertical ? `${base}${vertical.url}` : null,
    thumbUrl: `${base}/media/exports/${node.id}.jpg`,
    playUrl: base,
    isPublic: Boolean(publicBaseUrl()),
  };
}

/** Share page: the card platforms scrape, plus a player and a link back into the game. */
export async function sharePage(nodeId: string, requestOrigin: string) {
  const info = await shareInfo(nodeId, requestOrigin);
  logEvent({ kind: "job", label: "share page viewed", response: { nodeId, outcome: info.outcome } });
  const t = escapeHtml(info.title);
  const d = escapeHtml(info.description);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t} · Prison Escape</title>
<meta property="og:type" content="video.other" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
<meta property="og:image" content="${info.thumbUrl}" />
<meta property="og:video" content="${info.videoUrl}" />
<meta property="og:video:secure_url" content="${info.videoUrl}" />
<meta property="og:video:type" content="video/mp4" />
<meta property="og:video:width" content="864" />
<meta property="og:video:height" content="480" />
<meta property="og:url" content="${info.pageUrl}" />
<meta name="twitter:card" content="player" />
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${d}" />
<meta name="twitter:image" content="${info.thumbUrl}" />
<meta name="twitter:player" content="${info.pageUrl}" />
<meta name="twitter:player:width" content="864" />
<meta name="twitter:player:height" content="480" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=JetBrains+Mono&display=swap" />
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; gap:18px; padding:24px;
    background:#07090c; color:#fff; font-family:"Chakra Petch",system-ui,sans-serif; }
  video { width:min(100%,900px); border:2px solid rgba(255,138,42,.5); border-radius:6px; background:#000; }
  h1 { margin:0; font-size:clamp(22px,4vw,36px); letter-spacing:.04em; text-align:center; }
  h1 { color:#ff8a2a; }
  p { margin:0; color:rgba(255,255,255,.6); font-family:"JetBrains Mono",monospace; font-size:13px; text-align:center; max-width:70ch; }
  a.cta { padding:12px 28px; border:1px solid #ff8a2a; border-radius:6px; color:#ff8a2a; text-decoration:none;
    font-weight:700; letter-spacing:.3em; }
  a.cta:hover { background:#ff8a2a; color:#000; }
</style>
</head>
<body>
  <h1>${t}</h1>
  <video src="${info.videoUrl}" poster="${info.thumbUrl}" controls playsinline preload="metadata"></video>
  <p>${d}</p>
  <a class="cta" href="${info.playUrl}">DIRECT YOUR OWN ESCAPE</a>
</body>
</html>`;
}
