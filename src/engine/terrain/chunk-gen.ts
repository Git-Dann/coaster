import { CHUNK_SIZE, Heightfield, WATER_LEVEL } from './heightfield';
import { hash2 } from './noise';
import type { Biome, TerrainStroke } from '../../types/world';

export const LOD_SEGMENTS = [64, 32, 16, 8] as const;
export const VEG_STRIDE = 7;
export const VEG_TYPES = ['pine', 'oak', 'birch', 'bush', 'rock', 'flowers', 'grass'] as const;
export type VegType = (typeof VEG_TYPES)[number];

export interface ChunkRequest {
  cx: number;
  cz: number;
  lod: number;
  biome: Biome;
  seed: number;
  strokes: TerrainStroke[];
  /** Monotonic request id; results with stale ids are discarded. */
  rev: number;
}

export interface ChunkData {
  cx: number;
  cz: number;
  lod: number;
  rev: number;
  /** Positions relative to the chunk origin (cx·S, 0, cz·S), keeping float32 precision at any distance. */
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  index: Uint16Array;
  minY: number;
  maxY: number;
  /** Packed vegetation candidates: [type, x, y, z, rot, scale, tint] × n in world coordinates. */
  vegetation: Float32Array;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

const keyFor = (cx: number, cz: number) => `${cx},${cz}`;
export { keyFor as chunkKey };

/** Generate one terrain chunk. Pure and deterministic: identical inputs give identical outputs. */
export function generateChunk(req: ChunkRequest, hf?: Heightfield): ChunkData {
  const field = hf ?? new Heightfield(req.biome, req.seed);
  field.edits = req.strokes;
  const segs = LOD_SEGMENTS[Math.min(req.lod, LOD_SEGMENTS.length - 1)]!;
  const S = CHUNK_SIZE;
  const step = S / segs;
  const ox = req.cx * S;
  const oz = req.cz * S;
  const vpr = segs + 1;
  const gridCount = vpr * vpr;
  const skirtCount = segs * 4;
  const total = gridCount + skirtCount;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const heights = new Float64Array(gridCount);
  let minY = Infinity;
  let maxY = -Infinity;
  const col: [number, number, number] = [0, 0, 0];
  const e = Math.max(1, step * 0.5);
  for (let j = 0; j < vpr; j++) {
    for (let i = 0; i < vpr; i++) {
      const lx = i * step;
      const lz = j * step;
      const x = ox + lx;
      const z = oz + lz;
      const h = field.height(x, z);
      heights[j * vpr + i] = h;
      const hx = field.height(x + e, z) - field.height(x - e, z);
      const hz = field.height(x, z + e) - field.height(x, z - e);
      let nx = -hx / (2 * e);
      let ny = 1;
      let nz = -hz / (2 * e);
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const k = (j * vpr + i) * 3;
      positions[k] = lx;
      positions[k + 1] = h;
      positions[k + 2] = lz;
      normals[k] = nx;
      normals[k + 1] = ny;
      normals[k + 2] = nz;
      field.colour(x, z, h, 1 - ny, col);
      // Palette is authored in sRGB; vertex colours are linear.
      colors[k] = srgbToLinear(col[0]);
      colors[k + 1] = srgbToLinear(col[1]);
      colors[k + 2] = srgbToLinear(col[2]);
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }
  // Skirts: a ring of vertices dropped below each edge vertex hides cracks between LODs.
  const edge: number[] = [];
  for (let i = 0; i < segs; i++) edge.push(i); // top row (j=0)
  for (let j = 0; j < segs; j++) edge.push(j * vpr + segs); // right column
  for (let i = segs; i > 0; i--) edge.push(segs * vpr + i); // bottom row
  for (let j = segs; j > 0; j--) edge.push(j * vpr); // left column
  const drop = 2 + step * 0.6;
  for (let s = 0; s < edge.length; s++) {
    const src = edge[s]! * 3;
    const dst = (gridCount + s) * 3;
    positions[dst] = positions[src]!;
    positions[dst + 1] = positions[src + 1]! - drop;
    positions[dst + 2] = positions[src + 2]!;
    normals[dst] = normals[src]!;
    normals[dst + 1] = normals[src + 1]!;
    normals[dst + 2] = normals[src + 2]!;
    colors[dst] = colors[src]! * 0.9;
    colors[dst + 1] = colors[src + 1]! * 0.9;
    colors[dst + 2] = colors[src + 2]! * 0.9;
  }
  minY -= drop;

  const quads = segs * segs + edge.length;
  const index = new Uint16Array(quads * 6);
  let w = 0;
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * vpr + i;
      const b = a + 1;
      const c = a + vpr;
      const d = c + 1;
      // Alternate the diagonal to avoid directional artefacts.
      if ((i + j) & 1) {
        index[w++] = a;
        index[w++] = c;
        index[w++] = b;
        index[w++] = b;
        index[w++] = c;
        index[w++] = d;
      } else {
        index[w++] = a;
        index[w++] = c;
        index[w++] = d;
        index[w++] = a;
        index[w++] = d;
        index[w++] = b;
      }
    }
  }
  for (let s = 0; s < edge.length; s++) {
    const a = edge[s]!;
    const b = edge[(s + 1) % edge.length]!;
    const sa = gridCount + s;
    const sb = gridCount + ((s + 1) % edge.length);
    // Winding chosen so the skirt faces outwards; material is double-sided-safe either way.
    index[w++] = a;
    index[w++] = sa;
    index[w++] = b;
    index[w++] = b;
    index[w++] = sa;
    index[w++] = sb;
  }

