import { BakedTrack, newSample } from '../track/bake';
import type { SupportStyle, TrackDesign } from '../track/types';

export type MemberKind = 'tube' | 'beam' | 'pad';

/** One structural member: a cylinder or square beam from `a` to `b`. */
export interface Member {
  /** Stable key: support id + member index, so unchanged supports never flicker. */
  key: string;
  support: string;
  kind: MemberKind;
  a: [number, number, number];
  b: [number, number, number];
  /** Radius (tube/pad) or half-width (beam). */
  r: number;
}

type P3 = [number, number, number];
const TIER = 2.4;

interface Bent {
  id: string;
  s: number;
  posts: number;
  at: (post: number, y: number) => P3;
  levels: number[];
  top: number;
  base: number;
}

export const TIMBER_STYLES: ReadonlySet<SupportStyle> = new Set(['pine', 'walnut', 'painted-timber', 'weathered']);

type Ground = (x: number, z: number) => number;

/** Coarse spatial hash of track sample points for clearance tests. */
class TrackHash {
  private cells = new Map<string, number[]>();
  constructor(
    private track: BakedTrack,
    private cell = 3,
  ) {
    for (let i = 0; i < track.count; i += 2) {
      const k = `${Math.floor(track.pos[i * 3]! / cell)},${Math.floor(track.pos[i * 3 + 2]! / cell)}`;
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(i);
    }
  }
  /** Is there track (other than near arc position `selfS`) within `r` of the vertical line at x,z between y0 and y1? */
  blocked(x: number, z: number, y0: number, y1: number, r: number, selfS: number): boolean {
    const c = this.cell;
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++)
      for (let cz = Math.floor((z - r) / c); cz <= Math.floor((z + r) / c); cz++) {
        const l = this.cells.get(`${cx},${cz}`);
        if (!l) continue;
        for (const i of l) {
          const s = i * this.track.ds;
          let ds = Math.abs(s - selfS);
          if (this.track.closed) ds = Math.min(ds, this.track.length - ds);
          if (ds < 6) continue;
          const px = this.track.pos[i * 3]!;
          const py = this.track.pos[i * 3 + 1]!;
          const pz = this.track.pos[i * 3 + 2]!;
          if (py < y0 - 1.5 || py > y1 + 0.5) continue;
          if (Math.hypot(px - x, pz - z) < r) return true;
        }
      }
    return false;
  }
}

/**
 * Generate a procedural support structure for a track. Pure: same inputs give the same members
 * with the same keys. Supports are anchored to the terrain and attach to the track spine.
 * Inverted and near-vertical sections are left unsupported from below (documented limitation).
 */
