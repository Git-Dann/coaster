import { afterEach, describe, expect, test } from 'vitest';
import { AudioEngine, DEFAULT_VOLUMES, MAX_VOICES, clampVolumes, type CoasterAudioState, type EnvironmentAudioState, type UiSound } from './audio-engine';
import { RateLimiter, VoiceLimiter, clamp01, createNoiseBank } from './synth';
import { MUSIC_FADE_OUT, MUSIC_LOOKAHEAD, MUSIC_MAX_VOICES, Music } from './music';
import { LofiSequencer, type MusicEvent } from './lofi-sequencer';
import { BPM_MAX, BPM_MIN, SONG_MAX_SECONDS, SONG_MIN_SECONDS, generateSong } from './lofi-song';
import {
  MELODY_HIGH, MELODY_LOW, PROGRESSIONS, VOICING_HIGH, VOICING_LOW, buildProgression, chordPitchClasses, melodyPhrase,
  mulberry32, voiceMovement,
} from './lofi-theory';

const UI_SOUNDS: UiSound[] = [
  'tap', 'select', 'toggle', 'slider', 'open', 'close', 'undo', 'redo', 'save', 'colour', 'material',
  'carriage-add', 'carriage-remove', 'error-soft', 'success', 'circuit-complete',
];

const coasterState: CoasterAudioState = {
  speed: 12, liftEngaged: false, braking: 0, launching: false, material: 'timber',
  distance: 20, pan: 0.3, riding: false, verticalG: 1, inStation: false,
};
const envState: EnvironmentAudioState = { biome: 'meadow', weather: 'clear', hour: 7, water: 0.4, cameraHeight: 10 };

function exerciseAll(engine: AudioEngine): void {
  engine.setVolumes({ ...DEFAULT_VOLUMES });
  for (const s of UI_SOUNDS) engine.ui(s);
  for (const m of ['timber', 'steel'] as const) {
    for (const b of ['snap', 'place', 'delete', 'preview-tick'] as const) engine.build(m, b);
    engine.supportGrowth(true, m);
    engine.supportGrowth(false, m);
  }
  engine.updateCoaster(coasterState, 1 / 60);
  engine.updateCoaster({ ...coasterState, material: 'steel', riding: true, verticalG: 0.1, braking: 1, launching: true, liftEngaged: true }, 1 / 60);
  engine.chainClack();
  engine.updateEnvironment(envState, 1 / 60);
  engine.setMusicEnabled(true);
  engine.setMusicEnabled(false);
  engine.suspend();
  engine.resume();
}

// ----- minimal fake Web Audio ----------------------------------------------------------------------------------------

class FakeParam {
  value = 0;
  setValueAtTime(v: number): this { this.value = v; return this; }
  linearRampToValueAtTime(v: number): this { this.value = v; return this; }
  exponentialRampToValueAtTime(v: number): this {
    if (!(v > 0)) throw new RangeError('exponential ramp target must be positive');
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number): this { this.value = v; return this; }
  cancelScheduledValues(): this { return this; }
}

class FakeNode {
  connections = 0;
  connect<T>(dest: T): T { this.connections++; return dest; }
  disconnect(): void { this.connections = 0; }
}

class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakePanner extends FakeNode { pan = new FakeParam(); }
class FakeFilter extends FakeNode { type = 'lowpass'; frequency = new FakeParam(); Q = new FakeParam(); }
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(); knee = new FakeParam(); ratio = new FakeParam(); attack = new FakeParam(); release = new FakeParam();
}
let sourceStarts: number[] = [];
class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  started = false;
  start(when = 0): void { this.started = true; sourceStarts.push(when); }
  stop(): void { /* no-op */ }
}
class FakeShaper extends FakeNode { curve: Float32Array | null = null; oversample = 'none'; }
class FakeDelay extends FakeNode { delayTime = new FakeParam(); }
class FakeOsc extends FakeSource { type = 'sine'; frequency = new FakeParam(); detune = new FakeParam(); }
class FakeBufferSource extends FakeSource { buffer: FakeBuffer | null = null; loop = false; }
class FakeBuffer {
  readonly duration: number;
  private readonly data: Float32Array;
  constructor(_ch: number, length: number, sampleRate: number) {
    this.data = new Float32Array(length);
    this.duration = length / sampleRate;
  }
  getChannelData(): Float32Array { return this.data; }
}

