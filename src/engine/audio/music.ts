/**
 * Generative lo-fi hip-hop / chillhop soundtrack, synthesised entirely at runtime (no samples or files).
 *
 * Modules:
 * - `lofi-theory.ts`: chords, voice leading, progressions, pentatonic melody phrases (pure).
 * - `lofi-song.ts`: song generator (tempo 72–82 BPM, swing, key, progression, groove, 2–3 min section layout) (pure).
 * - `lofi-sequencer.ts`: look-ahead 16th-note scheduler on the audio clock that emits note events (pure).
 * - `lofi-instruments.ts`: kick, brushed snare / rim, hats, Rhodes, bass, pluck lead, vinyl crackle (Web Audio).
 * - This file: the music mix graph, the enable/disable fades, voice capping, and wiring sequencer events to instruments.
 *
 * Mix graph (built lazily on first enable):
 *
 *   drums ─► low-pass 9 kHz ─────────────────────────┐
 *   keys (tremolo) ─┬► tape delay (wow + flutter LFOs) ─► low-pass 3.8 kHz ─┤
 *   lead ───────────┘                                 │
 *   bass ─► low-pass 750 Hz ─────────────────────────┼─► fade ─► drive ─► tanh WaveShaper ─► low-pass 7.6 kHz ─► out ─► music bus
 *   crackle bed + brown-noise rumble + pops ─────────┘
 *
 * `tick(now)` is polled from the engine's per-frame updates; everything in the next 0.3 s is scheduled on the audio clock.
 */
import {
  bass, createCrackleBuffer, ghost, hat, kick, pluck, pop, rhodes, rim, saturationCurve, snare,
} from './lofi-instruments';
import { LofiSequencer, type EventSink, type MusicEvent } from './lofi-sequencer';
import type { Rng } from './lofi-theory';
import { VoiceLimiter, lfo, loopNoise, type NoiseBank } from './synth';

/** Music voices are capped separately from UI/world sounds so neither starves the other. */
export const MUSIC_MAX_VOICES = 24;
/** Scheduling horizon (s). */
export const MUSIC_LOOKAHEAD = 0.3;
export const MUSIC_FADE_IN = 3.5;
export const MUSIC_FADE_OUT = 1.5;
/** Low-priority events (ghost notes, open hats, pops) only play while this many voices are still free. */
const LOW_PRIORITY_HEADROOM = 6;

export interface MusicOptions {
  /** Called for every scheduled event (after clamping to the audio clock). For tests and debugging. */
  onEvent?: EventSink;
  /** Randomness for the song generator / sequencer (defaults to Math.random). */
  rng?: Rng;
  maxVoices?: number;
}

