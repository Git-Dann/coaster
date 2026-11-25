import { describe, expect, test } from 'vitest';
import { BakedTrack } from '../engine/track/bake';
import { withReturn } from '../engine/track/auto-return';
import { starterPlayable } from '../engine/track/starter';
import { Heightfield, PAD_HEIGHT } from '../engine/terrain/heightfield';
import { mulberry32 } from '../engine/terrain/noise';
import { planNext, SPECIALS, type BuildChoice } from '../features/builder/simple-builder';
import { TrainSim } from '../engine/physics/train-sim';
import { DEFAULT_PHYSICS } from '../engine/train/config';
import { cfg } from './physics/helpers';
import type { Biome } from '../types/world';
import type { TrackDesign } from '../engine/track/types';

/**
 * What a rider feels, measured in the real simulation: random coasters (launch first, so speeds are
 * high) are ridden for a full lap, and the g-forces must never jolt (no sudden change), spike or
 * flip. Also checks the track's orientation never flips and loops don't twist.
 */
const choices: BuildChoice[] = [];
for (const turn of [-1, 0, 1] as const) for (const slope of [-1, 0, 1] as const) choices.push({ kind: 'track', turn, slope });
for (const id of SPECIALS) choices.push({ kind: 'special', id });

/** The game's own estimate of speed at the end of the player's track (engine.estimateSpeed). */
function estimate(d: TrackDesign): number {
  let maxY = -Infinity;
  for (const n of d.nodes) maxY = Math.max(maxY, n.p[1]);
  const end = d.nodes[d.nodes.length - 1]!;
  const launch = Math.max(0, ...d.nodes.filter((n) => n.kind === 'launch').map((n) => n.param ?? 0));
  return Math.min(24, Math.max(8, Math.sqrt(2 * 9.81 * Math.max(0, maxY - end.p[1])) * 0.85, launch * 0.85));
}

function randomCoaster(biome: Biome, seed: number, trial: number): { d: TrackDesign; full: TrackDesign } {
  const hf = new Heightfield(biome, seed);
  const ground = (x: number, z: number) => hf.height(x, z);
  const rnd = mulberry32(seed * 31 + trial);
  let d = planNext(starterPlayable(PAD_HEIGHT + 1), { kind: 'special', id: 'launch' }, ground).design;
  for (let k = 0; k < 9; k++) {
    const p = planNext(d, choices[Math.floor(rnd() * choices.length)]!, ground);
    if (!p.blocked) d = p.design;
  }
  return { d, full: withReturn(d, { groundAt: ground, speed: estimate(d) }) };
}

const worlds: Array<[Biome, number]> = [
  ['meadow', 2026],
  ['alpine', 7],
];