export function generateSupports(design: Pick<TrackDesign, 'nodes' | 'closed' | 'supportStyle'>, track: BakedTrack, ground: Ground): Member[] {
  const timber = TIMBER_STYLES.has(design.supportStyle);
  const span = timber ? 2.4 : 6.5;
  const out: Member[] = [];
  const smp = newSample();
  const hash = new TrackHash(track);
  const bents: Bent[] = [];
  const segs = track.closed ? track.nodeS.length : track.nodeS.length - 1;
  for (let si = 0; si < segs; si++) {
    const s0 = track.nodeS[si]!;
    const s1 = si + 1 < track.nodeS.length ? track.nodeS[si + 1]! : track.length;
    const nodeId = design.nodes[si]?.id ?? `seg${si}`;
    const n = Math.max(1, Math.round((s1 - s0) / span));
    for (let k = 0; k < n; k++) {
      const s = s0 + ((k + 0.5) * (s1 - s0)) / n;
      track.sample(s, smp);
      const id = `${nodeId}:${k}`;
      if (smp.up[1] < 0.45) continue; // inverted / vertical: no ground support
      if (smp.kind === 'station') continue; // the station building carries the track
      const gx = smp.pos[0];
      const gz = smp.pos[2];
      const gy = ground(gx, gz);
      // Attach under the spine, along the track's down vector.
      const drop = timber ? 0.5 : 0.62;
      const ax = smp.pos[0] - smp.up[0] * drop;
      const ay = smp.pos[1] - smp.up[1] * drop;
      const az = smp.pos[2] - smp.up[2] * drop;
      const height = ay - gy;
      if (height < 0.35) continue;
      if (hash.blocked(ax, az, gy, ay - 0.5, timber ? 2 : 1.4, s)) continue;
      let mi = 0;
      const push = (kind: MemberKind, a: [number, number, number], b: [number, number, number], r: number) => out.push({ key: `${id}:${mi++}`, support: id, kind, a, b, r });
      // Horizontal right vector for bents and A-frames.
      let rx = smp.right[0];
      let rz = smp.right[2];
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl;
      rz /= rl;
      if (timber) {
        // A traditional bent: vertical posts under the rails, battered outer posts on taller
        // bents, ledgers on every tier and X-bracing between neighbouring posts.
        const offsets = height > 6 ? [-(1.25 + height * 0.09), -0.72, 0.72, 1.25 + height * 0.09] : [-0.9, 0.9];
        const topOffsets = height > 6 ? [-1.25, -0.72, 0.72, 1.25] : [-0.9, 0.9];
        const posts: P3[] = offsets.map((o) => {
          const x = ax + rx * o;
          const z = az + rz * o;
          return [x, ground(x, z), z];
        });
        const tops: P3[] = topOffsets.map((o) => [ax + rx * o, ay, az + rz * o]);
        const lerpPost = (i: number, y: number): P3 => {
          const b = posts[i]!;
          const t = tops[i]!;
          const k = (y - b[1]) / Math.max(0.01, t[1] - b[1]);
          return [b[0] + (t[0] - b[0]) * k, y, b[2] + (t[2] - b[2]) * k];
        };
        posts.forEach((p, i) => {
          push('pad', [p[0], p[1] - 0.3, p[2]], [p[0], p[1] + 0.15, p[2]], 0.26);
          push('beam', p, tops[i]!, 0.09);
        });
        // Cap ledger carrying the track.
        push('beam', tops[0]!, tops[tops.length - 1]!, 0.1);
        // Tiers at absolute heights so neighbouring bents line up for longitudinal bracing.
        const base = Math.max(...posts.map((p) => p[1]));
        const levels: number[] = [];
        for (let y = Math.ceil((base + 0.6) / TIER) * TIER; y < ay - 0.8; y += TIER) levels.push(y);
        let prev = base + 0.25;
        for (const y of [...levels, ay]) {
          if (y !== ay) push('beam', lerpPost(0, y), lerpPost(posts.length - 1, y), 0.055);
          for (let i = 0; i + 1 < posts.length; i++) {
            push('beam', lerpPost(i, prev), lerpPost(i + 1, y), 0.035);
            push('beam', lerpPost(i + 1, prev), lerpPost(i, y), 0.035);
          }
          prev = y;
        }
        bents.push({ id, s, posts: posts.length, at: (i, y) => lerpPost(i, y), levels, top: ay, base });
      } else {
        const r = 0.16 + Math.min(0.14, height * 0.006);
        if (height > 14) {
          // A-frame for tall supports.
          const splay = height * 0.13;
          const legs: Array<[number, number, number]> = [-1, 1].map((sgn) => [ax + rx * splay * sgn, ground(ax + rx * splay * sgn, az + rz * splay * sgn), az + rz * splay * sgn]);
          for (const l of legs) {
            push('pad', [l[0], l[1] - 0.3, l[2]], [l[0], l[1] + 0.15, l[2]], r * 2.6);
            push('tube', l, [ax, ay - 0.3, az], r);
          }
          const by = legs[0]![1] + height * 0.45;
          const t = 0.45;
          push(
            'tube',
            [legs[0]![0] + (ax - legs[0]![0]) * t, by, legs[0]![2] + (az - legs[0]![2]) * t],
            [legs[1]![0] + (ax - legs[1]![0]) * t, by, legs[1]![2] + (az - legs[1]![2]) * t],
            r * 0.55,
          );
        } else {
          push('pad', [ax, gy - 0.3, az], [ax, gy + 0.15, az], r * 2.6);
          push('tube', [ax, gy, az], [ax, ay - 0.1, az], r);
        }
        // Bolted flange plate where the column meets the spine bracket.
        push('pad', [ax, ay - 0.2, az], [ax, ay - 0.12, az], r * 1.9);
        // Short arm into the spine (follows banking).
        push('tube', [ax, ay - 0.15, az], [smp.pos[0] - smp.up[0] * 0.42, smp.pos[1] - smp.up[1] * 0.42, smp.pos[2] - smp.up[2] * 0.42], r * 0.75);
      }
    }
  }
  if (timber) longitudinalBracing(bents, span, track, out);
  return out;
}

/**
 * Longitudinal bracing between consecutive bents: stringers along each tier and alternating
 * diagonals on the outer lines of posts. This is what turns separate frames into the dense,
 * criss-crossed lattice of a wooden coaster.
 */
function longitudinalBracing(bents: Bent[], span: number, track: BakedTrack, out: Member[]): void {
  for (let b = 0; b + 1 < bents.length; b++) {
    const A = bents[b]!;
    const B = bents[b + 1]!;
    let ds = Math.abs(B.s - A.s);
    if (track.closed) ds = Math.min(ds, track.length - ds);
    if (ds > span * 1.7 || A.posts !== B.posts) continue;
    let mi = 0;
    const key = `${A.id}>${B.id}`;
    const push = (a: P3, c: P3, r: number) => out.push({ key: `${key}:${mi++}`, support: key, kind: 'beam', a, b: c, r });
    const outer = A.posts > 2 ? [0, A.posts - 1] : [0, 1];
    const shared = A.levels.filter((y) => B.levels.includes(y));
    for (const i of outer) {
      push(A.at(i, Math.min(A.top, B.top) - 0.05), B.at(i, Math.min(A.top, B.top) - 0.05), 0.045);
      for (let k = 0; k < shared.length; k++) {
        const y = shared[k]!;
        push(A.at(i, y), B.at(i, y), 0.04);
        const y2 = shared[k + 1] ?? Math.min(A.top, B.top);
        if ((b + k) % 2 === 0) push(A.at(i, y), B.at(i, y2), 0.032);
        else push(B.at(i, y), A.at(i, y2), 0.032);
      }
    }
  }
}
