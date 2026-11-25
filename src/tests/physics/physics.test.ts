import { describe, expect, test } from 'vitest';
import { BakedTrack, newSample } from '../../engine/track/bake';
import { TrainSim, G0 } from '../../engine/physics/train-sim';
import { DEFAULT_PHYSICS } from '../../engine/train/config';
import { FixedStepLoop } from '../../engine/core/fixed-step';
import { starterClosed } from '../../engine/track/starter';
import { translateDesign } from '../../engine/track/design-ops';
import { appendElement } from '../../engine/track/design-ops';
import { verticalLoop, piece } from '../../engine/track/elements';
import { FRICTIONLESS, cfg, design, line, node, rollingCircuit, run, running } from './helpers';

const g = DEFAULT_PHYSICS.gravity;

describe('free coast energy conservation', () => {
  test('mechanical energy is conserved without resistance', () => {
    const track = new BakedTrack(rollingCircuit());
    const sim = running(track, 3, 10, 14);
    const en = sim.energyAt(10, 14);
    const e0 = en.kinetic + en.potential;
    let maxRel = 0;
    run(sim, 60, 1 / 120, (s) => {
      maxRel = Math.max(maxRel, Math.abs(s.telemetry.energy - e0) / e0);
    });
    expect(maxRel).toBeLessThan(2e-5);
    expect(sim.telemetry.dissipated).toBe(0);
    expect(sim.telemetry.powered).toBe(0);
  });

  test('energy error converges as the timestep decreases', () => {
    const track = new BakedTrack(rollingCircuit());
    const err = (dt: number) => {
      const sim = running(track, 3, 10, 14);
      const e0 = sim.energyAt(10, 14);
      const E0 = e0.kinetic + e0.potential;
      let m = 0;
      run(sim, 20, dt, (s) => (m = Math.max(m, Math.abs(s.telemetry.energy - E0) / E0)));
      return m;
    };
    const e30 = err(1 / 30);
    const e60 = err(1 / 60);
    const e120 = err(1 / 120);
    expect(e60).toBeLessThan(e30);
    expect(e120).toBeLessThanOrEqual(e60 * 1.01);
    expect(e120).toBeLessThan(1e-4);
  });
});

describe('inclined track', () => {
  test('acceleration equals the gravitational component along the slope', () => {
    for (const deg of [5, 15, 30]) {
      const a = (deg * Math.PI) / 180;
      const dir: [number, number, number] = [Math.cos(a), Math.sin(a), 0];
      const track = new BakedTrack(design(line([0, 0, 0], dir, 200)));
      const sim = running(track, 1, 100, 0.0, FRICTIONLESS);
      sim.step(1 / 120);
      const expected = (-g * Math.sin(a) * sim.mass) / sim.massEff;
      expect(sim.telemetry.accel).toBeCloseTo(expected, 4);
    }
  });
});

describe('resistance', () => {
  test('rolling resistance and drag only remove energy', () => {
    const track = new BakedTrack(rollingCircuit());
    const sim = running(track, 4, 10, 15, { ...DEFAULT_PHYSICS });
    const e = sim.energyAt(10, 15);
    const E0 = e.kinetic + e.potential;
    let lastDiss = 0;
    run(sim, 30, 1 / 120, (s) => {
      expect(s.telemetry.dissipated).toBeGreaterThanOrEqual(lastDiss - 1e-9);
      lastDiss = s.telemetry.dissipated;
      // Energy balance: current + dissipated ≈ initial
      expect(Math.abs(s.telemetry.energy + s.telemetry.dissipated - E0) / E0).toBeLessThan(1e-3);
    });
    expect(sim.telemetry.energy).toBeLessThan(E0);
  });

  test('a coasting train slows naturally on flat track and does not oscillate around zero', () => {
    const track = new BakedTrack(design(line([0, 0, 0], [1, 0, 0], 2000, 50)));
    const sim = running(track, 3, 20, 10, { ...DEFAULT_PHYSICS });
    let prev = sim.v;
    let reversals = 0;
    run(sim, 240, 1 / 120, (s) => {
      expect(s.v).toBeLessThanOrEqual(prev + 1e-9);
      if (Math.sign(s.v) !== Math.sign(prev) && prev !== 0) reversals++;
      prev = s.v;
    });
    expect(sim.v).toBeLessThan(10);
    expect(sim.v).toBeGreaterThanOrEqual(-1e-6);
    expect(reversals).toBe(0);
  });
});

