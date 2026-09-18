# Testing Escape from Slop Prison yourself

## 1. Requirements

- **Bun** 1.3+: https://bun.sh
- **ffmpeg** on your PATH (extracts last frames, downscales reference images, builds the music loop)
- API keys: **at least one video provider** (fal, MachGen or GMI Cloud) and **GMI Cloud** for the LLM calls. Everything
  else is optional. The full list is in the table below.

## 2. Keys: `keys.json` locally, environment variables in deployment

Create `keys.json` in the project root. It is gitignored: **never commit it**. Environment variables override it, which is
how the deployment gets them. R2 credentials are the exception: they only come from environment variables, so locally
they go in a `.env` file (also gitignored; Bun loads it automatically).

```json
{
  "fal": "<fal.ai API key>",
  "machgen": "MGA_<key_id>:<secret>",
  "gmi": "<GMI Cloud API key (JWT starting with eyJ...)>",
  "googleClientId": "<id>.apps.googleusercontent.com",
  "googleClientSecret": "GOCSPX-...",
  "cfAnalyticsToken": "<Cloudflare Web Analytics token>",
  "elevenlabs": "sk_<optional>",
  "masky": "<optional>"
}
```

**Every key the project uses:**

| keys.json | Environment variable | Needed? | Where to get it | Used for |
|---|---|---|---|---|
| `fal` | `FAL_KEY` (or `FAL_API_KEY`) | one video provider | fal.ai → Dashboard → Keys | Step clips: MiniMax H3 Max 480P (**preferred provider**) |
| `falAdmin` | `FAL_ADMIN_KEY` | optional | fal.ai → Dashboard → Keys → new key with **Admin** scope | Reads the fal credit balance (admin credits card, $10 auto-pause for fal). A normal fal key can't |
| `machgen` | `MACHGEN_API_KEY` | one video provider | machgen.ai → Profile → API Keys | Step clips: H3 480p (2nd choice); `gen-image-machgen.ts`, `gen-music.ts` |
| `gmi` | `GMI_API_KEY` | **yes** | console.gmicloud.ai → API Keys | LLM calls (diagnostic, shot writer, archive match); H3 768P (3rd choice); `gen-image-gmi.ts`, `gen-intro.ts` |
| `googleClientId` / `googleClientSecret` | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Google sign-in | console.cloud.google.com → APIs & Services → Credentials → OAuth client ID (Web) | "Continue with Google" |
| `cfAnalyticsToken` | `CF_ANALYTICS_TOKEN` | optional | dash.cloudflare.com → Analytics & Logs → Web Analytics | Visitor analytics beacon |
| — | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | deployment: **yes**; local: for GMI refs / archive restore | dash.cloudflare.com → R2 → Manage API Tokens (**Object Read & Write**, bucket `slop-prison-media`) | Generated media, archive backups |
| — | `ADMIN_PASSWORD` | deployment: **yes** | you choose | Unlocks the admin panel (falls back to a public default when unset) |
| — | `AUTH_SECRET` | deployment: **yes** | `openssl rand -base64 32` | Signs sessions and guest cookies |
| `elevenlabs` | `ELEVENLABS_API_KEY` | optional | elevenlabs.io → Developers → API Keys | Direct music generation (paid plan) |
| `masky` | `MASKY_API_KEY` | optional | masky.ai | Masky video provider (off in deployment) |

**Video provider preference:** the default is the first provider with a key: **fal → MachGen → GMI**. The admin panel
only offers providers that have a key on that server.

**Google sign-in:** add both redirect URIs to the OAuth client in the Google console:
`https://prison-escape-production.up.railway.app/api/auth/callback/google` and `http://localhost:3000/api/auth/callback/google`.
Email + password sign-up is always on (Better Auth, passwords hashed). There is no email service yet, so addresses are not
verified and there is no password-reset email.

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
| **Prompts till success** | Roughly how many successful steps until Sloppy Joe can escape |
| **Live LLM (GMI)** | On by default. Off = mock responses (free), which also disables intent-key and Gemma matching in the action archive, leaving only near-identical wording as a cache hit |
| **No video generation (text only)** | On = shows the planned scene as text for 15s instead of a clip (free). Off = real MachGen clips (**spends credits**) |
| **Constant think** | On (default) = while waiting for the next action, always show the pre-made ultra macro "Sloppy Joe thinking" loop; no per-step idle loop is generated. Off = generate a fresh 4s idle loop after each successful clip (~$0.14, ~9s) |
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
| `bun scripts/gen-image-gmi.ts [--ref img.png ...] <prompt.txt>...` | Nano Banana Pro (`gemini-3-pro-image`) PNG next to each prompt on GMI, optional reference images (skips existing PNGs) | ~$0.134/image |
| `bun scripts/gen-image-machgen.ts <prompt.txt>...` | Same on MachGen (kept as a fallback) | ~$0.079/image |
| `bun scripts/gen-intro.ts intro keyframe\|video` | Looping 15s intro → `media/intro/intro.mp4` (GMI, 768P) | ~$0.13 + $1.20 |
| `bun scripts/gen-intro.ts sloppy-joe-thinking keyframe\|video` | Silent 4s "Sloppy Joe thinking" idle loop (GMI, 768P) | ~$0.13 + $0.32 |

