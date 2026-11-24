import { BakedTrack, newSample, type TrackSample } from './bake';
import type { TrackStyle } from './types';

/** Colour channel indices resolved in the track shader (see track-renderer). */
export const PART = { rail: 0, spine: 1, sleeper: 2, chain: 3, fin: 4 } as const;

interface Profile {
  /** Closed outline in (lateral, up) metres. */
  pts: Array<[number, number]>;
  part: number;
  smooth: boolean;
}

const circle = (cx: number, cy: number, r: number, n: number): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as [number, number];
  });

const rrect = (cx: number, cy: number, w: number, h: number, r: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  const corners: Array<[number, number, number]> = [
    [cx + w / 2 - r, cy + h / 2 - r, 0],
    [cx - w / 2 + r, cy + h / 2 - r, Math.PI / 2],
    [cx - w / 2 + r, cy - h / 2 + r, Math.PI],
    [cx + w / 2 - r, cy - h / 2 + r, (3 * Math.PI) / 2],
  ];
  for (const [x, y, a0] of corners) for (let k = 0; k <= 2; k++) out.push([x + Math.cos(a0 + (k * Math.PI) / 4) * r, y + Math.sin(a0 + (k * Math.PI) / 4) * r]);
  return out;
};

export const GAUGE_HALF = 0.55;

export function profilesFor(style: TrackStyle): Profile[] {
  const g = GAUGE_HALF;
  switch (style) {
    case 'tubular':
      return [
        { pts: circle(-g, 0, 0.07, 10), part: PART.rail, smooth: true },
        { pts: circle(g, 0, 0.07, 10), part: PART.rail, smooth: true },
        { pts: circle(0, -0.44, 0.17, 14), part: PART.spine, smooth: true },
      ];
    case 'boxspine':
      return [
        { pts: circle(-g, 0, 0.065, 10), part: PART.rail, smooth: true },
        { pts: circle(g, 0, 0.065, 10), part: PART.rail, smooth: true },
        { pts: rrect(0, -0.52, 0.38, 0.5, 0.05), part: PART.spine, smooth: false },
      ];
    case 'wood':
      // Laminated timber rail stacks with flat steel running strap on top.
      return [
        { pts: rrect(-g, -0.17, 0.2, 0.32, 0.02), part: PART.spine, smooth: false },
        { pts: rrect(g, -0.17, 0.2, 0.32, 0.02), part: PART.spine, smooth: false },
        { pts: rrect(-g, 0.0, 0.15, 0.03, 0.008), part: PART.rail, smooth: false },
        { pts: rrect(g, 0.0, 0.15, 0.03, 0.008), part: PART.rail, smooth: false },
      ];
    case 'mine':
      return [
        { pts: rrect(-g, -0.02, 0.09, 0.15, 0.015), part: PART.rail, smooth: false },
        { pts: rrect(g, -0.02, 0.09, 0.15, 0.015), part: PART.rail, smooth: false },
      ];
  }
}

export interface GeometryBuffers {
  position: Float32Array;
  normal: Float32Array;
  part: Float32Array;
  index: Uint32Array;
}

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  part: number[] = [];
  idx: number[] = [];
  get count() {
    return this.pos.length / 3;
  }
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, p: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.part.push(p);
    return this.count - 1;
  }
  finish(): GeometryBuffers {
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nor),
      part: new Float32Array(this.part),
      index: new Uint32Array(this.idx),
    };
  }
}

