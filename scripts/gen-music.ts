// Generates the background music loop with ElevenLabs Music from common-generated-assets/music/loop.txt.
// Tries the ElevenLabs API directly (hackathon credits), falls back to MachGen's Eleven-Music-v2 (~$0.006/s).
// Renders LOOP_SECS + XFADE_SECS, then crossfades the tail into the head for a seamless loop.
// Output: common-generated-assets/music/loop-raw.mp3, loop.mp3 (next to the prompt), media/music/loop.mp3 (served).
import keys from "../keys.json";
import { copyFileSync, mkdirSync } from "node:fs";

const DIR = "common-generated-assets/music";
const LOOP_SECS = 30; // 12 bars of 5/4 at 120 BPM
const XFADE_SECS = 4;
const prompt = (await Bun.file(`${DIR}/loop.txt`).text()).trim();
const raw = `${DIR}/loop-raw.mp3`;

async function viaElevenLabs() {
  const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192", {
    method: "POST",
    headers: { "xi-api-key": keys.elevenlabs, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      music_length_ms: (LOOP_SECS + XFADE_SECS) * 1000,
      model_id: "music_v1",
      force_instrumental: true,
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  await Bun.write(raw, await res.arrayBuffer());
  return "ElevenLabs API";
}

async function viaMachGen() {
  const API = "https://api.machgen.ai/api/v0";
  const auth = { Authorization: `Bearer ${keys.machgen}` };
  const submit = await fetch(`${API}/generate`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "Eleven-Music-v2",
      task_type: "T2M",
      prompt,
      audio_config: { duration_secs: LOOP_SECS + XFADE_SECS, output_format: "mp3_44100_192" },
    }),
  });
  const submitted: any = await submit.json();
  if (!submit.ok) throw new Error(`MachGen submit ${submit.status}: ${JSON.stringify(submitted)}`);
  let task: any;
  while (true) {
    await Bun.sleep(2500);
    task = await (await fetch(`${API}/tasks/${submitted.task_id}`, { headers: auth })).json();
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(task.status)) break;
  }
  if (task.status !== "COMPLETED") throw new Error(`MachGen ${task.status}: ${task.error_msg}`);
  const url = Object.values(task.task_output ?? {})[0] as string;
  await Bun.write(raw, await (await fetch(url, { headers: auth })).arrayBuffer());
  return `MachGen Eleven-Music-v2 (task ${submitted.task_id})`;
}

// The direct ElevenLabs Music API needs a paid plan (402 on free); pass --direct once the hackathon coupon is applied.
let source: string;
if (process.argv.includes("--direct")) {
  source = await viaElevenLabs();
} else {
  source = await viaMachGen();
}
console.log(`generated ${raw} via ${source}`);

// Equal-power crossfade: the last XFADE_SECS fade out over the fading-in first XFADE_SECS.
const filter = [
  `[0:a]atrim=0:${LOOP_SECS},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${XFADE_SECS}:curve=qsin[head]`,
  `[0:a]atrim=${LOOP_SECS}:${LOOP_SECS + XFADE_SECS},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${XFADE_SECS}:curve=qsin,apad=whole_dur=${LOOP_SECS}[tail]`,
  `[head][tail]amix=inputs=2:normalize=0,atrim=0:${LOOP_SECS}[out]`,
].join(";");
const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", raw, "-filter_complex", filter, "-map", "[out]", "-b:a", "192k", `${DIR}/loop.mp3`]);
if (p.exitCode !== 0) throw new Error(`ffmpeg loop: ${p.stderr}`);

mkdirSync("media/music", { recursive: true });
copyFileSync(`${DIR}/loop.mp3`, "media/music/loop.mp3");
console.log(`saved ${DIR}/loop.mp3 and media/music/loop.mp3`);
