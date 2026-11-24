import { Simplex2, hash2 } from './noise';
import type { Biome, TerrainStroke } from '../../types/world';

export const CHUNK_SIZE = 128;
export const WATER_LEVEL = 0;
/** Height of the flattened build pad around the origin where the starter coaster lives. */
export const PAD_HEIGHT = 4;

type RGB = [number, number, number];

export interface BiomeConfig {
  amp: number;
  largeAmp: number;
  ridge: number;
  grassLow: RGB;
  grassHigh: RGB;
  dry: RGB;
  rock: RGB;
  sand: RGB;
  path: RGB;
  snowLine: number;
  snowCover: number;
  treeDensity: number;
  /** Relative weights for pine, oak, birch, bush. */
  treeMix: [number, number, number, number];
  flowers: number;
  coast: boolean;
  /** Foliage tint used by vegetation materials. */
  foliage: RGB;
  foliageAlt: RGB;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

export const BIOME_CONFIG: Record<Biome, BiomeConfig> = {
  meadow: {
    amp: 9,
    largeAmp: 16,
    ridge: 0,
    grassLow: hex('#9DB27E'),
    grassHigh: hex('#B4BE86'),
    dry: hex('#C9C08A'),
    rock: hex('#9A9585'),
    sand: hex('#D9CBA3'),
    path: hex('#CDB48E'),
    snowLine: 999,
    snowCover: 0,
    treeDensity: 0.35,
    treeMix: [0.25, 0.45, 0.15, 0.15],
    flowers: 1,
    coast: false,
    foliage: hex('#6E8F5E'),
    foliageAlt: hex('#8EA866'),
  },
  woodland: {
    amp: 11,
    largeAmp: 18,
    ridge: 0,
    grassLow: hex('#7E9A6A'),
    grassHigh: hex('#8FA774'),
    dry: hex('#A6A47A'),
    rock: hex('#8C8A7E'),
    sand: hex('#C9BC98'),
    path: hex('#B79E7A'),
    snowLine: 999,
    snowCover: 0,
    treeDensity: 0.85,
    treeMix: [0.55, 0.25, 0.1, 0.1],
    flowers: 0.4,
    coast: false,
    foliage: hex('#4F6E52'),
    foliageAlt: hex('#6B8A5A'),
  },
  alpine: {
    amp: 12,
    largeAmp: 26,
    ridge: 120,
    grassLow: hex('#8FA67A'),
    grassHigh: hex('#A3AE86'),
    dry: hex('#B3AD8C'),
    rock: hex('#9C978E'),
    sand: hex('#C9C0A6'),
    path: hex('#BFAA8A'),
    snowLine: 70,
    snowCover: 1,
    treeDensity: 0.5,
    treeMix: [0.85, 0.05, 0.05, 0.05],
    flowers: 0.5,
    coast: false,
    foliage: hex('#4C6A53'),
    foliageAlt: hex('#5E7C5C'),
  },
  coastal: {
    amp: 7,
    largeAmp: 12,
    ridge: 0,
    grassLow: hex('#A9B486'),
    grassHigh: hex('#BDBF8E'),
    dry: hex('#D2C796'),
    rock: hex('#A49C8C'),
    sand: hex('#E3D3A8'),
    path: hex('#D6C29A'),
    snowLine: 999,
    snowCover: 0,
    treeDensity: 0.2,
    treeMix: [0.5, 0.15, 0.05, 0.3],
    flowers: 0.6,
    coast: true,
    foliage: hex('#6B8A61'),
    foliageAlt: hex('#8DA36C'),
  },
  autumn: {
    amp: 9,
    largeAmp: 16,
    ridge: 0,
    grassLow: hex('#A9A873'),
    grassHigh: hex('#BCAE76'),
    dry: hex('#C7A86E'),
    rock: hex('#9B9283'),
    sand: hex('#D4C29A'),
    path: hex('#C4A27A'),
    snowLine: 999,
    snowCover: 0,
    treeDensity: 0.55,
    treeMix: [0.2, 0.5, 0.2, 0.1],
    flowers: 0.3,
    coast: false,
    foliage: hex('#C9894F'),
    foliageAlt: hex('#E0B25E'),
  },
  winter: {
    amp: 9,
    largeAmp: 16,
    ridge: 0,
    grassLow: hex('#EEF0F0'),
    grassHigh: hex('#F7F8F6'),
    dry: hex('#E4E7E6'),
    rock: hex('#A9A9A6'),
    sand: hex('#E8E6DE'),
    path: hex('#CFC6B6'),
    snowLine: -999,
    snowCover: 1,
    treeDensity: 0.45,
    treeMix: [0.75, 0.1, 0.1, 0.05],
    flowers: 0,
    coast: false,
    foliage: hex('#5D7466'),
    foliageAlt: hex('#7B8F82'),
  },
};

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Spatial hash of terrain edit strokes so height lookups stay O(nearby strokes). */
export class TerrainEdits {
  static readonly CELL = 32;
  readonly strokes: TerrainStroke[] = [];
  private readonly cells = new Map<string, number[]>();
  revision = 0;

