import type { V3 } from '../core/vec3';
import { dubins, type Pose, type Seg } from './auto-return';
import { autoBank } from './elements';
import type { TrackDesign, TrackNode } from './types';

/**
 * The building grid (edit mode). Like a classic park builder: 8 m tiles, track that faces the four
 * compass directions, and heights in 2 m levels. The grid is anchored to the end of the station
 * platform, so every coaster has its own grid lined up with its station.
 */
export const TILE = 8;
export const LEVEL = 2;
const QUARTER = Math.PI / 2;

export interface GridFrame {
  /** Grid origin (end of the station platform). */
  x: number;
  z: number;
  /** Heading of the grid's "forward" axis (the station's direction). */
  h: number;
  /** Height of the station platform; levels are counted from here. */
  y: number;
}

const headingOf = (d: readonly number[]) => Math.atan2(-d[2]!, d[0]!);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The grid for a design: anchored at the last station node. */
export function gridFrame(design: Pick<TrackDesign, 'nodes'>): GridFrame {
  // The grid starts where your own building starts: the end of the station, or of the track the
  // coaster came with, so the first piece you add carries straight on (no sideways jog to reach a
  // grid that's out of line with it). Pieces built in edit mode carry a '~' in their group name.
  let anchor = design.nodes[0]!;
  for (const n of design.nodes) {
    if (n.group?.includes('~')) break;
    anchor = n;
  }
  return { x: anchor.p[0], z: anchor.p[2], h: headingOf(anchor.dir), y: anchor.p[1] };
}

/** Nearest compass heading of the grid. */
export function snapHeading(g: GridFrame, h: number): number {
  return g.h + Math.round(wrap(h - g.h) / QUARTER) * QUARTER;
}

/** Grid coordinates (tiles) of a world point. */
export function toGrid(g: GridFrame, x: number, z: number): { u: number; v: number } {
  const dx = x - g.x;
  const dz = z - g.z;
  const fx = Math.cos(g.h);
  const fz = -Math.sin(g.h);
  // Left of forward: heading + 90°.
  const lx = -Math.sin(g.h);
  const lz = -Math.cos(g.h);
  return { u: (dx * fx + dz * fz) / TILE, v: (dx * lx + dz * lz) / TILE };
}

export function fromGrid(g: GridFrame, u: number, v: number): { x: number; z: number } {
  return {
    x: g.x + (Math.cos(g.h) * u - Math.sin(g.h) * v) * TILE,
    z: g.z + (-Math.sin(g.h) * u - Math.cos(g.h) * v) * TILE,
  };
}

export function snapPoint(g: GridFrame, x: number, z: number): { x: number; z: number } {
  const { u, v } = toGrid(g, x, z);
  return fromGrid(g, Math.round(u), Math.round(v));
}

export function snapLevel(g: GridFrame, y: number): number {
  return g.y + Math.round((y - g.y) / LEVEL) * LEVEL;
}

/** Is a pose on the grid (on a grid point, facing a compass direction)? */
export function onGrid(g: GridFrame, p: V3, dir: V3): boolean {
  const s = snapPoint(g, p[0], p[2]);
  const h = headingOf(dir);
  return Math.hypot(s.x - p[0], s.z - p[2]) < 0.05 && Math.abs(wrap(h - snapHeading(g, h))) < 1e-3 && Math.abs(dir[1]) < 0.3; // a slope may carry on through the join
}

export interface PathOptions {
  /** Height at the end. */
  y1: number;
  /** Turn radius for arcs (m). */
  radius: number;
  /** Expected speed (m/s) for banking. */
  speed: number;
  kind?: TrackNode['kind'];
  param?: number;
}

/**
 * Exact track from a start pose to a target pose on the grid: circular arcs and straights (a Dubins
 * path), height eased smoothly from the start slope to level, turns banked for the speed. The last
 * node lands exactly on the target.
 */
