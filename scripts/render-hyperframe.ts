/**
 * Renders a HyperFrames composition to a transparent motion-graphic file, for editing outside the game.
 *
 *   bun scripts/render-hyperframe.ts escaped
 *   bun scripts/render-hyperframe.ts failed --secs 5 --fps 30 --backdrop
 *
 * The compositions are GSAP timelines in a web page, so this drives headless Chrome frame by frame: seek
 * the (paused) timeline to an exact time, screenshot with a transparent page background, repeat. That is
 * deterministic in a way that screen-recording the running animation is not - no dropped frames, no timing
 * drift, and a real alpha channel rather than a keyed-out colour.
 *
 * Two things make this work where the obvious approaches did not. The Chrome available here has no
 * outbound network, so GSAP and the webfonts are fetched by this script (which does), written next to a
 * copy of the composition and referenced locally - otherwise the page never finishes loading and every
 * screenshot blocks on it. And frames are captured with Chrome's own --screenshot flag rather than over
 * the DevTools protocol, which hangs in this environment; one process per frame is slower but it works,
 * so several run at once.
 *
 * By default the full-screen #dim and #flash washes are hidden, because a motion graphic is going to be
 * composited over someone else's footage and a near-opaque black wash would bury it. Pass --backdrop to
 * keep them and get exactly what the game shows.
 *
 * Out: out/motion/<name>/ with a PNG sequence, a ProRes 4444 .mov (editors) and a VP9 .webm (web).
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NAMES = ["escaped", "failed", "title", "intro-title", "prompt"] as const;
const args = process.argv.slice(2);
const name = args[0] ?? "";
const flag = (key: string, fallback: number) => {
  const at = args.indexOf(`--${key}`);
  return at === -1 ? fallback : Number(args[at + 1]) || fallback;
};
const keepBackdrop = args.includes("--backdrop");
/**
 * Where the frames, the scratch profiles and the finished files go. A 1080p render needs a few hundred
 * megabytes of PNG frames before a single video exists, so this points at a roomy disk rather than the
 * one the repo happens to sit on.
 */
const outRoot = (() => {
  const at = args.indexOf("--out");
  return at === -1 ? "out/motion" : args[at + 1] ?? "out/motion";
})();
const secs = flag("secs", 6);
const fps = flag("fps", 30);
const jobs = flag("jobs", 6);
const WIDTH = 1920;
const HEIGHT = 1080;

if (!NAMES.includes(name as never)) {
  console.error(`Usage: bun scripts/render-hyperframe.ts <${NAMES.join("|")}> [--secs 6] [--fps 30] [--backdrop] [--jobs 6]`);
  process.exit(1);
}

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(p => existsSync(p));
if (!CHROME) throw new Error("No Chrome or Edge found to render with.");

const outDir = `${outRoot}/${name}`;
const pageDir = `${outDir}/page`;
const frameDir = `${outDir}/frames`;
const profileRoot = `${outDir}/.profiles`;
for (const dir of [pageDir, `${pageDir}/vendor`, profileRoot]) mkdirSync(dir, { recursive: true });
// Frames already on disk are kept and skipped, so an interrupted render resumes instead of starting over.
if (args.includes("--fresh")) rmSync(frameDir, { recursive: true, force: true });
mkdirSync(frameDir, { recursive: true });

// ---- a copy of the composition that needs no network -----------------------------------------------
let page = await Bun.file(`hyperframes/${name}/index.html`).text();
const vendorFile = async (from: string, as: string) => {
  const res = await fetch(from);
  if (!res.ok) throw new Error(`Couldn't fetch ${from}: HTTP ${res.status}`);
  await Bun.write(`${pageDir}/vendor/${as}`, await res.arrayBuffer());
};

const gsapSrc = page.match(/https:\/\/cdn\.jsdelivr\.net\/[^"']+gsap[^"']*/)?.[0];
if (gsapSrc) {
  await vendorFile(gsapSrc, "gsap.min.js");
  page = page.replace(gsapSrc, "./vendor/gsap.min.js");
}

const fontsHref = page.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']+/)?.[0];
if (fontsHref) {
  let css = await (await fetch(fontsHref)).text();
  const files = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+/g) ?? [])];
  for (const [i, file] of files.entries()) {
    await vendorFile(file, `font-${i}.woff2`);
    css = css.split(file).join(`./font-${i}.woff2`);
  }
  await Bun.write(`${pageDir}/vendor/fonts.css`, css);
  page = page.replace(fontsHref, "./vendor/fonts.css");
  console.log(`vendored gsap + ${files.length} font file(s)`);
}

/**
 * Seeks the paused timeline to ?t= before Chrome takes its shot, and (unless --backdrop) hides the washes
 * that would otherwise fill the alpha channel with near-black.
 */