describe('incline and rollback', () => {
  test('insufficient energy stops the train and it rolls back', () => {
    const a = (20 * Math.PI) / 180;
    const nodes = [
      ...line([0, 0, 0], [1, 0, 0], 60, 20).slice(0, -1),
      ...line([60, 0, 0], [Math.cos(a), Math.sin(a), 0], 200, 20).map((n, i) => ({ ...n, id: `u${i}` })),
    ];
    const track = new BakedTrack(design(nodes));
    const v0 = 10;
    const sim = running(track, 1, 30, v0);
    let maxH = -Infinity;
    let rolledBack = false;
    run(sim, 20, 1 / 120, (s) => {
      maxH = Math.max(maxH, s.telemetry.height);
      if (s.v < -0.5) rolledBack = true;
    });
    // Centre-of-mass rise ≈ v²/2g scaled by M/M_eff (wheel inertia stores some kinetic energy).
    const expectedRise = ((v0 * v0) / (2 * g)) * (sim.massEff / sim.mass);
    expect(rolledBack).toBe(true);
    expect(maxH).toBeGreaterThan(expectedRise * 0.9);
    expect(maxH).toBeLessThan(expectedRise * 1.15);
  });
});

describe('distributed train mass', () => {
  // Flat run into a 25° descent: as more of the train passes the crest, acceleration grows.
  const a = (25 * Math.PI) / 180;
  const nodes = [
    ...line([0, 0, 0], [1, 0, 0], 80, 20).slice(0, -1),
    ...line([80, 0, 0], [Math.cos(a), -Math.sin(a), 0], 120, 20).map((n, i) => ({ ...n, id: `d${i}` })),
  ];
  const track = new BakedTrack(design(nodes));

  test('acceleration matches the sum of per-bogie gravity components', () => {
    for (const cars of [1, 3, 6]) {
      const sim = new TrainSim(track, cfg(cars), FRICTIONLESS);
      const smp = newSample();
      for (const front of [70, 85, 90, 100]) {
        sim.s = front;
        sim.v = 0;
        sim.state = 'running';
        // Expected from an independent evaluation of the track tangents at every bogie.
        let F = 0;
        const p = { steel: { pitch: 3.0, wheelbase: 1.8, mass: 850 } }.steel;
        for (let i = 0; i < cars; i++) {
          for (const o of [p.wheelbase / 2, -p.wheelbase / 2]) {
            track.sample(front - i * p.pitch + o, smp);
            F += (p.mass / 2) * -g * smp.dyds;
          }
        }
        sim.step(1e-4);
        expect(sim.telemetry.accel).toBeCloseTo(F / sim.massEff, 2);
      }
    }
  });

  test('a six-car train is pulled over the crest by its descending cars', () => {
    const one = new TrainSim(track, cfg(1), FRICTIONLESS);
    const six = new TrainSim(track, cfg(6), FRICTIONLESS);
    // Front car 6 m past the crest: the single car is fully on the slope, most of the long train is not.
    for (const sim of [one, six]) {
      sim.s = 86 + 0.9;
      sim.v = 0;
      sim.state = 'running';
      sim.step(1e-4);
    }
    expect(one.telemetry.accel).toBeGreaterThan(six.telemetry.accel * 1.3);
    expect(six.telemetry.accel).toBeGreaterThan(0.1);
    // As more of the long train passes the crest its acceleration keeps growing.
    let prev = -Infinity;
    for (const front of [76, 82, 88, 94, 100]) {
      six.s = front;
      six.v = 0;
      six.step(1e-4);
      expect(six.telemetry.accel).toBeGreaterThan(prev);
      prev = six.telemetry.accel;
    }
  });

  test('more mass does not by itself change acceleration on a uniform slope', () => {
    const dir: [number, number, number] = [Math.cos(0.3), -Math.sin(0.3), 0];
    const slope = new BakedTrack(design(line([0, 50, 0], dir, 200)));
    const r = [1, 3, 6].map((cars) => {
      const sim = running(slope, cars, 100, 0);
      sim.step(1e-4);
      return sim.telemetry.accel;
    });
    expect(r[1]).toBeCloseTo(r[0]!, 6);
    expect(r[2]).toBeCloseTo(r[0]!, 6);
  });
});

