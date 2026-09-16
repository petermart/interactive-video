# Testing Prison Escape yourself

## 1. Requirements

- **Bun** 1.3+: https://bun.sh
- **ffmpeg** on your PATH (extracts last frames, downscales reference images, builds the music loop)
- API keys for **MachGen** (video, images, music), **GMI Cloud** (LLM), and optionally **ElevenLabs**

## 2. Create `keys.json`

Create `keys.json` in the project root. It is gitignored: **never commit it**.

```json
{
  "machgen": "MGA_<key_id>:<secret>",
  "gmi": "<GMI Cloud API key (JWT starting with eyJ...)>",
  "elevenlabs": "sk_<ElevenLabs API key>"
}
```

| Key | Where to get it | Used for |
|---|---|---|
| `machgen` | machgen.ai → Profile → API Keys | MiniMax-H3 video clips, Nano Banana Pro images, Eleven-Music-v2 music |
| `gmi` | console.gmicloud.ai → API Keys | Gemini Flash LLM calls (diagnostic + shot writer) |
| `elevenlabs` | elevenlabs.io → Developers → API Keys | Optional: direct music generation (needs a paid plan) |

All three keys must be present, because the server imports `keys.json` at startup. Use a placeholder string for any key you don't have.

## 3. Install and start

```bash
bun install
```

```bash
bun run dev
```

Open **http://localhost:3000** and click **BEGIN**. Browsers only allow sound after a click, so music starts then.

## 4. Admin panel (gear icon, top right)

| Setting | What it does |
|---|---|
| **Success decided by** | `vibes` (the LLM judges creativity), `hybrid` (the LLM decides, guided by the numbers), or `dice` (server roll) |
| **General success probability** / **Creativity points (±)** | Used by `hybrid` and `dice` only |
| **Prompts till success** | Roughly how many successful steps until Larry can escape |
| **Live LLM (GMI)** | On by default. Off = mock responses (free), which also disables intent-key and Gemma matching in the action archive, leaving only near-identical wording as a cache hit |
| **No video generation (text only)** | On = shows the planned scene as text for 15s instead of a clip (free). Off = real MachGen clips (**spends credits**) |
| **Constant think** | On (default) = while waiting for the next action, always show the pre-made ultra macro "Larry thinking" loop; no per-step idle loop is generated. Off = generate a fresh 4s idle loop after each successful clip (~$0.14, ~9s) |
| **Analysis model** | LLM 1, "Analyzing escape plan": Gemini 3.1 Flash-Lite (~2s), Gemini 3.5 Flash-Lite (~2s, default), Gemini 3.8 Flash (~6s, deep reasoning) |
| **Shot writer model** | LLM 2, writes the H3 video prompt. Same options; Gemini 3.8 Flash gives richer shot lists |

## 5. Suggested test flow

1. **Free UI test:** Live LLM off, No video generation on. Type anything. "Grow wings" gets rejected; long, clever ideas succeed.
2. **LLM test:** turn **Live LLM on**. You get real judgments and shot lists as text. Costs fractions of a cent.
3. **Video test:** turn **No video generation off**. Each action now generates real clips:
   - Success: 15s R2V clip (~$0.75), plus a 4s idle loop (~$0.14) only if **Constant think** is off
   - Failure: 15s clip only ≈ **$0.75**
   - Watch the terminal: every MachGen submit logs its estimated cost.
4. Check your MachGen balance for free:
   ```bash
   bun -e "const k=require('./keys.json');fetch('https://api.machgen.ai/api/v0/billing/account',{headers:{Authorization:'Bearer '+k.machgen}}).then(r=>r.json()).then(b=>console.log('$'+(b.balance_micros/1e6).toFixed(2)))"
   ```

## 6. Debug history (☰ button, top right)

Every step is logged to `data/debug.sqlite` (gitignored): directions, both LLM calls (full prompts, JSON output, latency), the outcome decision, reference uploads, MachGen generations (request body, task timings, estimated cost), status changes and errors. Click a step to expand its events, and click an event to see its request and response.

Query it directly too:
```bash
bun -e "import {Database} from 'bun:sqlite'; console.table(new Database('data/debug.sqlite').query('SELECT kind,label,duration_ms,cost_usd FROM events ORDER BY id DESC LIMIT 20').all())"
```

If you leave or reload the page while a step is generating, the start button shows **RESUME** and picks the step back up. The server keeps generating either way.

## 7. Asset scripts (all spend credits)

| Command | Makes | Cost |
|---|---|---|
| `bun scripts/gen-image-machgen.ts <prompt.txt>...` | Nano Banana Pro PNG next to each prompt (skips existing PNGs) | ~$0.079/image |
| `bun scripts/gen-intro.ts intro keyframe\|video` | Looping 15s intro → `media/intro/intro.mp4` | ~$0.08 + ~$0.53 |
| `bun scripts/gen-intro.ts larry-thinking keyframe\|video` | Silent 4s "Larry thinking" idle loop | ~$0.08 + ~$0.14 |
| `bun scripts/gen-music.ts` | 30s seamless music loop → `media/music/loop.mp3` | ~$0.20 |

## 8. Downloads, credits and admin