/** Oriented box in track frame: centre offset (lat, up, along), half sizes, writes 24 verts. */
function frameBox(b: Builder, s: TrackSample, lat: number, upOff: number, hx: number, hy: number, hz: number, part: number, origin: readonly number[]): void {
  const T = s.tan;
  const U = s.up;
  const R = s.right;
  const cx = s.pos[0] + R[0] * lat + U[0] * upOff - origin[0]!;
  const cy = s.pos[1] + R[1] * lat + U[1] * upOff - origin[1]!;
  const cz = s.pos[2] + R[2] * lat + U[2] * upOff - origin[2]!;
  const faces: Array<[number[], number[], number[], number]> = [
    [R, U, T, hx],
    [U, T, R, hy],
    [T, R, U, hz],
  ];
  for (const [n, a, c, h] of faces) {
    const ha = a === R ? hx : a === U ? hy : hz;
    const hc = c === R ? hx : c === U ? hy : hz;
    for (const sgn of [1, -1]) {
      const base = b.count;
      for (const [ua, uc] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        b.vert(
          cx + n[0]! * h * sgn + a[0]! * ha * ua + c[0]! * hc * uc,
          cy + n[1]! * h * sgn + a[1]! * ha * ua + c[1]! * hc * uc,
          cz + n[2]! * h * sgn + a[2]! * ha * ua + c[2]! * hc * uc,
          n[0]! * sgn,
          n[1]! * sgn,
          n[2]! * sgn,
          part,
        );
      }
      // Choose winding so the face is counter-clockwise seen from outside.
      const cxv = a[1]! * c[2]! - a[2]! * c[1]!;
      const cyv = a[2]! * c[0]! - a[0]! * c[2]!;
      const czv = a[0]! * c[1]! - a[1]! * c[0]!;
      const facing = (cxv * n[0]! + cyv * n[1]! + czv * n[2]!) * sgn;
      if (facing > 0) b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
}

/** Arc-length stations along [s0, s1] adapted to curvature and twist. */
export function stations(track: BakedTrack, s0: number, s1: number, maxStep = 1.6, maxAngle = 0.045): number[] {
  const out = [s0];
  const a = newSample();
  const b = newSample();
  track.sample(s0, a);
  let last = s0;
  const fine = Math.min(0.25, (s1 - s0) / 4);
  for (let s = s0 + fine; s < s1 - 1e-6; s += fine) {
    track.sample(s, b);
    const dt = 1 - (a.tan[0] * b.tan[0] + a.tan[1] * b.tan[1] + a.tan[2] * b.tan[2]);
    const du = 1 - (a.up[0] * b.up[0] + a.up[1] * b.up[1] + a.up[2] * b.up[2]);
    if (s - last >= maxStep || dt > maxAngle * maxAngle * 0.5 || du > maxAngle * maxAngle * 0.5) {
      out.push(s);
      last = s;
      a.pos = [...b.pos];
      a.tan = [...b.tan];
      a.up = [...b.up];
    }
  }
  out.push(s1);
  return out;
}


/** Sweep a closed 2D profile along the given arc-length stations. */
function sweep(b: Builder, track: BakedTrack, prof: Profile, st: number[], origin: readonly number[], smp: TrackSample): void {
    const n = prof.pts.length;
  const ringStart: number[] = [];
  // Precompute 2D outline normals.
  const n2: Array<[number, number]> = prof.pts.map((_p, i) => {
    if (prof.smooth) {
      // Normal from circle centre approximated by neighbours.
      const prev = prof.pts[(i - 1 + n) % n]!;
      const next = prof.pts[(i + 1) % n]!;
      const tx = next[0] - prev[0];
      const ty = next[1] - prev[1];
      const l = Math.hypot(tx, ty) || 1;
      return [ty / l, -tx / l];
    }
    return [0, 0];
  });
  for (const s of st) {
    track.sample(s, smp);
    const R = smp.right;
    const U = smp.up;
    if (prof.smooth) {
      ringStart.push(b.count);
      for (let i = 0; i < n; i++) {
        const [x, y] = prof.pts[i]!;
        const [nx, ny] = n2[i]!;
        b.vert(
          smp.pos[0] + R[0] * x + U[0] * y - origin[0]!,
          smp.pos[1] + R[1] * x + U[1] * y - origin[1]!,
          smp.pos[2] + R[2] * x + U[2] * y - origin[2]!,
          R[0] * nx + U[0] * ny,
          R[1] * nx + U[1] * ny,
          R[2] * nx + U[2] * ny,
          prof.part,
        );
      }
    } else {
      // Flat-shaded outline: duplicate verts per edge for crisp, bevel-like facets.
      ringStart.push(b.count);
      for (let i = 0; i < n; i++) {
        const p0 = prof.pts[i]!;
        const p1 = prof.pts[(i + 1) % n]!;
        const ex = p1[0] - p0[0];
        const ey = p1[1] - p0[1];
        const l = Math.hypot(ex, ey) || 1;
        const nx = ey / l;
        const ny = -ex / l;
        for (const p of [p0, p1]) {
          b.vert(
            smp.pos[0] + R[0] * p[0] + U[0] * p[1] - origin[0]!,
            smp.pos[1] + R[1] * p[0] + U[1] * p[1] - origin[1]!,
            smp.pos[2] + R[2] * p[0] + U[2] * p[1] - origin[2]!,
            R[0] * nx + U[0] * ny,
            R[1] * nx + U[1] * ny,
            R[2] * nx + U[2] * ny,
            prof.part,
          );
        }
      }
    }
  }
  for (let r = 0; r + 1 < ringStart.length; r++) {
    const a0 = ringStart[r]!;
    const b0 = ringStart[r + 1]!;
    if (prof.smooth) {
      for (let i = 0; i < n; i++) {
        const i1 = (i + 1) % n;
        // Outline is CCW in the (right, up) plane; (edge × T) points inwards, so wind the other way.
        b.idx.push(a0 + i, b0 + i1, a0 + i1, a0 + i, b0 + i, b0 + i1);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const e0 = i * 2;
        const e1 = e0 + 1;
        b.idx.push(a0 + e0, b0 + e1, a0 + e1, a0 + e0, b0 + e0, b0 + e1);
      }
    }
  }
  }

/**
 * Build rail, spine and sleeper geometry for arc range [s0, s1] of a baked track.
 * Vertices are relative to `origin` so meshes stay precise far from the world origin.
 */
export function buildTrackGeometry(track: BakedTrack, style: TrackStyle, s0: number, s1: number, origin: readonly number[], lod = 1): GeometryBuffers {
  const b = new Builder();
  const profiles = profilesFor(style);
  const st = stations(track, s0, s1, lod > 1 ? 3 : 1.6, lod > 1 ? 0.09 : 0.045);
  const smp = newSample();
  for (const prof of profiles) sweep(b, track, prof, st, origin, smp);

  if (style === 'wood') woodDetails(b, track, s0, s1, st, origin, smp);
  else {
    // Cross ties.
    const spacing = style === 'mine' ? 0.75 : style === 'boxspine' ? 1.5 : 1.2;
    for (let s = Math.ceil(s0 / spacing) * spacing; s < s1; s += spacing) {
      track.sample(s, smp);
      if (style === 'tubular') {
        frameBox(b, smp, 0, -0.07, GAUGE_HALF, 0.035, 0.05, PART.sleeper, origin);
        frameBox(b, smp, 0, -0.24, 0.04, 0.17, 0.05, PART.sleeper, origin);
      } else if (style === 'boxspine') frameBox(b, smp, 0, -0.12, GAUGE_HALF + 0.02, 0.05, 0.09, PART.sleeper, origin);
      else frameBox(b, smp, 0, -0.14, 0.82, 0.06, 0.12, PART.sleeper, origin);
    }
    // Steel coasters only get a catwalk on the lift: open metal grating, no timber slats.
    if (style !== 'mine') steelLiftCatwalk(b, track, s0, s1, st, origin, smp);
  }
  // Section hardware: chain trough on lifts, brake/LSM fins.
  const hw = 0.6;
  for (let s = Math.ceil(s0 / hw) * hw; s < s1; s += hw) {
    track.sample(s, smp);
    if (smp.kind === 'lift') frameBox(b, smp, 0, -0.02, 0.06, 0.03, hw * 0.5, PART.chain, origin);
    else if (smp.kind === 'brake' || smp.kind === 'launch') frameBox(b, smp, 0, style === 'wood' ? -0.36 : -0.18, 0.012, 0.08, hw * 0.48, PART.fin, origin);
  }
  return b.finish();
}

/** Sub-ranges of [s0, s1) covered by lift sections, with their own stations. */
function liftRanges(track: BakedTrack, s0: number, s1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, c] of track.intervalsOf('lift')) {
    const lo = Math.max(a, s0);
    const hi = Math.min(c, s1);
    if (hi - lo > 0.5) out.push([lo, hi]);
  }
  return out;
}

