/**
 * Small, dependency-free synthesis toolkit shared by every audio module.
 *
 * Design notes:
 * - Pure helpers (clamping, rate limiting, voice accounting) have no Web Audio dependency so they can be unit tested in Node.
 * - One-shot primitives build short-lived node chains that always start and end near silence (exponential envelopes towards
 *   1e-4), so nothing clicks, and disconnect themselves when their source ends.
 * - Noise is generated once per AudioContext into a few seconds of looping buffers and reused everywhere with random read
 *   offsets, so no sound ever allocates a new AudioBuffer.
 */

export const SILENT = 0.0001;

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

export const clamp01 = (v: number): number => clamp(v, 0, 1);

export const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/** Multiplies `v` by a random factor in [1 - pct, 1 + pct]. Used for subtle per-play variation. */
export const vary = (v: number, pct: number): number => v * (1 + (Math.random() * 2 - 1) * pct);

export function pick<T>(items: readonly [T, ...T[]]): T {
  return items[Math.floor(Math.random() * items.length)] ?? items[0];
}

export const smoothstep = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/**
 * Per-key minimum interval between plays (milliseconds). Keeps continuous drags (sliders, preview ticks) from machine-gunning.
 * Pure: the caller supplies the clock.
 */
export class RateLimiter {
  private readonly last = new Map<string, number>();
  private readonly intervals: Readonly<Record<string, number>>;
  private readonly defaultMs: number;

  constructor(intervals: Readonly<Record<string, number>>, defaultMs = 0) {
    this.intervals = intervals;
    this.defaultMs = defaultMs;
  }

  /** Returns true (and records the play) if `key` may sound at `nowMs`. */
  allow(key: string, nowMs: number): boolean {
    const interval = this.intervals[key] ?? this.defaultMs;
    if (interval <= 0) return true;
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < interval && nowMs >= prev) return false;
    this.last.set(key, nowMs);
    return true;
  }

  reset(): void {
    this.last.clear();
  }
}

/**
 * Fixed-capacity voice accounting by end time. A slot is free once the audio clock passes its end time, so no `ended`
 * callbacks are needed to keep the count right. Sounds that cannot get a slot are simply dropped (graceful under load).
 */
export class VoiceLimiter {
  private readonly ends: Float64Array;

  constructor(capacity: number) {
    this.ends = new Float64Array(Math.max(1, Math.floor(capacity)));
  }

  get capacity(): number {
    return this.ends.length;
  }

  tryAcquire(now: number, endTime: number): boolean {
    for (let i = 0; i < this.ends.length; i++) {
      if ((this.ends[i] ?? 0) <= now) {
        this.ends[i] = endTime;
        return true;
      }
    }
    return false;
  }

  active(now: number): number {
    let n = 0;
    for (let i = 0; i < this.ends.length; i++) if ((this.ends[i] ?? 0) > now) n++;
    return n;
  }

  clear(): void {
    this.ends.fill(0);
  }
}

/**
 * Wraps an AudioParam with setTargetAtTime smoothing and skips redundant automation events, so per-frame updates don't
 * flood the automation timeline and never allocate.
 */
export class SmoothParam {
  private readonly param: AudioParam;
  private readonly tc: number;
  private last = Number.NaN;

  constructor(param: AudioParam, timeConstant: number, initial?: number) {
    this.param = param;
    this.tc = timeConstant;
    if (initial !== undefined) {
      param.value = initial;
      this.last = initial;
    }
  }

  set(value: number, now: number, timeConstant = this.tc): void {
    if (Math.abs(value - this.last) <= 1e-4 + Math.abs(value) * 0.002) return;
    this.last = value;
    this.param.setTargetAtTime(value, now, timeConstant);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Noise

export interface NoiseBank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
}

/** Generates white, pink (Paul Kellet's filter) and brown (leaky integrator) loops once per context. */
export function createNoiseBank(ctx: BaseAudioContext, seconds = 4): NoiseBank {
  const length = Math.floor(ctx.sampleRate * seconds);
  const white = ctx.createBuffer(1, length, ctx.sampleRate);
  const pink = ctx.createBuffer(1, length, ctx.sampleRate);
  const brown = ctx.createBuffer(1, length, ctx.sampleRate);
  const w = white.getChannelData(0);
  const p = pink.getChannelData(0);
  const b = brown.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let last = 0;
  for (let i = 0; i < length; i++) {
    const x = Math.random() * 2 - 1;
    w[i] = x * 0.5;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    p[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362) * 0.11;
    b6 = x * 0.115926;
    last = (last + 0.02 * x) / 1.02;
    b[i] = last * 3.5;
  }
  // Crossfade the loop seam so looping sources never click.
  const fade = Math.min(2048, Math.floor(length / 8));
  for (const data of [w, p, b]) {
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      const tail = length - fade + i;
      data[tail] = (data[tail] ?? 0) * (1 - k) + (data[i] ?? 0) * k;
    }
  }
  return { white, pink, brown };
}

