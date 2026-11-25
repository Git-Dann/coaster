import type { V3 } from '../core/vec3';
import { autoBank } from './elements';
import { separateCrossings } from './clearance';
import type { TrackDesign, TrackNode } from './types';

/**
 * Automatic return track.
 *
 * The player's track always runs back into the station: after their last piece we route a smooth
 * path home using a Dubins path (the shortest curve between two headings with a minimum turning
 * radius), so a valid route always exists whatever the player builds. The height eases from the
 * end of their track to station height, stays above the ground, the turns are banked for the
 * expected speed, and a brake run lines up with the platform. The circuit therefore can never be
 * left disconnected.
 */

type Seg = { kind: 'L' | 'R' | 'S'; len: number };

const TAU = Math.PI * 2;
const mod2pi = (a: number) => ((a % TAU) + TAU) % TAU;

interface Pose {
  x: number;
  z: number;
  /** Heading in the x–z plane, radians, 0 = +X, positive = turning left (towards −Z). */
  h: number;
}

/** Shortest Dubins path between poses with radius R. Returns segments with lengths in metres. */
export function dubins(a: Pose, b: Pose, R: number): Seg[] {
  // Work in a frame where a is at the origin heading +x, with standard maths orientation (CCW positive).
  // Our heading convention: dir = (cos h, −sin h) in (x, z). Map z → −y so CCW in (x, y) = left turn.
  const dx = b.x - a.x;
  const dy = -(b.z - a.z);
  const D = Math.hypot(dx, dy) / R;
  const th = Math.atan2(dy, dx);
  const alpha = mod2pi(a.h - th);
  const beta = mod2pi(b.h - th);
  const sa = Math.sin(alpha);
  const sb = Math.sin(beta);
  const ca = Math.cos(alpha);
  const cb = Math.cos(beta);
  const cab = Math.cos(alpha - beta);
  const cands: Array<[string, number, number, number]> = [];
  // LSL
  {
    const p2 = 2 + D * D - 2 * cab + 2 * D * (sa - sb);
    if (p2 >= 0) {
      const tmp = Math.atan2(cb - ca, D + sa - sb);
      cands.push(['LSL', mod2pi(-alpha + tmp), Math.sqrt(p2), mod2pi(beta - tmp)]);
    }
  }
  // RSR
  {
    const p2 = 2 + D * D - 2 * cab + 2 * D * (sb - sa);
    if (p2 >= 0) {
      const tmp = Math.atan2(ca - cb, D - sa + sb);
      cands.push(['RSR', mod2pi(alpha - tmp), Math.sqrt(p2), mod2pi(-beta + tmp)]);
    }
  }
  // LSR
  {
    const p2 = -2 + D * D + 2 * cab + 2 * D * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-ca - cb, D + sa + sb) - Math.atan2(-2, p);
      cands.push(['LSR', mod2pi(-alpha + tmp), p, mod2pi(-mod2pi(beta) + tmp)]);
    }
  }
  // RSL
  {
    const p2 = D * D - 2 + 2 * cab - 2 * D * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(ca + cb, D - sa - sb) - Math.atan2(2, p);
      cands.push(['RSL', mod2pi(alpha - tmp), p, mod2pi(beta - tmp)]);
    }
  }
  let best: [string, number, number, number] | null = null;
  for (const c of cands) if (!best || c[1] + c[2] + c[3] < best[1] + best[2] + best[3]) best = c;
  if (!best) {
    // Degenerate fallback (never expected with CSC words): straight line.
    return [{ kind: 'S', len: Math.hypot(b.x - a.x, b.z - a.z) }];
  }
  const word = best[0];
  return [
    { kind: word[0] as Seg['kind'], len: best[1] * R },
    { kind: word[1] as Seg['kind'], len: best[2] * R },
    { kind: word[2] as Seg['kind'], len: best[3] * R },
  ].filter((s) => s.len > 0.05);
}

const headingOf = (d: Readonly<V3>) => Math.atan2(-d[2], d[0]);

export interface ReturnOptions {
  groundAt: (x: number, z: number) => number;
  /** Expected train speed through the return (m/s), for banking. */
  speed: number;
  radius?: number;
  brakeLength?: number;
}

/**
 * Nodes that carry the train from the last node of `design` back to its first (station) node.
 * Does not include either endpoint. The last returned node's outgoing segment is a brake run.
 */