describe('banked curves', () => {
  test('a correctly banked turn produces no lateral force and the expected vertical force', () => {
    const v = 15;
    const R = 40;
    const bank = Math.atan2(v * v, g * R);
    // Full flat circle, banked so the up vector tilts towards the centre (left turn ⇒ negative bank).
    const nodes = [];
    const count = 12;
    for (let i = 0; i < count; i++) {
      const t = (i / count) * Math.PI * 2;
      nodes.push(node(`c${i}`, [R * Math.sin(t), 5, -R + R * Math.cos(t)], [Math.cos(t), 0, -Math.sin(t)], 'track', -bank));
    }
    // Moving +X at t=0 and curving towards −Z is a left turn, so the bank is negative (up tilts left).
    const track = new BakedTrack(design(nodes, true));
    const smp = track.sample(10, newSample());
    // Curvature points towards the centre; the up vector must tilt towards it as well.
    const tiltTowardsCentre = smp.up[0] * smp.curv[0] + smp.up[1] * smp.curv[1] + smp.up[2] * smp.curv[2];
    const sim = running(track, 1, 30, v);
    run(sim, 2);
    if (tiltTowardsCentre > 0) {
      expect(Math.abs(sim.telemetry.gLat)).toBeLessThan(0.03);
      expect(sim.telemetry.gVert).toBeCloseTo(Math.hypot(1, (v * v) / (g * R)) * (g / G0), 1);
    } else {
      // Bank sign convention mismatch would be a bug.
      throw new Error('bank tilts away from the centre of the turn');
    }
  });
});

describe('vertical loop', () => {
  test('speed and normal acceleration follow energy conservation through the loop', () => {
    let d = design([node('a', [0, 0, 0], [1, 0, 0]), node('b', [30, 0, 0], [1, 0, 0])]);
    d = appendElement(d, verticalLoop({ p: [30, 0, 0], dir: [1, 0, 0], bank: 0 }, 24));
    d = appendElement(d, piece({ p: d.nodes[d.nodes.length - 1]!.p, dir: [1, 0, 0], bank: 0 }, { length: 40, turn: 0, rise: 0, bank: 0 }));
    const track = new BakedTrack(d);
    expect(track.diagnostics.seamFlip).toBe(false);
    const sim = running(track, 1, 15, 24);
    let topH = -Infinity;
    let vTop = 0;
    let gTop = 0;
    let inverted = false;
    run(sim, 6, 1 / 240, (s) => {
      if (s.telemetry.height > topH) {
        topH = s.telemetry.height;
        vTop = s.v;
        gTop = s.telemetry.gVert;
        const smp = track.sample(s.cars[0]!.centre, newSample());
        inverted = smp.up[1] < -0.9;
      }
    });
    expect(inverted).toBe(true);
    const ratio = sim.mass / sim.massEff;
    const expectedV = Math.sqrt(24 * 24 - 2 * g * ratio * topH);
    expect(vTop).toBeCloseTo(expectedV, 0);
    // Riders are pressed into their seats at the top (positive G in the track frame).
    expect(gTop).toBeGreaterThan(0);
  });
});

describe('lift hill', () => {
  test('engages, climbs at chain speed and never rolls back', () => {
    const a = (30 * Math.PI) / 180;
    const nodes = [
      node('a', [0, 0, 0], [1, 0, 0], 'track'),
      node('b', [20, 0, 0], [1, 0, 0], 'lift', 0, 3),
      node('c', [30, 2.7, 0], [Math.cos(a), Math.sin(a), 0], 'lift', 0, 3),
      node('d', [80, 31.6, 0], [Math.cos(a), Math.sin(a), 0], 'lift', 0, 3),
      node('e', [90, 34, 0], [1, 0, 0], 'track'),
      node('f', [120, 34, 0], [1, 0, 0], 'track'),
    ];
    const track = new BakedTrack(design(nodes));
    const sim = running(track, 3, 12, 1, { ...DEFAULT_PHYSICS });
    let engaged = false;
    let minV = Infinity;
    let onLiftSpeeds: number[] = [];
    run(sim, 30, 1 / 120, (s) => {
      for (const e of s.events) if (e.type === 'lift-engage') engaged = true;
      s.events.length = 0;
      if (s.cars.every((c) => c.section === 'lift')) {
        minV = Math.min(minV, s.v);
        onLiftSpeeds.push(s.v);
      }
    });
    expect(engaged).toBe(true);
    expect(minV).toBeGreaterThanOrEqual(0);
    onLiftSpeeds = onLiftSpeeds.slice(Math.floor(onLiftSpeeds.length / 2));
    for (const v of onLiftSpeeds) expect(v).toBeCloseTo(3, 2);
    expect(sim.telemetry.powered).toBeGreaterThan(0);
  });

  test('a train stopped on the lift does not roll back', () => {
    const a = (30 * Math.PI) / 180;
    const track = new BakedTrack(design(line([0, 0, 0], [Math.cos(a), Math.sin(a), 0], 100, 20, 'lift')));
    const sim = running(track, 2, 40, -2);
    run(sim, 3, 1 / 120, (s) => expect(s.v).toBeGreaterThanOrEqual(0));
  });
});

