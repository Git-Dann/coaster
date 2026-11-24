/**
 * Synthesised instruments for the lo-fi soundtrack. Each call builds a short-lived node chain on the audio timeline that
 * starts and ends near silence (no clicks), stops its sources, and disconnects itself when done, so everything is garbage
 * collected. Noise comes from the shared, pre-generated noise bank; no buffers are allocated per note.
 *
 * Every function returns the time at which the voice is silent, for voice accounting.
 */
import { SILENT, midiToHz, playNoise, playTone, rand, type NoiseBank } from './synth';

/** Soft, rounded kick: sine pitch drop (105 → 46 Hz) plus a short low-mid "knock" so it reads on small speakers. */
export function kick(ctx: BaseAudioContext, dest: AudioNode, at: number, vel: number): number {
  const end = playTone(ctx, dest, { at, freq: 105, glide: 46, glideTime: 0.11, gain: 0.55 * vel, attack: 0.004, decay: 0.38 });
  playTone(ctx, dest, { at, freq: 190, glide: 95, glideTime: 0.05, gain: 0.1 * vel, attack: 0.003, decay: 0.07, type: 'triangle' });
  return end;
}

/** Dusty brushed snare: band-passed pink noise with a slow-ish attack and a short body tone. */
export function snare(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode, at: number, vel: number): number {
  const end = playNoise(ctx, dest, { buffer: noise.pink, at, gain: 0.3 * vel, attack: 0.005, decay: 0.17, type: 'bandpass', freq: 2100, q: 0.7 });
  playNoise(ctx, dest, { buffer: noise.white, at: at + 0.002, gain: 0.05 * vel, attack: 0.008, decay: 0.12, type: 'highpass', freq: 4500, q: 0.5 });
  playTone(ctx, dest, { at, freq: 190, glide: 160, gain: 0.12 * vel, attack: 0.003, decay: 0.08, type: 'triangle' });
  return end;
}

/** Side-stick / rim: a narrow wooden click with a short pitched body. */
export function rim(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode, at: number, vel: number): number {
  playNoise(ctx, dest, { buffer: noise.white, at, gain: 0.2 * vel, attack: 0.001, decay: 0.03, type: 'bandpass', freq: 1700, q: 3 });
  playTone(ctx, dest, { at, freq: 820, gain: 0.07 * vel, attack: 0.002, decay: 0.035 });
  return playTone(ctx, dest, { at, freq: 330, gain: 0.06 * vel, attack: 0.002, decay: 0.05, type: 'triangle' });
}

/** Ghost note: a very quiet, short brush. */
export function ghost(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode, at: number, vel: number): number {
  return playNoise(ctx, dest, { buffer: noise.pink, at, gain: 0.22 * vel, attack: 0.004, decay: 0.07, type: 'bandpass', freq: 2400, q: 0.8 });
}

/** Closed or open hat: high-passed white noise. */
export function hat(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode, at: number, vel: number, open: boolean): number {
  return playNoise(ctx, dest, {
    buffer: noise.white, at, gain: (open ? 0.07 : 0.09) * vel, attack: open ? 0.004 : 0.001, decay: open ? 0.3 : 0.035,
    type: 'highpass', freq: open ? 5500 : 6500, q: 0.6,
  });
}

/**
 * Rhodes-style electric piano: a sine carrier with 1:1 FM whose index decays (bright "tine" attack mellowing into a pure
 * tone), plus a slightly detuned octave partial. ~7 ms attack, long decay towards a sustain, gentle release at the gate.
 * Tremolo and tape wow are applied on the keys bus, not per note.
 */
export function rhodes(ctx: BaseAudioContext, dest: AudioNode, at: number, midi: number, vel: number, dur: number): number {
  const f = midiToHz(midi);
  const attack = 0.007;
  const release = at + Math.max(attack + 0.05, dur);
  const end = release + 0.9;
  const peak = 0.15 * vel;

  const car = ctx.createOscillator();
  car.frequency.setValueAtTime(f, at);
  const mod = ctx.createOscillator();
  mod.frequency.setValueAtTime(f, at);
  const modDepth = ctx.createGain();
  modDepth.gain.setValueAtTime(f * (0.5 + vel * 1.1), at);
  modDepth.gain.setTargetAtTime(f * 0.12, at, 0.22);
  mod.connect(modDepth).connect(car.frequency);

  const oct = ctx.createOscillator();
  oct.frequency.setValueAtTime(f * 2.004, at);
  const octLevel = ctx.createGain();
  octLevel.gain.setValueAtTime(0.14, at);
  octLevel.gain.setTargetAtTime(0.04, at, 0.35);

  const env = ctx.createGain();
  env.gain.setValueAtTime(SILENT, at);
  env.gain.linearRampToValueAtTime(peak, at + attack);
  env.gain.setTargetAtTime(peak * 0.32, at + attack, 0.7);
  env.gain.setTargetAtTime(0, release, 0.16);

  car.connect(env);
  oct.connect(octLevel).connect(env);
  env.connect(dest);
  for (const o of [car, mod, oct]) {
    o.start(at);
    o.stop(end);
  }
  car.onended = () => {
    env.disconnect();
    octLevel.disconnect();
    modDepth.disconnect();
  };
  return end;
}