interface MusicGraph {
  fade: GainNode;
  drums: GainNode;
  keys: GainNode;
  lead: GainNode;
  bass: GainNode;
  fx: GainNode;
  crackleIn: AudioNode;
  rumbleIn: AudioNode;
  crackle: AudioBuffer;
  lfos: OscillatorNode[];
  nodes: AudioNode[];
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function gainNode(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** Linear ramp from the parameter's current value to `target` over `dur`, replacing any pending automation. */
function rampTo(param: AudioParam, now: number, target: number, dur: number): void {
  const from = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  param.linearRampToValueAtTime(target, now + dur);
}

export class Music {
  private readonly ctx: BaseAudioContext;
  private readonly noise: NoiseBank;
  private readonly dest: AudioNode;
  private readonly voices: VoiceLimiter;
  private readonly onEvent: EventSink | undefined;
  private readonly seq: LofiSequencer;

  private graph: MusicGraph | null = null;
  private texture: AudioBufferSourceNode[] = [];
  private enabled = false;
  /** Scheduling is active (true while enabled, and during the fade-out). */
  private running = false;
  private needsStart = false;
  private stopAt = Infinity;
  private disposed = false;

  constructor(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode, options: MusicOptions = {}) {
    this.ctx = ctx;
    this.noise = noise;
    this.dest = dest;
    this.voices = new VoiceLimiter(options.maxVoices ?? MUSIC_MAX_VOICES);
    this.onEvent = options.onEvent;
    this.seq = new LofiSequencer(options.rng ?? Math.random, (ev) => this.play(ev));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** True while notes are being scheduled (including the fade-out). */
  get isPlaying(): boolean {
    return this.running;
  }

  /** The sequencer (read-only use: current song, position). */
  get sequencer(): LofiSequencer {
    return this.seq;
  }

  activeVoices(now = this.ctx.currentTime): number {
    return this.voices.active(now);
  }

  /** On: fade in over ~3.5 s (a new song starts if music was stopped). Off: fade out over ~1.5 s, then stop scheduling. */
  setEnabled(on: boolean): void {
    if (this.disposed || on === this.enabled) return;
    this.enabled = on;
    const now = this.ctx.currentTime;
    if (on) {
      const g = this.ensureGraph();
      if (!this.running) {
        this.running = true;
        this.needsStart = true;
      }
      this.stopAt = Infinity;
      this.startTexture(g, now);
      rampTo(g.fade.gain, now, 1, MUSIC_FADE_IN);
    } else {
      const g = this.graph;
      if (!g || !this.running) return;
      this.stopAt = now + MUSIC_FADE_OUT;
      rampTo(g.fade.gain, now, 0, MUSIC_FADE_OUT);
      this.stopTexture(this.stopAt + 0.05);
    }
  }

  /** Polled every frame with the audio clock. Cheap when idle. */
  tick(now: number): void {
    if (!this.running || this.disposed) return;
    if (!this.enabled && now >= this.stopAt) {
      this.running = false;
      return;
    }
    if (this.needsStart) {
      this.needsStart = false;
      this.seq.start(now + 0.1);
    }
    this.seq.advanceTo(now, MUSIC_LOOKAHEAD, this.stopAt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    this.enabled = false;
    const g = this.graph;
    this.graph = null;
    this.stopTexture(this.ctx.currentTime);
    if (!g) return;
    for (const o of g.lfos) {
      try {
        o.stop();
      } catch {
        // already stopped
      }
    }
    for (const n of g.nodes) n.disconnect();
  }

  // -------------------------------------------------------------------------------------------------------------------

  private ensureGraph(): MusicGraph {
    if (this.graph) return this.graph;
    const ctx = this.ctx;
    const nodes: AudioNode[] = [];
    const keep = <T extends AudioNode>(n: T): T => {
      nodes.push(n);
      return n;
    };

    // Master chain: fade → drive → soft saturation → warm low-pass → out.
    const out = keep(gainNode(ctx, 0.75));
    out.connect(this.dest);
    const tone = keep(filter(ctx, 'lowpass', 7600, 0.5));
    tone.connect(out);
    const shaper = keep(ctx.createWaveShaper());
    shaper.curve = saturationCurve();
    shaper.oversample = '2x';
    shaper.connect(tone);
    const drive = keep(gainNode(ctx, 1.25));
    drive.connect(shaper);
    const fade = keep(gainNode(ctx, 0));
    fade.connect(drive);

    // Drums: a little low-pass for warmth.
    const drumsLp = keep(filter(ctx, 'lowpass', 9000, 0.4));
    drumsLp.connect(fade);
    const drums = keep(gainNode(ctx, 0.9));
    drums.connect(drumsLp);

    // Keys and lead share a "tape": a short delay whose time is wobbled by slow wow and faster flutter LFOs.
    const keysLp = keep(filter(ctx, 'lowpass', 3800, 0.3));
    keysLp.connect(fade);
    const tape = keep(ctx.createDelay(0.05));
    tape.delayTime.value = 0.012;
    tape.connect(keysLp);
    const keys = keep(gainNode(ctx, 1));
    keys.connect(tape);
    const lead = keep(gainNode(ctx, 0.9));
    lead.connect(tape);
    const lfos: OscillatorNode[] = [];
    const wow = lfo(ctx, 0.45, 0.0011, tape.delayTime);
    const flutter = lfo(ctx, 5.7, 0.00012, tape.delayTime);
    const tremolo = lfo(ctx, 3.6, 0.07, keys.gain);
    for (const l of [wow, flutter, tremolo]) {
      lfos.push(l.osc);
      nodes.push(l.depth);
    }

    // Bass: round and low-passed.
    const bassLp = keep(filter(ctx, 'lowpass', 750, 0.5));
    bassLp.connect(fade);
    const bassIn = keep(gainNode(ctx, 1));
    bassIn.connect(bassLp);

    // Texture: crackle bed (high-passed clicks) + very quiet brown-noise rumble + pops. Bypasses the tape.
    const fx = keep(gainNode(ctx, 1));
    fx.connect(fade);
    const crackleLevel = keep(gainNode(ctx, 0.07));
    crackleLevel.connect(fx);
    const crackleLp = keep(filter(ctx, 'lowpass', 5500, 0.5));
    crackleLp.connect(crackleLevel);
    const crackleIn = keep(filter(ctx, 'highpass', 900, 0.5));
    crackleIn.connect(crackleLp);
    const rumbleLevel = keep(gainNode(ctx, 0.035));
    rumbleLevel.connect(fx);
    const rumbleIn = keep(filter(ctx, 'lowpass', 420, 0.5));
    rumbleIn.connect(rumbleLevel);

    this.graph = {
      fade, drums, keys, lead, bass: bassIn, fx, crackleIn, rumbleIn,
      crackle: createCrackleBuffer(ctx), lfos, nodes,
    };
    return this.graph;
  }

  private startTexture(g: MusicGraph, now: number): void {
    // Any previous (fading) texture keeps its scheduled stop; start a fresh pair.
    this.stopTexture(now + MUSIC_FADE_OUT);
    this.texture = [loopNoise(this.ctx, g.crackle, g.crackleIn), loopNoise(this.ctx, this.noise.brown, g.rumbleIn)];
  }

  private stopTexture(at: number): void {
    for (const src of this.texture) {
      try {
        src.stop(at);
      } catch {
        // already stopped
      }
      src.onended = () => src.disconnect();
    }
    this.texture = [];
  }

  /** Sequencer sink: clamps to the audio clock, applies the voice cap, and plays the instrument. */
  private play(ev: Readonly<MusicEvent>): void {
    const g = this.graph;
    if (!g) return;
    const at = Math.max(ev.time, this.ctx.currentTime + 0.005);
    if (this.onEvent) this.onEvent({ ...ev, time: at });
    const low = ev.inst === 'ghost' || ev.inst === 'openhat' || ev.inst === 'pop';
    if (low && this.voices.active(at) > this.voices.capacity - LOW_PRIORITY_HEADROOM) return;
    if (!this.voices.tryAcquire(at, at + estimateLength(ev))) return;
    const { ctx, noise } = this;
    switch (ev.inst) {
      case 'kick': kick(ctx, g.drums, at, ev.vel); break;
      case 'snare': snare(ctx, noise, g.drums, at, ev.vel); break;
      case 'rim': rim(ctx, noise, g.drums, at, ev.vel); break;
      case 'ghost': ghost(ctx, noise, g.drums, at, ev.vel); break;
      case 'hat': hat(ctx, noise, g.drums, at, ev.vel, false); break;
      case 'openhat': hat(ctx, noise, g.drums, at, ev.vel, true); break;
      case 'keys': rhodes(ctx, g.keys, at, ev.midi, ev.vel, ev.dur); break;
      case 'bass': bass(ctx, g.bass, at, ev.midi, ev.vel, ev.dur); break;
      case 'lead': pluck(ctx, g.lead, at, ev.midi, ev.vel, ev.dur); break;
      case 'pop': pop(ctx, noise, g.fx, at, ev.vel); break;
    }
  }
}

/** Approximate audible length of an event, for voice accounting. */
function estimateLength(ev: Readonly<MusicEvent>): number {
  switch (ev.inst) {
    case 'kick': return 0.4;
    case 'snare': return 0.2;
    case 'rim': return 0.06;
    case 'ghost': return 0.08;
    case 'hat': return 0.04;
    case 'openhat': return 0.31;
    case 'keys': return ev.dur + 0.9;
    case 'bass': return ev.dur + 0.35;
    case 'lead': return ev.dur + 0.7;
    case 'pop': return 0.015;
  }
}
