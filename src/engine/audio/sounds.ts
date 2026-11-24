/**
 * One-shot recipes for UI and construction sounds, plus the continuous support-growth texture.
 *
 * Every recipe layers 2–3 elements: a very short filtered-noise transient (the "touch"), a pitched body with a fast
 * exponential decay (the "material"), and sometimes a soft tail. Pitch (±4%), gain (±10%) and layer timing (a few ms) are
 * randomised per play so repeated actions feel organic. Frequencies stay below ~3 kHz for bodies and partials, which keeps
 * everything rounded and never piercing — closer to a wooden toy than a computer beep.
 */
import type { BuildMaterial, BuildSound, UiSound } from './types';
import { SmoothParam, lfo, loopNoise, midiToHz, playNoise, playTone, vary, type NoiseBank } from './synth';

export type Recipe = (ctx: BaseAudioContext, noise: NoiseBank, out: AudioNode, t: number) => void;

export interface RecipeEntry {
  /** Nominal duration (s), used for voice accounting. */
  dur: number;
  play: Recipe;
}

// ----- shared layers -------------------------------------------------------------------------------------------------

/** Soft fingertip transient: a few ms of band-passed noise. */
function touch(ctx: BaseAudioContext, n: NoiseBank, out: AudioNode, t: number, freq: number, gain: number, decay = 0.008): void {
  playNoise(ctx, out, { buffer: n.white, at: t, gain: vary(gain, 0.15), decay, type: 'bandpass', freq: vary(freq, 0.08), q: 1.4 });
}

/** Warm rounded pluck: sine fundamental + quiet octave triangle, low-passed. */
function pluck(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, gain: number, decay: number): void {
  playTone(ctx, out, { at: t, freq, gain, decay, attack: 0.004, type: 'sine' });
  playTone(ctx, out, { at: t, freq: freq * 2, gain: gain * 0.18, decay: decay * 0.5, attack: 0.004, type: 'triangle', lowpass: 2600 });
}

/** Wooden knock: triangle body with a quick inharmonic overtone — short, warm, low-mid. */
function woodBody(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, gain: number, decay = 0.07): void {
  playTone(ctx, out, { at: t, freq, gain, decay, attack: 0.002, type: 'triangle', lowpass: 1800, glide: freq * 0.92 });
  playTone(ctx, out, { at: t, freq: freq * 2.43, gain: gain * 0.25, decay: decay * 0.4, attack: 0.001, type: 'sine' });
}

/** Rounded metallic tap: sine body plus short inharmonic partials (free-bar ratios 2.76 / 5.40) that ring briefly. */
function metalBody(ctx: BaseAudioContext, out: AudioNode, t: number, freq: number, gain: number, ring = 0.25): void {
  playTone(ctx, out, { at: t, freq, gain, decay: ring * 0.6, attack: 0.002 });
  playTone(ctx, out, { at: t, freq: freq * 2.76, gain: gain * 0.3, decay: ring, attack: 0.002, lowpass: 3200 });
  playTone(ctx, out, { at: t, freq: freq * 5.4, gain: gain * 0.08, decay: ring * 0.5, attack: 0.002, lowpass: 3200 });
}

const j = (ms: number): number => Math.random() * ms * 0.001; // timing jitter

// Gentle major-pentatonic note palette around C5 for musical UI cues.
const C5 = midiToHz(72), D5 = midiToHz(74), E5 = midiToHz(76), G5 = midiToHz(79), A5 = midiToHz(81), C6 = midiToHz(84);

// ----- UI ------------------------------------------------------------------------------------------------------------