/**
 * Traditional wooden coaster detailing: spacer blocks between the laminated rail stacks, track
 * ledgers at every bent (2.4 m), and a timber catwalk of slats with handrails (both sides on the
 * lift, the outside elsewhere).
 */
function woodDetails(b: Builder, track: BakedTrack, s0: number, s1: number, st: number[], origin: readonly number[], smp: TrackSample): void {
  const g = GAUGE_HALF;
  for (let s = Math.ceil(s0 / 1.2) * 1.2; s < s1; s += 1.2) {
    track.sample(s, smp);
    frameBox(b, smp, 0, -0.2, g - 0.1, 0.07, 0.06, PART.spine, origin);
  }
  const lifts = liftRanges(track, s0, s1);
  const onLift = (s: number) => lifts.some(([a, c]) => s >= a && s <= c);
  for (let s = Math.ceil(s0 / 2.4) * 2.4; s < s1; s += 2.4) {
    track.sample(s, smp);
    if (smp.up[1] < 0.3) continue;
    const both = onLift(s);
    frameBox(b, smp, both ? 0 : -0.55, -0.4, both ? 1.95 : 1.4, 0.1, 0.1, PART.sleeper, origin);
    for (const side of both ? [-1, 1] : [-1]) frameBox(b, smp, side * 1.85, 0.12, 0.035, 0.42, 0.035, PART.spine, origin);
  }
  // Catwalk slats.
  for (let s = Math.ceil(s0 / 0.26) * 0.26; s < s1; s += 0.26) {
    track.sample(s, smp);
    if (smp.up[1] < 0.3) continue;
    for (const side of onLift(s) ? [-1, 1] : [-1]) frameBox(b, smp, side * 1.33, -0.29, 0.44, 0.017, 0.1, PART.sleeper, origin);
  }
  // Handrails and catwalk stringers, swept so they follow curves smoothly.
  const rail: Profile = { pts: rrect(-1.85, 0.55, 0.06, 0.06, 0.012), part: PART.spine, smooth: false };
  const stringer: Profile = { pts: rrect(-1.33, -0.34, 0.86, 0.07, 0.01), part: PART.spine, smooth: false };
  sweep(b, track, rail, st, origin, smp);
  sweep(b, track, stringer, st, origin, smp);
  for (const [a, c] of lifts) {
    const ls = stations(track, a, c);
    sweep(b, track, { ...rail, pts: rrect(1.85, 0.55, 0.06, 0.06, 0.012) }, ls, origin, smp);
    sweep(b, track, { ...stringer, pts: rrect(1.33, -0.34, 0.86, 0.07, 0.01) }, ls, origin, smp);
  }
}