  constructor(strokes: TerrainStroke[] = []) {
    for (const s of strokes) this.add(s);
  }

  add(s: TerrainStroke): void {
    const idx = this.strokes.length;
    this.strokes.push(s);
    const C = TerrainEdits.CELL;
    const x0 = Math.floor((s.x - s.radius) / C);
    const x1 = Math.floor((s.x + s.radius) / C);
    const z0 = Math.floor((s.z - s.radius) / C);
    const z1 = Math.floor((s.z + s.radius) / C);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const k = `${cx},${cz}`;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(idx);
      }
    this.revision++;
  }

  /** Strokes whose footprint could touch the axis-aligned box, in application order. */
  query(x0: number, z0: number, x1: number, z1: number): TerrainStroke[] {
    const C = TerrainEdits.CELL;
    const set = new Set<number>();
    for (let cx = Math.floor(x0 / C); cx <= Math.floor(x1 / C); cx++)
      for (let cz = Math.floor(z0 / C); cz <= Math.floor(z1 / C); cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (list) for (const i of list) set.add(i);
      }
    return [...set].sort((a, b) => a - b).map((i) => this.strokes[i]!);
  }

  at(x: number, z: number): TerrainStroke[] {
    const list = this.cells.get(`${Math.floor(x / TerrainEdits.CELL)},${Math.floor(z / TerrainEdits.CELL)}`);
    return list ? list.map((i) => this.strokes[i]!) : [];
  }
}

/**
 * Deterministic world height and surface model for a given biome and seed.
 * Pure; constructed identically on the main thread and in workers.
 */
export class Heightfield {
  readonly biome: Biome;
  readonly seed: number;
  readonly cfg: BiomeConfig;
  private readonly n: Simplex2;
  private readonly n2: Simplex2;
  private readonly riverPhase: number;
  /** Strokes applying to the current query region (set by the caller for workers). */
  edits: TerrainStroke[] | TerrainEdits = [];

  constructor(biome: Biome, seed: number) {
    this.biome = biome;
    this.seed = seed;
    this.cfg = BIOME_CONFIG[biome];
    this.n = new Simplex2(seed);
    this.n2 = new Simplex2(seed ^ 0x5bd1e995);
    this.riverPhase = hash2(seed, 7, 3) * Math.PI * 2;
  }

  /** River centre line (z as a function of x). */
  riverZ(x: number): number {
    return 78 + 34 * Math.sin(x / 170 + this.riverPhase) + 16 * Math.sin(x / 61 + this.riverPhase * 1.7);
  }

  /** 0..1 build-pad mask: flattened meadow where the starter coaster sits. */
  padMask(x: number, z: number): number {
    // Rounded rectangle x∈[-75,125], z∈[-60,18] with a 45 m soft edge.
    const dx = Math.max(-75 - x, 0, x - 125);
    const dz = Math.max(-60 - z, 0, z - 18);
    const d = Math.hypot(dx, dz);
    return 1 - smooth(0, 45, d);
  }

  /** Distance to the river centre line (approximate, vertical metric). */
  riverDistance(x: number, z: number): number {
    return Math.abs(z - this.riverZ(x)) * 0.9;
  }

  baseHeight(x: number, z: number): number {
    const c = this.cfg;
    const n = this.n;
    let h = 7 + c.largeAmp * n.fbm(x / 760, z / 760, 3) + c.amp * n.fbm(x / 190 + 11.3, z / 190 - 4.1, 4) + 0.5 * n.noise(x / 23, z / 23);
    if (c.ridge > 0) {
      const d = Math.hypot(x, z);
      h += c.ridge * this.n2.ridged(x / 520, z / 520, 4) * smooth(180, 700, d);
    }
    if (c.coast) {
      // Sea towards +Z beyond ~260 m, with low cliffs.
      const shore = 260 + 60 * this.n2.noise(x / 300, 0.5);
      h = h - smooth(shore - 60, shore + 30, z) * (h + 9) + 3 * smooth(shore - 90, shore - 50, z) * (1 - smooth(shore - 40, shore, z));
    }
    // Build pad around the origin.
    const pad = this.padMask(x, z);
    if (pad > 0) h = h + (PAD_HEIGHT + 0.5 * n.noise(x / 40, z / 40) - h) * pad;
    // River carving (skipped where the sea already is).
    const rd = this.riverDistance(x, z);
    const width = 9 + 3 * this.n2.noise(x / 90, 2.3);
    const carve = 1 - smooth(width * 0.45, width + 10, rd);
    if (carve > 0) h = h + (WATER_LEVEL - 1.6 - h) * carve;
    // Banks: soften slopes just outside the river.
    return h;
  }

