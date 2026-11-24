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
  const span = timber ? 3.4 : 6.5;
  const out: Member[] = [];
  const smp = newSample();
  const hash = new TrackHash(track);
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
      const drop = timber ? 0.32 : 0.62;
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
        const half = 0.75 + height * 0.07;
        const posts: Array<[number, number, number]> = [-1, 1].map((sgn) => [ax + rx * half * sgn, ground(ax + rx * half * sgn, az + rz * half * sgn), az + rz * half * sgn]);
        for (const p of posts) {
          push('pad', [p[0], p[1] - 0.25, p[2]], [p[0], p[1] + 0.12, p[2]], 0.28);
          push('beam', p, [p[0], ay, p[2]], 0.09);
        }
        // Cap ledger under the track.
        push('beam', [posts[0]![0], ay, posts[0]![2]], [posts[1]![0], ay, posts[1]![2]], 0.1);
        // Tiers with X-bracing.
        const tier = 3;
        const base = Math.max(posts[0]![1], posts[1]![1]);
        let y = base + tier;
        let prevY = base + 0.3;
        while (y < ay - 0.6) {
          push('beam', [posts[0]![0], y, posts[0]![2]], [posts[1]![0], y, posts[1]![2]], 0.07);
          push('beam', [posts[0]![0], prevY, posts[0]![2]], [posts[1]![0], y, posts[1]![2]], 0.05);
          push('beam', [posts[1]![0], prevY, posts[1]![2]], [posts[0]![0], y, posts[0]![2]], 0.05);
          prevY = y;
          y += tier;
        }
        if (ay - prevY > 1) {
          push('beam', [posts[0]![0], prevY, posts[0]![2]], [posts[1]![0], ay, posts[1]![2]], 0.05);
          push('beam', [posts[1]![0], prevY, posts[1]![2]], [posts[0]![0], ay, posts[0]![2]], 0.05);
        }
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
        // Short arm into the spine (follows banking).
        push('tube', [ax, ay - 0.15, az], [smp.pos[0] - smp.up[0] * 0.42, smp.pos[1] - smp.up[1] * 0.42, smp.pos[2] - smp.up[2] * 0.42], r * 0.75);
      }
    }
  }
  return out;
}
