import type { V3 } from '../../engine/core/vec3';
import { BakedTrack } from '../../engine/track/bake';
import { TrainSim } from '../../engine/physics/train-sim';
import { DEFAULT_PHYSICS, type PhysicsParams, type TrainConfig } from '../../engine/train/config';
import type { SectionKind, TrackDesign, TrackNode } from '../../engine/track/types';

export const COLOURS = { primary: '#fff', secondary: '#fff', seat: '#fff', trim: '#fff', wheels: '#fff' };

export function cfg(cars: number, style: TrainConfig['style'] = 'steel'): TrainConfig {
  return { cars, style, colours: COLOURS, finish: 'matte' };
}

export const FRICTIONLESS: PhysicsParams = { ...DEFAULT_PHYSICS, rollingCoeff: 0, dragScale: 0 };

export function node(id: string, p: V3, dir: V3, kind: SectionKind = 'track', bank = 0, param?: number): TrackNode {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  return { id, p, dir: [dir[0] / l, dir[1] / l, dir[2] / l], bank, kind, param };
}

export function design(nodes: TrackNode[], closed = false): TrackDesign {
  return {
    nodes,
    closed,
    style: 'tubular',
    supportStyle: 'powder-steel',
    colours: { rail: '#000', spine: '#000', sleeper: '#000', support: '#000' },
  };
}

/** Straight line of nodes every `step` metres along `dir` from `start`. */
export function line(start: V3, dir: V3, length: number, step = 20, kind: SectionKind = 'track'): TrackNode[] {
  const l = Math.hypot(dir[0], dir[1], dir[2]);
  const d: V3 = [dir[0] / l, dir[1] / l, dir[2] / l];
  const out: TrackNode[] = [];
  const n = Math.max(1, Math.round(length / step));
  for (let i = 0; i <= n; i++) {
    const s = (length * i) / n;
    out.push(node(`l${i}`, [start[0] + d[0] * s, start[1] + d[1] * s, start[2] + d[2] * s], d, kind));
  }
  return out;
}

/** A closed oval-ish circuit with rolling hills (no powered sections). */
export function rollingCircuit(): TrackDesign {
  const nodes: TrackNode[] = [];
  const R = 60;
  const count = 16;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const y = 12 + 6 * Math.sin(3 * a);
    const dy = (6 * 3 * Math.cos(3 * a)) / R; // dy/ds approx
    const p: V3 = [R * Math.cos(a), y, -R * Math.sin(a)];
    const t: V3 = [-Math.sin(a), dy, -Math.cos(a)];
    nodes.push(node(`r${i}`, p, t));
  }
  return design(nodes, true);
}

export function running(track: BakedTrack, cars: number, s: number, v: number, params: PhysicsParams = FRICTIONLESS): TrainSim {
  const sim = new TrainSim(track, cfg(cars), params);
  sim.s = s;
  sim.prevS = s;
  sim.v = v;
  sim.state = 'running';
  return sim;
}

export function run(sim: TrainSim, seconds: number, dt = 1 / 120, each?: (sim: TrainSim) => void): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    sim.step(dt);
    each?.(sim);
  }
}
