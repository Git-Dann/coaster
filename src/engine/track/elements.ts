import { type V3, v3, add, addScaled, normalize, cross, anglesFromDir, dirFromAngles, scale, set } from '../core/vec3';
import type { SectionKind } from './types';

/** Where a new element starts: the end of the existing track. */
export interface Cursor {
  p: V3;
  dir: V3;
  bank: number;
}

export interface ElementNode {
  p: V3;
  dir: V3;
  bank: number;
  kind?: SectionKind;
  param?: number;
  tension?: number;
}

export interface ElementResult {
  /** Kind (and parameter) to apply to the segment leaving the start cursor's node. */
  startKind: SectionKind;
  startParam?: number;
  nodes: ElementNode[];
}

const DEG = Math.PI / 180;
const Y: V3 = [0, 1, 0];

/** Local frame at a cursor: forward (horizontal), right (horizontal), up (world). */
function frame(c: Cursor) {
  const { heading, pitch } = anglesFromDir(c.dir);
  const f = dirFromAngles(heading, 0);
  const r = cross(v3(), f, Y);
  normalize(r, r);
  return { f, r, heading, pitch };
}

/** Local (forward, up, right) → world offset from cursor. */
function toWorld(c: Cursor, fr: ReturnType<typeof frame>, x: number, y: number, z: number): V3 {
  const out = v3();
  addScaled(out, c.p, fr.f, x);
  out[1] += y;
  addScaled(out, out, fr.r, z);
  return out;
}
function dirWorld(fr: ReturnType<typeof frame>, x: number, y: number, z: number): V3 {
  const out = v3();
  addScaled(out, out, fr.f, x);
  out[1] += y;
  addScaled(out, out, fr.r, z);
  return normalize(out, out);
}

export type Ease = 'both' | 'in' | 'out' | 'none';

export interface PieceParams {
  /** Horizontal length (m). */
  length: number;
  /** Heading change in degrees, positive = left. */
  turn: number;
  /** Height change (m). */
  rise: number;
  /**
   * Bank in degrees (positive tilts towards the right rail).
   * With ease 'both' this is the peak bank mid-turn and the piece returns to the start bank.
   * Otherwise it is the bank at the end of the piece.
   */
  bank: number;
  /** Pitch at the end in degrees. Default 0 (level). */
  endPitch?: number;
  /**
   * Curvature easing (transition curves). 'both' ramps curvature in and out so the turn
   * starts and ends straight, letting the bank follow the curvature and keeping lateral G low.
   */
  ease?: Ease;
  kind?: SectionKind;
  param?: number;
}

const ss = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Relative curvature weight along a piece for each easing mode. */
function easeWeight(ease: Ease, f: number): number {
  switch (ease) {
    case 'both':
      return ss(0, 0.35, f) * (1 - ss(0.65, 1, f));
    case 'in':
      return ss(0, 0.4, f);
    case 'out':
      return 1 - ss(0.6, 1, f);
    default:
      return 1;
  }
}

/**
 * The basic builder piece: a plan-view curve whose curvature follows an easing profile, with a
 * cubic height profile. Heading is integrated numerically so transitions are exact.
 * Splits into sub-nodes so each Hermite segment turns at most ~30°.
 */
