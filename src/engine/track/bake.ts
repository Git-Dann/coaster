import {
  type V3,
  v3,
  set,
  copy,
  dot,
  cross,
  len,
  normalize,
  scale,
  addScaled,
  rotateAxis,
  smoothstep,
  clamp,
} from '../core/vec3';
import { buildSegments, evalSegment, segmentCount, type HermiteSegment } from './spline';
import { SECTION_KINDS, type SectionKind, type TrackDesign } from './types';

/** Interpolated state of the track at an arc-length position. */
export interface TrackSample {
  pos: V3;
  /** Unit tangent. */
  tan: V3;
  /** Track up vector (includes banking). */
  up: V3;
  /** Track right vector (includes banking). */
  right: V3;
  /** Curvature vector d²r/ds² (points to centre of curvature, magnitude 1/R). */
  curv: V3;
  /** dy/ds of the interpolated centre line. Used for gravity so work matches potential energy exactly. */
  dyds: number;
  kind: SectionKind;
  param: number;
  bank: number;
}

export const newSample = (): TrackSample => ({
  pos: v3(),
  tan: v3(1, 0, 0),
  up: v3(0, 1, 0),
  right: v3(0, 0, 1),
  curv: v3(),
  dyds: 0,
  kind: 'track',
  param: 0,
  bank: 0,
});

export interface BakeDiagnostics {
  /** Largest curvature magnitude (1/m). */
  maxCurvature: number;
  /** For closed tracks: angle between the frame at the seam before correction (radians). */
  seamTwist: number;
  /** True when the closed circuit's frame parity is inconsistent (would need a half roll). */
  seamFlip: boolean;
  /** Maximum position gap between adjacent segments (should be ~0). */
  maxGap: number;
}

const DEFAULT_DS = 0.25;
const SUBDIV = 96;
const WORLD_UP: V3 = [0, 1, 0];

/**
 * Arc-length parameterised, frame-annotated representation of a track design.
 * This is the canonical source of truth for physics, rendering, supports and audio.
 * It never depends on rendered meshes.
 */
export class BakedTrack {
  readonly closed: boolean;
  readonly length: number;
  readonly ds: number;
  /** Number of stored samples. Open tracks store N+1 (both ends); closed tracks store N (wrap). */
  readonly count: number;
  readonly pos: Float64Array;
  readonly tan: Float64Array;
  readonly up: Float64Array;
  readonly curv: Float64Array;
  readonly bank: Float64Array;
  readonly kind: Uint8Array;
  readonly param: Float32Array;
  readonly segOf: Uint16Array;
  /** Arc-length position of each design node. */
  readonly nodeS: Float64Array;
  readonly diagnostics: BakeDiagnostics;
  readonly segments: HermiteSegment[];

