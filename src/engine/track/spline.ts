import { type V3, v3, sub, dot, len, addScaled, scale, normalize, clamp } from '../core/vec3';
import type { TrackDesign, TrackNode } from './types';

/**
 * A quintic Hermite segment. Position, first derivative and second derivative
 * are prescribed at both ends, giving G1 continuity everywhere and curvature
 * (G2) continuity at nodes because adjacent segments share a curvature vector.
 */
export interface HermiteSegment {
  p0: V3;
  p1: V3;
  v0: V3;
  v1: V3;
  a0: V3;
  a1: V3;
}

/** Arc-length estimate for a circular arc joining two directions over a chord. */
export function tangentMagnitude(p0: Readonly<V3>, d0: Readonly<V3>, p1: Readonly<V3>, d1: Readonly<V3>, tension = 1): number {
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const theta = Math.acos(clamp(dot(d0, d1), -1, 1));
  // arc / chord for a circular arc subtending theta. Clamp to keep very tight turns from looping.
  const half = Math.min(theta, 2.6) / 2;
  const ratio = half > 1e-4 ? half / Math.sin(half) : 1;
  return chord * ratio * tension;
}

const tmp = v3();
const tmp2 = v3();

/** Second derivative at either end of the cubic Hermite through the same data (used to estimate node curvature). */
function cubicEndAccel(p0: V3, v0: V3, p1: V3, v1: V3, atEnd: boolean, out: V3): V3 {
  sub(tmp, p1, p0);
  if (!atEnd) {
    // 6(P1-P0) - 4V0 - 2V1
    for (let i = 0; i < 3; i++) out[i] = 6 * tmp[i]! - 4 * v0[i]! - 2 * v1[i]!;
  } else {
    for (let i = 0; i < 3; i++) out[i] = -6 * tmp[i]! + 2 * v0[i]! + 4 * v1[i]!;
  }
  return out;
}

/** Curvature vector κ = (A - (A·T)T)/|V|² given derivative V and second derivative A. */
function curvatureFrom(v: V3, a: V3, out: V3): V3 {
  const vl = len(v);
  if (vl < 1e-9) return scale(out, out, 0);
  normalize(tmp2, v);
  const at = dot(a, tmp2);
  addScaled(out, a, tmp2, -at);
  return scale(out, out, 1 / (vl * vl));
}

export function segmentCount(design: Pick<TrackDesign, 'nodes' | 'closed'>): number {
  const n = design.nodes.length;
  if (n < 2) return 0;
  return design.closed ? n : n - 1;
}

/** Build all Hermite segments for a design. Pure; safe to call off the main thread. */
export function buildSegments(design: Pick<TrackDesign, 'nodes' | 'closed'>): HermiteSegment[] {
  const nodes = design.nodes;
  const n = nodes.length;
  const count = segmentCount(design);
  if (count === 0) return [];
  const at = (i: number): TrackNode => nodes[((i % n) + n) % n]!;

  // First pass: tangents and cubic-estimate curvature at each segment end.
  const segV0: V3[] = [];
  const segV1: V3[] = [];
  const kStart: V3[] = [];
  const kEnd: V3[] = [];
  for (let s = 0; s < count; s++) {
    const a = at(s);
    const b = at(s + 1);
    const m = tangentMagnitude(a.p, a.dir, b.p, b.dir, a.tension ?? 1);
    const v0 = scale(v3(), a.dir, m);
    const v1 = scale(v3(), b.dir, m);
    segV0.push(v0);
    segV1.push(v1);
    const acc = v3();
    kStart.push(curvatureFrom(v0, cubicEndAccel(a.p, v0, b.p, v1, false, acc), v3()));
    kEnd.push(curvatureFrom(v1, cubicEndAccel(a.p, v0, b.p, v1, true, v3()), v3()));
  }

  // Shared curvature at each node: average of incoming and outgoing estimates.
  const nodeK: V3[] = [];
  for (let i = 0; i < n; i++) {
    const outSeg = i < count ? i : -1;
    const inSeg = design.closed ? (i - 1 + count) % count : i - 1;
    const k = v3();
    let w = 0;
    if (outSeg >= 0) {
      addScaled(k, k, kStart[outSeg]!, 1);
      w++;
    }
    if (inSeg >= 0 && inSeg < count) {
      addScaled(k, k, kEnd[inSeg]!, 1);
      w++;
    }
    if (w > 0) scale(k, k, 1 / w);
    // Remove any tangential component so the curvature is perpendicular to the node direction.
    const d = at(i).dir;
    addScaled(k, k, d, -dot(k, d));
    nodeK.push(k);
  }

  const segs: HermiteSegment[] = [];
  for (let s = 0; s < count; s++) {
    const a = at(s);
    const b = at(s + 1);
    const v0 = segV0[s]!;
    const v1 = segV1[s]!;
    const m0 = len(v0);
    const m1 = len(v1);
    const ia = s;
    const ib = (s + 1) % n;
    segs.push({
      p0: [...a.p] as V3,
      p1: [...b.p] as V3,
      v0,
      v1,
      a0: scale(v3(), nodeK[ia]!, m0 * m0),
      a1: scale(v3(), nodeK[ib]!, m1 * m1),
    });
  }
  return segs;
}

