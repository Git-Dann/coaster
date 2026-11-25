import { BakedTrack, newSample } from "../track/bake";
import type { SupportStyle, TrackDesign } from "../track/types";

export type MemberKind = "tube" | "beam" | "pad";

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

export const TIMBER_STYLES: ReadonlySet<SupportStyle> = new Set([
  "pine",
  "walnut",
  "painted-timber",
  "weathered",
]);

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
  blocked(
    x: number,
    z: number,
    y0: number,
    y1: number,
    r: number,
    selfS: number,
  ): boolean {
    const c = this.cell;
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++)
      for (
        let cz = Math.floor((z - r) / c);
        cz <= Math.floor((z + r) / c);
        cz++
      ) {
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
 * The space a train needs around every piece of track, in the track's own frame: no support member
 * may ever enter it. Lateral is measured from the track centre, up/down from rail level.
 */
export const TRAIN_ENVELOPE = {
  lateral: 1.5,
  below: 1.0,
  above: 2.4,
  along: 0.3,
} as const;
/** Track this close (along the circuit) to a support is the track it carries. */
export const OWN_TRACK_ARC = 10;
/** Near its own track a support may reach rail level from below, but never above it. */
const OWN_BELOW = 0.35;

/** Tests support members against the train envelope around every part of the track. */
export class TrackClearance {
  private cells = new Map<string, number[]>();
  private cand: number[] = [];
  constructor(
    private track: BakedTrack,
    private cell = 3,
  ) {
    // Samples every 0.5 m; the envelope's along-track half-depth covers the gap between them.
    const step = Math.max(1, Math.round(0.5 / track.ds));
    for (let i = 0; i < track.count; i += step) {
      const k = `${Math.floor(track.pos[i * 3]! / cell)},${Math.floor(track.pos[i * 3 + 2]! / cell)}`;
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(i);
    }
  }

  /** Does a member (a segment of radius `r`) belonging to a support at arc `selfS` enter any train envelope? */
  clashes(a: P3, b: P3, r: number, selfS: number): boolean {
    const t = this.track;
    const E = TRAIN_ENVELOPE;
    const pad = E.lateral + E.above + r;
    const c = this.cell;
    const cand = this.cand;
    cand.length = 0;
    const x0 = Math.min(a[0], b[0]) - pad;
    const x1 = Math.max(a[0], b[0]) + pad;
    const z0 = Math.min(a[2], b[2]) - pad;
    const z1 = Math.max(a[2], b[2]) + pad;
    const y0 = Math.min(a[1], b[1]) - pad;
    const y1 = Math.max(a[1], b[1]) + pad;
    for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++)
      for (let cz = Math.floor(z0 / c); cz <= Math.floor(z1 / c); cz++) {
        const l = this.cells.get(`${cx},${cz}`);
        if (!l) continue;
        for (const i of l) {
          const py = t.pos[i * 3 + 1]!;
          if (py >= y0 && py <= y1) cand.push(i);
        }
      }
    if (cand.length === 0) return false;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const n = Math.max(1, Math.ceil(len / 0.4));
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const qx = a[0] + (b[0] - a[0]) * u;
      const qy = a[1] + (b[1] - a[1]) * u;
      const qz = a[2] + (b[2] - a[2]) * u;
      for (const i of cand) {
        const dx = qx - t.pos[i * 3]!;
        const dy = qy - t.pos[i * 3 + 1]!;
        const dz = qz - t.pos[i * 3 + 2]!;
        if (dx * dx + dy * dy + dz * dz > pad * pad) continue;
        const tx = t.tan[i * 3]!,
          ty = t.tan[i * 3 + 1]!,
          tz = t.tan[i * 3 + 2]!;
        const ux = t.up[i * 3]!,
          uy = t.up[i * 3 + 1]!,
          uz = t.up[i * 3 + 2]!;
        const along = dx * tx + dy * ty + dz * tz;
        if (Math.abs(along) > E.along + r) continue;
        const upw = dx * ux + dy * uy + dz * uz;
        // right = tan × up
        const lat =
          dx * (ty * uz - tz * uy) +
          dy * (tz * ux - tx * uz) +
          dz * (tx * uy - ty * ux);
        if (Math.abs(lat) > E.lateral + r) continue;
        let ds = Math.abs(i * t.ds - selfS);
        if (t.closed) ds = Math.min(ds, t.length - ds);
        // The carried track's spine is where the support attaches: only above it is off limits.
        const lo = ds < OWN_TRACK_ARC ? -OWN_BELOW : -E.below - r;
        if (upw > lo && upw < E.above + r) return true;
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
export function generateSupports(
  design: Pick<TrackDesign, "nodes" | "closed" | "supportStyle">,
  track: BakedTrack,
  ground: Ground,
): Member[] {
  const timber = TIMBER_STYLES.has(design.supportStyle);
  const span = timber ? 2.4 : 6.5;
  const out: Member[] = [];
  const smp = newSample();
  const hash = new TrackHash(track);
  const clear = new TrackClearance(track);
  const bents: Bent[] = [];
  const segs = track.closed ? track.nodeS.length : track.nodeS.length - 1;
  for (let si = 0; si < segs; si++) {
    const s0 = track.nodeS[si]!;
    const s1 =
      si + 1 < track.nodeS.length ? track.nodeS[si + 1]! : track.length;
    const nodeId = design.nodes[si]?.id ?? `seg${si}`;
    const n = Math.max(1, Math.round((s1 - s0) / span));
    for (let k = 0; k < n; k++) {
      const s = s0 + ((k + 0.5) * (s1 - s0)) / n;
      track.sample(s, smp);
      const id = `${nodeId}:${k}`;
      if (smp.up[1] < 0.45) continue; // inverted / vertical: no ground support
      if (smp.kind === "station") continue; // the station building carries the track
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
      // Members are collected per support, then checked against the train envelope of all track:
      // a clashing brace is left out; a clashing post, column or pad removes the whole support.
      let local: Array<{ m: Member; primary: boolean }> = [];
      let mi = 0;
      let primary = true;
      const push = (
        kind: MemberKind,
        a: [number, number, number],
        b: [number, number, number],
        r: number,
      ) => {
        local.push({
          m: { key: `${id}:${mi++}`, support: id, kind, a, b, r },
          primary,
        });
      };
      const accept = (): boolean => {
        const kept: Member[] = [];
        for (const { m, primary: p } of local) {
          if (!clear.clashes(m.a, m.b, m.r, s)) kept.push(m);
          else if (p) return false;
        }
        out.push(...kept);
        return true;
      };
      // Horizontal right vector for bents and A-frames.
      let rx = smp.right[0];
      let rz = smp.right[2];
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl;
      rz /= rl;
      if (timber) {
        // A traditional bent: vertical posts under the rails, battered outer posts on taller
        // bents, ledgers on every tier and X-bracing between neighbouring posts. If the wide bent
        // would reach into other track, a narrow two-post bent is tried before giving up.
        const build = (wide: boolean): Bent | null => {
          local = [];
          mi = 0;
          primary = true;
          const offsets = wide
            ? [-(1.25 + height * 0.09), -0.72, 0.72, 1.25 + height * 0.09]
            : [-0.9, 0.9];
          const topOffsets = wide ? [-1.25, -0.72, 0.72, 1.25] : [-0.9, 0.9];
          const posts: P3[] = offsets.map((o) => {
            const x = ax + rx * o;
            const z = az + rz * o;
            return [x, ground(x, z), z];
          });
          const tops: P3[] = topOffsets.map((o) => [
            ax + rx * o,
            ay,
            az + rz * o,
          ]);
          const lerpPost = (i: number, y: number): P3 => {
            const b = posts[i]!;
            const t = tops[i]!;
            const k = (y - b[1]) / Math.max(0.01, t[1] - b[1]);
            return [b[0] + (t[0] - b[0]) * k, y, b[2] + (t[2] - b[2]) * k];
          };
          posts.forEach((p, i) => {
            push(
              "pad",
              [p[0], p[1] - 0.3, p[2]],
              [p[0], p[1] + 0.15, p[2]],
              0.26,
            );
            push("beam", p, tops[i]!, 0.09);
          });
          // Cap ledger carrying the track.
          push("beam", tops[0]!, tops[tops.length - 1]!, 0.1);
          primary = false;
          // Tiers at absolute heights so neighbouring bents line up for longitudinal bracing.
          const base = Math.max(...posts.map((p) => p[1]));
          const levels: number[] = [];
          for (
            let y = Math.ceil((base + 0.6) / TIER) * TIER;
            y < ay - 0.8;
            y += TIER
          )
            levels.push(y);
          let prev = base + 0.25;
          for (const y of [...levels, ay]) {
            if (y !== ay)
              push(
                "beam",
                lerpPost(0, y),
                lerpPost(posts.length - 1, y),
                0.055,
              );
            for (let i = 0; i + 1 < posts.length; i++) {
              push("beam", lerpPost(i, prev), lerpPost(i + 1, y), 0.035);
              push("beam", lerpPost(i + 1, prev), lerpPost(i, y), 0.035);
            }
            prev = y;
          }
          if (!accept()) return null;
          return {
            id,
            s,
            posts: posts.length,
            at: (i, y) => lerpPost(i, y),
            levels,
            top: ay,
            base,
          };
        };
        const bent = (height > 6 ? build(true) : null) ?? build(false);
        if (bent) bents.push(bent);
      } else {
        const r = 0.16 + Math.min(0.14, height * 0.006);
        if (height > 14) {
          // A-frame for tall supports.
          const splay = height * 0.13;
          const legs: Array<[number, number, number]> = [-1, 1].map((sgn) => [
            ax + rx * splay * sgn,
            ground(ax + rx * splay * sgn, az + rz * splay * sgn),
            az + rz * splay * sgn,
          ]);
          for (const l of legs) {
            push(
              "pad",
              [l[0], l[1] - 0.3, l[2]],
              [l[0], l[1] + 0.15, l[2]],
              r * 2.6,
            );
            push("tube", l, [ax, ay - 0.3, az], r);
          }
          primary = false;
          const by = legs[0]![1] + height * 0.45;
          const t = 0.45;
          push(
            "tube",
            [
              legs[0]![0] + (ax - legs[0]![0]) * t,
              by,
              legs[0]![2] + (az - legs[0]![2]) * t,
            ],
            [
              legs[1]![0] + (ax - legs[1]![0]) * t,
              by,
              legs[1]![2] + (az - legs[1]![2]) * t,
            ],
            r * 0.55,
          );
        } else {
          push("pad", [ax, gy - 0.3, az], [ax, gy + 0.15, az], r * 2.6);
          push("tube", [ax, gy, az], [ax, ay - 0.1, az], r);
        }
        // Bolted flange plate where the column meets the spine bracket.
        primary = true;
        push("pad", [ax, ay - 0.2, az], [ax, ay - 0.12, az], r * 1.9);
        // Short arm into the spine (follows banking).
        push(
          "tube",
          [ax, ay - 0.15, az],
          [
            smp.pos[0] - smp.up[0] * 0.42,
            smp.pos[1] - smp.up[1] * 0.42,
            smp.pos[2] - smp.up[2] * 0.42,
          ],
          r * 0.75,
        );
        accept();
      }
    }
  }
  if (timber) longitudinalBracing(bents, span, track, out, clear);
  return out;
}

/**
 * Longitudinal bracing between consecutive bents: stringers along each tier and alternating
 * diagonals on the outer lines of posts. This is what turns separate frames into the dense,
 * criss-crossed lattice of a wooden coaster.
 */
function longitudinalBracing(
  bents: Bent[],
  span: number,
  track: BakedTrack,
  out: Member[],
  clear: TrackClearance,
): void {
  for (let b = 0; b + 1 < bents.length; b++) {
    const A = bents[b]!;
    const B = bents[b + 1]!;
    let ds = Math.abs(B.s - A.s);
    if (track.closed) ds = Math.min(ds, track.length - ds);
    if (ds > span * 1.7 || A.posts !== B.posts) continue;
    let mi = 0;
    const key = `${A.id}>${B.id}`;
    const push = (a: P3, c: P3, r: number) => {
      const k = `${key}:${mi++}`; // keys stay stable whether or not a brace is left out
      if (!clear.clashes(a, c, r, A.s))
        out.push({ key: k, support: key, kind: "beam", a, b: c, r });
    };
    const outer = A.posts > 2 ? [0, A.posts - 1] : [0, 1];
    const shared = A.levels.filter((y) => B.levels.includes(y));
    for (const i of outer) {
      push(
        A.at(i, Math.min(A.top, B.top) - 0.05),
        B.at(i, Math.min(A.top, B.top) - 0.05),
        0.045,
      );
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
