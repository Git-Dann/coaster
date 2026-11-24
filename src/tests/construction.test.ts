import { describe, expect, test } from 'vitest';
import { BakedTrack, newSample } from '../engine/track/bake';
import { starterClosed, starterDesign } from '../engine/track/starter';
import { buildTrackGeometry, GAUGE_HALF } from '../engine/track/track-geometry';
import { generateSupports } from '../engine/supports/support-gen';
import { generateChunk, LOD_SEGMENTS } from '../engine/terrain/chunk-gen';
import { CHUNK_SIZE, Heightfield, PAD_HEIGHT, TerrainEdits } from '../engine/terrain/heightfield';
import { checkClose, cloneDesign, mirrorDesign, translateDesign } from '../engine/track/design-ops';
import { checkPreview, makePreview, planDragToPiece, PRESETS } from '../features/builder/builder';
import { useGame, blankDesign } from '../stores/game';

const ground = new Heightfield('meadow', 2026);
const groundAt = (x: number, z: number) => ground.height(x, z);

describe('track geometry', () => {
  test('starter coaster is continuous and stays above the terrain', () => {
    const d = starterClosed(PAD_HEIGHT + 1);
    const t = new BakedTrack(d);
    expect(t.diagnostics.maxGap).toBeLessThan(1e-9);
    const a = newSample();
    const b = newSample();
    let minClear = Infinity;
    for (let s = 0; s < t.length; s += 0.25) {
      t.sample(s, a);
      t.sample(s + 0.25, b);
      const step = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
      expect(step).toBeLessThan(0.26);
      expect(a.tan[0] * b.tan[0] + a.tan[1] * b.tan[1] + a.tan[2] * b.tan[2]).toBeGreaterThan(0.995);
      minClear = Math.min(minClear, a.pos[1] - groundAt(a.pos[0], a.pos[2]));
    }
    expect(minClear).toBeGreaterThan(0.3);
  });

  test('every preset produces finite, continuous track from a level start', () => {
    for (const p of PRESETS) {
      const base = blankDesign(starterDesign(5));
      const prev = makePreview(base, p.id, {}, true, 'test');
      expect(prev, p.id).not.toBeNull();
      const t = new BakedTrack(prev!);
      for (let i = 0; i < t.pos.length; i++) expect(Number.isFinite(t.pos[i]!), `${p.id} pos`).toBe(true);
      for (let i = 0; i < t.up.length; i++) expect(Number.isFinite(t.up[i]!), `${p.id} up`).toBe(true);
      expect(t.diagnostics.maxGap).toBeLessThan(1e-9);
      // Tightest radius stays buildable.
      expect(1 / t.diagnostics.maxCurvature, p.id).toBeGreaterThan(2.2);
    }
  });

  test('rail separation is constant along the swept mesh', () => {
    const t = new BakedTrack(starterClosed(5));
    const geo = buildTrackGeometry(t, 'tubular', 0, 60, [0, 0, 0]);
    expect(geo.index.length % 3).toBe(0);
    for (const v of geo.position) expect(Number.isFinite(v)).toBe(true);
    const smp = newSample();
    for (let s = 0; s < t.length; s += 10) {
      t.sample(s, smp);
      const l = [smp.pos[0] - smp.right[0] * GAUGE_HALF, smp.pos[1] - smp.right[1] * GAUGE_HALF, smp.pos[2] - smp.right[2] * GAUGE_HALF];
      const r = [smp.pos[0] + smp.right[0] * GAUGE_HALF, smp.pos[1] + smp.right[1] * GAUGE_HALF, smp.pos[2] + smp.right[2] * GAUGE_HALF];
      expect(Math.hypot(l[0]! - r[0]!, l[1]! - r[1]!, l[2]! - r[2]!)).toBeCloseTo(GAUGE_HALF * 2, 6);
    }
  });

  test('vertical loop inverts smoothly without frame flips', () => {
    const base = blankDesign(starterDesign(5));
    const prev = makePreview(base, 'loop', { height: 20 }, true, 'x')!;
    const t = new BakedTrack(prev);
    const a = newSample();
    const b = newSample();
    let minUp = 1;
    for (let s = 0; s < t.length - 0.5; s += 0.5) {
      t.sample(s, a);
      t.sample(s + 0.5, b);
      minUp = Math.min(minUp, a.up[1]);
      // Up vector rotates smoothly: no sudden 180° flips.
      expect(a.up[0] * b.up[0] + a.up[1] * b.up[1] + a.up[2] * b.up[2]).toBeGreaterThan(0.9);
    }
    expect(minUp).toBeLessThan(-0.9);
  });
});

describe('supports', () => {
  test('supports are anchored to the terrain and have stable ids', () => {
    const d = starterClosed(PAD_HEIGHT + 1);
    const t = new BakedTrack(d);
    const a = generateSupports(d, t, groundAt);
    const b = generateSupports(d, t, groundAt);
    expect(a.length).toBeGreaterThan(30);
    expect(a.map((m) => m.key)).toEqual(b.map((m) => m.key));
    for (const m of a) {
      if (m.kind === 'pad') {
        const gy = groundAt(m.a[0], m.a[2]);
        expect(m.a[1]).toBeLessThan(gy + 0.01);
        expect(m.b[1]).toBeGreaterThan(gy - 0.01);
      }
    }
  });

  test('editing one end of the track leaves supports elsewhere untouched', () => {
    const d = starterDesign(PAD_HEIGHT + 1);
    const t = new BakedTrack(d);
    const before = new Map(generateSupports(d, t, groundAt).map((m) => [m.key, m]));
    const edited = cloneDesign(d);
    edited.nodes[edited.nodes.length - 1]!.p[1] += 3;
    const after = generateSupports(edited, new BakedTrack(edited), groundAt);
    let unchanged = 0;
    for (const m of after) {
      const o = before.get(m.key);
      if (o && o.a.every((v, i) => Math.abs(v - m.a[i]!) < 1e-3) && o.b.every((v, i) => Math.abs(v - m.b[i]!) < 1e-3)) unchanged++;
    }
    expect(unchanged / after.length).toBeGreaterThan(0.8);
  });

  test('timber style builds bents with bracing', () => {
    const d = { ...starterClosed(PAD_HEIGHT + 1), supportStyle: 'pine' as const };
    const m = generateSupports(d, new BakedTrack(d), groundAt);
    expect(m.filter((x) => x.kind === 'beam').length).toBeGreaterThan(m.filter((x) => x.kind === 'pad').length * 2);
  });
});

