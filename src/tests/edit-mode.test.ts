import { describe, expect, test } from 'vitest';
import { BakedTrack } from '../engine/track/bake';
import { withReturn } from '../engine/track/auto-return';
import { starterPlayable } from '../engine/track/starter';
import { Heightfield, PAD_HEIGHT } from '../engine/terrain/heightfield';
import { mulberry32 } from '../engine/terrain/noise';
import { gridFrame, onGrid, toGrid } from '../engine/track/grid';
import { MIN_VERTICAL } from '../engine/track/clearance';
import { TrainSim } from '../engine/physics/train-sim';
import { DEFAULT_PHYSICS } from '../engine/train/config';
import { SPECIALS, freshCoaster, planNext, removePiece, type BuildChoice } from '../features/builder/simple-builder';
import { cfg } from './physics/helpers';

const hf = new Heightfield('meadow', 2026);
const ground = (x: number, z: number) => hf.height(x, z);

function worstClash(track: BakedTrack): number {
  let worst = Infinity;
  for (let i = 0; i < track.count; i += 4)
    for (let j = i + 4; j < track.count; j += 4) {
      let ds = (j - i) * track.ds;
      if (track.closed) ds = Math.min(ds, track.length - ds);
      if (ds < 40) continue;
      const dx = track.pos[i * 3]! - track.pos[j * 3]!;
      const dz = track.pos[i * 3 + 2]! - track.pos[j * 3 + 2]!;
      if (dx * dx + dz * dz > 6.25) continue;
      worst = Math.min(worst, Math.abs(track.pos[i * 3 + 1]! - track.pos[j * 3 + 1]!));
    }
  return worst;
}

const choices: BuildChoice[] = [
  { kind: 'track', turn: 0, slope: 0 },
  { kind: 'track', turn: 1, slope: 0 },
  { kind: 'track', turn: -1, slope: 0 },
  { kind: 'track', turn: 0, slope: 1 },
  { kind: 'track', turn: 0, slope: -1 },
  { kind: 'track', turn: 1, slope: 1 },
  { kind: 'track', turn: -1, slope: -1 },
  ...SPECIALS.map((id) => ({ kind: 'special' as const, id })),
];