  height(x: number, z: number): number {
    let h = this.baseHeight(x, z);
    const strokes = this.edits instanceof TerrainEdits ? this.edits.at(x, z) : this.edits;
    if (strokes.length === 0) return h;
    for (const s of strokes) {
      const d = Math.hypot(x - s.x, z - s.z);
      if (d >= s.radius) continue;
      const f = 0.5 + 0.5 * Math.cos((Math.PI * d) / s.radius);
      switch (s.mode) {
        case 'raise':
          h += s.strength * f;
          break;
        case 'lower':
          h -= Math.abs(s.strength) * f;
          break;
        case 'flatten':
          h += (s.strength - h) * f;
          break;
        case 'smooth': {
          const r = s.radius * 0.35;
          const avg = (this.baseHeight(x + r, z) + this.baseHeight(x - r, z) + this.baseHeight(x, z + r) + this.baseHeight(x, z - r)) / 4;
          h += (avg - h) * f * 0.6;
          break;
        }
        default:
          break;
      }
    }
    return h;
  }

  /** Path paint and vegetation clearing masks at a point (0..1 each). */
  paintAt(x: number, z: number): { path: number; clear: number } {
    const strokes = this.edits instanceof TerrainEdits ? this.edits.at(x, z) : this.edits;
    let path = 0;
    let clear = 0;
    for (const s of strokes) {
      if (s.mode !== 'paint-path' && s.mode !== 'clear-vegetation') continue;
      const d = Math.hypot(x - s.x, z - s.z);
      if (d >= s.radius) continue;
      const f = 1 - smooth(s.radius * 0.6, s.radius, d);
      if (s.mode === 'paint-path') path = Math.max(path, f * Math.max(0.2, Math.min(1, s.strength || 1)));
      else clear = Math.max(clear, f);
    }
    return { path, clear };
  }

  /** Ground colour (linear-ish sRGB components 0..1) for a point with a given slope (0 = flat, 1 = vertical). */
  colour(x: number, z: number, h: number, slope: number, out: RGB): RGB {
    const c = this.cfg;
    const n = this.n2.noise(x / 37, z / 37) * 0.5 + 0.5;
    const n2 = this.n2.noise(x / 9 + 3, z / 9 - 7) * 0.5 + 0.5;
    const mix = (a: RGB, b: RGB, t: number) => {
      out[0] = a[0] + (b[0] - a[0]) * t;
      out[1] = a[1] + (b[1] - a[1]) * t;
      out[2] = a[2] + (b[2] - a[2]) * t;
    };
    mix(c.grassLow, c.grassHigh, Math.min(1, Math.max(0, n * 0.8 + (h - 6) / 40)));
    // Dry patches.
    const dry = smooth(0.62, 0.85, this.n.noise(x / 140 + 40, z / 140)) * 0.6;
    if (dry > 0) {
      const r = out[0] + (c.dry[0] - out[0]) * dry;
      const g = out[1] + (c.dry[1] - out[1]) * dry;
      const b = out[2] + (c.dry[2] - out[2]) * dry;
      out[0] = r;
      out[1] = g;
      out[2] = b;
    }
    // Sand / river banks.
    const bank = 1 - smooth(WATER_LEVEL + 0.4, WATER_LEVEL + 1.8, h);
    if (bank > 0) {
      out[0] += (c.sand[0] - out[0]) * bank;
      out[1] += (c.sand[1] - out[1]) * bank;
      out[2] += (c.sand[2] - out[2]) * bank;
    }
    // Rock on steep slopes.
    const rock = smooth(0.45, 0.75, slope + (n2 - 0.5) * 0.15);
    if (rock > 0) {
      out[0] += (c.rock[0] - out[0]) * rock;
      out[1] += (c.rock[1] - out[1]) * rock;
      out[2] += (c.rock[2] - out[2]) * rock;
    }
    // Snow above the snow line (alpine) or everywhere (winter).
    if (c.snowCover > 0) {
      const snow = smooth(c.snowLine - 8, c.snowLine + 8, h + (n - 0.5) * 10) * (1 - rock * 0.7);
      if (snow > 0) {
        out[0] += (0.95 - out[0]) * snow;
        out[1] += (0.96 - out[1]) * snow;
        out[2] += (0.97 - out[2]) * snow;
      }
    }
    // Painted paths.
    const paint = this.paintAt(x, z).path;
    if (paint > 0) {
      out[0] += (c.path[0] - out[0]) * paint;
      out[1] += (c.path[1] - out[1]) * paint;
      out[2] += (c.path[2] - out[2]) * paint;
    }
    // Subtle hand-painted mottling.
    const m = 0.94 + n2 * 0.1;
    out[0] *= m;
    out[1] *= m;
    out[2] *= m;
    return out;
  }

  /** Probability of a tree at a point (0..1): forest patches, none in water or on the pad centre. */
  treeDensity(x: number, z: number, h: number): number {
    if (h < WATER_LEVEL + 0.8) return 0;
    const patches = smooth(-0.15, 0.45, this.n.noise(x / 210 - 17, z / 210 + 9));
    const pad = this.padMask(x, z);
    const snowFree = this.cfg.snowCover > 0 && this.cfg.snowLine < 900 ? 1 - smooth(this.cfg.snowLine - 10, this.cfg.snowLine + 5, h) : 1;
    return this.cfg.treeDensity * patches * (1 - pad * 0.92) * snowFree * (1 - this.paintAt(x, z).clear);
  }
}