export const UI_RECIPES: Readonly<Record<UiSound, RecipeEntry>> = {
  tap: { dur: 0.09, play: (c, n, o, t) => {
    const p = vary(1, 0.04);
    touch(c, n, o, t, 2400, 0.08);
    pluck(c, o, t + j(3), 620 * p, vary(0.11, 0.1), 0.06);
  } },
  select: { dur: 0.25, play: (c, n, o, t) => {
    const p = vary(1, 0.03);
    touch(c, n, o, t, 2200, 0.06);
    pluck(c, o, t, E5 * p, 0.1, 0.12);
    pluck(c, o, t + 0.045 + j(6), A5 * p, 0.08, 0.18);
  } },
  toggle: { dur: 0.1, play: (c, n, o, t) => {
    touch(c, n, o, t, 1700, 0.1, 0.006);
    woodBody(c, o, t + j(3), vary(520, 0.05), 0.12, 0.05);
  } },
  slider: { dur: 0.04, play: (c, n, o, t) => {
    touch(c, n, o, t, 2800, 0.035, 0.004);
    playTone(c, o, { at: t, freq: vary(1150, 0.05), gain: 0.035, decay: 0.022, attack: 0.001, lowpass: 2500 });
  } },
  open: { dur: 0.22, play: (c, n, o, t) => {
    const p = vary(1, 0.04);
    playNoise(c, o, { buffer: n.pink, at: t, gain: 0.05, attack: 0.03, decay: 0.15, type: 'lowpass', freq: 500, freqEnd: 2200, q: 0.7 });
    playTone(c, o, { at: t, freq: 420 * p, glide: 640 * p, glideTime: 0.12, gain: 0.08, attack: 0.012, decay: 0.16 });
  } },
  close: { dur: 0.22, play: (c, n, o, t) => {
    const p = vary(1, 0.04);
    playNoise(c, o, { buffer: n.pink, at: t, gain: 0.045, attack: 0.02, decay: 0.14, type: 'lowpass', freq: 2000, freqEnd: 450, q: 0.7 });
    playTone(c, o, { at: t, freq: 620 * p, glide: 400 * p, glideTime: 0.12, gain: 0.075, attack: 0.01, decay: 0.15 });
  } },
  undo: { dur: 0.25, play: (c, n, o, t) => {
    const p = vary(1, 0.03);
    touch(c, n, o, t, 1900, 0.05);
    pluck(c, o, t, E5 * p, 0.08, 0.1);
    pluck(c, o, t + 0.06 + j(6), C5 * p, 0.08, 0.16);
  } },
  redo: { dur: 0.25, play: (c, n, o, t) => {
    const p = vary(1, 0.03);
    touch(c, n, o, t, 2100, 0.05);
    pluck(c, o, t, C5 * p, 0.08, 0.1);
    pluck(c, o, t + 0.06 + j(6), E5 * p, 0.08, 0.16);
  } },
  save: { dur: 0.7, play: (c, n, o, t) => {
    const p = vary(1, 0.02);
    touch(c, n, o, t, 1500, 0.06, 0.01);
    pluck(c, o, t, C5 * p, 0.07, 0.5);
    pluck(c, o, t + 0.035 + j(5), E5 * p, 0.06, 0.5);
    pluck(c, o, t + 0.07 + j(5), G5 * p, 0.055, 0.6);
  } },
  colour: { dur: 0.12, play: (c, n, o, t) => {
    const f = vary(700, 0.06);
    touch(c, n, o, t, 3000, 0.03, 0.005);
    playTone(c, o, { at: t, freq: f, glide: f * 1.35, glideTime: 0.05, gain: 0.08, attack: 0.006, decay: 0.09 });
  } },
  material: { dur: 0.12, play: (c, n, o, t) => {
    touch(c, n, o, t, 1300, 0.09, 0.01);
    woodBody(c, o, t + j(4), vary(330, 0.05), 0.13, 0.08);
  } },
  'carriage-add': { dur: 0.22, play: (c, n, o, t) => {
    touch(c, n, o, t, 1100, 0.12, 0.012);
    playTone(c, o, { at: t, freq: vary(150, 0.04), glide: 120, gain: 0.18, attack: 0.003, decay: 0.12, type: 'sine' });
    woodBody(c, o, t + 0.03 + j(8), vary(360, 0.05), 0.08, 0.06);
  } },
  'carriage-remove': { dur: 0.22, play: (c, n, o, t) => {
    woodBody(c, o, t, vary(330, 0.05), 0.07, 0.05);
    touch(c, n, o, t + 0.03, 900, 0.1, 0.012);
    playTone(c, o, { at: t + 0.03 + j(6), freq: vary(130, 0.04), glide: 95, gain: 0.15, attack: 0.003, decay: 0.12 });
  } },
  'error-soft': { dur: 0.35, play: (c, _n, o, t) => {
    // A gentle "hmm": two low, close, soft notes. Never a buzzer.
    const p = vary(1, 0.02);
    playTone(c, o, { at: t, freq: 330 * p, gain: 0.08, attack: 0.015, decay: 0.12, lowpass: 1200 });
    playTone(c, o, { at: t + 0.11, freq: 294 * p, gain: 0.07, attack: 0.015, decay: 0.2, lowpass: 1000 });
  } },
  success: { dur: 0.8, play: (c, n, o, t) => {
    const p = vary(1, 0.02);
    touch(c, n, o, t, 2000, 0.04);
    [C5, E5, G5, C6].forEach((f, i) => pluck(c, o, t + i * 0.07 + j(6), f * p, 0.065 - i * 0.008, 0.45));
  } },
  'circuit-complete': { dur: 2.4, play: (c, n, o, t) => {
    // Pentatonic flourish over a softly swelling Cmaj7 bed: the one "moment" sound, still calm.
    const p = vary(1, 0.015);
    touch(c, n, o, t, 1800, 0.05, 0.012);
    [C5, D5, E5, G5, A5, C6].forEach((f, i) => pluck(c, o, t + i * 0.085 + j(8), f * p, 0.055, 0.7));
    [midiToHz(48), midiToHz(55), midiToHz(59), midiToHz(64)].forEach((f) =>
      playTone(c, o, { at: t + 0.05, freq: f * p, gain: 0.03, attack: 0.35, decay: 1.9, type: 'triangle', lowpass: 900 }),
    );
  } },
};

