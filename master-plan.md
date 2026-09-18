# Escape from Slop Prison: Master Plan

Live interactive AI film built at the Multimodal Society AI Filmmaking Hackathon (Sep 13, 2026). Developer track.
**Submissions close 5:30 PM PT** (the guide also says 5:00, so aim for 5:00). Live demos start around 5:15 PM, 3:30 max. Show the sponsor tools in the demo.

The viewer watches a prisoner try to escape. After every clip the camera settles on the protagonist's face and asks
**"What should the protagonist do next?"** The viewer types an action. Two LLM calls judge it and write the next shot,
and MiniMax H3 Max (on fal.ai) generates it in roughly 7 seconds. A good idea gets you closer to the exit. A bad roll gets you re-detained or killed.

---

## 1. Stack

| Piece | Provider | Notes |
|---|---|---|
| Web app | Bun (`bun run dev`) | `server.ts` + static `public/`. No framework. |
| Video | **fal.ai** `minimax/h3-max-turbo` (default), references packed into a labeled first-frame sheet that is trimmed off; $0.0125/s at 480P until Sept 30 ($0.025/s after), ~4s per 15s clip |
| Video (references) | **fal.ai** `minimax/h3-max` | MiniMax H3 **Max** at 480P, $0.05/sec: a 15s step clip is **$0.75**. Measured on a 15s reference-to-video step: **9.2s** from submit to saved file (1.1s queue, 6.3s generating). The clip starts playing from fal's CDN as soon as it is ready. Prompt expansion disabled. |
| Video (fallbacks) | **MachGen** `MiniMax-H3`, then **GMI Cloud** `MiniMax-H3` | Default provider is the first with a key: fal → MachGen → GMI. MachGen: H3 480p, $0.75 R2V / $0.525 I2V per 15s, 13-30s. GMI: 768P minimum (no 480p, no H3 Max), $1.20 per 15s, ~4.5 min. |
| LLM | **GMI Cloud** `google/gemini-3.5-flash-lite` | OpenAI-compatible, `https://api.gmi-serving.com/v1`. ~$0.001/call, ~2s. Archive matching uses `google/gemma-4-26b-a4b-it`. |
| Character/environment art | **GMI Cloud** `gemini-3-pro-image` (Nano Banana Pro) | TODO: confirm whether a "Nano Banana 3 Pro" ID exists. Request-queue API. |
| Motion graphics | **HyperFrames** (HeyGen) | Kept as live HTML5 + GSAP overlays, not rendered MP4s. See `hyperframes/`. |
| Music | TODO (ElevenLabs Music, or MachGen `Eleven-Music-v2`) | One seamless background loop. |

Keys live in `keys.json` (gitignored): `fal`, `machgen`, `gmi`, plus Google sign-in and analytics. The full list is in `testing yourself.md`.

**Cost guard:** the admin panel has **Live LLM** and **Live Video** toggles. Both default to **off**. While off, the app uses
mock LLM responses and the placeholder clip, so UI work spends nothing.

---

## 2. Experience flow

```
[Start screen: HyperFrames "ESCAPE FROM SLOP PRISON" title] → click Start (unmutes, starts music)
      ↓
[Intro master video: multi-shot prison establishing + protagonist close-ups]
      ↓
[Idle loop: close-up on protagonist's face, organic motion]  +  HyperFrames "What should the protagonist do next?"
      ↓  viewer types direction in the bottom prompt bar
[LLM 1: Diagnostic] ── rejected → toast "try again" (reason), stay on idle loop
      ↓ allowed
[Success/fail decided by the admin's outcome mode: vibes (LLM) · hybrid (LLM + numbers) · dice (server roll)]
      ↓
[LLM 2: Shot writer] → H3 prompt + reference selection
      ↓
[H3 clip: the action plays out, ends on a close-up of the protagonist]
      ├─ success → [H3 idle loop from that last frame] → prompt again (depth + 1)
      ├─ success & near the exit → ESCAPED ending (HyperFrames "ESCAPED")
      └─ fail (re-detained or dead) → HyperFrames "YOU FAILED"
                                        [Try again from last step] [Try again from beginning]
```

