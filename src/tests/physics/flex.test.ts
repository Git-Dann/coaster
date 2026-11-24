import { describe, expect, test } from 'vitest';
import { BakedTrack } from '../../engine/track/bake';
import { starterClosed } from '../../engine/track/starter';
import { TrainSim } from '../../engine/physics/train-sim';
import { DEFAULT_PHYSICS } from '../../engine/train/config';
import { FLEX_STEEL, FLEX_TIMBER, StructureFlex } from '../../engine/physics/flex';
import { cfg } from './helpers';

function rideWithFlex(profile = FLEX_TIMBER, seconds = 60) {
  const track = new BakedTrack(starterClosed(5));
  const sim = new TrainSim(track, cfg(6), { ...DEFAULT_PHYSICS });
  const flex = new StructureFlex();
  flex.profile = profile;
  sim.dispatch();
  let maxSway = 0;
  let maxBounce = 0;

  const o: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < seconds * 120; i++) {
    sim.step(1 / 120);
    flex.step(sim, track, 1 / 120);
    maxSway = Math.max(maxSway, Math.abs(flex.sway));
    maxBounce = Math.max(maxBounce, Math.abs(flex.bounce));
  }
  flex.update(sim, track, sim.cars, () => 0);
  const c = sim.cars[0]!;
  const p = track.sample(c.front, { pos: [0, 0, 0], tan: [1, 0, 0], up: [0, 1, 0], right: [0, 0, 1], curv: [0, 0, 0], dyds: 0, kind: 'track', param: 0, bank: 0 }).pos;
  flex.offsetAt(p[0], p[1], p[2], o);
  const maxDeflect = Math.abs(o[1]);
  const far = flex.offsetAt(p[0] + 200, p[1], p[2] + 200, [0, 0, 0]);
  return { maxSway, maxBounce, maxDeflect, far };
}

describe('structural flex', () => {
  test('timber flex is subtle: centimetres, never more', () => {
    const r = rideWithFlex(FLEX_TIMBER);
    expect(r.maxSway).toBeGreaterThan(0.005); // visible up close
    expect(r.maxSway).toBeLessThanOrEqual(0.08);
    expect(r.maxBounce).toBeLessThanOrEqual(0.03);
    expect(r.maxDeflect).toBeGreaterThan(0.004);
    expect(r.maxDeflect).toBeLessThan(0.05);
    expect(Math.abs(r.far[0]) + Math.abs(r.far[1]) + Math.abs(r.far[2])).toBeLessThan(1e-6);
  });

  test('steel is much stiffer than timber', () => {
    const t = rideWithFlex(FLEX_TIMBER);
    const s = rideWithFlex(FLEX_STEEL);
    expect(s.maxSway).toBeLessThan(t.maxSway / 4);
    expect(s.maxDeflect).toBeLessThan(t.maxDeflect / 4);
  });

  test('rougher wooden track arrives slower at the same point in the lap', () => {
    const speedAt = (roughness: number) => {
      const track = new BakedTrack(starterClosed(5));
      const sim = new TrainSim(track, cfg(4), { ...DEFAULT_PHYSICS });
      sim.trackRoughness = roughness;
      sim.dispatch();
      // Run until the train is past the lift and reaches 75 % of the circuit.
      let reached = 0;
      for (let i = 0; i < 120 * 90 && !reached; i++) {
        sim.step(1 / 120);
        if (sim.state === 'running' && sim.s > track.length * 0.75 && sim.s < track.length * 0.8) reached = sim.v;
      }
      return reached;
    };
    const steel = speedAt(1);
    const wood = speedAt(1.55);
    expect(steel).toBeGreaterThan(5);
    expect(wood).toBeLessThan(steel - 0.2);
  });
});