describe('braking', () => {
  test('brakes slow the train to the target speed without adding energy', () => {
    const nodes = [node('a', [0, 0, 0], [1, 0, 0]), node('b', [40, 0, 0], [1, 0, 0], 'brake', 0, 2), node('c', [140, 0, 0], [1, 0, 0])];
    const track = new BakedTrack(design(nodes));
    const sim = running(track, 3, 20, 15);
    let prevE = sim.energyAt(20, 15).kinetic;
    let maxDecel = 0;
    run(sim, 8, 1 / 120, (s) => {
      expect(s.telemetry.energy).toBeLessThanOrEqual(prevE + 1e-6);
      prevE = s.telemetry.energy;
      maxDecel = Math.max(maxDecel, -s.telemetry.accel);
    });
    expect(sim.v).toBeGreaterThan(1.5);
    expect(sim.v).toBeLessThan(2.6);
    expect(maxDecel).toBeLessThanOrEqual(DEFAULT_PHYSICS.brakeDecel + 0.01);
    expect(sim.telemetry.powered).toBe(0);
  });
});

describe('station', () => {
  test('stops smoothly at the platform and dispatches repeatably', () => {
    const track = new BakedTrack(starterClosed(2));
    const sim = new TrainSim(track, cfg(6), { ...DEFAULT_PHYSICS });
    const stop = sim.s;
    expect(sim.state).toBe('hold');
    expect(sim.stationFits()).toBe(true);
    const arrivals: number[] = [];
    let maxStationDecel = 0;
    run(sim, 300, 1 / 120, (s) => {
      for (const e of s.events) if (e.type === 'arrive') arrivals.push(s.time);
      s.events.length = 0;
      if (s.cars[0]!.section === 'station' && s.state === 'running') maxStationDecel = Math.max(maxStationDecel, -s.telemetry.accel);
    });
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(sim.s - stop) < 0.05 || sim.state !== 'hold').toBe(true);
    const laps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
    for (const l of laps) expect(l).toBeCloseTo(laps[0]!, 1);
    expect(maxStationDecel).toBeLessThan(3);
  });
});

describe('closed circuits', () => {
  test('position, tangent, banking and frame are continuous at the seam', () => {
    for (const d of [starterClosed(2), rollingCircuit()]) {
      const track = new BakedTrack(d);
      const a = track.sample(track.length - 1e-3, newSample());
      const b = track.sample(1e-3, newSample());
      const dist = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]);
      expect(dist).toBeLessThan(0.01);
      expect(a.tan[0] * b.tan[0] + a.tan[1] * b.tan[1] + a.tan[2] * b.tan[2]).toBeGreaterThan(0.9999);
      expect(a.up[0] * b.up[0] + a.up[1] * b.up[1] + a.up[2] * b.up[2]).toBeGreaterThan(0.9999);
      expect(track.diagnostics.seamFlip).toBe(false);
    }
  });
});