### Idle loop (no freeze frames)
Instead of pausing on the clip's last frame, every successful clip is followed by a second H3 generation:
- LLM 2 is told the clip must **end on a close-up of the protagonist's face**.
- The server pulls the last frame (ffmpeg), sends it to the video provider, and runs `I2V` with that same image as both the first
  and last frame (`keyframe_indices: [0, -1]`). The result loops seamlessly.
- Prompt: breathing, blinking, eyes darting, flickering practical light, near-static camera.
- The browser plays it with `loop`.

That makes each successful step **15s clip + 4s loop ≈ $0.67**, and a failure step **≈ $0.53**. $100 covers roughly 150 steps.

---

## 3. Admin panel (gear icon, top right)

| Setting | Range | Meaning |
|---|---|---|
| **Success decided by** | vibes / hybrid / dice | Who decides success (see below). Default **vibes**. |
| **General success probability** | 0–100 | Baseline chance a valid direction advances the story (hybrid and dice only). |
| **Creativity points (±)** | 0, 5, 10, 15, 20, 25, 30, 40, 50 | Max points creativity adds (brilliant idea) or removes (lazy idea) from the chance (hybrid and dice only). |
| **Prompts till success** | 1–20 | Rough number of successful steps before the exit is reachable. Not exact. |
| Live LLM | on/off | Off = mock diagnostic/writer responses. |
| **No video generation** | on/off (default on) | Text-only testing: after the LLM calls, the scene summary and shot list show for 15s in place of the clip, then the outcome plays (YOU FAILED overlay, escape, or back to the prompt). Turn off to spend video-provider credits on real clips. |
| LLM model | dropdown | Default `google/gemini-3.5-flash-lite` for both the analysis and the shot writer. |

The panel also shows the last diagnosis (innovation score, computed chance, roll) for tuning.

### Outcome modes
LLM 1 always scores the direction's **innovation 0–100**. Then:

| Mode | Who decides | Uses probability + creativity points? |
|---|---|---|
| **vibes** (default) | LLM 1, purely on creativity, cleverness and plausibility in context | No, ignored |
| **hybrid** | LLM 1, given the probability and creativity points as a rough guide it may overrule | Partially |
| **dice** | Server roll | Yes, strictly |

The chance used by hybrid (as a guide) and dice (as the roll target):
```
chance = clamp(base + ((innovation − 50) / 50) × creativityPoints, 0, 100)   // base 0 → always fail, 100 → always succeed
dice:    success = random() × 100 < chance
```
Example: base 60, creativity ±30 → innovation 95 gives 87, innovation 29 gives 47.
In vibes and hybrid, LLM 1 returns `succeeds` and `verdictReason`, which appear in the admin debug readout.
Exit proximity = `depth / promptsTillSuccess`. A success is the **final escape** when `depth + 1 ≥ promptsTillSuccess`,
or when LLM 1 says the action plausibly reaches the exit and `depth + 1 ≥ 0.75 × promptsTillSuccess`.

---

## 4. LLM calls

Both go to GMI with JSON output. Both get the style bible, shot rules, world catalog, and the story so far.

### LLM 1: Diagnostic
Input: direction text, story log, current environment, depth, promptsTillSuccess, success probability.
Rejects anything:
- **Mythical / impossible:** grow wings, teleport, superpowers, magic.
- **Outside the protagonist's agency:** "a portal opens", "the guards decide to let him out", "an earthquake frees him".
- Off-topic, or unsafe for a public demo.

Output:
```json
{ "allowed": true, "rejectionReason": "", "innovation": 72, "innovationNote": "...",
  "successBeat": "what happens if it works", "failBeat": "what happens if it goes wrong",
  "failType": "redetained | dead", "reachesExit": false }
```