- **Share your film:** the YOU FAILED and ESCAPED screens stitch the run into one MP4 (intro + every generated clip, background music underneath at 35%, steps without video skipped, cached per ending) and offer keyless shares:
  - One **SHARE** button, plus a `⋯` menu. On a phone (any browser that can put a file in the OS share sheet) the button opens the native sheet with the real MP4 attached — the only keyless route to Instagram and TikTok. On desktop it opens the menu instead.
  - The menu is a horizontal carousel of platform icons (mouse wheel scrolls it sideways) — six link composers, then Instagram/TikTok/YouTube marked ↓ because they need a manual upload — with Copy link and the two downloads as chips underneath.
  - The 9:16 cut is a second ffmpeg pass (720×1280, blurred fill), so it is only rendered when something asks for it: a phone share, an Instagram/TikTok save, or the 9:16 download. Desktop outcome screens only wait for the landscape stitch. It renders single-threaded with the blur done on a thumbnail-sized copy, because a 1080×1920 multi-threaded x264 encode gets OOM-killed on the deploy container.
  - Each ending gets a page at `/s/<nodeId>` with Open Graph and Twitter player tags, a poster frame and a player, plus a link back into the game. Social platforms must be able to fetch it, so links only work for real when the server is public (Railway); on localhost the UI says so.
- **Rewatch:** the outcome screens and the idle HUD have a rewatch control that replays the last clip and then re-runs the YOU FAILED / ESCAPED graphics with their normal timing.
- **Credits:** in the admin panel, enter the admin password (`hackathon`; only its SHA-256 hash is stored in `src/server/credits.ts`) to see:
  - **MachGen**: live balance from MachGen's billing API.
  - **GMI Cloud**: an **estimate**, because GMI's balance API only works with a console login: `GMI_BALANCE_BASELINE` (update it from the GMI console) minus the LLM spend logged since then.
- **Auto-pause:** when MachGen drops below **$10**, steps run without generating video and a small red banner tells players to notify the administrator.
- **Debug history** is scoped to your browser session: each tab session gets a new UUID, and ☰ only shows that session's steps.

## 9. Action archive (clip reuse)

Every generated step clip is saved to SQLite (`action_clips`), keyed by **the environment the viewer was in**, the
**outcome**, and the action. A later viewer trying the same thing there gets the saved clip instead of a paid generation.

A hit replays the whole decision, not just the video: the archived row carries the **verdict** (allowed or rejected),
the **outcome** (success / fail / escaped), the **fail type**, the **destination environment** and the story beat, so
**both LLM calls and the generation are skipped**. Rejections are archived too, so "grow wings" costs nothing the second
time. Note this makes repeats deterministic: the same action in the same room replays the archived result rather than
being re-judged.

Lookup order, cheapest first:

0. **Words / Gemma before LLM 1.** The archive is searched on the raw text first, so a known action never reaches the
   analysis or shot-writer calls at all.
1. **Intent key (indexed, instant).** After LLM 1 runs (only on a miss) it returns `intentKey`, a canonical
   `verb:tool:target:destination` (e.g. `pry:spoon:vent-grate:air-vents`). Differently worded attempts that mean the same
   thing produce the same key, so "jimmy the air duct cover open using my cutlery" matches "unscrew the vent with my
   spoon" with no extra call. Keys are normalised part by part, so spacing and punctuation don't split them.
2. **Word overlap.** Content words are compared (stopwords stripped, plurals folded); 0.75+ reuses immediately.
3. **Lite Gemma** (`google/gemma-4-26b-a4b-it`, ~$0.0005) judges the shortlist. When nothing scores well it still sweeps
   up to 6 clips from that location, which catches synonyms, **but only while that location holds ≤40 clips**; past that a
   weak score means a genuinely new idea.
4. **Miss?** Generate as normal and save it for the next viewer.

**Archive size:** each location keeps its 30 most-reused clips per outcome; older unused rows are pruned on save. Rows
only, the mp4 files stay in the clip cache.

**Admin:** *Reuse archived actions* turns the whole thing off. *Display whether video is freshly generated or cached*
(off by default) shows a **CACHED** or **GENERATED** badge in the top-left while a step plays. The credits section shows
archive size, reuse count and the generation cost skipped. Every hit and miss is logged to the debug drawer.

## 9. Deploying (Railway, Docker)

The app needs a long-running server, ffmpeg and a disk, so it deploys as a Docker container. Serverless platforms like Vercel don't fit.

1. **Commit and push** everything, including `Dockerfile`, `.dockerignore` and `railway.json`. Generated assets in `common-generated-assets/` and `media/intro`, `media/music` must be committed.
2. On **railway.com**: *New Project → Deploy from GitHub repo* → pick this repo. Railway builds the `Dockerfile` automatically.
3. **Add a volume** to the service, mounted at **`/data`**. Generated clips, exports, settings and the debug DB are stored there (`STORAGE_DIR=/data` is set in the Dockerfile).
4. **Variables** (Service → Variables):
   | Variable | Value |
   |---|---|
   | `MACHGEN_API_KEY` | your MachGen key |
   | `GMI_API_KEY` | your GMI key |
   | `ELEVENLABS_API_KEY` | optional |
5. **Networking → Generate Domain** to get a public URL. Railway sets `PORT` for you.
6. Open the site, then in the admin panel decide whether to turn off **No video generation**. Settings live on the volume, so changing a default in `config.ts` does not move an instance that already has a settings file — `PUT /api/settings` or the admin panel does.

Local production-mode check (no Docker needed):
```bash
NODE_ENV=production STORAGE_DIR=./.prod-data PORT=3099 bun src/index.ts
```

## 10. Where things live

- `master-plan.md`: the full design and TODOs
- `data/world.json`: style rules, characters, environments (with image paths), map adjacency
- `asset-personalities/`: per-character and per-environment gameplay notes
- `common-generated-assets/`: every prompt `.txt` with its generated `.png` / `.mp4` / `.mp3` next to it
- `hyperframes/`: live HTML/GSAP overlays (title, intro title, prompt, failed, escaped)
- `media/cache/`: generated step clips and uploaded reference JPEGs (gitignored)