let created = 0;
class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  constructor() { created++; }
  resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }
  suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }
  close(): Promise<void> { this.state = 'closed'; return Promise.resolve(); }
  createGain(): FakeGain { return new FakeGain(); }
  createStereoPanner(): FakePanner { return new FakePanner(); }
  createBiquadFilter(): FakeFilter { return new FakeFilter(); }
  createDynamicsCompressor(): FakeCompressor { return new FakeCompressor(); }
  createOscillator(): FakeOsc { return new FakeOsc(); }
  createBufferSource(): FakeBufferSource { return new FakeBufferSource(); }
  createWaveShaper(): FakeShaper { return new FakeShaper(); }
  createDelay(): FakeDelay { return new FakeDelay(); }
  createBuffer(ch: number, length: number, rate: number): FakeBuffer { return new FakeBuffer(ch, length, rate); }
}

type MutableGlobal = { AudioContext?: unknown; webkitAudioContext?: unknown };
const g = globalThis as unknown as MutableGlobal;
function installFake(): FakeAudioContext[] {
  const instances: FakeAudioContext[] = [];
  g.AudioContext = class extends FakeAudioContext {
    constructor() { super(); instances.push(this); }
  };
  return instances;
}

afterEach(() => {
  delete g.AudioContext;
  delete g.webkitAudioContext;
});

// ----- tests ---------------------------------------------------------------------------------------------------------

describe('AudioEngine without Web Audio', () => {
  test('every method is a safe no-op before unlock', () => {
    expect(typeof g.AudioContext).toBe('undefined');
    const engine = new AudioEngine();
    expect(engine.unlocked).toBe(false);
    expect(() => exerciseAll(engine)).not.toThrow();
    expect(engine.activeVoices()).toBe(0);
    expect(() => engine.dispose()).not.toThrow();
  });

  test('unlock resolves (never throws) when AudioContext is missing', async () => {
    const engine = new AudioEngine();
    const warn = console.warn;
    console.warn = () => {};
    try {
      await expect(engine.unlock()).resolves.toBeUndefined();
      await engine.unlock();
    } finally {
      console.warn = warn;
    }
    expect(engine.unlocked).toBe(false);
    expect(() => exerciseAll(engine)).not.toThrow();
    expect(engine.activeVoices()).toBe(0);
  });

  test('activeVoices() is 0 before unlock even with Web Audio present', () => {
    installFake();
    const engine = new AudioEngine();
    engine.ui('tap');
    expect(engine.activeVoices()).toBe(0);
  });
});

describe('volumes', () => {
  test('are clamped to 0..1', () => {
    const v = clampVolumes({ master: 2, ui: -1, construction: 0.5, coaster: Number.NaN, environment: Infinity, music: 1.0001, muted: false });
    expect(v).toEqual({ master: 1, ui: 0, construction: 0.5, coaster: 0, environment: 0, music: 1, muted: false });
    const engine = new AudioEngine();
    engine.setVolumes({ master: 5, ui: -3, construction: 0.25, coaster: 1, environment: 0, music: 9, muted: true });
    expect(engine.getVolumes()).toEqual({ master: 1, ui: 0, construction: 0.25, coaster: 1, environment: 0, music: 1, muted: true });
    expect(clamp01(-0.5)).toBe(0);
  });
});

describe('RateLimiter', () => {
  test('suppresses repeated slider calls within the window', () => {
    const rl = new RateLimiter({ slider: 50 }, 0);
    expect(rl.allow('slider', 0)).toBe(true);
    expect(rl.allow('slider', 10)).toBe(false);
    expect(rl.allow('slider', 49)).toBe(false);
    expect(rl.allow('slider', 50)).toBe(true);
    expect(rl.allow('slider', 60)).toBe(false);
    // other keys are independent and unlimited with a 0 default
    expect(rl.allow('tap', 60)).toBe(true);
    expect(rl.allow('tap', 60)).toBe(true);
  });

  test('a clock that jumps backwards does not lock a key out', () => {
    const rl = new RateLimiter({ slider: 50 });
    expect(rl.allow('slider', 1000)).toBe(true);
    expect(rl.allow('slider', 0)).toBe(true);
  });
});

describe('VoiceLimiter', () => {
  test('caps concurrent voices and frees slots by end time', () => {
    const vl = new VoiceLimiter(2);
    expect(vl.tryAcquire(0, 1)).toBe(true);
    expect(vl.tryAcquire(0, 2)).toBe(true);
    expect(vl.tryAcquire(0, 1)).toBe(false);
    expect(vl.active(0.5)).toBe(2);
    expect(vl.active(1.5)).toBe(1);
    expect(vl.tryAcquire(1.5, 3)).toBe(true);
  });
});