### LLM 2: Shot writer
Input: the rolled outcome and its beat, plus everything above.
Output:
```json
{ "shotPrompt": "multi-shot H3 prompt, ends on protagonist close-up", "environmentId": "hall-b",
  "characterIds": ["protagonist", "guard-03"], "summary": "one sentence for the story log",
  "loopPrompt": "idle close-up loop prompt" }
```
### Reference image budget (max 9 per H3 request)
The server fills the 9 slots in priority order:
1. **Environment plate** for `environmentId`. **Always included.**
2. **Protagonist** character sheet.
3. **Previous clip's last frame**, for continuity (when one exists).
4. **Other characters**, in the writer's ranked `characterIds` order, until all 9 slots are used.

The prompt is prefixed with a legend ("Image 1: environment plate of kitchen. Image 2: …") so H3 knows what each reference is.
- **Refs exist:** `R2V` with the selected references.
- **No refs yet** (assets still TODO): `I2V` from the previous last frame, or `T2V` for the first step.

---

## 5. Style bible (applies to every generation)

- **Look:** anime, 12 fps feel (limited animation, held poses, snappy key poses), dynamic camera and action.
- **Grade:** warm orange and teal. Sodium-vapor orange practicals against cool teal shadows.
- **Mood:** tense prison-break thriller with spy-film energy. Red/blue police light accents during alarms.
- **Protagonist:** visually distinct. **Red jumpsuit**; every other prisoner wears orange.

## 6. Shot rules

- Valid shot types: **wide, medium, close-up, macro**. Use a variety in every clip, never the same type twice in a row.
- **Fast cuts every 2–4 seconds** (about 5–6 shots per 15s clip). More action in less time.
- The writer outputs a timestamped shot list ("Shot 1 (0–3s, wide, slow push): …").
- Respect the **rule of thirds**, use **leading lines** (bars, corridors, pipes, catwalks), and keep **eyelines** consistent across cuts.
- Every successful step clip **ends on a close-up of the protagonist's face** so the idle loop can pick up from it.
- 480p, 16:9. Step clips 15s, idle loops 4s.

---

## 7. World catalog

Source of truth: `data/world.json`, which the LLMs read. Image paths fill in as assets get generated.

### Characters (TODO: generate character sheets, see `docs/character-sheet-prompts.md`)
- [ ] `protagonist`: red jumpsuit, visually distinct hero
- [ ] `guard-01` … `guard-10`: 10 unique guards
- [ ] `prisoner-01` … `prisoner-10`: 10 unique prisoners (orange jumpsuits)

### Environments (TODO: generate ~20, each a traversable node with neighbors)
- [ ] `cell-block-a`: protagonist's cell (start)
- [ ] `cell-block-tier`: upper tier catwalk
- [ ] `hall-main`: main corridor
- [ ] `cafeteria`
- [ ] `kitchen`
- [ ] `laundry`
- [ ] `yard`
- [ ] `workshop`
- [ ] `infirmary`
- [ ] `library`
- [ ] `showers`
- [ ] `solitary`
- [ ] `visitation`
- [ ] `guard-station`: monitors and keys
- [ ] `warden-office`
- [ ] `air-vents`: obscure path
- [ ] `utility-tunnels`: pipes and steam
- [ ] `sewer-drain`: obscure path
- [ ] `rooftop`
- [ ] `guard-tower`: Hawk's sniper cabin, searchlight, catwalk over the fence
- [ ] `perimeter-fence`: double razor-wire fence and searchlights
- [ ] `loading-dock`: delivery trucks (exit candidate)

Adjacency lives in `data/world.json` so the writer keeps routes plausible (e.g. kitchen → loading-dock, showers → utility-tunnels → sewer-drain).

---

### Asset folders
- `common-generated-assets/characters/*.txt` and `common-generated-assets/environments/*.txt`: image-generation prompts (awaiting validation).
  Naming: `sloppy-joe-protagonist`, `guard1`…`guard10`, `prisoner1`…`prisoner10`, and environment ids.
- `asset-personalities/characters/*.md` and `asset-personalities/environments/*.md`: gameplay notes the LLMs will reference.
  Characters list personality, wants, weakness, locations, how they help, how Sloppy Joe can win them over, danger and voice.
  Environments list security, steps to the nearest exit, guards and inmates present, items, hazards, ways in and out,
  high-innovation ideas, and what gets Sloppy Joe caught.