/** Evaluate position, first and second derivatives of a quintic Hermite segment at t ∈ [0,1]. */
export function evalSegment(seg: HermiteSegment, t: number, p: V3 | null, d1: V3 | null, d2: V3 | null): void {
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const t5 = t4 * t;
  if (p) {
    const h0 = 1 - 10 * t3 + 15 * t4 - 6 * t5;
    const h1 = t - 6 * t3 + 8 * t4 - 3 * t5;
    const h2 = 0.5 * t2 - 1.5 * t3 + 1.5 * t4 - 0.5 * t5;
    const h3 = 0.5 * t3 - t4 + 0.5 * t5;
    const h4 = -4 * t3 + 7 * t4 - 3 * t5;
    const h5 = 10 * t3 - 15 * t4 + 6 * t5;
    for (let i = 0; i < 3; i++)
      p[i] = h0 * seg.p0[i]! + h1 * seg.v0[i]! + h2 * seg.a0[i]! + h3 * seg.a1[i]! + h4 * seg.v1[i]! + h5 * seg.p1[i]!;
  }
  if (d1) {
    const h0 = -30 * t2 + 60 * t3 - 30 * t4;
    const h1 = 1 - 18 * t2 + 32 * t3 - 15 * t4;
    const h2 = t - 4.5 * t2 + 6 * t3 - 2.5 * t4;
    const h3 = 1.5 * t2 - 4 * t3 + 2.5 * t4;
    const h4 = -12 * t2 + 28 * t3 - 15 * t4;
    const h5 = 30 * t2 - 60 * t3 + 30 * t4;
    for (let i = 0; i < 3; i++)
      d1[i] = h0 * seg.p0[i]! + h1 * seg.v0[i]! + h2 * seg.a0[i]! + h3 * seg.a1[i]! + h4 * seg.v1[i]! + h5 * seg.p1[i]!;
  }
  if (d2) {
    const h0 = -60 * t + 180 * t2 - 120 * t3;
    const h1 = -36 * t + 96 * t2 - 60 * t3;
    const h2 = 1 - 9 * t + 18 * t2 - 10 * t3;
    const h3 = 3 * t - 12 * t2 + 10 * t3;
    const h4 = -24 * t + 84 * t2 - 60 * t3;
    const h5 = 60 * t - 180 * t2 + 120 * t3;
    for (let i = 0; i < 3; i++)
      d2[i] = h0 * seg.p0[i]! + h1 * seg.v0[i]! + h2 * seg.a0[i]! + h3 * seg.a1[i]! + h4 * seg.v1[i]! + h5 * seg.p1[i]!;
  }
}
