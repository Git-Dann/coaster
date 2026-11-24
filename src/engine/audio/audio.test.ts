import { afterEach, describe, expect, test } from 'vitest';
import { AudioEngine, DEFAULT_VOLUMES, MAX_VOICES, clampVolumes, type CoasterAudioState, type EnvironmentAudioState, type UiSound } from './audio-engine';
import { RateLimiter, VoiceLimiter, clamp01 } from './synth';

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
class FakeSource extends FakeNode {
  onended: (() => void) | null = null;
  started = false;
  start(): void { this.started = true; }
  stop(): void { /* no-op */ }
}
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