/** Starts a looping noise source at a random offset (decorrelates layers sharing a buffer). */
export function loopNoise(ctx: BaseAudioContext, buffer: AudioBuffer, dest: AudioNode): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(dest);
  src.start(ctx.currentTime, Math.random() * buffer.duration);
  return src;
}

/** Simple sine/triangle LFO wired to `target` with the given depth. Returns the oscillator (for stopping). */
export function lfo(ctx: BaseAudioContext, hz: number, depth: number, target: AudioParam, type: OscillatorType = 'sine'): { osc: OscillatorNode; depth: GainNode } {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.value = depth;
  osc.connect(g).connect(target);
  osc.start();
  return { osc, depth: g };
}

// ---------------------------------------------------------------------------------------------------------------------
// One-shot primitives

export interface ToneSpec {
  at: number;
  freq: number;
  gain: number;
  decay: number;
  attack?: number;
  type?: OscillatorType;
  /** Exponential pitch glide target (Hz), reached after `glideTime` (default: decay). */
  glide?: number;
  glideTime?: number;
  vibratoHz?: number;
  vibratoDepth?: number;
  /** Optional low-pass cutoff to round off the tone. */
  lowpass?: number;
  onEnd?: () => void;
}

/** A pitched layer: oscillator → (low-pass) → exponential AD envelope. Returns the end time. */
export function playTone(ctx: BaseAudioContext, dest: AudioNode, s: ToneSpec): number {
  const attack = s.attack ?? 0.004;
  const end = s.at + attack + s.decay;
  const osc = ctx.createOscillator();
  osc.type = s.type ?? 'sine';
  osc.frequency.setValueAtTime(s.freq, s.at);
  if (s.glide !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, s.glide), s.at + (s.glideTime ?? s.decay));
  const env = ctx.createGain();
  env.gain.setValueAtTime(SILENT, s.at);
  env.gain.linearRampToValueAtTime(Math.max(SILENT, s.gain), s.at + attack);
  env.gain.exponentialRampToValueAtTime(SILENT, end);
  let filter: BiquadFilterNode | null = null;
  if (s.lowpass !== undefined) {
    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = s.lowpass;
    filter.Q.value = 0.5;
    osc.connect(filter).connect(env);
  } else {
    osc.connect(env);
  }
  env.connect(dest);
  let vibGain: GainNode | null = null;
  if (s.vibratoHz !== undefined && s.vibratoDepth !== undefined) {
    const vib = ctx.createOscillator();
    vib.frequency.value = s.vibratoHz;
    vibGain = ctx.createGain();
    vibGain.gain.value = s.vibratoDepth;
    vib.connect(vibGain).connect(osc.frequency);
    vib.start(s.at);
    vib.stop(end + 0.02);
  }
  osc.start(s.at);
  osc.stop(end + 0.02);
  const onEnd = s.onEnd;
  osc.onended = () => {
    env.disconnect();
    filter?.disconnect();
    vibGain?.disconnect();
    onEnd?.();
  };
  return end;
}

export interface NoiseSpec {
  buffer: AudioBuffer;
  at: number;
  gain: number;
  decay: number;
  attack?: number;
  type?: BiquadFilterType;
  freq: number;
  /** Optional exponential filter sweep target (Hz). */
  freqEnd?: number;
  q?: number;
}

/** A filtered noise layer (transient clicks, whooshes, droplets). Returns the end time. */
export function playNoise(ctx: BaseAudioContext, dest: AudioNode, s: NoiseSpec): number {
  const attack = s.attack ?? 0.001;
  const end = s.at + attack + s.decay;
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = s.type ?? 'bandpass';
  filter.frequency.setValueAtTime(s.freq, s.at);
  if (s.freqEnd !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(20, s.freqEnd), end);
  filter.Q.value = s.q ?? 1;
  const env = ctx.createGain();
  env.gain.setValueAtTime(SILENT, s.at);
  env.gain.linearRampToValueAtTime(Math.max(SILENT, s.gain), s.at + attack);
  env.gain.exponentialRampToValueAtTime(SILENT, end);
  src.connect(filter).connect(env).connect(dest);
  src.start(s.at, Math.random() * Math.max(0, s.buffer.duration - end + s.at - 0.05));
  src.stop(end + 0.02);
  src.onended = () => env.disconnect();
  return end;
}

/** A momentary stereo-placed sub-bus for a multi-layer event; disconnects itself after `dispose()` is invoked. */
export function eventBus(ctx: BaseAudioContext, dest: AudioNode, pan: number, gain: number): { input: GainNode; dispose: () => void } {
  const input = ctx.createGain();
  input.gain.value = gain;
  const panner = ctx.createStereoPanner();
  panner.pan.value = clamp(pan, -1, 1);
  input.connect(panner).connect(dest);
  return {
    input,
    dispose: () => {
      input.disconnect();
      panner.disconnect();
    },
  };
}

export const midiToHz = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);
