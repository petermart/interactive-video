# Character Sheet Prompts (brainstorm)

Target model: **Nano Banana Pro** (`gemini-3-pro-image` on GMI). Confirm whether a "Nano Banana 3 Pro" ID exists.
Output: one 16:9 character sheet per character. Save to `media/assets/characters/<id>.png` and set `image` in `data/world.json`.

Sheets are **H3 reference images** (max 9 per clip), so every sheet must read clearly at a glance:
one character, neutral background, consistent lighting, no text clutter.

---

## Shared style block (prepend to every character prompt)

> Anime character reference sheet, 16:9, clean flat mid-grey background. Modern cinematic anime style with bold clean
> line art, cel shading with two-tone shadows, expressive eyes, and slightly exaggerated proportions for dynamic posing,
> designed for limited 12 fps animation. Warm orange rim light from the left, cool teal fill shadow from the right.
> Layout: full-body front view, 3/4 view, and back view in a row; on the right, a column of 3 head close-ups
> (neutral, determined, shocked); bottom strip with 3 small detail callouts (hands, shoes, a signature prop).
> Same character, same outfit and colors in every view. No text labels, no watermark, no other characters.

---

## Hero

### `protagonist`
> A lean, wiry man in his late 20s with sharp, determined amber eyes, messy jet-black hair falling over his forehead,
> and a thin pale scar cutting through his left eyebrow. He wears a **bright crimson-red prison jumpsuit**, the only red
> jumpsuit in the prison, with the top half unzipped and the sleeves tied around his waist over a fitted charcoal tank top.
> Taped wrists, scuffed white slip-on prison shoes, stencil number "4471" on the back of the jumpsuit.
> Signature prop: a bent spoon sharpened into a tool. Posture: coiled, alert, ready to run.
> Expressions: calculating smirk, gritted-teeth determination, wide-eyed alarm.

*Why he pops: red vs. everyone's orange, the scar, and the sleeves-tied silhouette read even in a wide shot.*

---

## Guards (navy uniforms, badges, radios; each has a unique silhouette)

### `guard-01`: The Sergeant
> A towering, broad-shouldered veteran prison sergeant in his 50s with a grey buzz cut, thick walrus mustache and heavy
> brow. Navy uniform stretched tight, sergeant stripes, heavy black baton on his belt, polished boots.
> Signature prop: baton tapped against his palm. Expressions: stone-faced glare, bellowing, rare grim nod.

### `guard-02`: The Rookie
> A skinny, nervous rookie guard in his early 20s with an oversized cap sliding down his forehead, freckles, and big
> anxious eyes. A slightly too-large navy uniform, a clipboard clutched to his chest, a whistle on a lanyard.
> Expressions: startled, trying to look tough, panicked.

### `guard-03`: The Lieutenant
> A stern woman lieutenant in her 40s with a tight black bun, sharp cheekbones and mirrored aviator sunglasses.
> A crisp navy uniform with lieutenant bars and a shoulder radio. Signature prop: a radio handset raised to her mouth.
> Expressions: unreadable, eyebrow raised, commanding shout.

### `guard-04`: The Key Keeper
> A heavyset, jolly-looking guard in his 40s with rosy cheeks and a double chin, and a huge jangling ring of brass keys
> on his belt. A navy uniform with donut crumbs and a coffee stain. Expressions: sleepy yawn, suspicious squint, huffing after a run.

### `guard-05`: The Tower Sniper
> A silent watchtower sniper wearing a black balaclava, a helmet with flipped-up night-vision goggles, a tactical vest
> over a navy uniform, and a long scoped rifle slung across the back. Only the eyes are visible and cold.
> Expressions: eyes narrowed through a scope, head tilt, alert.

### `guard-06`: The K-9 Handler
> A rugged K-9 handler in her 30s with a short undercut and a tactical cap, in navy cargo pants and a padded bite-sleeve
> on one arm. A **German shepherd** on a short leash sits at her side (include the dog in all views).
> Expressions: whistle command, focused, grinning at the dog.

### `guard-07`: The Control Room Watcher
> A wiry, paranoid control-room guard in his 30s with slicked hair, dark circles, a headset with a mic, and thick glasses
> reflecting glowing CCTV monitors. A navy uniform with rolled sleeves and an energy drink in hand.
> Expressions: squinting at a screen, jumpy, smug.

### `guard-08`: The Riot Brute
> A massive bald riot-squad officer in full black tactical armor, a scratched helmet with the visor up, a riot shield
> and a stun baton. A thick neck and a scar across the scalp.
> Expressions: snarl, emotionless, charging roar.

