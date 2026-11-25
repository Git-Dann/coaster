import { useGame } from '../stores/game';
import { services } from './services';

/**
 * Mobile audio unlocking.
 *
 * - iOS Safari only lets audio start inside certain gestures (touchend / click / keydown),
 *   not pointerdown, so we listen for those on the whole document.
 * - iOS mutes Web Audio when the ringer switch is on silent unless the page declares a playback
 *   audio session. Safari 17+ supports `navigator.audioSession`, which is all we use there; only
 *   older versions get a looping silent HTML audio element to switch the session to playback.
 * - Music starts once audio is unlocked if the music volume is above zero.
 */
let unlocked = false;
let silent: HTMLAudioElement | null = null;

function silentWavUrl(): string {
  // 0.25 s of silence, 8 kHz mono 8-bit PCM.
  const samples = 2000;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function playbackSession(): void {
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  try {
    if (nav.audioSession) {
      nav.audioSession.type = 'playback';
      return; // Safari 17+: no silent HTML audio needed
    }
  } catch {
    /* not supported: fall back below */
  }
  try {
    if (!silent) {
      silent = new Audio(silentWavUrl());
      silent.setAttribute('playsinline', '');
      silent.loop = true;
      silent.volume = 0.01;
    }
    void silent.play().catch(() => {});
  } catch {
    /* best effort */
  }
}

async function unlock(): Promise<void> {
  const engine = services.engine;
  if (!engine) return;
  playbackSession();
  await engine.audio.unlock();
  if (engine.audio.unlocked && !unlocked) {
    unlocked = true;
    const s = useGame.getState().settings;
    engine.audio.setVolumes(s.audio);
    engine.audio.setMusicEnabled(s.audio.music > 0.01 && !s.audio.muted);
  }
}

export function installAudioUnlock(): () => void {
  const handler = () => {
    void unlock();
  };
  const events = ['touchend', 'click', 'keydown', 'pointerup'] as const;
  for (const e of events) document.addEventListener(e, handler, { capture: true, passive: true });
  // Re-unlock after returning from the background (iOS suspends the context).
  const vis = () => {
    if (!document.hidden && unlocked) void services.engine?.audio.unlock();
  };
  document.addEventListener('visibilitychange', vis);
  return () => {
    for (const e of events) document.removeEventListener(e, handler, { capture: true });
    document.removeEventListener('visibilitychange', vis);
  };
}