  constructor(design: Pick<TrackDesign, 'nodes' | 'closed'>, ds = DEFAULT_DS) {
    const segs = buildSegments(design);
    this.segments = segs;
    this.closed = design.closed && segs.length >= 2;
    const segCount = segmentCount(design);

    // 1. Arc-length tables per segment (Simpson integration of |P'|).
    const segLen: number[] = [];
    const tables: Float64Array[] = [];
    const d = v3();
    let maxGap = 0;
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si]!;
      const table = new Float64Array(SUBDIV + 1);
      let acc = 0;
      let prevSpeed: number;
      evalSegment(seg, 0, null, d, null);
      prevSpeed = len(d);
      for (let k = 1; k <= SUBDIV; k++) {
        const t0 = (k - 1) / SUBDIV;
        const t1 = k / SUBDIV;
        evalSegment(seg, (t0 + t1) / 2, null, d, null);
        const mid = len(d);
        evalSegment(seg, t1, null, d, null);
        const end = len(d);
        acc += ((t1 - t0) / 6) * (prevSpeed + 4 * mid + end);
        prevSpeed = end;
        table[k] = acc;
      }
      tables.push(table);
      segLen.push(acc);
      if (si > 0) {
        const prev = segs[si - 1]!;
        maxGap = Math.max(maxGap, Math.hypot(prev.p1[0] - seg.p0[0], prev.p1[1] - seg.p0[1], prev.p1[2] - seg.p0[2]));
      }
    }
    const total = segLen.reduce((a, b) => a + b, 0);
    this.length = total;
    const n = Math.max(1, Math.round(total / ds));
    this.ds = total > 0 ? total / n : ds;
    this.count = this.closed ? n : n + 1;
    const N = this.count;
    this.pos = new Float64Array(N * 3);
    this.tan = new Float64Array(N * 3);
    this.up = new Float64Array(N * 3);
    this.curv = new Float64Array(N * 3);
    this.bank = new Float64Array(N);
    this.kind = new Uint8Array(N);
    this.param = new Float32Array(N);
    this.segOf = new Uint16Array(N);

    const nodes = design.nodes;
    this.nodeS = new Float64Array(nodes.length);
    {
      let acc = 0;
      for (let i = 0; i < nodes.length; i++) {
        this.nodeS[i] = acc;
        if (i < segLen.length) acc += segLen[i]!;
      }
    }

    // 2. Uniform arc-length resampling.
    const p = v3();
    const d2 = v3();
    const tN = v3();
    const k = v3();
    let maxCurv = 0;
    let si = 0;
    let segStart = 0;
    for (let i = 0; i < N; i++) {
      const s = Math.min(i * this.ds, total);
      while (si < segs.length - 1 && s > segStart + segLen[si]!) {
        segStart += segLen[si]!;
        si++;
      }
      if (segs.length === 0) break;
      const seg = segs[si]!;
      const local = clamp(s - segStart, 0, segLen[si]!);
      const t = invertArc(tables[si]!, segLen[si]!, local, seg);
      evalSegment(seg, t, p, d, d2);
      const sp = len(d);
      normalize(tN, d);
      // κ = (A − (A·T)T) / |V|²
      addScaled(k, d2, tN, -dot(d2, tN));
      scale(k, k, 1 / Math.max(sp * sp, 1e-9));
      maxCurv = Math.max(maxCurv, len(k));
      this.pos.set(p, i * 3);
      this.tan.set(tN, i * 3);
      this.curv.set(k, i * 3);
      const node = nodes[si]!;
      this.kind[i] = SECTION_KINDS.indexOf(node.kind);
      this.param[i] = node.param ?? 0;
      this.segOf[i] = si;
    }

    // 3. Bank profile: monotone cubic interpolation of node banks over arc length.
    this.computeBank(design, segCount);

    // 4. Frames: upright-continuous reference with rotation-minimising transport through vertical sections.
    const { seamTwist, seamFlip } = this.computeFrames();

    this.diagnostics = { maxCurvature: maxCurv, seamTwist, seamFlip, maxGap };
  }

  private computeBank(design: Pick<TrackDesign, 'nodes' | 'closed'>, segCount: number): void {
    const nodes = design.nodes;
    if (nodes.length === 0) return;
    // Knots (s, bank) including a wrap knot for closed circuits.
    const ks: number[] = [];
    const kb: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      ks.push(this.nodeS[i]!);
      kb.push(nodes[i]!.bank);
    }
    if (this.closed && segCount === nodes.length) {
      const last = kb[kb.length - 1]!;
      let b0 = nodes[0]!.bank;
      const turns = Math.round((last - b0) / (2 * Math.PI));
      b0 += turns * 2 * Math.PI;
      ks.push(this.length);
      kb.push(b0);
    }
    const m = ks.length;
    const slopes = new Float64Array(m);
    const delta = (i: number) => (kb[i + 1]! - kb[i]!) / Math.max(ks[i + 1]! - ks[i]!, 1e-6);
    for (let i = 0; i < m; i++) {
      if (i === 0 || i === m - 1) {
        if (this.closed && m > 2) {
          // Periodic: slope at the seam uses both sides.
          const dl = delta(m - 2);
          const dr = delta(0);
          slopes[i] = dl * dr <= 0 ? 0 : (dl + dr) / 2;
        } else slopes[i] = 0;
        continue;
      }
      const dl = delta(i - 1);
      const dr = delta(i);
      slopes[i] = dl * dr <= 0 ? 0 : (dl + dr) / 2;
      // Fritsch–Carlson limiter to prevent overshoot.
      const lim = 3 * Math.min(Math.abs(dl), Math.abs(dr));
      if (Math.abs(slopes[i]!) > lim) slopes[i] = Math.sign(slopes[i]!) * lim;
    }
    let j = 0;
    for (let i = 0; i < this.count; i++) {
      const s = i * this.ds;
      while (j < m - 2 && s > ks[j + 1]!) j++;
      if (m === 1) {
        this.bank[i] = kb[0]!;
        continue;
      }
      const h = Math.max(ks[j + 1]! - ks[j]!, 1e-6);
      const u = clamp((s - ks[j]!) / h, 0, 1);
      const u2 = u * u;
      const u3 = u2 * u;
      this.bank[i] =
        (2 * u3 - 3 * u2 + 1) * kb[j]! +
        (u3 - 2 * u2 + u) * h * slopes[j]! +
        (-2 * u3 + 3 * u2) * kb[j + 1]! +
        (u3 - u2) * h * slopes[j + 1]!;
    }
  }

  private computeFrames(): { seamTwist: number; seamFlip: boolean } {
    const N = this.count;
    const T = v3();
    const right = v3();
    const cand = v3();
    const upr = v3();
    const up = v3();
    const prevRight = v3();
    const rights = new Float64Array(N * 3);
    // Initial right vector.
    this.readVec(this.tan, 0, T);
    cross(right, T, WORLD_UP);
    if (len(right) < 1e-6) set(right, 0, 0, 1);
    normalize(prevRight, right);

    const frameAt = (Tv: V3, prev: V3, out: V3) => {
      addScaled(cand, prev, Tv, -dot(prev, Tv));
      normalize(cand, cand);
      cross(upr, Tv, WORLD_UP);
      const hl = len(upr);
      if (hl > 1e-6) {
        scale(upr, upr, 1 / hl);
        if (dot(upr, cand) < 0) scale(upr, upr, -1);
        const w = smoothstep(0.1, 0.25, hl);
        for (let c = 0; c < 3; c++) out[c] = cand[c]! + (upr[c]! - cand[c]!) * w;
        addScaled(out, out, Tv, -dot(out, Tv));
        normalize(out, out);
        if (len(out) < 0.5) copy(out, cand);
      } else copy(out, cand);
    };

    for (let i = 0; i < N; i++) {
      this.readVec(this.tan, i, T);
      frameAt(T, prevRight, right);
      rights.set(right, i * 3);
      copy(prevRight, right);
    }

    let seamTwist = 0;
    let seamFlip = false;
    if (this.closed && N > 2) {
      // Transport the last frame one step onto the first tangent and measure residual twist.
      this.readVec(this.tan, 0, T);
      const endRight = v3();
      frameAt(T, prevRight, endRight);
      const r0: V3 = [rights[0]!, rights[1]!, rights[2]!];
      const c = clamp(dot(endRight, r0), -1, 1);
      const sgn = Math.sign(dot(cross(v3(), endRight, r0), T)) || 1;
      seamTwist = Math.acos(c) * sgn;
      seamFlip = Math.abs(seamTwist) > Math.PI / 2;
      if (!seamFlip && Math.abs(seamTwist) > 1e-9) {
        // Distribute the residual twist along the circuit so the seam is continuous.
        for (let i = 0; i < N; i++) {
          this.readVec(this.tan, i, T);
          const r: V3 = [rights[i * 3]!, rights[i * 3 + 1]!, rights[i * 3 + 2]!];
          rotateAxis(r, r, T, (seamTwist * i) / N);
          rights.set(r, i * 3);
        }
      }
    }

    for (let i = 0; i < N; i++) {
      this.readVec(this.tan, i, T);
      set(right, rights[i * 3]!, rights[i * 3 + 1]!, rights[i * 3 + 2]!);
      cross(up, right, T);
      rotateAxis(up, up, T, this.bank[i]!);
      this.up.set(up, i * 3);
    }
    return { seamTwist, seamFlip };
  }

  private readVec(arr: Float64Array, i: number, out: V3): V3 {
    return set(out, arr[i * 3]!, arr[i * 3 + 1]!, arr[i * 3 + 2]!);
  }

  /** Wrap or clamp an arc-length position into the valid range. */
  wrap(s: number): number {
    if (this.closed) {
      const L = this.length;
      return ((s % L) + L) % L;
    }
    return clamp(s, 0, this.length);
  }

  /** Sample the track at arc length s. Writes into `out` without allocating. */
  sample(s: number, out: TrackSample): TrackSample {
    const N = this.count;
    const h = this.ds;
    const sw = this.wrap(s);
    let i = Math.floor(sw / h);
    let u = sw / h - i;
    if (this.closed) {
      i = i % N;
    } else if (i >= N - 1) {
      i = N - 2;
      u = 1;
    }
    if (N < 2) {
      out.kind = 'track';
      return out;
    }
    const j = this.closed ? (i + 1) % N : i + 1;
    const P = this.pos;
    const Tn = this.tan;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    const d00 = (6 * u2 - 6 * u) / h;
    const d10 = 3 * u2 - 4 * u + 1;
    const d01 = (-6 * u2 + 6 * u) / h;
    const d11 = 3 * u2 - 2 * u;
    for (let c = 0; c < 3; c++) {
      const pi = P[i * 3 + c]!;
      const pj = P[j * 3 + c]!;
      const ti = Tn[i * 3 + c]!;
      const tj = Tn[j * 3 + c]!;
      out.pos[c] = h00 * pi + h10 * h * ti + h01 * pj + h11 * h * tj;
      out.tan[c] = d00 * pi + d10 * ti + d01 * pj + d11 * tj;
      out.curv[c] = this.curv[i * 3 + c]! + (this.curv[j * 3 + c]! - this.curv[i * 3 + c]!) * u;
      out.up[c] = this.up[i * 3 + c]! + (this.up[j * 3 + c]! - this.up[i * 3 + c]!) * u;
    }
    out.dyds = out.tan[1];
    normalize(out.tan, out.tan);
    // Re-orthonormalise the frame.
    addScaled(out.up, out.up, out.tan, -dot(out.up, out.tan));
    normalize(out.up, out.up);
    cross(out.right, out.tan, out.up);
    const k = u < 0.5 ? i : j;
    out.kind = SECTION_KINDS[this.kind[k]!] ?? 'track';
    out.param = this.param[k]!;
    out.bank = this.bank[i]! + (this.bank[j]! - this.bank[i]!) * u;
    return out;
  }

  /** Arc-length intervals [start, end) covered by sections of a given kind. */
  intervalsOf(kind: SectionKind): Array<[number, number]> {
    const idx = SECTION_KINDS.indexOf(kind);
    const out: Array<[number, number]> = [];
    let start = -1;
    for (let i = 0; i < this.count; i++) {
      const on = this.kind[i] === idx;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        out.push([start * this.ds, i * this.ds]);
        start = -1;
      }
    }
    if (start >= 0) {
      const end = this.closed ? this.length : (this.count - 1) * this.ds;
      // Merge wrap-around interval for closed tracks.
      if (this.closed && out.length > 0 && out[0]![0] === 0) {
        const first = out.shift()!;
        out.push([start * this.ds, this.length + first[1]]);
      } else out.push([start * this.ds, end]);
    }
    return out;
  }

  /** Nearest arc-length position to a world point (coarse scan + local refine). */
  nearest(point: Readonly<V3>): { s: number; distance: number } {
    let best = 0;
    let bestD = Infinity;
    const P = this.pos;
    for (let i = 0; i < this.count; i++) {
      const dx = P[i * 3]! - point[0];
      const dy = P[i * 3 + 1]! - point[1];
      const dz = P[i * 3 + 2]! - point[2];
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
    return { s: best * this.ds, distance: Math.sqrt(bestD) };
  }
}

const _d = v3();
/** Invert the arc-length table: find t such that arc(t) = s. */
function invertArc(table: Float64Array, total: number, s: number, seg: HermiteSegment): number {
  if (s <= 0) return 0;
  if (s >= total) return 1;
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid]! < s) lo = mid;
    else hi = mid;
  }
  const a = table[lo]!;
  const b = table[hi]!;
  let t = (lo + (b > a ? (s - a) / (b - a) : 0)) / (table.length - 1);
  // One Newton refinement using the local speed; integrate the residual with Simpson on [t_lo, t].
  const tLo = lo / (table.length - 1);
  for (let it = 0; it < 2; it++) {
    evalSegment(seg, tLo, null, _d, null);
    const s0 = len(_d);
    evalSegment(seg, (tLo + t) / 2, null, _d, null);
    const s1 = len(_d);
    evalSegment(seg, t, null, _d, null);
    const s2 = len(_d);
    const arc = a + ((t - tLo) / 6) * (s0 + 4 * s1 + s2);
    if (s2 < 1e-9) break;
    t = clamp(t - (arc - s) / s2, tLo, hi / (table.length - 1));
  }
  return t;
}
