/**
 * Cozy Coaster's procedural audio engine. Every sound is synthesised at runtime with the Web Audio API — no files.
 *
 * Graph: ui / construction / coaster / environment / music buses → master gain → gentle compressor → soft limiter → out.
 *
 * Safety model: nothing is created until `unlock()` is called from a user gesture. Before that, and in environments without
 * an AudioContext (SSR, Node tests), every method is a cheap no-op. Continuous layers (coaster, ambience, support growth)
 * are built lazily on first use and then only steered with smoothed parameter changes.
 */
import type { BuildMaterial, BuildSound, CoasterAudioState, EnvironmentAudioState, UiSound, Volumes } from './types';
import { Ambience } from './ambience';
import { CoasterAudio } from './coaster-audio';
import { Music } from './music';
import { BUILD_RECIPES, PIECE_RECIPES, type PieceSound, GrowthTexture, UI_RECIPES, type RecipeEntry } from './sounds';
import { RateLimiter, SmoothParam, VoiceLimiter, clamp01, createNoiseBank, type NoiseBank } from './synth';

export type { BuildMaterial, BuildSound, CoasterAudioState, EnvironmentAudioState, UiSound, Volumes } from './types';
export { RateLimiter, VoiceLimiter } from './synth';
export { MUSIC_MAX_VOICES } from './music';

/** Max concurrent one-shot voices (UI, build, clacks, bird phrases, droplets). Music has its own cap (MUSIC_MAX_VOICES). */
export const MAX_VOICES = 24;

/** Minimum ms between repeats of the same sound; continuous drags never machine-gun. */
export const RATE_LIMITS: Readonly<Record<string, number>> = {
  slider: 50,
  'build:preview-tick': 50,
  colour: 45,
  tap: 30,
  'build:snap': 40,
  chain: 35,
};
const DEFAULT_RATE_MS = 25;

/** Per-bus trims keep overall loudness modest and the families balanced at equal user volumes. */
const BUS_TRIM = { ui: 0.55, construction: 0.6, coaster: 0.7, environment: 0.55, music: 0.55 } as const;
type BusName = keyof typeof BUS_TRIM;
const BUS_NAMES: readonly BusName[] = ['ui', 'construction', 'coaster', 'environment', 'music'];

const VOLUME_TC = 0.08;
const MASTER_LEVEL = 0.85;

export const DEFAULT_VOLUMES: Readonly<Volumes> = {
  master: 0.8, ui: 0.7, construction: 0.8, coaster: 0.8, environment: 0.7, music: 0.5, muted: false,
};

/** Returns a copy of `v` with every channel clamped to 0..1 (non-finite values become 0). */
export function clampVolumes(v: Volumes): Volumes {
  return {
    master: clamp01(v.master),
    ui: clamp01(v.ui),
    construction: clamp01(v.construction),
    coaster: clamp01(v.coaster),
    environment: clamp01(v.environment),
    music: clamp01(v.music),
    muted: Boolean(v.muted),
  };
}

type AudioContextCtor = new () => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const g = globalThis as typeof globalThis & { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  if (typeof g.AudioContext === 'function') return g.AudioContext;
  if (typeof g.webkitAudioContext === 'function') return g.webkitAudioContext;
  return null;
}

interface Graph {
  ctx: AudioContext;
  noise: NoiseBank;
  master: GainNode;
  masterLevel: SmoothParam;
  buses: Record<BusName, GainNode>;
  busLevels: Record<BusName, SmoothParam>;
}

export class AudioEngine {
  private graph: Graph | null = null;
  private isUnlocked = false;
  private disposed = false;
  private hidden = false;
  private warnedUnsupported = false;
  private volumes: Volumes = { ...DEFAULT_VOLUMES };
  private musicOn = false;
  private readonly voices = new VoiceLimiter(MAX_VOICES);
  private readonly limiter = new RateLimiter(RATE_LIMITS, DEFAULT_RATE_MS);

  private coaster: CoasterAudio | null = null;
  private ambience: Ambience | null = null;
  private growth: GrowthTexture | null = null;
  private music: Music | null = null;

  get unlocked(): boolean {
    return this.isUnlocked;
  }