describe('AudioEngine with a fake AudioContext', () => {
  test('unlock creates one context, is idempotent, and plays one-shots within limits', async () => {
    const instances = installFake();
    const engine = new AudioEngine();
    await engine.unlock();
    await engine.unlock();
    expect(instances.length).toBe(1);
    expect(engine.unlocked).toBe(true);

    engine.ui('tap');
    expect(engine.activeVoices()).toBe(1);

    // Slider drag at the same instant: only one voice.
    for (let i = 0; i < 20; i++) engine.ui('slider');
    expect(engine.activeVoices()).toBe(2);

    // Global cap holds under a flood of distinct sounds over time.
    const ctx = instances[0];
    if (!ctx) throw new Error('no context');
    for (let i = 0; i < 200; i++) {
      ctx.currentTime += 0.03;
      for (const s of UI_SOUNDS) engine.ui(s);
    }
    expect(engine.activeVoices()).toBeLessThanOrEqual(MAX_VOICES);
    ctx.currentTime += 10;
    expect(engine.activeVoices()).toBe(0);
  });

  test('continuous layers, ambience and music run without throwing', async () => {
    const instances = installFake();
    const engine = new AudioEngine();
    await engine.unlock();
    const ctx = instances[0];
    if (!ctx) throw new Error('no context');
    expect(() => exerciseAll(engine)).not.toThrow();

    engine.setMusicEnabled(true);
    const before = created;
    // Simulate two minutes of frames across biomes/weather/time of day.
    const biomes = ['meadow', 'woodland', 'alpine', 'coastal', 'autumn', 'winter'] as const;
    const weathers = ['clear', 'partly-cloudy', 'overcast', 'light-rain', 'rain', 'snow', 'mist', 'golden-haze'] as const;
    for (let f = 0; f < 120 * 30; f++) {
      ctx.currentTime += 1 / 30;
      const env: EnvironmentAudioState = {
        biome: biomes[Math.floor(f / 600) % biomes.length] ?? 'meadow',
        weather: weathers[Math.floor(f / 450) % weathers.length] ?? 'clear',
        hour: (f / 150) % 24,
        water: 0.5,
        cameraHeight: 30,
      };
      engine.updateEnvironment(env, 1 / 30);
      engine.updateCoaster({ ...coasterState, speed: 25 * Math.sin(f / 100) }, 1 / 30);
      if (f % 10 === 0) engine.chainClack();
    }
    expect(created).toBe(before); // no extra contexts
    expect(engine.activeVoices()).toBeLessThanOrEqual(MAX_VOICES);

    engine.suspend();
    expect(ctx.state).toBe('suspended');
    engine.ui('tap'); // ignored while hidden
    engine.resume();
    await Promise.resolve();
    expect(ctx.state).toBe('running');

    engine.dispose();
    await Promise.resolve();
    expect(ctx.state).toBe('closed');
    expect(engine.unlocked).toBe(false);
    expect(() => exerciseAll(engine)).not.toThrow();
  });
});

// ----- lo-fi music ---------------------------------------------------------------------------------------------------

describe('lo-fi theory', () => {
  test('progressions produce valid, smoothly voice-led voicings in a warm register', () => {
    let total = 0;
    let transitions = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed);
      const template = PROGRESSIONS[seed % PROGRESSIONS.length];
      if (!template) throw new Error('no template');
      const chords = buildProgression(rng, seed % 12, template, seed % 2 === 0);
      expect(chords.reduce((n, c) => n + c.beats, 0)).toBe(seed % 2 === 0 ? 32 : 16);
      for (const c of chords) {
        expect(c.notes.length).toBe(4);
        const pcs = chordPitchClasses(c.rootPc, c.quality);
        for (let i = 0; i < c.notes.length; i++) {
          const n = c.notes[i] ?? 0;
          expect(n).toBeGreaterThanOrEqual(VOICING_LOW);
          expect(n).toBeLessThanOrEqual(VOICING_HIGH);
          expect(pcs).toContain(n % 12);
          if (i > 0) expect(n).toBeGreaterThan(c.notes[i - 1] ?? 0); // sorted, distinct
        }
        expect((c.notes[3] ?? 0) - (c.notes[0] ?? 0)).toBeLessThanOrEqual(16);
        expect(c.bassRoot % 12).toBe(c.rootPc);
        expect(c.bassRoot).toBeGreaterThanOrEqual(38);
        expect(c.bassRoot).toBeLessThan(50);
      }
      // Consecutive chords, including the loop's wrap-around.
      for (let i = 0; i < chords.length; i++) {
        const a = chords[i]?.notes ?? [];
        const b = chords[(i + 1) % chords.length]?.notes ?? [];
        const m = voiceMovement(a, b);
        expect(m).toBeLessThan(6);
        total += m;
        transitions++;
      }
    }
    expect(total / transitions).toBeLessThan(4);
  });

  test('melody phrases are sparse, pentatonic and in range', () => {
    const rng = mulberry32(7);
    const penta = [0, 2, 4, 7, 9];
    for (let i = 0; i < 300; i++) {
      const key = i % 12;
      const phrase = melodyPhrase(rng, key, () => [key, (key + 4) % 12, (key + 7) % 12], 72);
      expect(phrase.length).toBeGreaterThanOrEqual(1);
      expect(phrase.length).toBeLessThanOrEqual(6);
      let prevStep = -1;
      for (const n of phrase) {
        expect(n.midi).toBeGreaterThanOrEqual(MELODY_LOW);
        expect(n.midi).toBeLessThanOrEqual(MELODY_HIGH);
        expect(penta).toContain((((n.midi - key) % 12) + 12) % 12);
        expect(n.step).toBeGreaterThan(prevStep);
        expect(n.step).toBeLessThanOrEqual(26);
        prevStep = n.step;
      }
    }
  });
});

