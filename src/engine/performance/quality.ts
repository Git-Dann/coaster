import type { QualityTier } from '../../types/world';

export interface QualityLevel {
  name: string;
  pixelRatio: number;
  shadowMap: number;
  shadows: boolean;
  shadowExtent: number;
  vegRadius: number;
  vegDensity: number;
  weather: number;
  drawDistance: number;
}

/** Ordered from cheapest to richest. The adaptive controller moves along this ladder. */
export const LEVELS: QualityLevel[] = [
  { name: 'battery', pixelRatio: 0.75, shadowMap: 512, shadows: false, shadowExtent: 50, vegRadius: 120, vegDensity: 0.45, weather: 0.35, drawDistance: 380 },
  { name: 'low', pixelRatio: 1, shadowMap: 1024, shadows: true, shadowExtent: 60, vegRadius: 170, vegDensity: 0.65, weather: 0.5, drawDistance: 460 },
  { name: 'balanced', pixelRatio: 1.25, shadowMap: 1536, shadows: true, shadowExtent: 75, vegRadius: 220, vegDensity: 0.85, weather: 0.75, drawDistance: 560 },
  { name: 'high', pixelRatio: 1.6, shadowMap: 2048, shadows: true, shadowExtent: 90, vegRadius: 270, vegDensity: 1, weather: 1, drawDistance: 680 },
  { name: 'ultra', pixelRatio: 2, shadowMap: 4096, shadows: true, shadowExtent: 110, vegRadius: 330, vegDensity: 1, weather: 1, drawDistance: 820 },
];

export const TIER_INDEX: Record<Exclude<QualityTier, 'auto'>, number> = { battery: 0, balanced: 2, high: 3, ultra: 4 };

/**
 * Adaptive quality from measured frame times (not device names). Uses a rolling window and
 * hysteresis: degrade after sustained slowness, recover only after sustained headroom.
 */
export class QualityController {
  private samples = new Float32Array(120);
  private n = 0;
  private i = 0;
  private slowFor = 0;
  private fastFor = 0;
  level: number;
  /** Target frame time in ms (16.7 for 60 FPS). */
  budget = 1000 / 60;
  changed = false;

  constructor(start = 2) {
    this.level = start;
  }

  push(frameMs: number): void {
    if (!(frameMs > 0) || frameMs > 250) return; // ignore pauses
    this.samples[this.i] = frameMs;
    this.i = (this.i + 1) % this.samples.length;
    this.n = Math.min(this.n + 1, this.samples.length);
  }

  percentile(p: number): number {
    if (this.n === 0) return 0;
    const arr = Array.from(this.samples.subarray(0, this.n)).sort((a, b) => a - b);
    return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]!;
  }

  /** Call about once per second with elapsed seconds; returns true when the level changed. */
  evaluate(dt: number, adaptive: boolean): boolean {
    this.changed = false;
    if (!adaptive || this.n < 60) return false;
    const p90 = this.percentile(0.9);
    const p50 = this.percentile(0.5);
    if (p90 > this.budget * 1.25 || p50 > this.budget * 1.08) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else if (p90 < this.budget * 0.72) {
      this.fastFor += dt;
      this.slowFor = 0;
    } else {
      this.slowFor = Math.max(0, this.slowFor - dt);
      this.fastFor = Math.max(0, this.fastFor - dt * 0.5);
    }
    if (this.slowFor > 2.5 && this.level > 0) {
      this.level--;
      this.slowFor = 0;
      this.n = 0;
      this.changed = true;
    } else if (this.fastFor > 10 && this.level < LEVELS.length - 2) {
      // Auto never climbs to ultra on its own; recovery is gradual.
      this.level++;
      this.fastFor = 0;
      this.n = 0;
      this.changed = true;
    }
    return this.changed;
  }
}