describe('frame-rate independence', () => {
  test('30, 60 and 120 FPS rendering produce identical simulation results', () => {
    const results = [30, 60, 120, 144].map((fps) => {
      const track = new BakedTrack(starterClosed(2));
      const sim = new TrainSim(track, cfg(4), { ...DEFAULT_PHYSICS });
      const loop = new FixedStepLoop(1 / 120);
      const frames = Math.round(90 * fps);
      for (let i = 0; i < frames; i++) loop.advance(1 / fps, (dt) => sim.step(dt));
      return { s: sim.s, v: sim.v, t: sim.time };
    });
    for (const r of results) {
      // Same number of fixed steps up to one step of phase difference.
      expect(Math.abs(r.t - results[0]!.t)).toBeLessThanOrEqual(1 / 120 + 1e-9);
      expect(Math.abs(r.s - results[0]!.s)).toBeLessThan(0.3);
    }
  });

  test('irregular frame times give the same result as regular ones', () => {
    const mk = () => new TrainSim(new BakedTrack(starterClosed(2)), cfg(3), { ...DEFAULT_PHYSICS });
    const a = mk();
    const b = mk();
    const la = new FixedStepLoop(1 / 120);
    const lb = new FixedStepLoop(1 / 120);
    for (let i = 0; i < 60 * 60; i++) la.advance(1 / 60, (dt) => a.step(dt));
    let t = 0;
    let k = 0;
    while (t < 60 - 1e-9) {
      const f = [1 / 30, 1 / 90, 1 / 45, 1 / 144][k++ % 4]!;
      const step = Math.min(f, 60 - t);
      lb.advance(step, (dt) => b.step(dt));
      t += step;
    }
    expect(Math.abs(a.time - b.time)).toBeLessThanOrEqual(1 / 120 + 1e-9);
    expect(Math.abs(a.s - b.s)).toBeLessThan(0.3);
  });

  test('backgrounded tabs do not replay long gaps', () => {
    const loop = new FixedStepLoop(1 / 120, 8, 0.25);
    let n = 0;
    loop.advance(30, () => n++);
    expect(n).toBeLessThanOrEqual(8);
  });
});

describe('long-duration operation', () => {
  test('repeated circuits produce no NaNs or energy gains', () => {
    const track = new BakedTrack(starterClosed(2));
    const sim = new TrainSim(track, cfg(6), { ...DEFAULT_PHYSICS });
    let arrivals = 0;
    const atArrival: number[] = [];
    run(sim, 20 * 60, 1 / 120, (s) => {
      expect(Number.isFinite(s.s) && Number.isFinite(s.v)).toBe(true);
      for (const e of s.events) {
        if (e.type === 'arrive') {
          arrivals++;
          atArrival.push(s.telemetry.energy);
        }
        expect(e.type).not.toBe('numeric-error');
      }
      s.events.length = 0;
    });
    expect(arrivals).toBeGreaterThan(15);
    for (const e of atArrival) expect(Math.abs(e - atArrival[0]!)).toBeLessThan(1);
    // Frames stay orthonormal.
    const smp = newSample();
    for (let s = 0; s < track.length; s += 3) {
      track.sample(s, smp);
      expect(Math.hypot(...smp.up)).toBeCloseTo(1, 6);
      expect(smp.up[0] * smp.tan[0] + smp.up[1] * smp.tan[1] + smp.up[2] * smp.tan[2]).toBeCloseTo(0, 6);
    }
    // 20 simulated minutes: ~4 s alone, longer when the suite runs in parallel on CI.
  }, 30_000);
});

describe('origin independence', () => {
  test('translating the coaster far from the origin does not change the simulation', () => {
    const base = starterClosed(2);
    const far = translateDesign(base, 250_000, 0, -180_000);
    const run2 = (d: typeof base) => {
      const sim = new TrainSim(new BakedTrack(d), cfg(5), { ...DEFAULT_PHYSICS });
      run(sim, 70);
      return sim;
    };
    const a = run2(base);
    const b = run2(far);
    expect(b.s).toBeCloseTo(a.s, 3);
    expect(b.v).toBeCloseTo(a.v, 3);
    expect(b.telemetry.gVert).toBeCloseTo(a.telemetry.gVert, 3);
  });
});

describe('input validation', () => {
  test('carriage count and parameters are clamped', () => {
    const track = new BakedTrack(starterClosed(2));
    const sim = new TrainSim(track, cfg(42), { ...DEFAULT_PHYSICS, gravity: Number.NaN, rollingCoeff: -3 });
    expect(sim.cfg.cars).toBe(6);
    expect(sim.params.gravity).toBe(DEFAULT_PHYSICS.gravity);
    expect(sim.params.rollingCoeff).toBe(0);
  });
});