describe('lo-fi song generator', () => {
  test('tempo, swing and structure stay within the brief', () => {
    const rng = mulberry32(42);
    let prevKey = -1;
    for (let i = 0; i < 300; i++) {
      const song = generateSong(rng, prevKey);
      expect(song.bpm).toBeGreaterThanOrEqual(BPM_MIN);
      expect(song.bpm).toBeLessThanOrEqual(BPM_MAX);
      expect(song.swing).toBeGreaterThanOrEqual(0.55);
      expect(song.swing).toBeLessThanOrEqual(0.6);
      expect(song.keyPc).not.toBe(prevKey);
      prevKey = song.keyPc;
      expect(song.sections.reduce((n, s) => n + s.bars, 0)).toBe(song.bars);
      expect(song.duration).toBeCloseTo(song.bars * song.barSeconds, 6);
      expect(song.duration).toBeGreaterThanOrEqual(SONG_MIN_SECONDS);
      expect(song.duration).toBeLessThanOrEqual(SONG_MAX_SECONDS);
      expect(song.sections[0]?.kind).toBe('intro');
      expect(song.sections[0]?.drums).toBe('none');
      expect(song.sections[song.sections.length - 1]?.kind).toBe('outro');
      expect(song.sections.some((s) => s.melody)).toBe(true);
      expect(song.chordAtBeat.length).toBe(song.loopBars * 4);
      for (const s of song.sections) expect(s.bars).toBeGreaterThan(0);
    }
  });
});

describe('lo-fi sequencer', () => {
  const key = (e: MusicEvent): string => `${e.inst}:${e.time.toFixed(6)}:${e.midi}`;

  test('schedules ahead on the audio clock without duplicates, across song changes', () => {
    const events: MusicEvent[] = [];
    let now = 0;
    const seq = new LofiSequencer(mulberry32(3), (e) => {
      expect(e.time).toBeGreaterThanOrEqual(now - 0.005);
      expect(e.time).toBeLessThan(now + MUSIC_LOOKAHEAD + 0.2);
      events.push({ ...e });
    });
    seq.start(0.1);
    const rng = mulberry32(99);
    // ~7 minutes of irregular frames (8–50 ms), so at least two song changes.
    while (now < 420) {
      seq.advanceTo(now, MUSIC_LOOKAHEAD);
      now += 0.008 + rng() * 0.042;
    }
    expect(seq.songCount).toBeGreaterThanOrEqual(3);
    const keys = new Set(events.map(key));
    expect(keys.size).toBe(events.length);
    const insts = new Set(events.map((e) => e.inst));
    for (const i of ['kick', 'snare', 'hat', 'keys', 'bass', 'lead'] as const) {
      if (i === 'snare' && !insts.has('snare')) expect(insts.has('rim')).toBe(true);
      else expect(insts.has(i)).toBe(true);
    }
    // Pitched parts stay in their registers.
    for (const e of events) {
      if (e.inst === 'keys') expect(e.midi).toBeGreaterThanOrEqual(VOICING_LOW);
      if (e.inst === 'bass') {
        expect(e.midi).toBeGreaterThanOrEqual(37); // root range 38..49, approach notes one below
        expect(e.midi).toBeLessThanOrEqual(61); // octave pops
      }
      expect(e.vel).toBeGreaterThan(0);
      expect(e.vel).toBeLessThanOrEqual(1.2);
    }
  });

  test('after a 30 s pause it resumes from now instead of bursting the missed notes', () => {
    let now = 0;
    const events: MusicEvent[] = [];
    const seq = new LofiSequencer(mulberry32(11), (e) => events.push({ ...e }));
    seq.start(0.1);
    for (; now < 20; now += 1 / 60) seq.advanceTo(now, MUSIC_LOOKAHEAD);
    events.length = 0;
    now += 30;
    seq.advanceTo(now, MUSIC_LOOKAHEAD);
    for (const e of events) {
      expect(e.time).toBeGreaterThanOrEqual(now);
      expect(e.time).toBeLessThan(now + MUSIC_LOOKAHEAD + 0.2);
    }
    expect(events.length).toBeLessThan(30);
    // ...and carries on normally.
    for (let f = 0; f < 600; f++) {
      now += 1 / 60;
      seq.advanceTo(now, MUSIC_LOOKAHEAD);
    }
    expect(events.length).toBeGreaterThan(20);
    expect(seq.position.time).toBeGreaterThan(now);
    expect(seq.position.time).toBeLessThan(now + MUSIC_LOOKAHEAD + 0.25);
  });
});