  const vegetation = req.lod <= 1 ? placeVegetation(field, req, heights, vpr, step) : new Float32Array(0);
  return { cx: req.cx, cz: req.cz, lod: req.lod, rev: req.rev, positions, normals, colors, index, minY, maxY, vegetation };
}

function sampleGrid(heights: Float64Array, vpr: number, step: number, lx: number, lz: number): number {
  const gx = Math.min(vpr - 1.001, Math.max(0, lx / step));
  const gz = Math.min(vpr - 1.001, Math.max(0, lz / step));
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const u = gx - i;
  const v = gz - j;
  const h00 = heights[j * vpr + i]!;
  const h10 = heights[j * vpr + i + 1]!;
  const h01 = heights[(j + 1) * vpr + i]!;
  const h11 = heights[(j + 1) * vpr + i + 1]!;
  return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
}

function placeVegetation(field: Heightfield, req: ChunkRequest, heights: Float64Array, vpr: number, step: number): Float32Array {
  const S = CHUNK_SIZE;
  const ox = req.cx * S;
  const oz = req.cz * S;
  const out: number[] = [];
  const cfg = field.cfg;
  const mixTotal = cfg.treeMix.reduce((a, b) => a + b, 0);
  // Trees on a jittered 7 m grid.
  const cell = 7;
  const n = Math.floor(S / cell);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gx = req.cx * n + i;
      const gz = req.cz * n + j;
      const r1 = hash2(gx, gz, req.seed);
      const r2 = hash2(gx, gz, req.seed + 1);
      const r3 = hash2(gx, gz, req.seed + 2);
      const lx = (i + 0.15 + r1 * 0.7) * cell;
      const lz = (j + 0.15 + r2 * 0.7) * cell;
      const x = ox + lx;
      const z = oz + lz;
      const h = sampleGrid(heights, vpr, step, lx, lz);
      const dens = field.treeDensity(x, z, h);
      if (r3 >= dens) continue;
      // Avoid steep slopes.
      const s = Math.abs(sampleGrid(heights, vpr, step, lx + 2, lz) - sampleGrid(heights, vpr, step, lx - 2, lz)) / 4;
      if (s > 0.8) continue;
      let pick = hash2(gx, gz, req.seed + 3) * mixTotal;
      let type = 0;
      for (; type < 3; type++) {
        pick -= cfg.treeMix[type]!;
        if (pick <= 0) break;
      }
      const scale = 0.75 + hash2(gx, gz, req.seed + 4) * 0.6;
      out.push(type, x, h - 0.1, z, hash2(gx, gz, req.seed + 5) * Math.PI * 2, scale, hash2(gx, gz, req.seed + 6));
    }
  }
  // Ground cover on a finer grid: flowers, grass tufts and rocks.
  const fine = 4;
  const m = Math.floor(S / fine);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const gx = req.cx * m + i;
      const gz = req.cz * m + j;
      const r = hash2(gx, gz, req.seed + 11);
      const lx = (i + hash2(gx, gz, req.seed + 12)) * fine;
      const lz = (j + hash2(gx, gz, req.seed + 13)) * fine;
      const x = ox + lx;
      const z = oz + lz;
      const h = sampleGrid(heights, vpr, step, lx, lz);
      if (h < WATER_LEVEL + 0.6) continue;
      if (field.paintAt(x, z).path > 0.3) continue;
      const rot = hash2(gx, gz, req.seed + 14) * Math.PI * 2;
      const sc = 0.6 + hash2(gx, gz, req.seed + 15) * 0.8;
      const tint = hash2(gx, gz, req.seed + 16);
      if (r < 0.012) out.push(4, x, h - 0.15, z, rot, sc, tint);
      else if (r < 0.012 + 0.05 * cfg.flowers) out.push(5, x, h, z, rot, sc, tint);
      else if (r < 0.1 + 0.05 * cfg.flowers && cfg.snowCover === 0) out.push(6, x, h, z, rot, sc, tint);
      else if (r < 0.11 + 0.05 * cfg.flowers + 0.02) out.push(3, x, h, z, rot, sc * 0.8, tint);
    }
  }
  return new Float32Array(out);
}
