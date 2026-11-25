import { describe, expect, test } from 'vitest';
import { BakedTrack } from '../engine/track/bake';
import { withReturn, dubins } from '../engine/track/auto-return';
import { starterPlayable } from '../engine/track/starter';
import { TrainSim } from '../engine/physics/train-sim';
import { DEFAULT_PHYSICS } from '../engine/train/config';
import { Heightfield, PAD_HEIGHT } from '../engine/terrain/heightfield';
import { mulberry32 } from '../engine/terrain/noise';
import { PIECES, addPiece, adjustPiece, freshCoaster, removePiece, type PieceId } from '../features/builder/simple-builder';
import { cfg } from './physics/helpers';
import { MIN_VERTICAL } from '../engine/track/clearance';

/** Every pair of track points far apart along the circuit but close in plan must be vertically separated. */
function worstClash(track: BakedTrack): { gap: number; s1: number; s2: number } {
  let worst = { gap: Infinity, s1: 0, s2: 0 };
  const step = 4; // 1 m
  const idx: number[] = [];
  for (let i = 0; i < track.count; i += step) idx.push(i);
  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const i = idx[a]!;
      const j = idx[b]!;
      let ds = Math.abs(i - j) * track.ds;
      if (track.closed) ds = Math.min(ds, track.length - ds);
      if (ds < 40) continue;
      const dx = track.pos[i * 3]! - track.pos[j * 3]!;
      const dz = track.pos[i * 3 + 2]! - track.pos[j * 3 + 2]!;
      if (dx * dx + dz * dz > 2.5 * 2.5) continue;
      const gap = Math.abs(track.pos[i * 3 + 1]! - track.pos[j * 3 + 1]!);
      if (gap < worst.gap) worst = { gap, s1: i * track.ds, s2: j * track.ds };
    }
  }
  return worst;
}

const hf = new Heightfield('meadow', 2026);
const ground = (x: number, z: number) => hf.height(x, z);

function ride(design: ReturnType<typeof starterPlayable>) {
  const circuit = withReturn(design, { groundAt: ground, speed: 15 });
  const track = new BakedTrack(circuit);
  return { circuit, track };
}

describe('dubins paths', () => {
  test('reach the goal pose', () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 50; i++) {
      const a = { x: (rnd() - 0.5) * 200, z: (rnd() - 0.5) * 200, h: rnd() * Math.PI * 2 };
      const b = { x: (rnd() - 0.5) * 200, z: (rnd() - 0.5) * 200, h: rnd() * Math.PI * 2 };
      const R = 15;
      let { x, z, h } = a;
      for (const s of dubins(a, b, R)) {
        const n = 200;
        for (let k = 0; k < n; k++) {
          const ds = s.len / n;
          if (s.kind !== 'S') h += ((s.kind === 'L' ? 1 : -1) * ds) / R;
          x += Math.cos(h) * ds;
          z -= Math.sin(h) * ds;
        }
      }
      expect(Math.hypot(x - b.x, z - b.z)).toBeLessThan(0.6);
      const dh = Math.atan2(Math.sin(h - b.h), Math.cos(h - b.h));
      expect(Math.abs(dh)).toBeLessThan(0.02);
    }
  });
});

