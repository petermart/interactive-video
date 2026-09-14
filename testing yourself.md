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
| **Live LLM (GMI)** | Off = mock responses (free). On = real Gemini calls (~$0.001 each) |
| **No video generation (text only)** | On = shows the planned scene as text for 15s instead of a clip (free). Off = real MachGen clips (**spends credits**) |
| **LLM model** | GMI model ID, default `google/gemini-3.8-flash` |

## 5. Suggested test flow

1. **Free UI test:** Live LLM off, No video generation on. Type anything. "Grow wings" gets rejected; long, clever ideas succeed.
2. **LLM test:** turn **Live LLM on**. You get real judgments and shot lists as text. Costs fractions of a cent.
3. **Video test:** turn **No video generation off**. Each action now generates real clips:
   - Success: 15s R2V clip (~$0.75) + 4s idle loop (~$0.14) ≈ **$0.89**
   - Failure: 15s clip only ≈ **$0.75**
   - Watch the terminal: every MachGen submit logs its estimated cost.
4. Check your MachGen balance for free:
   ```bash
   bun -e "const k=require('./keys.json');fetch('https://api.machgen.ai/api/v0/billing/account',{headers:{Authorization:'Bearer '+k.machgen}}).then(r=>r.json()).then(b=>console.log('$'+(b.balance_micros/1e6).toFixed(2)))"
   ```

## 6. Asset scripts (all spend credits)

| Command | Makes | Cost |
|---|---|---|
| `bun scripts/gen-image-machgen.ts <prompt.txt>...` | Nano Banana Pro PNG next to each prompt (skips existing PNGs) | ~$0.079/image |
| `bun scripts/gen-intro.ts intro keyframe\|video` | Looping 15s intro → `media/intro/intro.mp4` | ~$0.08 + ~$0.53 |
| `bun scripts/gen-intro.ts larry-thinking keyframe\|video` | Silent 4s "Larry thinking" idle loop | ~$0.08 + ~$0.14 |
| `bun scripts/gen-music.ts` | 30s seamless music loop → `media/music/loop.mp3` | ~$0.20 |

## 7. Where things live

- `master-plan.md`: the full design and TODOs
- `data/world.json`: style rules, characters, environments (with image paths), map adjacency
- `asset-personalities/`: per-character and per-environment gameplay notes
- `common-generated-assets/`: every prompt `.txt` with its generated `.png` / `.mp4` / `.mp3` next to it
- `hyperframes/`: live HTML/GSAP overlays (title, intro title, prompt, failed, escaped)
- `media/cache/`: generated step clips and uploaded reference JPEGs (gitignored)