describe('Music with a fake AudioContext', () => {
  function setup(seed: number): { ctx: FakeAudioContext; music: Music; events: MusicEvent[] } {
    const ctx = new FakeAudioContext();
    ctx.state = 'running';
    const audio = ctx as unknown as AudioContext;
    const events: MusicEvent[] = [];
    const music = new Music(audio, createNoiseBank(audio, 0.5), audio.createGain(), {
      rng: mulberry32(seed),
      onEvent: (e) => events.push({ ...e }),
    });
    return { ctx, music, events };
  }

  test('does nothing until enabled, then schedules ahead and caps voices', () => {
    const { ctx, music, events } = setup(5);
    for (let f = 0; f < 60; f++) { ctx.currentTime += 1 / 60; music.tick(ctx.currentTime); }
    expect(events.length).toBe(0);

    music.setEnabled(true);
    sourceStarts = [];
    let maxVoices = 0;
    for (let f = 0; f < 60 * 200; f++) {
      ctx.currentTime += 1 / 60;
      const before = sourceStarts.length;
      music.tick(ctx.currentTime);
      // Every source started this tick starts now or later (never in the past).
      for (let i = before; i < sourceStarts.length; i++) expect(sourceStarts[i] ?? 0).toBeGreaterThanOrEqual(ctx.currentTime);
      maxVoices = Math.max(maxVoices, music.activeVoices());
    }
    expect(events.length).toBeGreaterThan(500);
    expect(maxVoices).toBeLessThanOrEqual(MUSIC_MAX_VOICES);
    expect(new Set(events.map((e) => `${e.inst}:${e.time.toFixed(6)}:${e.midi}`)).size).toBe(events.length);
  });

  test('pausing ticks for 30 s does not burst-schedule, and disabling fades out then stops', () => {
    const { ctx, music, events } = setup(8);
    music.setEnabled(true);
    for (let f = 0; f < 60 * 20; f++) { ctx.currentTime += 1 / 60; music.tick(ctx.currentTime); }
    events.length = 0;
    ctx.currentTime += 30;
    music.tick(ctx.currentTime);
    expect(events.length).toBeLessThan(30);
    for (const e of events) expect(e.time).toBeGreaterThanOrEqual(ctx.currentTime);

    music.setEnabled(false);
    expect(music.isPlaying).toBe(true); // still scheduling during the fade-out
    const offAt = ctx.currentTime;
    for (let f = 0; f < 60 * 3; f++) { ctx.currentTime += 1 / 60; music.tick(ctx.currentTime); }
    expect(music.isPlaying).toBe(false);
    for (const e of events) expect(e.time).toBeLessThanOrEqual(offAt + MUSIC_FADE_OUT + 0.1);
    const count = events.length;
    for (let f = 0; f < 60 * 5; f++) { ctx.currentTime += 1 / 60; music.tick(ctx.currentTime); }
    expect(events.length).toBe(count);

    // Re-enabling starts again; dispose is safe and final.
    music.setEnabled(true);
    for (let f = 0; f < 60 * 2; f++) { ctx.currentTime += 1 / 60; music.tick(ctx.currentTime); }
    expect(events.length).toBeGreaterThan(count);
    music.dispose();
    const after = events.length;
    music.setEnabled(true);
    for (let f = 0; f < 60; f++) { ctx.currentTime += 1 / 60; music.tick(ctx.currentTime); }
    expect(events.length).toBe(after);
  });
});
