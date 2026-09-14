import { existsSync, mkdirSync } from "node:fs";
import keysJson from "../../keys.json";
import worldJson from "../../data/world.json";

export const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
export const MEDIA_DIR = `${ROOT}media`;
export const CACHE_DIR = `${MEDIA_DIR}/cache`;
mkdirSync(CACHE_DIR, { recursive: true });

export const keys = keysJson as { machgen: string; gmi: string; elevenlabs: string };

export type Character = { id: string; role: string; description: string; image: string | null };
export type Environment = {
  id: string;
  description: string;
  neighbors: string[];
  image: string | null;
};
export type World = {
  style: string;
  shotRules: string[];
  startEnvironment: string;
  exitEnvironments: string[];
  characters: Character[];
  environments: Environment[];
};
export const world = worldJson as World;

import { CREATIVITY_POINT_OPTIONS, LLM_MODEL_OPTIONS, OUTCOME_MODES, type LlmModelId, type OutcomeMode } from "./constants";
export { CREATIVITY_POINT_OPTIONS, OUTCOME_MODES, type OutcomeMode };

export type Settings = {
  outcomeMode: OutcomeMode;
  successProbability: number; // 0-100
  creativityPoints: number; // one of CREATIVITY_POINT_OPTIONS
  promptsTillSuccess: number; // 1-20
  liveLLM: boolean;
  liveVideo: boolean;
  /** LLM 1 ("Analyzing escape plan"): speed matters most. */
  analysisModel: LlmModelId;
  /** LLM 2 (shot writer): quality of the H3 prompt matters more. */
  writerModel: LlmModelId;
};

const SETTINGS_FILE = `${ROOT}data/settings.json`;
const defaults: Settings = {
  outcomeMode: "vibes",
  successProbability: 60,
  creativityPoints: 30,
  promptsTillSuccess: 6,
  liveLLM: false,
  liveVideo: false,
  analysisModel: "google/gemini-3.5-flash-lite",
  writerModel: "google/gemini-3.8-flash",
};

let settings: Settings = defaults;
if (existsSync(SETTINGS_FILE)) {
  const { llmModel: _legacy, ...saved } = await Bun.file(SETTINGS_FILE).json();
  settings = { ...defaults, ...saved };
}

export const getSettings = () => settings;

export async function updateSettings(patch: Partial<Settings>) {
  const next = { ...settings, ...patch };
  if (!OUTCOME_MODES.includes(next.outcomeMode)) next.outcomeMode = settings.outcomeMode;
  const validModel = (id: string) => LLM_MODEL_OPTIONS.some(m => m.id === id);
  if (!validModel(next.analysisModel)) next.analysisModel = settings.analysisModel;
  if (!validModel(next.writerModel)) next.writerModel = settings.writerModel;
  if (!CREATIVITY_POINT_OPTIONS.includes(next.creativityPoints as never)) next.creativityPoints = settings.creativityPoints;
  next.successProbability = clamp(Math.round(Number(next.successProbability)), 0, 100);
  next.promptsTillSuccess = clamp(Math.round(Number(next.promptsTillSuccess)), 1, 20);
  next.liveLLM = Boolean(next.liveLLM);
  next.liveVideo = Boolean(next.liveVideo);
  settings = next;
  await Bun.write(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Intro assets fall back to the placeholder clip until the real ones are generated. */
export function introMedia() {
  const pick = (path: string) => (existsSync(`${MEDIA_DIR}/${path}`) ? `/media/${path}` : "/media/placeholder.mp4");
  const intro = pick("intro/intro.mp4");
  return {
    intro,
    // The intro is generated as a seamless loop, so it doubles as its own idle loop.
    introLoop: existsSync(`${MEDIA_DIR}/intro/intro-loop.mp4`) ? "/media/intro/intro-loop.mp4" : intro,
    // Silent macro loop of Larry deliberating; the idle background whenever a step has no loop of its own.
    thinkingLoop: existsSync(`${MEDIA_DIR}/intro/larry-thinking.mp4`) ? "/media/intro/larry-thinking.mp4" : intro,
    music: existsSync(`${MEDIA_DIR}/music/loop.mp3`) ? "/media/music/loop.mp3" : null,
  };
}
