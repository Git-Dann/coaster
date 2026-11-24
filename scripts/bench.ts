/**
 * Reproducible CPU benchmark of the renderer-independent systems (run: npx tsx scripts/bench.ts).
 * Seeded scene: the starter coaster, meadow biome, seed 2026. Reports median of repeated runs.
 */
import { BakedTrack } from '../src/engine/track/bake';
import { starterClosed } from '../src/engine/track/starter';
import { TrainSim } from '../src/engine/physics/train-sim';
import { DEFAULT_PHYSICS } from '../src/engine/train/config';
import { generateSupports } from '../src/engine/supports/support-gen';
import { generateChunk } from '../src/engine/terrain/chunk-gen';
import { Heightfield, PAD_HEIGHT } from '../src/engine/terrain/heightfield';
import { buildTrackGeometry } from '../src/engine/track/track-geometry';
import { makePreview } from '../src/features/builder/builder';

function median(f: () => void, runs = 15): number {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    f();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)]!;
}

const design = starterClosed(PAD_HEIGHT + 1);
const hf = new Heightfield('meadow', 2026);
const ground = (x: number, z: number) => hf.height(x, z);
const track = new BakedTrack(design);
const sim = new TrainSim(track, { cars: 6, style: 'steel', colours: { primary: '#000', secondary: '#000', seat: '#000', trim: '#000', wheels: '#000' }, finish: 'matte' }, { ...DEFAULT_PHYSICS });
sim.dispatch();
for (let i = 0; i < 120 * 40; i++) sim.step(1 / 120);

const rows: Array<[string, number, string]> = [
  ['Bake starter track (370 m)', median(() => new BakedTrack(design)), 'ms'],
  ['Sim step, 6 cars (one 1/120 s step)', median(() => { for (let i = 0; i < 1000; i++) sim.step(1 / 120); }) / 1000, 'ms'],
  ['Sim cost per rendered second (120 steps)', median(() => { for (let i = 0; i < 120; i++) sim.step(1 / 120); }), 'ms'],
  ['Generate supports (whole coaster)', median(() => generateSupports(design, track, ground)), 'ms'],
  ['Track mesh, whole coaster (uncached)', median(() => buildTrackGeometry(track, 'tubular', 0, track.length, [0, 0, 0]), 7), 'ms'],
  ['Builder preview (bake + append element)', median(() => makePreview(design.closed ? { ...design, closed: false } : design, 'hill', {}, true, 'b')), 'ms'],
  ['Terrain chunk LOD0 (64×64 + vegetation)', median(() => generateChunk({ cx: 1, cz: 2, lod: 0, biome: 'meadow', seed: 2026, strokes: [], rev: 1 }), 7), 'ms'],
  ['Terrain chunk LOD3 (8×8)', median(() => generateChunk({ cx: 9, cz: 2, lod: 3, biome: 'meadow', seed: 2026, strokes: [], rev: 1 }), 15), 'ms'],
];
console.log(`Node ${process.version}, ${process.platform}/${process.arch}`);
for (const [n, v, u] of rows) console.log(`${n.padEnd(46)} ${v.toFixed(3).padStart(9)} ${u}`);