### `guard-09`: The Warden's Right Hand
> An older, elegant officer in his 60s with slicked silver hair, a trimmed goatee and a cold thin smile. A crisp navy
> dress uniform with gold trim, white gloves and a ceremonial peaked cap. Signature prop: a pocket watch.
> Expressions: polite menace, disappointed, rare fury.

### `guard-10`: The Night Shift
> A lanky, exhausted night-shift guard in his 30s with messy hair, heavy eye bags and stubble. A wrinkled navy uniform,
> a long flashlight and a dented coffee thermos. Expressions: half-asleep, flashlight sweep squint, jolted awake.

---

## Prisoners (standard ORANGE jumpsuits; never red)

### `prisoner-01`: The Gentle Giant
> A massive tattooed lifer in his 40s with a braided grey-streaked beard, a shaved head and calm, gentle eyes.
> An orange jumpsuit with sleeves ripped off to show sleeve tattoos. Signature prop: a tiny paperback book in huge hands.
> Expressions: serene, protective frown, warm laugh.

### `prisoner-02`: The Hacker Kid
> A skinny tech-savvy kid, around 19, with taped-together glasses, a wild curly afro and restless fidgety hands.
> An oversized orange jumpsuit with pockets full of wires and a contraband calculator.
> Expressions: excited grin, nervous glance, genius eureka.

### `prisoner-03`: The Old Con Man
> A charming old con man in his 70s with slicked-back white hair, a gold tooth and twinkling eyes.
> A neatly pressed orange jumpsuit with a folded handkerchief tucked in. Signature prop: a deck of cards mid-shuffle.
> Expressions: sly wink, feigned innocence, conspiratorial whisper.

### `prisoner-04`: The Boxer
> A muscular boxer in his 30s with a flattened nose, cauliflower ears, a cornrows hairstyle and taped knuckles.
> An orange jumpsuit tied at the waist over a sweat-stained white tank top.
> Expressions: guard up, cocky smirk, bloodied determination.

### `prisoner-05`: The Artist
> A quiet artist in her 30s with long dreadlocks tied back with a strip of cloth and paint-stained fingers.
> An orange jumpsuit covered in colorful paint smudges. Signature prop: a charcoal stick and a folded prison map sketch.
> Expressions: dreamy, intense focus, knowing half-smile.

### `prisoner-06`: The Smuggler
> A twitchy, rat-like smuggler in his 40s with a shaved head, shifty eyes and a pencil mustache. An orange jumpsuit with
> dozens of hidden pockets sewn inside, contraband peeking out (cigarettes, candy, a small screwdriver).
> Expressions: shifty look over the shoulder, greedy grin, panicked.

### `prisoner-07`: The Ex-Soldier
> A stoic ex-soldier in his 50s with a grey crew cut, a square jaw, dog tags and rigid military posture.
> A perfectly squared-away orange jumpsuit. Signature prop: dog tags clenched in a fist.
> Expressions: thousand-yard stare, tactical nod, rare smile.

### `prisoner-08`: The Kitchen King
> A flamboyant kitchen worker in his 30s with a hairnet over a pompadour, a huge gap-toothed grin and an apron over an
> orange jumpsuit. Signature prop: a giant ladle. Expressions: theatrical delight, mock outrage, whispering a secret.

### `prisoner-09`: The Gang Boss
> A hulking gang leader in his 40s with face tattoos, dark sunglasses indoors, a gold chain hidden under his collar and
> heavily scarred knuckles. An orange jumpsuit worn open over a white undershirt.
> Expressions: intimidating stillness, slow smile, explosive anger.

### `prisoner-10`: The Acrobat
> A small, nimble acrobat-thief in her 20s with a short pixie cut, wrapped wrists and ankles, and a mischievous smirk.
> A cropped, rolled-up orange jumpsuit for mobility. Pose her mid-flip in the back view.
> Expressions: playful smirk, focused mid-leap, cheeky tongue out.

---

## Environment plate template (21 environments, see `data/world.json`)

> Anime background art, 16:9, cinematic establishing plate of **[ENVIRONMENT DESCRIPTION]** inside a gritty modern
> maximum-security prison. Empty of people. Painterly anime background style with detailed hard-surface props and
> clean perspective. **Warm sodium-vapor orange practical lights against cool teal shadows.** Strong leading lines
> (bars, corridors, pipes, catwalks) with the focal point on a rule-of-thirds intersection. Slight haze and volumetric light.
> Show clear traversable paths (doors, vents, grates) that connect to [NEIGHBORS]. No text, no watermark.

Generate each environment from its `description` and `neighbors` fields in `data/world.json`.