  /** Create/resume the AudioContext. Call from a user gesture; safe to call repeatedly; never throws. */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.graph) {
        const Ctor = getAudioContextCtor();
        if (!Ctor) {
          if (!this.warnedUnsupported) console.warn('[audio] Web Audio is not available; running silently.');
          this.warnedUnsupported = true;
          return;
        }
        this.graph = this.buildGraph(new Ctor());
      }
      // A user gesture implies the page is visible.
      this.hidden = false;
      const { ctx } = this.graph;
      if (ctx.state !== 'running') await ctx.resume();
      this.isUnlocked = ctx.state === 'running';
    } catch (err) {
      console.warn('[audio] unlock failed', err);
    }
  }

  private buildGraph(ctx: AudioContext): Graph {
    const noise = createNoiseBank(ctx);
    // Gentle glue compression, then a fast high-threshold limiter as a safety net against clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -3;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.002;
    limit.release.value = 0.1;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(comp).connect(limit).connect(ctx.destination);
    const v = this.volumes;
    const masterLevel = new SmoothParam(master.gain, VOLUME_TC);
    masterLevel.set(v.muted ? 0 : v.master * MASTER_LEVEL, ctx.currentTime, 0.15);
    const buses = {} as Record<BusName, GainNode>;
    const busLevels = {} as Record<BusName, SmoothParam>;
    for (const name of BUS_NAMES) {
      const g = ctx.createGain();
      g.connect(master);
      buses[name] = g;
      busLevels[name] = new SmoothParam(g.gain, VOLUME_TC, this.busTarget(name));
    }
    this.music = new Music(ctx, noise, buses.music);
    this.music.setEnabled(this.musicOn);
    return { ctx, noise, master, masterLevel, buses, busLevels };
  }

  private busTarget(name: BusName): number {
    // Music fades itself in/out (and stops scheduling) when toggled, so its bus is not gated here.
    return this.volumes[name] * BUS_TRIM[name];
  }

  /** The graph if sound can be played right now, else null. */
  private live(): Graph | null {
    const g = this.graph;
    if (!g || !this.isUnlocked || this.hidden || g.ctx.state !== 'running') return null;
    return g;
  }

  /** Current (clamped) volumes. */
  getVolumes(): Readonly<Volumes> {
    return this.volumes;
  }

  setVolumes(v: Volumes): void {
    this.volumes = clampVolumes(v);
    this.applyVolumes();
  }

  private applyVolumes(): void {
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    g.masterLevel.set(this.volumes.muted ? 0 : this.volumes.master * MASTER_LEVEL, now);
    for (const name of BUS_NAMES) g.busLevels[name].set(this.busTarget(name), now);
  }

  private oneShot(key: string, entry: RecipeEntry, bus: BusName): void {
    const g = this.live();
    if (!g) return;
    const now = g.ctx.currentTime;
    if (!this.limiter.allow(key, now * 1000)) return;
    if (!this.voices.tryAcquire(now, now + entry.dur + 0.03)) return;
    entry.play(g.ctx, g.noise, g.buses[bus], now + 0.005);
  }

  ui(sound: UiSound): void {
    this.oneShot(sound, UI_RECIPES[sound], 'ui');
  }

  build(material: BuildMaterial, sound: BuildSound): void {
    this.oneShot(`build:${sound}`, BUILD_RECIPES[material][sound], 'construction');
  }

  /** A sound for the kind of piece just added in edit mode (ratchet for climbs, whoosh for drops…). */
  piece(sound: PieceSound): void {
    this.oneShot(`piece:${sound}`, PIECE_RECIPES[sound], 'construction');
  }

  supportGrowth(active: boolean, material: BuildMaterial): void {
    const g = this.live();
    if (!g) return;
    if (!this.growth) {
      if (!active) return;
      this.growth = new GrowthTexture(g.ctx, g.noise, g.buses.construction);
    }
    this.growth.set(active, material);
  }

  /** Per-frame. Allocation-free after the first call (which lazily builds the continuous coaster layers). */
  updateCoaster(state: CoasterAudioState, _dt: number): void {
    const g = this.live();
    if (!g) return;
    if (!this.coaster) this.coaster = new CoasterAudio(g.ctx, g.noise, g.buses.coaster);
    this.coaster.update(state);
    this.music?.tick(g.ctx.currentTime);
  }

  chainClack(): void {
    const g = this.live();
    if (!g || !this.coaster) return;
    const now = g.ctx.currentTime;
    if (!this.limiter.allow('chain', now * 1000)) return;
    if (!this.voices.tryAcquire(now, now + 0.06)) return;
    this.coaster.clack();
  }

  updateEnvironment(state: EnvironmentAudioState, dt: number): void {
    const g = this.live();
    if (!g) return;
    if (!this.ambience) this.ambience = new Ambience(g.ctx, g.noise, g.buses.environment, this.voices);
    this.ambience.update(state, Number.isFinite(dt) ? dt : 0);
    this.music?.tick(g.ctx.currentTime);
  }

  setMusicEnabled(on: boolean): void {
    this.musicOn = on;
    this.music?.setEnabled(on);
    this.applyVolumes();
  }

  suspend(): void {
    this.hidden = true;
    const g = this.graph;
    if (!g || g.ctx.state !== 'running') return;
    g.ctx.suspend().catch((err: unknown) => console.warn('[audio] suspend failed', err));
  }

  resume(): void {
    this.hidden = false;
    const g = this.graph;
    if (!g || !this.isUnlocked || g.ctx.state !== 'suspended') return;
    g.ctx.resume().catch((err: unknown) => console.warn('[audio] resume failed', err));
  }

  activeVoices(): number {
    const g = this.graph;
    if (!g || !this.isUnlocked) return 0;
    return this.voices.active(g.ctx.currentTime);
  }

  dispose(): void {
    this.disposed = true;
    this.isUnlocked = false;
    const g = this.graph;
    this.graph = null;
    try {
      this.coaster?.dispose();
      this.ambience?.dispose();
      this.growth?.dispose();
      this.music?.dispose();
    } catch (err) {
      console.warn('[audio] dispose failed', err);
    }
    this.coaster = null;
    this.ambience = null;
    this.growth = null;
    this.music = null;
    this.voices.clear();
    this.limiter.reset();
    if (g) g.ctx.close().catch((err: unknown) => console.warn('[audio] close failed', err));
  }
}
