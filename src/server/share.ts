import { beaconTag } from "./analytics";
import { publicBaseUrl } from "./config";
import { logEvent } from "./db";
import { ensureThumbnail, exportFilm, exportVertical } from "./export";
import { isEphemeral } from "./ephemeral";
import { getNode, type StoryNode } from "./pipeline";

/** Tags asked for by the hackathon submission, used as default share text. */
//const TAGS = "@multimodalsoc @MachgenAI @gmi_cloud @ElevenLabs";
const TAGS = "Created by @JustPeterMartin using @gmi_cloud @fal @MachGenAI";
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function headline(node: StoryNode) {
  if (node.outcome === "escaped") return `Sloppy Joe escaped in ${node.depth} move${node.depth === 1 ? "" : "s"}`;
  if (node.outcome === "fail") return node.failType === "dead" ? "Sloppy Joe didn't make it out alive" : "Sloppy Joe got caught";
  return "Sloppy Joe is planning his escape";
}

/** Everything the share page and the share buttons need for one ending. */
export async function shareInfo(nodeId: string, requestOrigin: string, opts: { vertical?: boolean } = {}) {
  const node = getNode(nodeId);
  if (!node) throw new Error("Unknown node");
  const film = await exportFilm(nodeId);

  /**
   * A film that only exists on the container's disk cannot be shared: it is deleted when the viewer leaves,
   * so any link handed out now is a guaranteed 404 later. Downloading it still works — that copy is theirs
   * and outlives ours — so the film is still useful, just not linkable.
   */
  const temporary = isEphemeral(film.url);
  if (!temporary) await ensureThumbnail(node.id);
  // Instagram/TikTok want 9:16; built on request so landscape-only shares don't pay for it.
  const vertical = opts.vertical ? await exportVertical(nodeId) : null;

  // Social platforms fetch these URLs themselves, so they must be public: on localhost they only work locally.
  const base = publicBaseUrl() ?? requestOrigin;
  const title = headline(node);
  const description = node.direction
    ? `"${node.direction}" — an interactive AI film where you direct the escape.`
    : "An interactive AI film where you direct the escape.";

  return {
    nodeId: node.id,
    outcome: node.outcome,
    title,
    description,
    text: `${title}. ${node.direction ? `My move: "${node.direction}". ` : ""}Direct your own AI escape ${TAGS}`,
    // No share page for a temporary film: the link would outlive the file behind it.
    pageUrl: temporary ? null : `${base}/s/${node.id}`,
    videoUrl: `${base}${film.url}`,
    verticalUrl: vertical ? `${base}${vertical.url}` : null,
    thumbUrl: temporary ? null : `${base}/media/exports/${node.id}.jpg`,
    playUrl: base,
    isPublic: Boolean(publicBaseUrl()),
    /** False while storage is full: the player can still watch and download, but not post a link. */
    shareable: !temporary,
    shareBlockedReason: temporary
      ? "Storage is full, so this cut is temporary — you can download it, but it can't be linked."
      : null,
  };
}

/** Share page: the card platforms scrape, plus a player and a link back into the game. */
export async function sharePage(nodeId: string, requestOrigin: string) {
  const info = await shareInfo(nodeId, requestOrigin);
  // Refuse rather than serve a page whose video is about to be deleted under it.
  if (!info.shareable) throw new Error("This cut is temporary and has no share page");
  logEvent({ kind: "job", label: "share page viewed", response: { nodeId, outcome: info.outcome } });
  const t = escapeHtml(info.title);
  const d = escapeHtml(info.description);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t} · Escape from Slop Prison</title>
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
${beaconTag()}
</body>
</html>`;
}