page = page.replace(
  "</body>",
  `<script>
  (function () {
    var q = new URLSearchParams(location.search);
    var at = parseFloat(q.get("t") || "0");
    var name = ${JSON.stringify(name)};
    if (q.has("clean")) {
      var sheet = document.createElement("style");
      sheet.textContent = "#dim,#flash,#bleed,#vignette,.scanlines,#scan{display:none !important}html,body{background:transparent !important}";
      document.head.appendChild(sheet);
    }
    (function settle() {
      var tl = window.__timelines && window.__timelines[name];
      if (!tl) return setTimeout(settle, 20);
      tl.pause();
      tl.seek(at, false);
    })();
  })();
  </script></body>`,
);
await Bun.write(`${pageDir}/index.html`, page);

const fileUrl = `file:///${resolve(pageDir, "index.html").replace(/\\/g, "/")}`;
const total = Math.round(secs * fps);
console.log(`rendering ${name}: ${total} frames at ${fps}fps (${secs}s), ${WIDTH}x${HEIGHT}, ${jobs} at a time`);

// ---- frames ------------------------------------------------------------------------------------------
let done = 0;
/**
 * One profile per worker, reused across that worker's frames. Chrome builds a profile from scratch on
 * every launch otherwise, which on this machine cost more than the render of the frame itself.
 */
async function shoot(frame: number, worker: number) {
  const out = resolve(frameDir, `f${String(frame).padStart(4, "0")}.png`);
  if (existsSync(out)) {
    done++;
    return;
  }
  const profile = resolve(profileRoot, `w${worker}`);
  const url = `${fileUrl}?embed=1&t=${(frame / fps).toFixed(4)}${keepBackdrop ? "" : "&clean=1"}`;
  const proc = Bun.spawn(
    [
      CHROME!,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--hide-scrollbars",
      "--mute-audio",
      `--user-data-dir=${profile}`,
      // The whole point: no white page behind the composition.
      "--default-background-color=00000000",
      `--window-size=${WIDTH},${HEIGHT}`,
      // Lets fonts, layout and the seek settle without waiting in real time.
      "--virtual-time-budget=1200",
      `--screenshot=${out}`,
      url,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  await proc.exited;
  if (!existsSync(out)) throw new Error(`Chrome produced no frame ${frame}`);
  if (++done % 20 === 0 || done === total) console.log(`  ${done}/${total}`);
}

const queue = [...Array(total).keys()];
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async (_, worker) => {
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) await shoot(next, worker);
}));

// ---- encode ------------------------------------------------------------------------------------------
const suffix = keepBackdrop ? "-with-backdrop" : "";
const mov = `${outDir}/${name}${suffix}.mov`;
const webm = `${outDir}/${name}${suffix}.webm`;
const encode = (extra: string[], label: string) => {
  const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-framerate", String(fps), "-i", `${frameDir}/f%04d.png`, ...extra], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${label} failed: ${p.stderr.toString().trim().slice(-300)}`);
  console.log(`wrote ${label}`);
};

/**
 * The PNG sequence is the deliverable: it is the one alpha format every editor imports, it needs no codec
 * decisions, and a half-finished render is still usable. Encoding is opt-in with --encode, because ProRes
 * 4444 runs to roughly 35MB per second of 1080p and filled this machine's disk twice.
 */
if (args.includes("--encode")) {
  // VP9 with alpha: a few megabytes, so it is written first and always.
  encode(["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "0", "-crf", "26", webm], webm);
  // ProRes 4444 carries alpha and drops straight into Premiere / Resolve / FCP - when there is room for it.
  const outDrive = resolve(outDir).match(/^([A-Za-z]):/)?.[1] ?? "C";
  const freeMb = Number(
    Bun.spawnSync(["powershell", "-Command", `[math]::Round((Get-PSDrive ${outDrive}).Free/1MB,0)`]).stdout.toString().trim() || "0",
  );
  const needMb = Math.ceil(secs * 40) + 100;
  if (freeMb && freeMb < needMb) {
    console.log(`\nSkipped the ProRes .mov: it needs about ${needMb}MB and ${outDrive}: has ${freeMb}MB free.`);
  } else {
    encode(["-c:v", "prores_ks", "-profile:v", "4444", "-qscale:v", "12", "-pix_fmt", "yuva444p10le", "-alpha_bits", "8", "-vendor", "apl0", mov], mov);
  }
}

rmSync(profileRoot, { recursive: true, force: true });
rmSync(pageDir, { recursive: true, force: true });
console.log(`\nPNG sequence (${total} frames, ${WIDTH}x${HEIGHT}, RGBA): ${resolve(frameDir)}`);