describe('terrain', () => {
  test('chunks are deterministic regardless of generation order', () => {
    const req = (cx: number, cz: number) => ({ cx, cz, lod: 1, biome: 'meadow' as const, seed: 7, strokes: [], rev: 1 });
    const a1 = generateChunk(req(0, 0));
    generateChunk(req(3, -2));
    const a2 = generateChunk(req(0, 0));
    expect(Array.from(a1.positions)).toEqual(Array.from(a2.positions));
    expect(Array.from(a1.vegetation)).toEqual(Array.from(a2.vegetation));
  });

  test('neighbouring chunks share identical edge heights (no seams)', () => {
    const lod = 1;
    const segs = LOD_SEGMENTS[lod];
    const a = generateChunk({ cx: 2, cz: 1, lod, biome: 'alpine', seed: 3, strokes: [], rev: 1 });
    const b = generateChunk({ cx: 3, cz: 1, lod, biome: 'alpine', seed: 3, strokes: [], rev: 1 });
    const vpr = segs + 1;
    for (let j = 0; j < vpr; j++) {
      const ea = a.positions[(j * vpr + segs) * 3 + 1]!;
      const eb = b.positions[(j * vpr + 0) * 3 + 1]!;
      expect(ea).toBeCloseTo(eb, 4);
    }
  });

  test('positions are chunk-local so precision holds far from the origin', () => {
    const far = generateChunk({ cx: 4000, cz: -3500, lod: 3, biome: 'meadow', seed: 1, strokes: [], rev: 1 });
    for (let i = 0; i < far.positions.length; i += 3) {
      expect(far.positions[i]!).toBeGreaterThanOrEqual(0);
      expect(far.positions[i]!).toBeLessThanOrEqual(CHUNK_SIZE);
    }
  });

  test('terrain edits raise the ground locally only', () => {
    const hf = new Heightfield('meadow', 9);
    const edits = new TerrainEdits([{ mode: 'raise', x: 300, z: 300, radius: 10, strength: 4 }]);
    const base = hf.height(300, 300);
    hf.edits = edits;
    expect(hf.height(300, 300)).toBeCloseTo(base + 4, 5);
    hf.edits = [];
    const far = hf.height(400, 400);
    hf.edits = edits;
    expect(hf.height(400, 400)).toBe(far);
  });
});

describe('construction intelligence', () => {
  test('plan drag maps a point to a piece whose end lands near it', () => {
    const c = { p: [0, 5, 0] as [number, number, number], dir: [1, 0, 0] as [number, number, number] };
    const straight = planDragToPiece(c, [30, 5, 0]);
    expect(straight.turn).toBe(0);
    expect(straight.length).toBe(30);
    const left = planDragToPiece(c, [20, 5, -20]);
    expect(left.turn).toBeGreaterThan(60); // positive = left
    const right = planDragToPiece(c, [20, 5, 20]);
    expect(right.turn).toBeLessThan(-60);
  });

  test('previews never modify committed nodes', () => {
    const d = starterDesign(5);
    const snapshot = JSON.stringify(d.nodes);
    makePreview(d, 'hill', { height: 12 }, true, 's');
    expect(JSON.stringify(d.nodes)).toBe(snapshot);
  });

  test('closing is refused with a friendly reason when geometry does not fit', () => {
    const blank = blankDesign(starterDesign(5));
    const r = checkClose(blank);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/[a-z]/);
    expect(checkClose(starterDesign(5), groundAt).ok).toBe(true);
  });

  test('tight geometry is blocked with a helpful hint', () => {
    const base = blankDesign(starterDesign(5));
    const prev = makePreview(base, 'track', { length: 4, turn: 180, rise: 0 }, false, 't')!;
    const r = checkPreview(prev, base.nodes.length, groundAt);
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('wider turn');
  });

  test('translating and mirroring preserve track length', () => {
    const d = starterClosed(5);
    const L = new BakedTrack(d).length;
    expect(new BakedTrack(translateDesign(d, 500, 3, -200)).length).toBeCloseTo(L, 6);
    expect(new BakedTrack(mirrorDesign(d)).length).toBeCloseTo(L, 3);
  });
});

describe('undo and redo', () => {
  test('a construction operation is one undo step', () => {
    const g = useGame.getState();
    g.newWorld({ blank: true });
    const start = useGame.getState().design;
    const prev = makePreview(start, 'lift', {}, true, 'u')!;
    useGame.getState().commitDesign(prev);
    expect(useGame.getState().design.nodes.length).toBeGreaterThan(start.nodes.length + 1);
    useGame.getState().undo();
    expect(useGame.getState().design.nodes.length).toBe(start.nodes.length);
    useGame.getState().redo();
    expect(useGame.getState().design.nodes.length).toBe(prev.nodes.length);
  });

  test('carriage changes stay within 1–6', () => {
    useGame.getState().setTrain({ cars: 6 });
    expect(useGame.getState().train.cars).toBe(6);
  });
});