export function pathTo(start: { p: V3; dir: V3; bank: number }, target: Pose, opt: PathOptions, idPrefix: string, group: string): TrackNode[] {
  const s: Pose = { x: start.p[0], z: start.p[2], h: headingOf(start.dir) };
  const R = opt.radius;
  const segs: Seg[] = dubins(s, target, R);
  const total = segs.reduce((a, g) => a + g.len, 0);
  if (total < 0.5) return [];
  const y0 = start.p[1];
  const startPitch = Math.asin(Math.max(-1, Math.min(1, start.dir[1])));
  // Bank for the speed (up to 60° for a fast train in a tight turn, so riders aren't thrown
  // sideways), and less on short arcs (a small joining bend).
  const bankFor = (arc: number) => Math.min(1.05, (Math.abs(autoBank(90, R, opt.speed)) * Math.PI) / 180) * Math.min(1, arc / (Math.PI / 2));
  // Keep the bank on the same winding as the start (after rolls it can carry whole turns).
  const wind = Math.round(start.bank / (2 * Math.PI)) * 2 * Math.PI;
  const out: TrackNode[] = [];
  let x = s.x;
  let z = s.z;
  let h = s.h;
  let travelled = 0;
  for (let si = 0; si < segs.length; si++) {
    const sg = segs[si]!;
    if (sg.len < 1e-6) continue;
    // Arcs get a node every ≤ 30° so the curve stays round; straights every ≤ 8 m.
    const n = sg.kind === 'S' ? Math.max(1, Math.ceil(sg.len / 8)) : Math.max(2, Math.ceil(sg.len / R / (Math.PI / 6)));
    const ds = sg.len / n;
    for (let k = 0; k < n; k++) {
      if (sg.kind === 'S') {
        x += Math.cos(h) * ds;
        z -= Math.sin(h) * ds;
      } else {
        const sgn = sg.kind === 'L' ? 1 : -1;
        const dh = (sgn * ds) / R;
        const hm = h + dh / 2;
        const chord = 2 * R * Math.sin(Math.abs(dh) / 2);
        x += Math.cos(hm) * chord;
        z -= Math.sin(hm) * chord;
        h += dh;
      }
      travelled += ds;
      const u = Math.min(1, travelled / total);
      const ease = u * u * (3 - 2 * u);
      const carry = Math.tan(startPitch) * total * (u - 2 * u * u + u * u * u);
      const y = y0 + (opt.y1 - y0) * ease + carry;
      // Bank into arcs, easing in and out at the ends of each arc.
      // Smooth in and out: zero at each end of the arc, full in the middle.
      const f = (k + 1) / n;
      const bank = sg.kind === 'S' ? 0 : (sg.kind === 'L' ? -1 : 1) * bankFor(sg.len / R) * Math.sin(Math.PI * Math.min(1, f));
      out.push({ id: `${idPrefix}${out.length}`, p: [x, y, z], dir: [Math.cos(h), 0, -Math.sin(h)], bank: wind + bank, kind: opt.kind ?? 'track', param: opt.param, group });
    }
  }
  // Land exactly on the target, level, facing the target heading.
  const last = out[out.length - 1]!;
  last.p = [target.x, opt.y1, target.z];
  last.dir = [Math.cos(target.h), 0, -Math.sin(target.h)];
  last.bank = wind;
  // Slopes consistent with neighbouring heights.
  for (let i = 0; i < out.length - 1; i++) {
    const prev = i === 0 ? start.p : out[i - 1]!.p;
    const next = out[i + 1]!.p;
    const run = Math.hypot(next[0] - prev[0], next[2] - prev[2]) || 1;
    const pitch = Math.atan2(next[1] - prev[1], run) * 0.9;
    const n = out[i]!;
    const hh = headingOf(n.dir);
    n.dir = [Math.cos(hh) * Math.cos(pitch), Math.sin(pitch), -Math.sin(hh) * Math.cos(pitch)];
  }
  return out;
}

/** The grid pose `forward` tiles ahead and `left` tiles to the side of a (snapped) pose, turning by `quarters`. */
export function gridTarget(g: GridFrame, from: { x: number; z: number; h: number }, forward: number, left: number, quarters: number): Pose {
  const h = snapHeading(g, from.h);
  const base = snapPoint(g, from.x, from.z);
  const fx = Math.cos(h);
  const fz = -Math.sin(h);
  const lx = -Math.sin(h);
  const lz = -Math.cos(h);
  const p = snapPoint(g, base.x + (fx * forward + lx * left) * TILE, base.z + (fz * forward + lz * left) * TILE);
  return { x: p.x, z: p.z, h: h + quarters * QUARTER };
}