export function piece(c: Cursor, pp: PieceParams): ElementResult {
  const fr = frame(c);
  const theta = pp.turn * DEG;
  const ease: Ease = pp.ease ?? 'both';
  const Lh = Math.max(1, pp.length);
  const steps = Math.max(1, Math.ceil(Math.abs(pp.turn) / 30), Math.ceil(Lh / 30), ease === 'none' ? 1 : 4);
  const p0 = fr.pitch;
  const p1 = (pp.endPitch ?? 0) * DEG;
  const m0 = Math.tan(Math.max(-1.3, Math.min(1.3, p0))) * Lh;
  const m1 = Math.tan(Math.max(-1.3, Math.min(1.3, p1))) * Lh;
  // Integrate heading and plan position.
  const N = 400;
  const W = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) W[i] = W[i - 1]! + (easeWeight(ease, (i - 0.5) / N) * 1) / N;
  const wTot = W[N]! || 1;
  const xs = new Float64Array(N + 1);
  const zs = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const hd = (theta * (W[i - 1]! + W[i]!)) / 2 / wTot;
    xs[i] = xs[i - 1]! + (Math.cos(hd) * Lh) / N;
    zs[i] = zs[i - 1]! - (Math.sin(hd) * Lh) / N;
  }
  const b0 = c.bank;
  // Bank targets are absolute angles: pick the equivalent nearest the start so a piece after a roll
  // never unwinds whole turns.
  let bT = pp.bank * DEG;
  bT += Math.round((b0 - bT) / (2 * Math.PI)) * 2 * Math.PI;
  const nodes: ElementNode[] = [];
  for (let k = 1; k <= steps; k++) {
    const f = k / steps;
    const i = Math.round(f * N);
    const hd = (theta * W[i]!) / wTot;
    const f2 = f * f;
    const f3 = f2 * f;
    const y = (f3 - 2 * f2 + f) * m0 + (-2 * f3 + 3 * f2) * pp.rise + (f3 - f2) * m1;
    const dy = ((3 * f2 - 4 * f + 1) * m0 + (-6 * f2 + 6 * f) * pp.rise + (3 * f2 - 2 * f) * m1) / Lh;
    const p = toWorld(c, fr, xs[i]!, y, zs[i]!);
    const dir = dirWorld(fr, Math.cos(hd), dy, -Math.sin(hd));
    let bank: number;
    if (ease === 'both') bank = b0 + (bT - b0) * easeWeight('both', f);
    else if (ease === 'in') bank = b0 + (bT - b0) * ss(0, 0.4, f);
    else if (ease === 'out') bank = b0 + (bT - b0) * ss(0.6, 1, f);
    else bank = b0 + (bT - b0) * (f * f * (3 - 2 * f));
    nodes.push({ p, dir, bank, kind: pp.kind ?? 'track', param: pp.param });
  }
  return { startKind: pp.kind ?? 'track', startParam: pp.param, nodes };
}

/** Banked helix of `turns` revolutions (positive = left) with total height change. */
export function helix(c: Cursor, turns: number, radius: number, rise: number, bankDeg: number): ElementResult {
  const total = Math.abs(turns) * 360;
  const sgn = Math.sign(turns) || 1;
  const length = Math.abs(turns) * 2 * Math.PI * radius;
  const pitch = Math.atan2(rise, length) / DEG;
  const parts: PieceParams[] = [
    { length: length * 0.22, turn: sgn * total * 0.15, rise: rise * 0.2, bank: -sgn * bankDeg, endPitch: pitch, ease: 'in' },
    { length: length * 0.56, turn: sgn * total * 0.7, rise: rise * 0.6, bank: -sgn * bankDeg, endPitch: pitch, ease: 'none' },
    { length: length * 0.22, turn: sgn * total * 0.15, rise: rise * 0.2, bank: c.bank / DEG, endPitch: 0, ease: 'out' },
  ];
  const res: ElementNode[] = [];
  let cur: Cursor = c;
  for (const pp of parts) {
    const r = piece(cur, pp);
    res.push(...r.nodes);
    const end = r.nodes[r.nodes.length - 1]!;
    cur = { p: end.p, dir: end.dir, bank: end.bank };
  }
  return { startKind: 'track', nodes: res };
}

/** Vertical-plane profile made of circular arcs and straight lines, used for lifts and drops. */
type ProfileStep = { arc: number; to: number } | { line: number };

