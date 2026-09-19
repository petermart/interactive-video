import { useEffect, useState } from "react";

/**
 * How loud the soundtrack is, per browser. This is the one setting that belongs to the viewer rather than the
 * operator: everything else in the settings panel spends money or changes the rules, so it sits behind the admin
 * password, but the music plays in someone's ears and they get to turn it down.
 *
 * Kept outside React because the player reads it from an audio element and a Web Audio gain node (iOS ignores
 * HTMLMediaElement.volume), while the slider lives in another component entirely.
 */

const KEY = "prison-escape:music-volume";
export const DEFAULT_MUSIC_VOLUME = 0.35;

const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_MUSIC_VOLUME);

const read = () => {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === null ? DEFAULT_MUSIC_VOLUME : clamp(Number(saved));
  } catch {
    return DEFAULT_MUSIC_VOLUME; // private mode, blocked storage: the default is fine
  }
};

let value = read();
const listeners = new Set<(v: number) => void>();

export const musicVolume = () => value;

export function setMusicVolume(next: number) {
  value = clamp(next);
  try {
    localStorage.setItem(KEY, String(value));
  } catch {}
  for (const fn of listeners) fn(value);
}

/** Subscribes to changes; returns the unsubscribe. */
export function onMusicVolume(fn: (v: number) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The slider's view of it. */
export function useMusicVolume() {
  const [v, setV] = useState(musicVolume);
  useEffect(() => onMusicVolume(setV), []);
  return [v, setMusicVolume] as const;
}