- [ ] Wire `asset-personalities` into the LLM 1 and LLM 2 context (current environment + neighbors + characters present).

## 8. TODOs

### Assets
- [ ] **Character sheets** (Nano Banana Pro on GMI): protagonist, 10 guards, 10 prisoners. Prompts in `docs/character-sheet-prompts.md`.
- [ ] **Environment plates** (Nano Banana Pro): the 21 locations above, same style bible, empty of people.
- [ ] **Intro master video**: prompts in `common-generated-assets/videos/intro-keyframe.txt` and `intro.txt`, generated by `scripts/gen-intro.ts`.
  - Step 1: Nano Banana Pro keyframe of Sloppy Joe in his cell, built from his sheet and the cell image.
  - Step 2: MiniMax-H3 image-to-video, 15s, 480p, `EXPRESS`, with the keyframe as both first and last frame, so it loops seamlessly.
  - It has 7 fast cuts: Sloppy Joe close-up → top-down aerial of the prison → guard tower → sergeant in the hall → inmates on the tier → spoon on the vent → back to Sloppy Joe.
  - No typography in the video: "ESCAPE FROM SLOP PRISON" is the `intro-title` HyperFrames overlay, and the prompt bar reads "Sloppy Joe's in his cell. What should Sloppy Joe do?".
  - The intro doubles as the idle loop at the start, since it loops.
- [ ] **Background music**: seamless loop, tense spy/anime score at `media/music/loop.mp3`. Generate later (ElevenLabs).

### HyperFrames (iterate via the HyperFrames MCP)
Setup: `.mcp.json` registers the hosted server `https://mcp.heygen.com/mcp/hyperframes/`. Sign in with HeyGen on first use.
Optional local skills: `npx skills add heygen-com/hyperframes` (pick "Core Skills"). Node 24 is installed; 22+ required.
Compositions live in `hyperframes/<name>/index.html`. Each registers a paused GSAP timeline on `window.__timelines[name]`,
and `src/client/HyperFrame.tsx` embeds it in an iframe, fills `data-bind` text, and calls `restart()`.
Open one directly (e.g. `/hyperframes/title/index.html`) to preview it autoplaying.

- [x] `title`: "ESCAPE FROM SLOP PRISON" spy HUD, red/blue police sweep (first draft)
- [x] `prompt`: "What should the protagonist do next?" (first draft)
- [x] `failed`: "YOU FAILED" with a re-detained/dead subtitle (first draft)
- [x] `escaped`: win card (first draft)
- [ ] `loading`: "analyzing escape plan…" HUD while the LLM and H3 run
- [ ] Polish all of the above with the HyperFrames MCP; keep them as live HTML (no render)

### App
- [x] Bun server, admin panel, prompt bar, pipeline skeleton with mock modes
- [ ] First live LLM run (ask before running)
- [ ] First live end-to-end step (ask before generating)
- [ ] Verify the MachGen `/api/v0/upload` response shape (used for last-frame uploads)
- [ ] **Dialogue and sound references** (idea, maybe needed). H3 R2V accepts up to 3 reference audio clips (audio can't be sent alone), so options are:
  - A **voice reference per speaking character** (ElevenLabs voice design → short sample) so the protagonist and key guards sound consistent.
  - The writer adds short **dialogue lines** per shot, and H3 generates them with native audio using the voice refs.
  - Or generate dialogue and SFX separately with ElevenLabs (TTS / Sound Effects) and mix it over the clip. More control, more latency.
  - Budget note: audio refs don't take image slots (max 9 images, max 3 audio).
  - The user may set up an ElevenLabs account (Creator plan credits from the hackathon). MachGen also hosts `Eleven-v3` (T2S/T2D) and `Eleven-Music-v2`.
- [ ] ElevenLabs narration or SFX per step? (Best use of ElevenLabs prize)
- [ ] Tripo3D usage? (e.g. 3D prison map in the admin view or HUD)

### Submission
- [ ] Demo video on YouTube (unlisted), GitHub link, hosted link
- [ ] Tag @multimodalsoc @gmi_cloud @MachgenAI @magnific @ElevenLabs @tripoai on X