describe('ride comfort', () => {
  test('no jolts, spikes or flips anywhere on the ridden circuit', () => {
    for (const [biome, seed] of worlds) {
      for (let trial = 0; trial < 6; trial++) {
        const { full } = randomCoaster(biome, seed, trial);
        const t = new BakedTrack(full);
        const sim = new TrainSim(t, cfg(4), { ...DEFAULT_PHYSICS });
        sim.dispatch();
        const dt = 1 / 120;
        let sv = 1;
        let sl = 0;
        let pv = 1;
        let pl = 0;
        let travelled = 0;
        let last = sim.s;
        let worst = { jerk: 0, gMax: 0, gMin: 1, lat: 0 };
        let latAt = '';
        let minAt = '';
        let maxAt = '';
        let jerkAt = '';
        const here = () => {
          let ni = 0;
          while (ni + 1 < t.nodeS.length && t.nodeS[ni + 1]! <= sim.s) ni++;
          return `at ${sim.s.toFixed(0)} m (${full.nodes[Math.min(ni + 1, full.nodes.length - 1)]!.group}), ${sim.v.toFixed(1)} m/s`;
        };
        for (let i = 0; i < 120 * 300 && travelled < t.length + 5; i++) {
          sim.step(dt);
          let ds = sim.s - last;
          if (ds < -t.length / 2) ds += t.length;
          travelled += Math.max(0, ds);
          last = sim.s;
          // A rider's body smooths over a few hundredths of a second.
          sv += (sim.telemetry.gVert - sv) * 0.2;
          sl += (sim.telemetry.gLat - sl) * 0.2;
          if (i > 60) {
            const j = Math.hypot(sv - pv, sl - pl) / dt;
            if (j > worst.jerk) jerkAt = here();
            if (sv < worst.gMin) minAt = here();
            if (sv > worst.gMax) maxAt = here();
            worst = {
              jerk: Math.max(worst.jerk, Math.hypot(sv - pv, sl - pl) / dt),
              gMax: Math.max(worst.gMax, sv),
              gMin: Math.min(worst.gMin, sv),
              lat: Math.max(worst.lat, Math.abs(sl)),
            };
            if (Math.abs(sl) >= worst.lat) {
              let ni = 0;
              while (ni + 1 < t.nodeS.length && t.nodeS[ni + 1]! <= sim.s) ni++;
              latAt = `at ${sim.s.toFixed(0)} m (${full.nodes[Math.min(ni + 1, full.nodes.length - 1)]!.group}), ${sim.v.toFixed(1)} m/s`;
            }
          }
          pv = sv;
          pl = sl;
        }
        const where = `${biome} coaster ${trial}`;
        expect(worst.jerk, `${where}: g-force jolt ${jerkAt}`).toBeLessThan(65);
        expect(worst.gMax, `${where}: peak vertical g ${maxAt}`).toBeLessThan(5);
        expect(worst.gMin, `${where}: strongest negative g ${minAt}`).toBeGreaterThan(-1.5);
        expect(worst.lat, `${where}: sideways g ${latAt}`).toBeLessThan(2.5);
      }
    }
  }, 300_000);

  test("the track's orientation never flips, and loops don't twist", () => {
    for (const [biome, seed] of worlds) {
      for (let trial = 0; trial < 6; trial++) {
        const { full } = randomCoaster(biome, seed, trial);
        const t = new BakedTrack(full, 0.25);
        for (let i = 1; i < t.count; i++) {
          const dotUp = t.up[i * 3]! * t.up[(i - 1) * 3]! + t.up[i * 3 + 1]! * t.up[(i - 1) * 3 + 1]! + t.up[i * 3 + 2]! * t.up[(i - 1) * 3 + 2]!;
          // At most ~11° of roll in a quarter of a metre (rolls and corkscrews included).
          expect(dotUp, `${biome} coaster ${trial}: the track flips at ${(i * t.ds).toFixed(1)} m`).toBeGreaterThan(0.98);
        }
      }
    }
    const hf = new Heightfield('meadow', 2026);
    const ground = (x: number, z: number) => hf.height(x, z);
    const base = planNext(starterPlayable(PAD_HEIGHT + 1), { kind: 'special', id: 'launch' }, ground).design;
    const p = planNext(base, { kind: 'special', id: 'loop' }, ground);
    expect(p.blocked).toBeNull();
    const t = new BakedTrack({ ...p.design, closed: false }, 0.25);
    const s0 = t.nodeS[p.start]!;
    const s1 = t.nodeS[Math.min(p.start + 10, p.design.nodes.length - 1)]!;
    let roll = 0;
    for (let i = Math.ceil(s0 / t.ds) + 2; i < Math.floor(s1 / t.ds) - 2; i++) {
      const a = (i - 2) * 3;
      const b = (i + 2) * 3;
      const u0 = [t.up[a]!, t.up[a + 1]!, t.up[a + 2]!];
      const u1 = [t.up[b]!, t.up[b + 1]!, t.up[b + 2]!];
      const tn = [t.tan[i * 3]!, t.tan[i * 3 + 1]!, t.tan[i * 3 + 2]!];
      const cx = [u0[1]! * u1[2]! - u0[2]! * u1[1]!, u0[2]! * u1[0]! - u0[0]! * u1[2]!, u0[0]! * u1[1]! - u0[1]! * u1[0]!];
      roll = Math.max(roll, Math.abs(cx[0]! * tn[0]! + cx[1]! * tn[1]! + cx[2]! * tn[2]!) / (4 * t.ds));
    }
    // A loop has no roll of its own: its rails stay parallel all the way round.
    expect(roll).toBeLessThan(0.05);
  });
});