export function returnNodes(design: TrackDesign, opt: ReturnOptions): TrackNode[] {
  const first = design.nodes[0];
  const last = design.nodes[design.nodes.length - 1];
  if (!first || !last || design.nodes.length < 2) return [];
  // Wider turns for faster trains: aim for about 1.1 g of centripetal acceleration.
  const R = opt.radius ?? Math.min(34, Math.max(14, (opt.speed * opt.speed) / (9.81 * 1.1)));
  const brake = opt.brakeLength ?? 26;
  const fh = headingOf(first.dir);
  const fdir = [Math.cos(fh), 0, -Math.sin(fh)];
  // Line up with the station: the brake run starts `brake` metres before the platform.
  const goal: Pose = { x: first.p[0] - fdir[0]! * brake, z: first.p[2] - fdir[2]! * brake, h: fh };
  const start: Pose = { x: last.p[0], z: last.p[2], h: headingOf(last.dir) };
  // Leave the player's track with a short straight so the join is smooth.
  const lead = 6;
  const s0: Pose = { x: start.x + Math.cos(start.h) * lead, z: start.z - Math.sin(start.h) * lead, h: start.h };
  const segs: Seg[] = [{ kind: 'S', len: lead }, ...dubins(s0, goal, R)];
  const total = segs.reduce((a, s) => a + s.len, 0);
  const y0 = last.p[1];
  const y1 = first.p[1];
  const startPitch = Math.asin(Math.max(-1, Math.min(1, last.dir[1])));

  const out: TrackNode[] = [];
  let x = start.x;
  let z = start.z;
  let h = start.h;
  let travelled = 0;
  const step = 7;
  const bankMag = Math.abs(autoBank(90, R, opt.speed)) * (Math.PI / 180);
  // After rolls the last bank can be a whole number of turns: keep the return on the same winding
  // so it never unwinds those turns as a real twist.
  const wind = Math.round((last.bank - first.bank) / (2 * Math.PI)) * 2 * Math.PI;
  for (let si = 0; si < segs.length; si++) {
    const sg = segs[si]!;
    const n = Math.max(1, Math.ceil(sg.len / step));
    const ds = sg.len / n;
    for (let k = 0; k < n; k++) {
      // Advance along the segment.
      if (sg.kind === 'S') {
        x += Math.cos(h) * ds;
        z -= Math.sin(h) * ds;
      } else {
        const sgn = sg.kind === 'L' ? 1 : -1;
        const dh = (sgn * ds) / R;
        // Exact arc chord.
        const hm = h + dh / 2;
        const chord = 2 * R * Math.sin(Math.abs(dh) / 2);
        x += Math.cos(hm) * chord;
        z -= Math.sin(hm) * chord;
        h += dh;
      }
      travelled += ds;
      const u = travelled / total;
      // Ease height from the end of the player's track to station height, honouring the start slope.
      const ease = u * u * (3 - 2 * u);
      const slopeCarry = Math.tan(startPitch) * total * (u - 2 * u * u + u * u * u);
      let y = y0 + (y1 - y0) * ease + slopeCarry;
      y = Math.max(y, opt.groundAt(x, z) + 1.1);
      const nextKind = segs[si]!.kind;
      const bank = wind + first.bank + (nextKind === 'S' ? 0 : (nextKind === 'L' ? -1 : 1) * bankMag * Math.min(1, Math.sin(Math.PI * Math.min(1, (k + 1) / n)) * 3));
      out.push({ id: `ret_${si}_${k}`, p: [x, y, z], dir: [Math.cos(h), 0, -Math.sin(h)], bank, kind: 'track', group: 'return' });
    }
  }
  // Give nodes slopes consistent with their neighbours' heights.
  for (let i = 0; i < out.length; i++) {
    const prev = i === 0 ? last.p : out[i - 1]!.p;
    const next = i === out.length - 1 ? [goal.x, y1, goal.z] : out[i + 1]!.p;
    const run = Math.hypot(next[0]! - prev[0]!, next[2]! - prev[2]!) || 1;
    const pitch = Math.atan2(next[1]! - prev[1]!, run) * 0.9;
    const n = out[i]!;
    const hh = headingOf(n.dir);
    n.dir = [Math.cos(hh) * Math.cos(pitch), Math.sin(pitch), -Math.sin(hh) * Math.cos(pitch)];
  }
  // The path ends exactly at the start of the brake run: make that node the brake run, level with
  // the platform and lined up with it (replacing it rather than adding a coincident node).
  const end = out[out.length - 1];
  const brakeNode: TrackNode = { id: 'ret_brake', p: [goal.x, y1, goal.z], dir: [fdir[0]!, 0, fdir[2]!], bank: first.bank + wind, kind: 'brake', param: 2.4, group: 'return' };
  if (end && Math.hypot(end.p[0] - goal.x, end.p[2] - goal.z) < 2.5) out[out.length - 1] = brakeNode;
  else out.push(brakeNode);
  // A Dubins path can end with a sliver of a segment, leaving two nodes almost on top of each
  // other. A curve between near-coincident nodes with different directions loops wildly, so drop
  // any node that crowds its successor (the brake node always stays).
  for (let i = out.length - 2; i >= 0; i--) {
    const a = out[i]!.p;
    const b = out[i + 1]!.p;
    if (Math.hypot(a[0] - b[0], a[2] - b[2]) < 3) out.splice(i, 1);
  }
  // The same applies to the join with the player's last node.
  while (out.length > 1 && Math.hypot(out[0]!.p[0] - last.p[0], out[0]!.p[2] - last.p[2]) < 3) out.shift();
  // The return must never pass through the player's track: lift it over (or under) crossings.
  // The final brake run into the station stays level.
  const temp: TrackDesign = { ...design, nodes: [...design.nodes.map((n) => ({ ...n, p: [...n.p] as V3, dir: [...n.dir] as V3 })), ...out], closed: true };
  separateCrossings(temp, design.nodes.length, opt.groundAt, 2);
  // A trim brake halfway round keeps very fast layouts from arriving too quickly.
  const mid = out[Math.floor(out.length * 0.6)];
  if (mid && mid !== out[out.length - 1]) {
    mid.kind = 'brake';
    mid.param = 12;
  }
  return out;
}

/** The ridden circuit: the player's design plus the automatic return (closed). */
export function withReturn(design: TrackDesign, opt: ReturnOptions): TrackDesign {
  if (design.closed || design.nodes.length < 2) return design;
  const ret = returnNodes(design, opt);
  return { ...design, nodes: [...design.nodes.map((n) => ({ ...n })), ...ret], closed: true };
}