function verticalProfile(c: Cursor, steps: ProfileStep[], kind: SectionKind = 'track', param?: number): ElementNode[] {
  const fr = frame(c);
  let x = 0;
  let y = 0;
  let pitch = fr.pitch;
  const nodes: ElementNode[] = [];
  const push = () => nodes.push({ p: toWorld(c, fr, x, y, 0), dir: dirWorld(fr, Math.cos(pitch), Math.sin(pitch), 0), bank: c.bank, kind, param });
  for (const st of steps) {
    if ('line' in st) {
      x += Math.cos(pitch) * st.line;
      y += Math.sin(pitch) * st.line;
      push();
    } else {
      const target = st.to * DEG;
      const sub = Math.max(1, Math.ceil(Math.abs(target - pitch) / (25 * DEG)));
      const start = pitch;
      for (let k = 1; k <= sub; k++) {
        const a0 = start + ((target - start) * (k - 1)) / sub;
        const a1 = start + ((target - start) * k) / sub;
        const sgn = Math.sign(a1 - a0);
        // Arc of radius R turning in the vertical plane: chord integration.
        x += sgn * st.arc * (Math.sin(a1) - Math.sin(a0));
        y += -sgn * st.arc * (Math.cos(a1) - Math.cos(a0));
        pitch = a1;
        push();
      }
    }
  }
  return nodes;
}

/** Chain lift: transition up, straight climb, crest. */
export function liftHill(c: Cursor, height: number, angleDeg = 32, speed = 3.4): ElementResult {
  const a = angleDeg * DEG;
  const Rb = 14;
  const Rc = 10;
  const used = Rb * (1 - Math.cos(a)) + Rc * (1 - Math.cos(a));
  const line = Math.max(1, (height - used) / Math.sin(a));
  const nodes = verticalProfile(c, [{ arc: Rb, to: angleDeg }, { line }, { arc: Rc, to: 0 }], 'lift', speed);
  // The crest beyond the last chain node is free-running track.
  nodes.push({ ...nodes[nodes.length - 1]!, p: toWorld(c, frame(c), 0, 0, 0) });
  const crest = nodes[nodes.length - 2]!;
  const fr = frame({ p: crest.p, dir: crest.dir, bank: c.bank });
  nodes[nodes.length - 1] = { p: toWorld({ p: crest.p, dir: crest.dir, bank: c.bank }, fr, 3, 0, 0), dir: [...crest.dir] as V3, bank: c.bank, kind: 'track' };
  crest.kind = 'track';
  return { startKind: 'lift', startParam: speed, nodes };
}

/** Steep drop with a crest transition, straight fall and a generous pull-out. */
export function drop(c: Cursor, depth: number, angleDeg = 50, pullOut = 17): ElementResult {
  const a = angleDeg * DEG;
  const Rc = 9;
  let Rp = pullOut;
  let used = Rc * (1 - Math.cos(a)) + Rp * (1 - Math.cos(a));
  if (used > depth * 0.9) {
    Rp = Math.max(6, (depth * 0.9) / (1 - Math.cos(a)) - Rc);
    used = Rc * (1 - Math.cos(a)) + Rp * (1 - Math.cos(a));
  }
  const line = Math.max(0.5, (depth - used) / Math.sin(a));
  const nodes = verticalProfile(c, [{ arc: Rc, to: -angleDeg }, { line }, { arc: Rp, to: 0 }]);
  return { startKind: 'track', nodes };
}

/**
 * Camelback / airtime hill with a sin² profile: zero slope at both ends and a gentle crest.
 * Crest curvature is 2π²H/L², so longer hills give floater airtime, shorter ones ejector airtime.
 */
export function hill(c: Cursor, height: number, length: number): ElementResult {
  const fr = frame(c);
  const nodes: ElementNode[] = [];
  const count = 6;
  for (let k = 1; k <= count; k++) {
    const u = k / count;
    const y = height * Math.sin(Math.PI * u) ** 2;
    const dy = (height * Math.PI * Math.sin(2 * Math.PI * u)) / length;
    nodes.push({ p: toWorld(c, fr, length * u, y, 0), dir: dirWorld(fr, 1, dy, 0), bank: c.bank });
  }
  return { startKind: 'track', nodes };
}