// ----- construction --------------------------------------------------------------------------------------------------

type BuildRecipes = Readonly<Record<BuildSound, RecipeEntry>>;

const TIMBER: BuildRecipes = {
  snap: { dur: 0.12, play: (c, n, o, t) => {
    touch(c, n, o, t, 1400, 0.14, 0.008);
    woodBody(c, o, t + j(3), vary(280, 0.05), 0.16, 0.08);
  } },
  place: { dur: 0.25, play: (c, n, o, t) => {
    touch(c, n, o, t, 900, 0.16, 0.014);
    playTone(c, o, { at: t, freq: vary(95, 0.05), glide: 70, gain: 0.22, attack: 0.003, decay: 0.16 });
    woodBody(c, o, t + j(4), vary(200, 0.05), 0.14, 0.12);
  } },
  delete: { dur: 0.25, play: (c, n, o, t) => {
    playNoise(c, o, { buffer: n.pink, at: t, gain: 0.08, attack: 0.01, decay: 0.18, type: 'lowpass', freq: 1800, freqEnd: 300, q: 0.8 });
    woodBody(c, o, t + j(4), vary(240, 0.05), 0.09, 0.07);
  } },
  'preview-tick': { dur: 0.04, play: (c, n, o, t) => {
    touch(c, n, o, t, 1600, 0.04, 0.004);
    playTone(c, o, { at: t, freq: vary(560, 0.05), gain: 0.03, decay: 0.025, attack: 0.001, type: 'triangle', lowpass: 1500 });
  } },
};

const STEEL: BuildRecipes = {
  snap: { dur: 0.3, play: (c, n, o, t) => {
    touch(c, n, o, t, 3200, 0.1, 0.005);
    metalBody(c, o, t + j(3), vary(520, 0.05), 0.09, 0.22);
  } },
  place: { dur: 0.45, play: (c, n, o, t) => {
    touch(c, n, o, t, 2000, 0.12, 0.01);
    playTone(c, o, { at: t, freq: vary(110, 0.05), glide: 85, gain: 0.18, attack: 0.003, decay: 0.14 });
    metalBody(c, o, t + j(4), vary(380, 0.05), 0.08, 0.38);
  } },
  delete: { dur: 0.3, play: (c, n, o, t) => {
    playNoise(c, o, { buffer: n.pink, at: t, gain: 0.07, attack: 0.01, decay: 0.18, type: 'lowpass', freq: 2600, freqEnd: 400, q: 0.8 });
    metalBody(c, o, t + j(4), vary(440, 0.05), 0.05, 0.15);
  } },
  'preview-tick': { dur: 0.06, play: (c, n, o, t) => {
    touch(c, n, o, t, 3000, 0.03, 0.003);
    playTone(c, o, { at: t, freq: vary(900, 0.05), gain: 0.025, decay: 0.04, attack: 0.001, lowpass: 2600 });
  } },
};

export const BUILD_RECIPES: Readonly<Record<BuildMaterial, BuildRecipes>> = { timber: TIMBER, steel: STEEL };

// ----- continuous support growth -------------------------------------------------------------------------------------

/**
 * A soft mechanical "growing" texture: band-passed noise gently amplitude-modulated by a slow ratchet LFO, with a quiet
 * hum underneath for steel. Built once, then only faded in and out; the timbre retunes smoothly when the material changes.
 */
export class GrowthTexture {
  private readonly out: GainNode;
  private readonly level: SmoothParam;
  private readonly bandFreq: SmoothParam;
  private readonly humLevel: SmoothParam;
  private readonly stoppables: AudioScheduledSourceNode[] = [];
  private readonly ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.level = new SmoothParam(this.out.gain, 0.15, 0);

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 3;
    this.bandFreq = new SmoothParam(band.frequency, 0.2, 800);
    const am = ctx.createGain();
    am.gain.value = 0.55;
    band.connect(am).connect(this.out);
    this.stoppables.push(loopNoise(ctx, noise.pink, band));
    this.stoppables.push(lfo(ctx, 7.5, 0.4, am.gain, 'triangle').osc);

    const hum = ctx.createOscillator();
    hum.frequency.value = 140;
    const humGain = ctx.createGain();
    humGain.gain.value = 0;
    this.humLevel = new SmoothParam(humGain.gain, 0.2, 0);
    hum.connect(humGain).connect(this.out);
    hum.start();
    this.stoppables.push(hum);
  }

  set(active: boolean, material: BuildMaterial): void {
    const now = this.ctx.currentTime;
    this.bandFreq.set(material === 'steel' ? 1500 : 750, now);
    this.humLevel.set(material === 'steel' ? 0.12 : 0, now);
    this.level.set(active ? 0.14 : 0, now, active ? 0.15 : 0.3);
  }

  dispose(): void {
    for (const s of this.stoppables) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.out.disconnect();
  }
}