describe('edit mode builds on the grid', () => {
  test('every piece ends on a grid point facing a compass direction', () => {
    for (const c of choices) {
      const plan = planNext(starterPlayable(PAD_HEIGHT + 1), c, ground);
      const end = plan.design.nodes[plan.design.nodes.length - 1]!;
      const g = gridFrame(plan.design);
      const { u, v } = toGrid(g, end.p[0], end.p[2]);
      expect(onGrid(g, end.p, end.dir), `${JSON.stringify(c)} ends at ${u.toFixed(2)},${v.toFixed(2)}`).toBe(true);
    }
  });

  test('a straight is two tiles; a quarter turn turns 90° and moves two tiles across', () => {
    const d0 = starterPlayable(PAD_HEIGHT + 1);
    let d = planNext(d0, { kind: 'track', turn: 0, slope: 0 }, ground).design; // join the grid first
    const g = gridFrame(d);
    const a = d.nodes[d.nodes.length - 1]!;
    const s = planNext(d, { kind: 'track', turn: 0, slope: 0 }, ground).design;
    const b = s.nodes[s.nodes.length - 1]!;
    expect(Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2])).toBeCloseTo(16, 3);
    d = planNext(d, { kind: 'track', turn: 1, slope: 0 }, ground).design;
    const c = d.nodes[d.nodes.length - 1]!;
    const ga = toGrid(g, a.p[0], a.p[2]);
    const gc = toGrid(g, c.p[0], c.p[2]);
    expect(Math.abs(gc.u - ga.u) + Math.abs(gc.v - ga.v)).toBeCloseTo(4, 3);
    const turned = Math.atan2(Math.sin(Math.atan2(-c.dir[2], c.dir[0]) - Math.atan2(-a.dir[2], a.dir[0])), Math.cos(Math.atan2(-c.dir[2], c.dir[0]) - Math.atan2(-a.dir[2], a.dir[0])));
    expect(Math.abs(turned)).toBeCloseTo(Math.PI / 2, 3);
  });

  test('a quarter turn is a single round arc (never a loop the long way round)', () => {
    let d = planNext(starterPlayable(PAD_HEIGHT + 1), { kind: 'track', turn: 0, slope: 0 }, ground).design;
    for (const turn of [1, -1, 1, 1] as const) {
      const before = d.nodes.length;
      d = planNext(d, { kind: 'track', turn, slope: 0 }, ground).design;
      const part = new BakedTrack({ ...d, closed: false, nodes: d.nodes.slice(before - 1) });
      expect(part.length, `turn ${turn}`).toBeGreaterThan((Math.PI / 2) * 16 - 1);
      expect(part.length, `turn ${turn}`).toBeLessThan((Math.PI / 2) * 16 + 1.5);
    }
  });

  test('random building sessions: always on the grid, closed, clash-free, never below ground, the train never errors', () => {
    const rnd = mulberry32(99);
    for (let trial = 0; trial < 30; trial++) {
      let d = trial % 2 ? starterPlayable(PAD_HEIGHT + 1) : freshCoaster(starterPlayable(PAD_HEIGHT + 1), PAD_HEIGHT + 1, ground);
      const steps = 2 + Math.floor(rnd() * 10);
      for (let k = 0; k < steps; k++) {
        if (rnd() < 0.15) {
          d = removePiece(d);
          continue;
        }
        const c = choices[Math.floor(rnd() * choices.length)]!;
        const plan = planNext(d, c, ground);
        d = plan.design;
        const end = d.nodes[d.nodes.length - 1]!;
        expect(onGrid(gridFrame(d), end.p, end.dir), `trial ${trial} step ${k} ${JSON.stringify(c)}`).toBe(true);
      }
      const t = new BakedTrack(withReturn(d, { groundAt: ground, speed: 15 }));
      expect(t.closed).toBe(true);
      expect(t.diagnostics.seamFlip, `trial ${trial}`).toBe(false);
      expect(worstClash(t), `trial ${trial}`).toBeGreaterThanOrEqual(MIN_VERTICAL - 0.6);
      for (let i = 0; i < t.count; i += 4) expect(t.pos[i * 3 + 1]! - ground(t.pos[i * 3]!, t.pos[i * 3 + 2]!), `trial ${trial}`).toBeGreaterThan(0.4);
      let twist = 0;
      for (let i = 1; i < t.count; i++) twist = Math.max(twist, Math.abs(t.bank[i]! - t.bank[i - 1]!) / t.ds);
      expect(twist, `trial ${trial} twist rate`).toBeLessThan(0.7);
      const sim = new TrainSim(t, cfg(4), { ...DEFAULT_PHYSICS });
      sim.dispatch();
      for (let i = 0; i < 120 * 20; i++) {
        sim.step(1 / 120);
        for (const e of sim.events) expect(e.type, `trial ${trial}`).not.toBe('numeric-error');
        sim.events.length = 0;
      }
    }
  }, 90_000);

  test('regression (playtest): every piece in turn, every special, then keyboard pieces: no clash, no twist', () => {
    let d = starterPlayable(PAD_HEIGHT + 1);
    const seq: Array<BuildChoice | 'rm'> = [];
    for (const turn of [0, 1, -1] as const) for (const slope of [0, 1, -1] as const) seq.push({ kind: 'track', turn, slope });
    for (const id of SPECIALS) seq.push({ kind: 'special', id });
    seq.push({ kind: 'track', turn: 1, slope: 0 }, { kind: 'track', turn: 1, slope: 1 }, { kind: 'track', turn: -1, slope: 1 }, 'rm');
    for (const c of seq) {
      d = c === 'rm' ? removePiece(d) : planNext(d, c, ground).design;
      for (const speed of [10, 16, 22]) {
        const t = new BakedTrack(withReturn(d, { groundAt: ground, speed }));
        expect(worstClash(t), `${JSON.stringify(c)} at speed ${speed}`).toBeGreaterThanOrEqual(MIN_VERTICAL - 0.6);
        let twist = 0;
        for (let i = 1; i < t.count; i++) twist = Math.max(twist, Math.abs(t.bank[i]! - t.bank[i - 1]!) / t.ds);
        expect(twist, `${JSON.stringify(c)} twist`).toBeLessThan(0.7);
      }
    }
  }, 120_000);

  test('the ghost knows when it is at the ground and when it passes under other track', () => {
    let d = starterPlayable(PAD_HEIGHT + 1);
    for (let i = 0; i < 3; i++) d = planNext(d, { kind: 'track', turn: 0, slope: -1 }, ground).design;
    const p = planNext(d, { kind: 'track', turn: 0, slope: -1 }, ground);
    expect(p.atGround).toBe(true);
    expect(p.height).toBeGreaterThan(1);
  });
});