/**
 * Teardrop vertical loop. Curvature grows towards the top (clothoid-like), which keeps
 * vertical G-forces more even than a circle. Exits offset to the right to clear the entry.
 */
export function verticalLoop(c: Cursor, height: number, lateral = 3.6): ElementResult {
  const fr = frame(c);
  // Integrate a curve whose direction angle φ goes 0 → 2π with κ(φ) = k0 + (k1 − k0)·sin²(φ/2).
  const k0 = 1;
  const k1 = 2.6;
  const steps = 720;
  const pts: Array<[number, number, number]> = [[0, 0, 0]];
  let x = 0;
  let y = 0;
  for (let i = 0; i < steps; i++) {
    const phi = ((i + 0.5) / steps) * 2 * Math.PI;
    const kappa = k0 + (k1 - k0) * Math.sin(phi / 2) ** 2;
    const ds = (2 * Math.PI) / steps / kappa;
    x += Math.cos(phi) * ds;
    y += Math.sin(phi) * ds;
    pts.push([x, y, ((i + 1) / steps) * 2 * Math.PI]);
  }
  const maxY = Math.max(...pts.map((p) => p[1]));
  const sc = height / maxY;
  const endX = pts[pts.length - 1]![0] * sc;
  const nodes: ElementNode[] = [];
  const count = 10;
  for (let k = 1; k <= count; k++) {
    const idx = Math.round((k / count) * steps);
    const [px, py, phi] = pts[idx]!;
    const u = k / count;
    const zs = lateral * (u * u * (3 - 2 * u));
    const dzs = (lateral * 6 * u * (1 - u)) / (2 * Math.PI * 10); // small lateral drift in direction
    nodes.push({ p: toWorld(c, fr, px * sc, py * sc, zs), dir: dirWorld(fr, Math.cos(phi), Math.sin(phi), dzs), bank: c.bank });
  }
  // Short run-out so the following piece starts level.
  nodes.push({ p: toWorld(c, fr, endX + 8, 0, lateral), dir: dirWorld(fr, 1, 0, 0), bank: c.bank });
  return { startKind: 'track', nodes };
}

/**
 * Heartline roll: the rider's heartline follows a smooth path while the track rolls 360°
 * around it. Used for corkscrews (large offset) and zero-G rolls (small offset + hump).
 */
export function heartlineRoll(
  c: Cursor,
  length: number,
  offset: number,
  hump: number,
  direction: 1 | -1 = 1,
  rollAngle = 2 * Math.PI,
  lateralShift = 0,
  startInverted = false,
): ElementResult {
  const inv = startInverted ? -1 : 1;
  const fr = frame(c);
  const nodes: ElementNode[] = [];
  const count = Math.max(6, Math.ceil((Math.abs(rollAngle) / (2 * Math.PI)) * 10));
  const pos = v3();
  const prev = v3();
  const U = v3();
  const eps = 1e-3;
  const at = (u: number, out: V3): number => {
    const sm = u * u * u * (u * (u * 6 - 15) + 10); // smootherstep
    const phi = direction * rollAngle * sm;
    const hx = length * u;
    const hy = inv * offset + hump * Math.sin(Math.PI * u) ** 2;
    const hz = lateralShift * (u * u * (3 - 2 * u));
    // Up vector rotated about forward axis by phi: U = Y cos φ + R sin φ
    set(U, 0, inv * Math.cos(phi), inv * Math.sin(phi));
    // Track centre sits `offset` below the heartline along U.
    const tx = hx;
    const ty = hy - offset * U[1];
    const tz = hz - offset * U[2];
    const w = toWorld(c, fr, tx, ty, tz);
    set(out, w[0], w[1], w[2]);
    return phi;
  };
  for (let k = 1; k <= count; k++) {
    const u = k / count;
    const phi = at(u, pos);
    at(Math.max(0, u - eps), prev);
    const nxt = v3();
    at(Math.min(1, u + eps), nxt);
    const d = normalize(v3(), add(v3(), scale(v3(), nxt, 1), scale(v3(), prev, -1)));
    nodes.push({ p: [pos[0], pos[1], pos[2]], dir: d, bank: c.bank + phi });
  }
  return { startKind: 'track', nodes };
}

