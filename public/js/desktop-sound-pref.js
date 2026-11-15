// Remote-sound preference for Desktop tabs: one on/off flag per browser. Kept out of
// desktop-session.js, which never touches storage (its desktop password must stay in memory).
const SOUND_KEY = 'rh-desktop-sound';

export function readSoundOn() {
  try { return globalThis.localStorage?.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}

export function saveSoundOn(on) {
  try { globalThis.localStorage?.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* storage blocked: keep it for this page only */ }
}
