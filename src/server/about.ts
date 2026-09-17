/**
 * About page: where this came from and how it works. Rendered on the server like the share page so it needs
 * no client bundle and is scrapeable, and so a link to it can be handed out on its own.
 */

import { beaconTag } from "./analytics";

export const REPO_URL = "https://github.com/petermart/interactive-video";
const MASTER_PLAN_URL = `${REPO_URL}/blob/main/master-plan.md`;

/** The pipeline behind one typed action, which is the part of the master plan worth summarising. */
const STEPS: [string, string][] = [
  ["You type a direction", "Anything you like. Free text, no menu of options to pick from."],
  ["A game master rules on it", "A fast model decides whether the attempt is allowed, whether it works, and where it leaves you."],
  ["A cinematographer writes the shot", "A second model turns that verdict into a single continuous shot description in the film's house style."],
  ["The shot is generated", "An image-to-video model shoots it, continuing from the last frame so the film stays unbroken."],
  ["The clip is archived", "The next viewer who tries the same thing in the same place gets your clip instead of paying to regenerate it."],
];

export function aboutPage() {
  const steps = STEPS.map(
    ([title, body], i) => `
      <li>
        <span class="n">${String(i + 1).padStart(2, "0")}</span>
        <div><h3>${title}</h3><p>${body}</p></div>
      </li>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>About · Escape from Slop Prison</title>
<meta name="description" content="An interactive AI film built at the AI Filmmaking Masterclass + Hackathon at Yes SF, San Francisco." />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&family=JetBrains+Mono:wght@400;600&display=swap" />
<style>
  :root { --sodium: #ff8a2a; --teal: #1fb5b0; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; padding: 48px 24px 72px;
    background: radial-gradient(ellipse at 50% 0%, #0d1418 0%, #07090c 70%); color: #fff;
    font-family: "Chakra Petch", system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  .kicker { font: 600 13px "JetBrains Mono", monospace; letter-spacing: .4em; color: var(--teal); margin-bottom: 14px; }
  h1 { margin: 0 0 6px; font-size: clamp(30px, 6vw, 52px); line-height: 1.02; letter-spacing: .02em; }
  h1 .accent { color: var(--sodium); display: block; }
  .lede { margin: 20px 0 0; font-size: 18px; line-height: 1.6; color: rgba(255,255,255,.78); }
  h2 { margin: 44px 0 14px; font-size: 13px; font-family: "JetBrains Mono", monospace; font-weight: 600;
    letter-spacing: .34em; color: var(--teal); text-transform: uppercase; }
  p { line-height: 1.65; color: rgba(255,255,255,.72); }
  a { color: var(--sodium); }
  ol { list-style: none; margin: 0; padding: 0; }
  ol li { display: flex; gap: 16px; padding: 14px 0; border-top: 1px solid rgba(255,255,255,.09); }
  ol li:first-child { border-top: 0; }
  .n { font: 600 13px "JetBrains Mono", monospace; color: var(--sodium); padding-top: 4px; min-width: 26px; }
  ol h3 { margin: 0 0 4px; font-size: 16px; letter-spacing: .02em; }
  ol p { margin: 0; font-size: 14px; }
  .links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
  .btn { padding: 11px 22px; border: 1px solid rgba(255,255,255,.22); border-radius: 6px; color: #fff;
    text-decoration: none; font-weight: 600; font-size: 14px; letter-spacing: .12em; }
  .btn:hover { border-color: var(--sodium); color: var(--sodium); }
  .btn.primary { border-color: var(--sodium); color: var(--sodium); }
  .btn.primary:hover { background: var(--sodium); color: #000; }
  footer { margin-top: 52px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,.09);
    font-family: "JetBrains Mono", monospace; font-size: 12px; color: rgba(255,255,255,.4); }
</style>
</head>
<body>
<main>
  <div class="kicker">ABOUT</div>
  <h1>Escape from <span class="accent">Slop Prison</span></h1>

  <p class="lede">
    An interactive AI film. You are not picking from a menu: you type whatever you want Sloppy Joe to try,
    and the next shot of the film is written and generated around it. Every viewer's escape is a different cut.
  </p>

  <h2>Where it came from</h2>
  <p>
    Built at the <strong>AI Filmmaking Masterclass + Hackathon</strong> at Yes SF in San Francisco on
    <strong>13 September</strong>. The brief was to make something that could only exist because the
    generation is happening live, rather than a pre-rendered film with branching picked in advance.
  </p>

  <h2>How a turn works</h2>
  <ol>${steps}</ol>

  <h2>The master plan</h2>
  <p>
    The whole thing was built against a written plan: the world and its cast, the house style every shot is
    held to, the two-model split between ruling on an action and writing the shot, and the caching that keeps
    a public demo affordable. It is in the repository, unedited.
  </p>
  <div class="links">
    <a class="btn primary" href="${MASTER_PLAN_URL}">READ THE MASTER PLAN</a>
    <a class="btn" href="${REPO_URL}">SOURCE ON GITHUB</a>
    <a class="btn" href="/">PLAY</a>
  </div>

  <footer>Escape from Slop Prison · built at Yes SF, San Francisco</footer>
</main>
${beaconTag()}
</body>
</html>`;
}