export function corkscrew(c: Cursor, length = 22, radius = 3.4, direction: 1 | -1 = 1): ElementResult {
  return heartlineRoll(c, length, radius, 0, direction, 2 * Math.PI, direction * 1.5);
}

export function zeroGRoll(c: Cursor, length = 26, height = 7, direction: 1 | -1 = 1): ElementResult {
  return heartlineRoll(c, length, 1.2, height, direction);
}

/**
 * Immelmann-style half loop up followed by a half roll out (exit heading reversed).
 * With `reverse` it becomes a dive loop: half roll in, then half loop down.
 */
export function halfLoopRoll(c: Cursor, height: number, reverse = false, direction: 1 | -1 = 1): ElementResult {
  const fr = frame(c);
  const nodes: ElementNode[] = [];
  if (!reverse) {
    // Half loop: φ from 0 to π, radius grows tighter towards the top.
    const R = height / 2;
    const count = 6;
    for (let k = 1; k <= count; k++) {
      const phi = (k / count) * Math.PI;
      const x = R * Math.sin(phi) * 1.05;
      const y = R * (1 - Math.cos(phi));
      nodes.push({ p: toWorld(c, fr, x, y, 0), dir: dirWorld(fr, Math.cos(phi) * 1.05, Math.sin(phi), 0), bank: c.bank });
    }
    const top = nodes[nodes.length - 1]!;
    const cur: Cursor = { p: top.p, dir: top.dir, bank: top.bank };
    const roll = heartlineRoll(cur, 18, 1.2, 0, direction, Math.PI, 0, true);
    // Frame at the top is inverted relative to the start; the half roll returns it upright.
    nodes.push(...roll.nodes);
    // Run out (descend slightly).
    const last = nodes[nodes.length - 1]!;
    const run = piece({ p: last.p, dir: last.dir, bank: last.bank }, { length: 10, turn: 0, rise: -2, bank: (last.bank * 180) / Math.PI });
    nodes.push(...run.nodes);
  } else {
    const roll = heartlineRoll(c, 18, 1.2, 1.5, direction, Math.PI, 0);
    nodes.push(...roll.nodes);
    const top = nodes[nodes.length - 1]!;
    const tc: Cursor = { p: top.p, dir: top.dir, bank: top.bank };
    const fr2 = frame(tc);
    const R = height / 2;
    const count = 6;
    for (let k = 1; k <= count; k++) {
      const phi = (k / count) * Math.PI;
      // Downward half loop: dives forward and comes back underneath, heading reversed.
      const x = R * Math.sin(phi) * 1.05;
      const y = -R * (1 - Math.cos(phi));
      nodes.push({ p: toWorld(tc, fr2, x, y, 0), dir: dirWorld(fr2, Math.cos(phi) * 1.05, -Math.sin(phi), 0), bank: tc.bank });
    }
  }
  return { startKind: 'track', nodes };
}

export function straight(c: Cursor, length: number, kind: SectionKind = 'track', param?: number): ElementResult {
  return piece(c, { length, turn: 0, rise: 0, bank: c.bank / DEG, kind, param });
}

/** Recommended bank angle (degrees, signed) for a turn of radius R at speed v so riders feel no lateral force. */
export function autoBank(turnDeg: number, radius: number, speed: number): number {
  const ang = Math.atan2(speed * speed, 9.80665 * Math.max(radius, 1)) / DEG;
  return -Math.sign(turnDeg) * Math.min(ang, 80);
}
