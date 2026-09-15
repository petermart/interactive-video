// Larry talking-head intro via Masky (https://masky.ai/skill.md). Spends Masky credits; run one step at a time.
//   bun scripts/masky-intro.ts portrait  -> images/edit: Larry face portrait from his GMI-hosted character sheet (~0.01 cr)
//   bun scripts/masky-intro.ts avatars   -> create "Larry" (talking) and "Blackstone Prison" (B-roll source) avatars
//   bun scripts/masky-intro.ts speak     -> lip-synced talking-head clip of the intro script
//   bun scripts/masky-intro.ts broll     -> video-2 prison B-roll starting from the guard tower plate
//   bun scripts/masky-intro.ts composite -> ffmpeg: B-roll full frame + Larry picture-in-picture, Larry's audio (free)
// Prompts, IDs and outputs live in common-generated-assets/videos/masky/ (state.json tracks progress).
import keys from "../keys.json";
import { existsSync, mkdirSync } from "node:fs";

const API = "https://masky.ai/api";
const DIR = "common-generated-assets/videos/masky";
const STATE = `${DIR}/state.json`;
const headers = { Authorization: `Bearer ${(keys as { masky: string }).masky}`, "Content-Type": "application/json" };
mkdirSync(DIR, { recursive: true });

type State = {
  larrySheetUrl?: string;
  guardTowerUrl?: string;
  portraitUrl?: string;
  larryAvatarId?: string;
  prisonAvatarId?: string;
  speakGenerationId?: string;
  talkingVideoUrl?: string;
  brollGenerationId?: string;
  brollVideoUrl?: string;
  credits?: Record<string, unknown>;
};
const state: State = existsSync(STATE) ? await Bun.file(STATE).json() : {};
const save = () => Bun.write(STATE, JSON.stringify(state, null, 2));
const prompt = async (name: string) => (await Bun.file(`${DIR}/${name}.txt`).text()).trim();

async function call(method: string, path: string, body?: object) {
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  return json;
}

async function download(url: string, out: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  await Bun.write(out, await res.arrayBuffer());
  console.log(`saved ${out}`);
}

/** Public URLs of the images generated on GMI (Masky needs public http(s) image URLs). */
async function gmiImageUrls() {
  const gmiKey = (keys as { gmi: string }).gmi;
  const list: any = await (
    await fetch("https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests?model_id=gemini-3-pro-image", {
      headers: { Authorization: `Bearer ${gmiKey}` },
    })
  ).json();
  const items: any[] = list.requests ?? list.data ?? list.items ?? list;
  const find = (needle: string) => items.find(q => q.payload?.prompt?.includes(needle))?.outcome?.media_urls?.[0]?.url;
  return { larry: find("CHARACTER: Larry"), tower: find("ENVIRONMENT: The guard tower") };
}

const step = process.argv[2];