describe('the track can never be left disconnected', () => {
  test('the playable starter rides as a closed, smooth circuit', () => {
    const { circuit, track } = ride(starterPlayable(PAD_HEIGHT + 1));
    expect(circuit.closed).toBe(true);
    expect(track.diagnostics.maxGap).toBeLessThan(1e-9);
    expect(track.diagnostics.seamFlip).toBe(false);
    expect(1 / track.diagnostics.maxCurvature).toBeGreaterThan(3);
    expect(worstClash(track).gap).toBeGreaterThanOrEqual(MIN_VERTICAL - 0.6);
    const sim = new TrainSim(track, cfg(6), { ...DEFAULT_PHYSICS });
    let arrivals = 0;
    for (let i = 0; i < 120 * 200; i++) {
      sim.step(1 / 120);
      for (const e of sim.events) {
        if (e.type === 'arrive') arrivals++;
        expect(e.type).not.toBe('numeric-error');
      }
      sim.events.length = 0;
    }
    expect(arrivals).toBeGreaterThanOrEqual(2);
  });

  test('random kid-style layouts always close into a valid circuit', () => {
    const rnd = mulberry32(42);
    const ids = PIECES.map((p) => p.id);
    for (let trial = 0; trial < 40; trial++) {
      let d = freshCoaster(starterPlayable(PAD_HEIGHT + 1), PAD_HEIGHT + 1, ground);
      const count = 1 + Math.floor(rnd() * 8);
      for (let k = 0; k < count; k++) {
        const id = ids[Math.floor(rnd() * ids.length)] as PieceId;
        const r = addPiece(d, id, ground);
        d = r.design;
        if (rnd() < 0.4) {
          const adj = adjustPiece(d, r.active, { rise: (rnd() - 0.5) * 30, height: 4 + rnd() * 20, length: 10 + rnd() * 50 }, ground);
          if (adj) d = adj.design;
        }
        if (rnd() < 0.15) d = removePiece(d);
      }
      const { circuit, track } = ride(d);
      expect(circuit.closed, `trial ${trial}`).toBe(true);
      expect(track.diagnostics.maxGap).toBeLessThan(1e-6);
      expect(track.diagnostics.seamFlip, `trial ${trial}`).toBe(false);
      for (let i = 0; i < track.pos.length; i++) expect(Number.isFinite(track.pos[i]!)).toBe(true);
      // No two parts of the coaster may ever share the same space.
      const clash = worstClash(track);
      expect(clash.gap, `trial ${trial} clash at ${clash.s1.toFixed(0)}/${clash.s2.toFixed(0)} m`).toBeGreaterThanOrEqual(MIN_VERTICAL - 0.6);
      // Banking never spins faster than a roll element (no hidden unwinding twists between pieces).
      let twist = 0;
      for (let i = 1; i < track.count; i++) twist = Math.max(twist, Math.abs(track.bank[i]! - track.bank[i - 1]!) / track.ds);
      expect(twist, `trial ${trial} twist rate`).toBeLessThan(0.6);
      // The train always behaves: it may stall on a layout without enough energy, but never errors.
      const sim = new TrainSim(track, cfg(4), { ...DEFAULT_PHYSICS });
      sim.dispatch();
      for (let i = 0; i < 120 * 40; i++) {
        sim.step(1 / 120);
        for (const e of sim.events) expect(e.type, `trial ${trial}`).not.toBe('numeric-error');
        sim.events.length = 0;
      }
    }
    // 40 layouts × 40 s of simulation: allow time when the suite runs in parallel.
  }, 60_000);
});

describe('tap-to-add building', () => {
  test('adjusting the newest piece never changes earlier track', () => {
    const d0 = starterPlayable(PAD_HEIGHT + 1);
    const r = addPiece(d0, 'left', ground);
    const before = JSON.stringify(r.design.nodes.slice(0, r.active.start).map((n) => n.p));
    const adj = adjustPiece(r.design, r.active, { rise: 12, length: 40 }, ground)!;
    expect(JSON.stringify(adj.design.nodes.slice(0, r.active.start).map((n) => n.p))).toBe(before);
    expect(adj.design.nodes[adj.design.nodes.length - 1]!.p[1]).toBeGreaterThan(r.design.nodes[r.design.nodes.length - 1]!.p[1] + 5);
  });

  test('removing a piece removes all of it, and the station always stays', () => {
    let d = starterPlayable(PAD_HEIGHT + 1);
    const n = d.nodes.length;
    d = addPiece(d, 'loop', ground).design;
    expect(d.nodes.length).toBeGreaterThan(n + 3);
    d = removePiece(d);
    expect(d.nodes.length).toBe(n);
    for (let i = 0; i < 30; i++) d = removePiece(d);
    expect(d.nodes.length).toBeGreaterThanOrEqual(2);
    expect(d.nodes[0]!.kind).toBe('station');
  });

  test('pieces never go underground', () => {
    let d = starterPlayable(PAD_HEIGHT + 1);
    for (let i = 0; i < 4; i++) d = addPiece(d, 'down', ground).design;
    for (const node of d.nodes) expect(node.p[1]).toBeGreaterThanOrEqual(ground(node.p[0], node.p[2]) + 1.0);
  });
});
