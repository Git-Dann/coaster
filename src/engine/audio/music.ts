/**
 * Generative ambient music: sparse felt-piano phrases in F major, drawn from the major pentatonic over gently changing
 * maj7-family chords. Each phrase is 3–7 notes (sometimes a soft bass root first), followed by 20–60 s of silence.
 * Melodies are a random walk biased towards chord tones, so no loop ever repeats verbatim.
 *
 * Driven by polling the audio clock (`tick(now)`) from the engine's per-frame updates; a whole phrase is scheduled on the
 * audio timeline in one go, so timing stays sample-accurate regardless of frame rate.
 */
import { VoiceLimiter, midiToHz, playNoise, playTone, rand, type NoiseBank } from './synth';

const KEY = 65; // F4
/** Major pentatonic degrees (semitones from the key). */
const PENTA = [0, 2, 4, 7, 9] as const;
/** Chord tones relative to the key: Fmaj7, Bbmaj7, Dm7, Gm7, Am7. */
const CHORDS: readonly (readonly number[])[] = [
  [0, 4, 7, 11],
  [5, 9, 12, 16],
  [-3, 0, 4, 7],
  [2, 5, 9, 12],
  [4, 7, 11, 14],
];

/** Melody pitch pool: two octaves of the pentatonic from F4. */
const POOL: number[] = [];
for (let o = 0; o < 2; o++) for (const d of PENTA) POOL.push(KEY + o * 12 + d);
POOL.push(KEY + 24);

export class Music {
  private readonly ctx: BaseAudioContext;
  private readonly noise: NoiseBank;
  private readonly dest: AudioNode;
  private readonly voices: VoiceLimiter;
  private enabled = false;
  private nextAt = 0;
  private lastChord = -1;
  private lastIndex = 4;

  constructor(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode, voices: VoiceLimiter) {
    this.ctx = ctx;
    this.noise = noise;
    this.dest = dest;
    this.voices = voices;
  }

  setEnabled(on: boolean): void {
    if (on && !this.enabled) this.nextAt = this.ctx.currentTime + rand(2, 6);
    this.enabled = on;
  }

  tick(now: number): void {
    if (!this.enabled || now < this.nextAt) return;
    const end = this.phrase(now + 0.05);
    this.nextAt = end + rand(20, 60);
  }

  /** Schedules one phrase starting at `t0`; returns its (approximate) end time. */
  private phrase(t0: number): number {
    let chordIdx = Math.floor(Math.random() * CHORDS.length);
    if (chordIdx === this.lastChord) chordIdx = (chordIdx + 1 + Math.floor(Math.random() * (CHORDS.length - 1))) % CHORDS.length;
    this.lastChord = chordIdx;
    const chord = CHORDS[chordIdx] ?? CHORDS[0] ?? [0];
    const chordPcs = new Set(chord.map((c) => ((c % 12) + 12) % 12));

    const notes = 3 + Math.floor(Math.random() * 5);
    let t = t0;
    const plan: { midi: number; at: number; vel: number }[] = [];
    if (Math.random() < 0.6) plan.push({ midi: KEY - 24 + (chord[0] ?? 0), at: t, vel: 0.45 });
    let idx = this.lastIndex;
    for (let i = 0; i < notes; i++) {
      // Random walk of ±1–2 pool steps, nudged onto chord tones.
      for (let tries = 0; tries < 4; tries++) {
        const step = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2));
        const cand = Math.min(POOL.length - 1, Math.max(0, idx + step));
        idx = cand;
        const midi = POOL[cand] ?? KEY;
        if (chordPcs.has((((midi - KEY) % 12) + 12) % 12) || tries === 3) break;
      }
      const midi = POOL[idx] ?? KEY;
      const vel = rand(0.45, 0.75) * (1 - (i / notes) * 0.35);
      plan.push({ midi, at: t + rand(0, 0.02), vel });
      if (Math.random() < 0.2) plan.push({ midi: midi - (Math.random() < 0.5 ? 5 : 3), at: t, vel: vel * 0.6 }); // soft dyad
      t += rand(0.35, 1.1) * (i === notes - 2 ? 1.5 : 1); // linger before the last note
    }
    this.lastIndex = idx;
    const end = t + 4.5;
    // A phrase counts as a single voice for the global cap.
    if (!this.voices.tryAcquire(this.ctx.currentTime, end)) return end;
    for (const n of plan) this.note(n.midi, n.at, n.vel);
    return end;
  }

  /** Felt-piano-like tone: sine fundamental + soft triangle partials that fade faster, a muted hammer thump, low-passed. */
  private note(midi: number, at: number, vel: number): void {
    const f = midiToHz(midi);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900 + vel * 1500;
    lp.Q.value = 0.3;
    lp.connect(this.dest);
    const decay = rand(2.8, 4.2) * (midi < 55 ? 1.3 : 1);
    playTone(this.ctx, lp, { at, freq: f, gain: vel * 0.16, attack: 0.01, decay, onEnd: () => lp.disconnect() });
    playTone(this.ctx, lp, { at, freq: f * 2.002, gain: vel * 0.04, attack: 0.01, decay: decay * 0.45, type: 'triangle' });
    playTone(this.ctx, lp, { at, freq: f * 3.01, gain: vel * 0.012, attack: 0.01, decay: decay * 0.25 });
    playNoise(this.ctx, lp, { buffer: this.noise.pink, at, gain: vel * 0.02, decay: 0.03, type: 'lowpass', freq: 700 });
  }
}
