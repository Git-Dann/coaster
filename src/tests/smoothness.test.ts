import { describe, expect, test } from 'vitest';
import { BakedTrack } from '../engine/track/bake';
import { withReturn } from '../engine/track/auto-return';
import { starterPlayable } from '../engine/track/starter';
import { Heightfield, PAD_HEIGHT } from '../engine/terrain/heightfield';
import { mulberry32 } from '../engine/terrain/noise';
import { planNext, SPECIALS, type BuildChoice } from '../features/builder/simple-builder';
import type { Biome } from '../types/world';

/**
 * Coaster track is smooth: no ripples that follow the ground, no dips before a hump, no banking
 * that flips at a single point. These measure the whole ridden circuit on several terrains.
 */
const choices: BuildChoice[] = [];
for (const turn of [-1, 0, 1] as const) for (const slope of [-1, 0, 1] as const) choices.push({ kind: 'track', turn, slope });
for (const id of SPECIALS) choices.push({ kind: 'special', id });

/** Height turning points (with at least `min` metres of rise or fall) along [a, b). */
function turningPoints(t: BakedTrack, a: number, b: number, min = 0.3): number {
  let n = 0;
  let dir = 0;
  let pivot = t.pos[Math.floor(a / t.ds) * 3 + 1]!;
  for (let i = Math.floor(a / t.ds) + 1; i < Math.min(t.count, b / t.ds); i++) {
    const y = t.pos[i * 3 + 1]!;
    if (dir >= 0 && y < pivot - min) {
      if (dir > 0) n++;
      dir = -1;
      pivot = y;
    } else if (dir <= 0 && y > pivot + min) {
      if (dir < 0) n++;
      dir = 1;
      pivot = y;
    } else if ((dir > 0 && y > pivot) || (dir < 0 && y < pivot)) pivot = y;
  }
  return n;
}

/** Worst rate of change of the banking rate (rad/m²) along [a, b), over 4 m windows. */
function bankJerk(t: BakedTrack, a: number, b: number): number {
  const k = Math.round(2 / t.ds);
  let worst = 0;
  for (let i = Math.max(k, Math.floor(a / t.ds)); i < Math.min(t.count - k, b / t.ds); i++) {
    worst = Math.max(worst, Math.abs(t.bank[i + k]! - 2 * t.bank[i]! + t.bank[i - k]!) / (k * t.ds) ** 2);
  }
  return worst;
}

const worlds: Array<[Biome, number]> = [
  ['meadow', 2026],
  ['alpine', 7],
  ['woodland', 3],
];

describe('smooth track', () => {
  test('the automatic return floats over the ground: at most one hump, gentle banking', () => {
    let points = 0;
    let metres = 0;
    for (const [biome, seed] of worlds) {
      const hf = new Heightfield(biome, seed);
      const ground = (x: number, z: number) => hf.height(x, z);
      const rnd = mulberry32(seed);
      for (let trial = 0; trial < 10; trial++) {
        let d = starterPlayable(PAD_HEIGHT + 1);
        for (let k = 0; k < 8; k++) {
          const p = planNext(d, choices[Math.floor(rnd() * choices.length)]!, ground);
          if (!p.blocked) d = p.design;
        }
        const t = new BakedTrack(withReturn(d, { groundAt: ground, speed: 12 }), 0.25);
        const from = t.nodeS[d.nodes.length - 1]!;
        const tp = turningPoints(t, from, t.length);
        expect(tp, `${biome} trial ${trial}: the return rises and falls ${tp} times`).toBeLessThanOrEqual(1);
        expect(bankJerk(t, from, t.length), `${biome} trial ${trial}: banking changes abruptly`).toBeLessThan(0.06);
        // Still clear of the ground everywhere (on the station pad, at least as high as the platform sits).
        for (let i = Math.floor(from / t.ds); i < t.count; i += 4) expect(t.pos[i * 3 + 1]! - ground(t.pos[i * 3]!, t.pos[i * 3 + 2]!)).toBeGreaterThan(0.4);
        // It doesn't wander off across the map to get home.
        const first = d.nodes[0]!;
        const last = d.nodes[d.nodes.length - 1]!;
        const straight = Math.hypot(last.p[0] - first.p[0], last.p[2] - first.p[2]);
        expect(t.length - from, `${biome} trial ${trial}: the return is ${(t.length - from).toFixed(0)} m long`).toBeLessThanOrEqual(Math.max(220, straight * 2.4 + 2 * Math.PI * 34 + 60) + 40);
        points += tp;
        metres += t.length - from;
      }
    }
    expect((points / metres) * 100).toBeLessThan(0.35);
  });

  test('plain pieces are one smooth rise, fall or level run (no bumps), on any terrain', () => {
    for (const [biome, seed] of worlds) {
      const hf = new Heightfield(biome, seed);
      const ground = (x: number, z: number) => hf.height(x, z);
      const rnd = mulberry32(seed + 1);
      for (let trial = 0; trial < 10; trial++) {
        let d = starterPlayable(PAD_HEIGHT + 1);
        for (let k = 0; k < 10; k++) {
          const c = choices[Math.floor(rnd() * choices.length)]!;
          const p = planNext(d, c, ground);
          if (p.blocked) continue;
          if (c.kind === 'track') {
            const t = new BakedTrack({ ...p.design, closed: false }, 0.25);
            expect(turningPoints(t, t.nodeS[p.start - 1]!, t.length), `${biome}: ${JSON.stringify(c)} has a bump`).toBe(0);
          }
          d = p.design;
        }
      }
    }
  });
});