if (step === "portrait") {
  const urls = await gmiImageUrls();
  if (!urls.larry || !urls.tower) throw new Error("Could not find GMI-hosted Larry sheet or guard tower plate");
  state.larrySheetUrl = urls.larry;
  state.guardTowerUrl = urls.tower;
  const r = await call("POST", "/images/edit", { prompt: await prompt("portrait"), imageUrl: urls.larry });
  state.portraitUrl = r.imageUrl;
  state.credits = { ...state.credits, portrait: r.creditCost };
  await save();
  await download(r.imageUrl, `${DIR}/larry-portrait.${r.imageUrl.split("?")[0].split(".").pop() ?? "jpg"}`);
  console.log(r);
} else if (step === "avatars") {
  if (!state.portraitUrl || !state.guardTowerUrl) throw new Error("Run the portrait step first");
  const larry = await call("POST", "/avatars", {
    displayName: "Larry (Inmate 4471)",
    imageUrl: state.portraitUrl,
    personalityPrompt: await prompt("personality"),
    humeVoiceId: "82a76fb8-3524-4e87-9265-9795c8e4ede6", // "Male Protagonist"
  });
  state.larryAvatarId = larry.avatar?.avatarId ?? larry.avatarId; // response nests the avatar
  const prison = await call("POST", "/avatars", {
    displayName: "Blackstone Prison (B-roll)",
    imageUrl: state.guardTowerUrl,
    personalityPrompt: "A maximum-security prison at night. Used only as a scene source for B-roll.",
  });
  state.prisonAvatarId = prison.avatar?.avatarId ?? prison.avatarId;
  await save();
  console.log({ larry, prison });
} else if (step === "speak") {
  if (!state.larryAvatarId) throw new Error("Run the avatars step first");
  const r = await call("POST", `/avatars/${state.larryAvatarId}/speak`, { text: await prompt("script"), textMode: "literal", output: "video" });
  state.speakGenerationId = r.generationId ?? r.id;
  await save();
  console.log("started", r);
  while (true) {
    await Bun.sleep(5000);
    const res = await call("GET", `/avatars/speak/${state.speakGenerationId}`);
    const g = res.generation ?? res; // response nests the generation
    console.log(" status", g.status);
    if (g.status === "error") throw new Error(JSON.stringify(g));
    if (g.videoUrl) {
      state.talkingVideoUrl = g.videoUrl;
      state.credits = { ...state.credits, speak: g.creditsCharged ?? g.creditCost };
      await save();
      await download(g.videoUrl, `${DIR}/larry-talking.mp4`);
      break;
    }
  }
} else if (step === "broll") {
  if (!state.prisonAvatarId) throw new Error("Run the avatars step first");
  const r = await call("POST", "/videos/video-2", {
    avatarId: state.prisonAvatarId,
    prompt: await prompt("broll"),
    duration: 15,
    resolution: "720p",
    aspectRatio: "16:9",
  });
  state.brollGenerationId = r.generationId;
  state.credits = { ...state.credits, broll: r.creditCost };
  await save();
  console.log("started", r);
  while (true) {
    await Bun.sleep(8000);
    const g = await call("GET", `/videos/video-2/${state.brollGenerationId}`);
    console.log(" status", g.status);
    if (g.status === "error" || g.status === "failed") throw new Error(JSON.stringify(g));
    // A URL can appear while still "rendering" (partial file); only download once the status is ready.
    const url = g.videoUrl ?? g.url;
    if (url && (g.status === "ready" || g.status === "video")) {
      state.brollVideoUrl = url;
      await save();
      await download(url, `${DIR}/prison-broll.mp4`);
      break;
    }
  }
} else if (step === "composite") {
  const talking = `${DIR}/larry-talking.mp4`;
  const broll = `${DIR}/prison-broll.mp4`;
  if (!existsSync(talking) || !existsSync(broll)) throw new Error("Need larry-talking.mp4 and prison-broll.mp4");
  // B-roll scaled to 1280x720 and looped to cover the talk; Larry as a square face-crop inset, bottom-left,
  // with a thin orange border. Output length follows Larry's speech; audio is Larry's voice only.
  const filter = [
    "[1:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1[bg]",
    "[0:v]crop=ih:ih,scale=280:280,setsar=1,pad=iw+8:ih+8:4:4:color=0xff8a2a[pip]", // square face crop
    "[bg][pip]overlay=x=36:y=H-h-36:shortest=1[v]",
  ].join(";");
  const p = Bun.spawnSync([
    "ffmpeg", "-v", "error", "-y",
    "-i", talking,
    "-stream_loop", "-1", "-i", broll,
    "-filter_complex", filter,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-c:a", "aac", "-b:a", "160k",
    "-shortest", `${DIR}/larry-intro-composite.mp4`,
  ]);
  if (p.exitCode !== 0) throw new Error(`ffmpeg: ${p.stderr}`);
  console.log(`saved ${DIR}/larry-intro-composite.mp4`);
} else {
  console.error("Usage: bun scripts/masky-intro.ts portrait|avatars|speak|broll|composite");
  process.exit(1);
}