GMI takes reference images as **public URLs only**, so the GMI scripts publish them to R2 first: fill in the `R2_*`
variables in `.env` on the machine you run them from.
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
  - **GMI Cloud**: an **estimate**, because GMI's balance API only works with a console login: `GMI_BALANCE_BASELINE` (update it from the GMI console) minus the video spend (durable `gmi_spend` ledger, never pruned) and the LLM spend logged since then.
  - **Players**: unique players, directions, paid generations per player and archive reuse rate, with a full report (per day, distribution, top players) one click away. A player is a signed-in account, else the one-year guest cookie; steps from before attribution existed only know their browser tab, so those over-count people.
- **Auto-pause:** when the active video provider drops below **$10** (MachGen: live balance; GMI: the estimate above), steps run without generating video and a small red banner tells players to notify the administrator.

## Video provider

**fal.ai H3 Max is the default** (admin panel → *Video provider*). Measured on one 15s reference-to-video step:

| Provider | Model | Resolution | 15s step | Submit → saved |
|---|---|---|---|---|
| **fal** (default) | MiniMax H3 **Max** | 480P | $0.75 (+~$0.02 refs) | **9.2s** |
| MachGen | MiniMax H3 | 480p | $0.75 R2V / $0.525 I2V | 13-30s |
| GMI Cloud | MiniMax H3 | 768P minimum | $1.20 | ~274s |

- **fal** sends reference images inline (1024px JPEG data URIs, built once per server run), so nothing is uploaded first.
  They are kept at 1024px because fal bills references above 4,096 tokens; nine 1600px sheets would add ~$0.17 a step.
  Prompt expansion is disabled. fal has no balance API, so the $10 auto-pause does not apply to it: watch the fal
  dashboard. Key: `fal` in `keys.json`, or `FAL_KEY` / `FAL_API_KEY`.
- **The clip plays before it is stored.** fal returns its CDN link the moment the clip is ready and the player starts
  watching it; the download, the copy to R2, the last-frame extraction and the archive entry happen in the
  background. The next step, per-step idle loops and film exports wait for that to finish, which it almost always
  has by then (it takes ~2-4s and the clip is 15s long). If it fails, the CDN link keeps playing and the step is just
  not archived.
- **GMI** (768P only, no H3 Max, no 480p) and **MachGen** stay selectable. GMI fetches references by URL, so they go to
  R2 once (`refs/…`) and are passed as signed URLs.

**Step speed-ups:** LLM 1 now starts at the same time as the archive lookup instead of after it (a hit discards it,
~$0.0005 wasted), and the Gemma archive match gives up after 4s and counts as a miss.

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

**Archive size:** each location keeps its 50 most-reused clips per outcome; older unused rows are pruned on save, and the
pruned clip's video is deleted from R2 with it.

**Backups:** the rows live in SQLite on the deploy volume, which survives redeploys but not the volume or service being
deleted. So the deployment also writes the whole table to R2 as `backups/action_clips.json` (15s after any change, on
boot, and daily, plus a dated `backups/action_clips-YYYY-MM-DD.json` per day). On boot, **an empty archive restores
itself from that backup** — a fresh volume, or a laptop with the R2 variables in `.env`, starts from production's
library. Only the deployment writes backups (`ARCHIVE_BACKUP=0` opts it out; `ARCHIVE_BACKUP=1` opts another host in), so
a local experiment can never overwrite production's copy.

**Admin:** *Reuse archived actions* turns the whole thing off. *Display whether video is freshly generated or cached*
(off by default) shows a **CACHED** or **GENERATED** badge in the top-left while a step plays. The credits section shows
archive size, reuse count and the generation cost skipped. Every hit and miss is logged to the debug drawer.

## 9. Deploying (Railway, Docker)

The app needs a long-running server, ffmpeg and a disk, so it deploys as a Docker container. Serverless platforms like Vercel don't fit.

1. **Commit and push** everything, including `Dockerfile`, `.dockerignore` and `railway.json`. Generated assets in `common-generated-assets/` and `media/intro`, `media/music` must be committed.
2. On **railway.com**: *New Project → Deploy from GitHub repo* → pick this repo. Railway builds the `Dockerfile` automatically.
3. **Add a volume** to the service, mounted at **`/data`**. Generated clips, exports, settings and the debug DB are stored there (`STORAGE_DIR=/data` is set in the Dockerfile).
4. **Variables** (Service → Variables). Every key from the table in section 2, as environment variables:
   | Variable | Required |
   |---|---|
   | `FAL_KEY` | yes (or `MACHGEN_API_KEY` / GMI as the video provider) |
   | `MACHGEN_API_KEY` | fallback video provider |
   | `GMI_API_KEY` | yes (LLM calls) |
   | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | yes (media + archive backups) |
   | `ADMIN_PASSWORD` | yes |
   | `AUTH_SECRET` | yes |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in |
   | `CF_ANALYTICS_TOKEN` | for analytics |
   | `ELEVENLABS_API_KEY` | optional |

   Changing a variable with the CLI redeploys unless you pass `--skip-deploys`.
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