/** Warm round bass: triangle (odd harmonics reach phone speakers) over a sine fundamental; the bus low-passes it. */
export function bass(ctx: BaseAudioContext, dest: AudioNode, at: number, midi: number, vel: number, dur: number): number {
  const f = midiToHz(midi);
  const attack = 0.012;
  const release = at + Math.max(attack + 0.04, dur);
  const end = release + 0.35;
  const peak = 0.26 * vel;
  const tri = ctx.createOscillator();
  tri.type = 'triangle';
  tri.frequency.setValueAtTime(f, at);
  const sine = ctx.createOscillator();
  sine.frequency.setValueAtTime(f, at);
  const env = ctx.createGain();
  env.gain.setValueAtTime(SILENT, at);
  env.gain.linearRampToValueAtTime(peak, at + attack);
  env.gain.setTargetAtTime(peak * 0.6, at + attack, 0.35);
  env.gain.setTargetAtTime(0, release, 0.06);
  tri.connect(env);
  sine.connect(env);
  env.connect(dest);
  for (const o of [tri, sine]) {
    o.start(at);
    o.stop(end);
  }
  tri.onended = () => env.disconnect();
  return end;
}

/** Mellow pluck lead: triangle + sine through a closing low-pass, soft attack, a touch of delayed vibrato. */
export function pluck(ctx: BaseAudioContext, dest: AudioNode, at: number, midi: number, vel: number, dur: number): number {
  const f = midiToHz(midi);
  const release = at + Math.max(0.08, dur);
  const end = release + 0.7;
  const peak = 0.075 * vel;
  const tri = ctx.createOscillator();
  tri.type = 'triangle';
  tri.frequency.setValueAtTime(f, at);
  const sine = ctx.createOscillator();
  sine.frequency.setValueAtTime(f, at);
  const vib = ctx.createOscillator();
  vib.frequency.value = 5;
  const vibDepth = ctx.createGain();
  vibDepth.gain.setValueAtTime(0, at);
  vibDepth.gain.linearRampToValueAtTime(f * 0.004, at + 0.4);
  vib.connect(vibDepth);
  vibDepth.connect(tri.frequency);
  vibDepth.connect(sine.frequency);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.6;
  lp.frequency.setValueAtTime(2600, at);
  lp.frequency.setTargetAtTime(900, at, 0.25);
  const env = ctx.createGain();
  env.gain.setValueAtTime(SILENT, at);
  env.gain.linearRampToValueAtTime(peak, at + 0.008);
  env.gain.setTargetAtTime(peak * 0.45, at + 0.008, 0.3);
  env.gain.setTargetAtTime(0, release, 0.15);
  tri.connect(lp);
  sine.connect(lp);
  lp.connect(env).connect(dest);
  for (const o of [tri, sine, vib]) {
    o.start(at);
    o.stop(end);
  }
  tri.onended = () => {
    env.disconnect();
    lp.disconnect();
    vibDepth.disconnect();
  };
  return end;
}

/** A single louder vinyl pop on top of the crackle bed. */
export function pop(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode, at: number, vel: number): number {
  return playNoise(ctx, dest, { buffer: noise.white, at, gain: 0.12 * vel, attack: 0.0005, decay: rand(0.004, 0.012), type: 'bandpass', freq: rand(1400, 3500), q: 1.2 });
}

// ---------------------------------------------------------------------------------------------------------------------
// Texture and bus helpers

/**
 * Generates (once per music graph) a few seconds of sparse vinyl crackle: random tiny decaying clicks, a few larger.
 * Looped at a random offset under a high-pass, it gives a constant, non-rhythmic crackle bed for free.
 */
export function createCrackleBuffer(ctx: BaseAudioContext, seconds = 6.7): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, length, sr);
  const d = buf.getChannelData(0);
  const perSample = 16 / sr;
  const tau = Math.max(1, sr / 22050);
  for (let i = 0; i < length; i++) {
    if (Math.random() >= perSample) continue;
    const amp = Math.random() < 0.05 ? rand(0.5, 0.9) : rand(0.05, 0.3);
    const n = Math.max(2, Math.floor(rand(3, 20) * tau));
    const sign = Math.random() < 0.5 ? -1 : 1;
    for (let k = 0; k < n && i + k < length; k++) {
      const shape = k === 0 ? sign : Math.random() * 2 - 1;
      d[i + k] = (d[i + k] ?? 0) + amp * shape * Math.exp(-k / (n * 0.3));
    }
  }
  return buf;
}

/** Soft saturation transfer curve: tanh(k·x) normalised so ±1 maps to ±1. */
export function saturationCurve(samples = 1024, drive = 1.6): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}