/** Steel lift catwalk on the right: galvanised grating, stringers, stanchions and a tube handrail. */
function steelLiftCatwalk(b: Builder, track: BakedTrack, s0: number, s1: number, _st: number[], origin: readonly number[], smp: TrackSample): void {
  for (const [a, c] of liftRanges(track, s0, s1)) {
    const ls = stations(track, a, c);
    sweep(b, track, { pts: rrect(1.2, -0.3, 0.8, 0.025, 0.006), part: PART.fin, smooth: false }, ls, origin, smp);
    sweep(b, track, { pts: rrect(1.6, -0.36, 0.05, 0.12, 0.01), part: PART.fin, smooth: false }, ls, origin, smp);
    sweep(b, track, { pts: circle(1.6, 0.72, 0.03, 8), part: PART.fin, smooth: true }, ls, origin, smp);
    sweep(b, track, { pts: circle(1.6, 0.25, 0.02, 6), part: PART.fin, smooth: true }, ls, origin, smp);
    for (let s = Math.ceil(a / 1.8) * 1.8; s < c; s += 1.8) {
      track.sample(s, smp);
      frameBox(b, smp, 1.6, 0.18, 0.025, 0.54, 0.025, PART.fin, origin);
      frameBox(b, smp, 0.95, -0.33, 0.6, 0.03, 0.03, PART.fin, origin);
    }
  }
}
