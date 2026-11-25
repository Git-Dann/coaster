import type { V3 } from '../../engine/core/vec3';
import { BakedTrack } from '../../engine/track/bake';
import { appendElement, cloneDesign, liftAboveGround, removeLastPiece, uprightBankAtEnd } from '../../engine/track/design-ops';
import type { TrackDesign, TrackNode } from '../../engine/track/types';
import { SECTION_KINDS } from '../../engine/track/types';

const KIND_LIFT = SECTION_KINDS.indexOf('lift');
const KIND_LAUNCH = SECTION_KINDS.indexOf('launch');
const KIND_BRAKE = SECTION_KINDS.indexOf('brake');
const KIND_STATION = SECTION_KINDS.indexOf('station');
import { MIN_VERTICAL, PLAN_RADIUS, findClashes, separateCrossings } from '../../engine/track/clearance';
import { LEVEL, TILE, gridFrame, gridTarget, onGrid, pathTo, snapLevel, type GridFrame } from '../../engine/track/grid';
import { estimateSpeedAtEnd, presetById, type PresetId } from './builder';

/**
 * Tap-to-add building. Each kid-friendly piece maps onto a builder preset with friendly defaults.
 * The newest piece stays adjustable until another piece is added; adjustments replace it in place
 * (one undo step for "add + adjust"). The automatic return keeps the circuit closed at all times.
 */
export type PieceId = 'straight' | 'left' | 'right' | 'up' | 'down' | 'hill' | 'lift' | 'drop' | 'loop' | 'roll' | 'corkscrew' | 'helix' | 'brakes' | 'launch';

export interface KidPiece {
  id: PieceId;
  label: string;
  icon: string;
  preset: PresetId;
  params: Record<string, number>;
  /** Which parameter the height lever controls (if any). */
  heightKey?: string;
  /** Which parameter "longer/shorter" scales. */
  sizeKey?: string;
}

export const PIECES: KidPiece[] = [
  { id: 'straight', label: 'Straight', icon: 'p-straight', preset: 'track', params: { length: 20, turn: 0, rise: 0, bank: 0 }, heightKey: 'rise', sizeKey: 'length' },
  { id: 'left', label: 'Left', icon: 'p-left', preset: 'track', params: { length: 28, turn: 90, rise: 0, bank: 0 }, heightKey: 'rise', sizeKey: 'length' },
  { id: 'right', label: 'Right', icon: 'p-right', preset: 'track', params: { length: 28, turn: -90, rise: 0, bank: 0 }, heightKey: 'rise', sizeKey: 'length' },
  { id: 'up', label: 'Up', icon: 'p-up', preset: 'track', params: { length: 26, turn: 0, rise: 7, bank: 0 }, heightKey: 'rise', sizeKey: 'length' },
  { id: 'down', label: 'Down', icon: 'p-down', preset: 'track', params: { length: 26, turn: 0, rise: -7, bank: 0 }, heightKey: 'rise', sizeKey: 'length' },
  { id: 'hill', label: 'Hill', icon: 'p-hill', preset: 'hill', params: { height: 7, length: 44 }, heightKey: 'height', sizeKey: 'length' },
  { id: 'lift', label: 'Lift', icon: 'p-lift', preset: 'lift', params: { height: 18, angle: 32, speed: 3.4 }, heightKey: 'height' },
  { id: 'drop', label: 'Drop', icon: 'p-drop', preset: 'drop', params: { depth: 15, angle: 50 }, heightKey: 'depth' },
  { id: 'loop', label: 'Loop', icon: 'p-loop', preset: 'loop', params: { height: 16 }, heightKey: 'height' },
  { id: 'roll', label: 'Roll', icon: 'p-roll', preset: 'zerog', params: { length: 28, height: 6, direction: 1 }, heightKey: 'height', sizeKey: 'length' },
  { id: 'corkscrew', label: 'Corkscrew', icon: 'p-cork', preset: 'corkscrew', params: { length: 22, direction: 1 }, sizeKey: 'length' },
  { id: 'helix', label: 'Spiral', icon: 'p-helix', preset: 'helix', params: { turns: 1, radius: 15, rise: -4 }, heightKey: 'rise', sizeKey: 'radius' },
  { id: 'brakes', label: 'Brakes', icon: 'p-brake', preset: 'brake', params: { length: 16, speed: 4 }, sizeKey: 'length' },
  { id: 'launch', label: 'Launch', icon: 'p-launch', preset: 'launch', params: { length: 28, speed: 20 }, sizeKey: 'length' },
];

export const pieceById = (id: PieceId) => PIECES.find((p) => p.id === id)!;

export interface ActivePiece {
  piece: PieceId;
  group: string;
  /** Index of the first node belonging to the piece. */
  start: number;
  params: Record<string, number>;
}

let serial = 0;
const newGroup = () => `g${Date.now().toString(36)}${(serial++).toString(36)}`;

/** Build `design` + piece from the node before `start`. Never alters nodes before the piece. */
/** Chain speed on climbing pieces (m/s), the same as a standard lift hill. */
const CHAIN_SPEED = 3.4;

/** Steepest gentle climb or descent for plain track pieces (about 19° on average, under 30° at the steepest point): taller rises get longer. */
const MAX_GRADE = 0.35;

/** Lowest point of the track from node `from` onwards, measured above the ground. */
function minClearance(d: TrackDesign, from: number, ground: (x: number, z: number) => number): number {
  const part: TrackDesign = { ...d, closed: false, nodes: d.nodes.slice(Math.max(0, from)) };
  if (part.nodes.length < 2) return Infinity;
  const t = new BakedTrack(part, 0.5);
  let min = Infinity;
  for (let i = 0; i < t.count; i += 2) min = Math.min(min, t.pos[i * 3 + 1]! - ground(t.pos[i * 3]!, t.pos[i * 3 + 2]!));
  return min;
}

/**
 * Build the piece, and if any part of it would dip into the ground, make it descend less until it
 * fits. The adjusted value is reported back so the controls show the real shape.
 */
function generate(base: TrackDesign, piece: KidPiece, rawParams: Record<string, number>, group: string, ground: (x: number, z: number) => number): { design: TrackDesign; params: Record<string, number> } {
  const params = { ...rawParams };
  // Start from how much height there actually is to come down (to the lowest ground ahead).
  const start = base.nodes[base.nodes.length - 1]!;
  const hd = Math.atan2(-start.dir[2], start.dir[0]);
  let low = ground(start.p[0], start.p[2]);
  for (let d = 10; d <= 60; d += 10) low = Math.max(low, ground(start.p[0] + Math.cos(hd) * d, start.p[2] - Math.sin(hd) * d));
  const avail = start.p[1] - low - 1.4;
  if (piece.id === 'drop') {
    const range = paramRange('drop', 'depth');
    params.depth = Math.min(params.depth ?? 15, Math.max(range?.min ?? 4, avail));
  } else if ((params.rise ?? 0) < 0) params.rise = Math.max(params.rise!, -Math.max(0, avail));
  let res = generateCore(base, piece, params, group, ground);
  for (const k of ['depth', 'rise']) if (params[k] !== undefined && rawParams[k] !== params[k]) res.params[k] = Math.round(params[k]! * 2) / 2;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (minClearance(res.design, base.nodes.length - 1, ground) >= 0.9) break;
    const key = piece.id === 'drop' ? 'depth' : (params.rise ?? 0) < 0 ? 'rise' : null;
    if (!key) break;
    const range = paramRange(piece.id, key);
    const v = params[key]! * 0.75;
    params[key] = key === 'depth' && range ? Math.max(range.min, v) : v;
    res = generateCore(base, piece, params, group, ground);
    res.params[key] = Math.round(params[key]! * 2) / 2;
  }
  // Still too low (a drop that starts at ground level): climb a little first, as part of the piece.
  const clr = minClearance(res.design, base.nodes.length - 1, ground);
  if (clr < 0.9 && COMPLEX.has(piece.id)) {
    const rise = 0.9 - clr + 0.6;
    const last = base.nodes[base.nodes.length - 1]!;
    const ramp = presetById('track').make({ p: [...last.p] as V3, dir: [...last.dir] as V3, bank: last.bank }, { length: Math.max(18, rise / MAX_GRADE), turn: 0, rise, bank: 0 }, { uprightBank: last.bank, speedAtEnd: 10, autoBank: false });
    const raised = appendElement({ ...cloneDesign(base), closed: false }, ramp, group);
    const res2 = generateCore(raised, piece, params, group, ground);
    if (minClearance(res2.design, base.nodes.length - 1, ground) > clr) res = res2;
  }
  return res;
}

function generateCore(base: TrackDesign, piece: KidPiece, rawParams: Record<string, number>, group: string, ground: (x: number, z: number) => number): { design: TrackDesign; params: Record<string, number> } {
  const params = { ...rawParams };
  const shown = { ...rawParams };
  if (piece.preset === 'track') {
    // Going down can never go below the ground: limit the drop to what fits, and report it back
    // so the lever shows where the track really is.
    const start = base.nodes[base.nodes.length - 1]!;
    const run = Math.max(params.length ?? 20, Math.abs(params.rise ?? 0) / MAX_GRADE);
    const h = Math.atan2(-start.dir[2], start.dir[0]);
    const ex = start.p[0] + Math.cos(h) * run;
    const ez = start.p[2] - Math.sin(h) * run;
    const floor = Math.max(ground(ex, ez), ground(start.p[0], start.p[2])) + 1.4 - start.p[1];
    if ((params.rise ?? 0) < floor) params.rise = shown.rise = Math.min(0, Math.round(floor * 2) / 2);
    // Steep requests become longer, gentler ramps instead of spikes.
    params.length = Math.max(params.length ?? 20, Math.abs(params.rise ?? 0) / MAX_GRADE);
  }
  if (piece.id === 'helix') {
    // Each full turn must clear the one below it.
    const turns = Math.abs(params.turns ?? 1);
    const need = (MIN_VERTICAL + 0.6) * Math.max(1, turns);
    const rise = params.rise ?? -need;
    if (Math.abs(rise) < need) params.rise = (rise > 0 ? 1 : -1) * need;
  }
  const d = cloneDesign(base);
  d.closed = false;
  const last = d.nodes[d.nodes.length - 1]!;
  const baked = d.nodes.length >= 2 ? new BakedTrack(d, 0.5) : null;
  const preset = presetById(piece.preset);
  const ctx = { uprightBank: baked ? uprightBankAtEnd(d, baked) : last.bank, speedAtEnd: estimateSpeedAtEnd(d, baked), autoBank: true };
  const res = preset.make({ p: [...last.p] as V3, dir: [...last.dir] as V3, bank: last.bank }, { ...preset.defaults, ...params }, ctx);
  // The node the piece leaves from keeps its own kind if it is the station end; otherwise follow the piece.
  const next = appendElement(d, res, group);
  if (last.group === 'station' && base.nodes.length === 2) next.nodes[base.nodes.length - 1]!.kind = res.startKind;
  liftAboveGround(next, base.nodes.length, ground);
  // New track never passes through existing track.
  if (!COMPLEX.has(piece.id)) {
    // Simple track is smoothly lifted over (or dropped under) crossings.
    separateCrossings(next, base.nodes.length, ground);
    return { design: next, params: shown };
  }
  // Loops, rolls, spirals and the like are never bent: if one would clash, a gentle ramp in front
  // of it raises the whole element clear, keeping its shape exact (ramp and element are one piece).
  let result = next;
  let extra = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { conflicts } = findClashes(result, base.nodes.length, ground);
    if (conflicts.length === 0) return { design: result, params: shown };
    extra += Math.max(MIN_VERTICAL + 0.5, ...conflicts.map((c) => Math.abs(c.lift))) + 0.5;
    const rise = Math.min(30, extra);
    const ramp = presetById('track').make(
      { p: [...last.p] as V3, dir: [...last.dir] as V3, bank: last.bank },
      { length: Math.max(18, rise * 4), turn: 0, rise, bank: 0 },
      ctx,
    );
    const withRamp = appendElement(d, ramp, group);
    const rl = withRamp.nodes[withRamp.nodes.length - 1]!;
    const res2 = preset.make({ p: [...rl.p] as V3, dir: [...rl.dir] as V3, bank: rl.bank }, { ...preset.defaults, ...params }, ctx);
    result = liftAboveGround(appendElement(withRamp, res2, group), base.nodes.length, ground);
  }
  // Last resort: smooth only the simple parts.
  separateCrossings(result, base.nodes.length, ground);
  return { design: result, params: shown };
}

/** Elements whose shape must never be bent to clear other track. */
const COMPLEX: ReadonlySet<PieceId> = new Set(['loop', 'roll', 'corkscrew', 'helix', 'lift', 'drop']);

/** Open a closed (legacy) circuit so pieces can be added; the auto-return reconnects it. */
export function opened(d: TrackDesign): TrackDesign {
  return d.closed ? { ...cloneDesign(d), closed: false } : d;
}

export function addPiece(design: TrackDesign, id: PieceId, ground: (x: number, z: number) => number, params?: Record<string, number>): { design: TrackDesign; active: ActivePiece } {
  const base = opened(design);
  const piece = pieceById(id);
  const group = newGroup();
  const next = generate(base, piece, { ...piece.params, ...params }, group, ground);
  return { design: next.design, active: { piece: id, group, start: base.nodes.length, params: next.params } };
}

// ------------------------------------------------------------------ edit mode (construction)

export type Turn = -1 | 0 | 1;
export type Slope = -1 | 0 | 1;
/** What the next piece will be: plain track (direction + slope) or a special element. */
export type BuildChoice = { kind: 'track'; turn: Turn; slope: Slope } | { kind: 'special'; id: PieceId };

export const DEFAULT_CHOICE: BuildChoice = { kind: 'track', turn: 0, slope: 0 };
/** Special elements offered in edit mode (plain track comes from direction + slope). */
export const SPECIALS: PieceId[] = ['hill', 'lift', 'drop', 'loop', 'roll', 'corkscrew', 'helix', 'brakes', 'launch'];

export interface NextPiece {
  design: TrackDesign;
  /** Index of the first node of the new piece. */
  start: number;
  /** End of the new piece above the ground, metres. */
  height: number;
  /** A downward piece that couldn't go down because the track is already at the ground. */
  atGround: boolean;
  /** Committed track passing above or below the new piece, if any (clear gap in metres). */
  crossing: { above: boolean; gap: number } | null;
  /** Why this piece can't be built smoothly here (null when it can). Nothing rough is ever built. */
  blocked: string | null;
}

/**
 * Walk the train's speed along the track from the station, the way the physics will play out:
 * chain lifts pull up to their chain speed, launches push to their launch speed, brakes trim, and
 * otherwise gravity, rolling resistance and air drag act (slightly pessimistic, so a "yes" holds
 * in the real simulation). Returns where the train would run out of speed, if anywhere, and the
 * lowest speed reached from `fromS` on.
 */
export function energyWalk(t: BakedTrack, roughness = 1, fromS = 0, v0 = 2): { stallS: number | null; minV: number; minVInverted: number; vEnd: number } {
  const g = 9.81;
  const mu = 0.0045 * roughness * 1.4;
  const k = 0.0009; // drag per metre (½ρ·CdA/m), rounded up
  let v = v0; // the station tyres send the train off at about 2 m/s
  let minV = Infinity;
  let minVInverted = Infinity;
  const step = 2;
  for (let i = step; i < t.count; i += step) {
    const s = i * t.ds;
    const ds = step * t.ds;
    const dy = t.pos[i * 3 + 1]! - t.pos[(i - step) * 3 + 1]!;
    const kind = t.kind[i]!;
    const param = t.param[i]!;
    const curv = Math.hypot(t.curv[i * 3]!, t.curv[i * 3 + 1]!, t.curv[i * 3 + 2]!);
    const v2 = v * v - 2 * g * dy - 2 * (mu * g * (1 + (curv * v * v) / g) + k * v * v) * ds;
    v = Math.sqrt(Math.max(0, v2));
    if (kind === KIND_LIFT) v = Math.max(v, param || 3.4);
    else if (kind === KIND_LAUNCH) v = Math.max(v, param || 18);
    else if (kind === KIND_BRAKE && param > 0) v = Math.min(v, Math.max(param, 1.5));
    else if (kind === KIND_STATION) v = Math.max(v, 1.5);
    if (s >= fromS) {
      minV = Math.min(minV, v);
      if (t.up[i * 3 + 1]! < 0.2) minVInverted = Math.min(minVInverted, v);
    }
    if (v < 0.6) return { stallS: s, minV: Math.min(minV, v), minVInverted, vEnd: 0 };
  }
  return { stallS: null, minV, minVInverted, vEnd: v };
}

/** How many up-and-down bumps each kind of piece naturally has (plain track: one gentle ramp). */
const NATURAL_BUMPS: Partial<Record<PieceId, number>> = { hill: 2, loop: 2, roll: 2, corkscrew: 2, lift: 1, drop: 1, helix: 1 };
/** Tightest natural curvature (1/m) of each element; plain track and joins stay far gentler. */
const MAX_CURVATURE: Partial<Record<PieceId, number>> = { loop: 0.3, roll: 0.3, corkscrew: 0.34, hill: 0.22, lift: 0.14, drop: 0.21, helix: 0.13 };
/** Fastest natural change in curvature (1/m per m) of each element; plain track eases in and out of its turns. */
const MAX_CURVATURE_RATE: Partial<Record<PieceId, number>> = { loop: 0.35, roll: 0.3, corkscrew: 0.48, drop: 0.28, hill: 0.2 };

/**
 * Smoothness check for a planned piece (and the join into it): no wobbles (more vertical bumps than
 * the piece naturally has), no kinks (curvature tighter than the element needs) and no sudden
 * changes in curvature.
 */
export function roughness(design: TrackDesign, start: number, choice: BuildChoice): string | null {
  const part = new BakedTrack({ ...design, closed: false, nodes: design.nodes.slice(Math.max(0, start - 1)) }, 0.25);
  const id = choice.kind === 'special' ? choice.id : null;
  const maxK = (id && MAX_CURVATURE[id]) ?? 0.14;
  const maxDk = (id && MAX_CURVATURE_RATE[id]) ?? 0.2;
  let k = 0;
  let dk = 0;
  for (let i = 4; i < part.count - 4; i++) {
    const c = part.curv;
    k = Math.max(k, Math.hypot(c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!));
    // Change of the curvature vector (size and direction) per metre: catches wobbles and kinks.
    const a = (i - 2) * 3;
    const b = (i + 2) * 3;
    dk = Math.max(dk, Math.hypot(c[b]! - c[a]!, c[b + 1]! - c[a + 1]!, c[b + 2]! - c[a + 2]!) / (4 * part.ds));
  }
  // Count height turning points with some prominence (ignoring sub-50 cm ripples).
  let bumps = 0;
  let dir = 0;
  let pivot = part.pos[1]!;
  for (let i = 1; i < part.count; i++) {
    const y = part.pos[i * 3 + 1]!;
    if (dir >= 0 && y < pivot - 0.5) {
      if (dir > 0) bumps++;
      dir = -1;
      pivot = y;
    } else if (dir <= 0 && y > pivot + 0.5) {
      if (dir < 0) bumps++;
      dir = 1;
      pivot = y;
    } else if ((dir > 0 && y > pivot) || (dir < 0 && y < pivot)) pivot = y;
  }
  // Plain track is one smooth rise, fall or level run: no bumps at all. Elements keep their natural
  // shape plus a little allowance for the join.
  const allowed = id ? (NATURAL_BUMPS[id] ?? 1) + 1 : 0;
  if (bumps > allowed || dk > maxDk * 1.15 || k > maxK * 1.15) return 'Too close to other track to fit smoothly here. Try another direction, or go up or down first';
  return null;
}

// ------------------------------------------------------------------ fast planning (edit mode)

/**
 * Everything about the existing track that every option needs, worked out once per design (not
 * once per option): expected speed, the train's speed arriving at the end, and a spatial index
 * of the track (plus the fixed station approach) for clash checks.
 */
interface BaseInfo {
  speed: number;
  vEnd: number;
  stalled: boolean;
  /** Sample positions (x, y, z) every metre, and whether each is far enough back to count for clashes. */
  pts: Float64Array;
  far: Uint8Array;
  cells: Map<string, number[]>;
}
const baseCache = new WeakMap<TrackDesign, BaseInfo>();
const CELL = 4;
const cellKey = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

function baseInfo(base: TrackDesign): BaseInfo {
  const hit = baseCache.get(base);
  if (hit) return hit;
  const pts: number[] = [];
  const far: number[] = [];
  let speed = 8;
  let vEnd = 2;
  let stalled = false;
  if (base.nodes.length >= 2) {
    const t = new BakedTrack({ ...base, closed: false }, 0.5);
    speed = estimateSpeedAtEnd(base, t);
    const e = energyWalk(t, base.style === 'wood' ? 1.55 : base.style === 'mine' ? 1.3 : 1);
    vEnd = e.vEnd;
    stalled = e.stallS !== null;
    // Track within 30 m (along the circuit) of the end is where new track joins: not a clash.
    for (let i = 0; i < t.count; i += 2) {
      pts.push(t.pos[i * 3]!, t.pos[i * 3 + 1]!, t.pos[i * 3 + 2]!);
      far.push(i * t.ds < t.length - 30 ? 1 : 0);
    }
  }
  // The automatic return always arrives along a straight brake run into the station.
  const f = base.nodes[0]!;
  for (let m = 1; m <= 40; m++) {
    pts.push(f.p[0] - f.dir[0] * m, f.p[1], f.p[2] - f.dir[2] * m);
    far.push(1);
  }
  const cells = new Map<string, number[]>();
  for (let i = 0; i < pts.length / 3; i++) {
    const k = cellKey(pts[i * 3]!, pts[i * 3 + 2]!);
    let l = cells.get(k);
    if (!l) cells.set(k, (l = []));
    l.push(i);
  }
  const info = { speed, vEnd, stalled, pts: Float64Array.from(pts), far: Uint8Array.from(far), cells };
  baseCache.set(base, info);
  return info;
}

/** Does the new piece (baked on its own) come within the clash rule of existing track, or of itself? */
function fastConflicts(info: BaseInfo, part: BakedTrack): boolean {
  const R = PLAN_RADIUS + 0.7;
  for (let i = 0; i < part.count; i += 2) {
    const x = part.pos[i * 3]!;
    const y = part.pos[i * 3 + 1]!;
    const z = part.pos[i * 3 + 2]!;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let gx = -1; gx <= 1; gx++)
      for (let gz = -1; gz <= 1; gz++) {
        const l = info.cells.get(`${cx + gx},${cz + gz}`);
        if (!l) continue;
        for (const j of l) {
          if (!info.far[j]) continue;
          const dx = info.pts[j * 3]! - x;
          const dz = info.pts[j * 3 + 2]! - z;
          if (dx * dx + dz * dz > R * R) continue;
          if (Math.abs(info.pts[j * 3 + 1]! - y) < MIN_VERTICAL) return true;
        }
      }
    // The piece against itself (a spiral over its own turn), more than 30 m apart along it.
    for (let j = i + Math.ceil(30 / part.ds); j < part.count; j += 2) {
      const dx = part.pos[j * 3]! - x;
      const dz = part.pos[j * 3 + 2]! - z;
      if (dx * dx + dz * dz > R * R) continue;
      if (Math.abs(part.pos[j * 3 + 1]! - y) < MIN_VERTICAL) return true;
    }
  }
  return false;
}

const planMemo = new WeakMap<TrackDesign, Map<string, NextPiece>>();

/**
 * Plan the next piece for the current choice without committing anything: the edit-mode ghost.
 * Committing is just using `design` as the new design (one undo step).
 */
export function planNext(design: TrackDesign, choice: BuildChoice, ground: (x: number, z: number) => number, committed?: BakedTrack | null): NextPiece {
  // Plans are pure for a given design and choice: reuse them (the panel asks for the same ones often).
  let memo = planMemo.get(design);
  if (!memo) planMemo.set(design, (memo = new Map()));
  const key = `${JSON.stringify(choice)}|${committed ? committed.length.toFixed(2) : '-'}`;
  const cached = memo.get(key);
  if (cached) return cached;
  const result = planNextUncached(design, choice, ground, committed);
  memo.set(key, result);
  return result;
}

/**
 * Where one plain piece meets the next, give the shared node the slope that runs smoothly through
 * both (like a spline through the heights either side), instead of always levelling off. A chain of
 * climbs or descents is then one steady slope, not a staircase of crests and dips. The station
 * stays level.
 */
function smoothJoinPitch(d: TrackDesign, j: number): void {
  const prev = d.nodes[j - 1];
  const join = d.nodes[j];
  const next = d.nodes[j + 1];
  if (!prev || !join || !next) return;
  // Never the station (it stays level). The end of a special piece takes the slope only when the
  // stretch into it is a plain lead-out (unbanked, nearly straight): an element's own exit keeps
  // its shape.
  if (join.group === 'station' || prev.group === 'station') return;
  if (join.kind !== 'track' && join.kind !== 'lift') return;
  const plain = decodeChoice(join.group ?? '')?.kind === 'track';
  if (!plain) {
    const wrapped = (b: number) => Math.abs(b - Math.round(b / (2 * Math.PI)) * 2 * Math.PI);
    const turn = Math.abs(Math.atan2(-prev.dir[2], prev.dir[0]) - Math.atan2(-join.dir[2], join.dir[0]));
    const level = Math.abs(prev.dir[1]) < 0.35;
    if (wrapped(join.bank) > 0.05 || wrapped(prev.bank) > 0.05 || Math.min(turn, 2 * Math.PI - turn) > 0.2 || !level) return;
  }
  const runIn = Math.hypot(join.p[0] - prev.p[0], join.p[2] - prev.p[2]);
  const runOut = Math.hypot(next.p[0] - join.p[0], next.p[2] - join.p[2]);
  // Needs a proper stretch either side to judge the slope from.
  if (runIn < 3 || runOut < 3) return;
  // Monotone rule (no overshoot): keep a slope through the join only when the track carries on the
  // same way on both sides; where a climb meets level track (or a crest or dip) the join is level, so
  // a level piece never rises and falls back.
  const secIn = (join.p[1] - prev.p[1]) / runIn;
  const secOut = (next.p[1] - join.p[1]) / runOut;
  let slope = 0;
  if (secIn * secOut > 1e-6) {
    slope = (secIn * runOut + secOut * runIn) / (runIn + runOut);
    const lim = 3 * Math.min(Math.abs(secIn), Math.abs(secOut));
    if (Math.abs(slope) > lim) slope = Math.sign(slope) * lim;
  }
  const pitch = Math.atan(slope);
  const h = Math.hypot(join.dir[0], join.dir[2]) || 1;
  const fx = join.dir[0] / h;
  const fz = join.dir[2] / h;
  d.nodes[j] = { ...join, dir: [fx * Math.cos(pitch), Math.sin(pitch), fz * Math.cos(pitch)] };
}

/**
 * Grid target for a lead-out (back onto the grid after older track or a special piece): far enough
 * ahead that the height change, plus any slope the track leaves the element with, stays gentle
 * (about a 12% grade). A short, steep lead-out is a dip and a crest in quick succession.
 */
function leadOutTarget(g: GridFrame, t: TrackNode, yFor: (x: number, z: number) => number, radius = 10): { target: ReturnType<typeof gridTarget>; y1: number } {
  const h = Math.atan2(-t.dir[2], t.dir[0]);
  let best = gridTarget(g, { x: t.p[0], z: t.p[2], h }, 2, 0, 0);
  let y1 = yFor(best.x, best.z);
  for (let tiles = 2; tiles <= 8; tiles++) {
    const target = gridTarget(g, { x: t.p[0], z: t.p[2], h }, tiles, 0, 0);
    const y = yFor(target.x, target.z);
    const run = Math.hypot(target.x - t.p[0], target.z - t.p[2]);
    best = target;
    y1 = y;
    // The exit slope carried over this run, and the height still to make up.
    const carried = Math.abs(t.dir[1]) * run * 0.5;
    // A sideways step back onto the grid line is an S of two arcs of this radius: it needs room.
    const fx = Math.cos(h);
    const fz = -Math.sin(h);
    const side = Math.abs((target.x - t.p[0]) * -fz + (target.z - t.p[2]) * fx);
    const sNeeded = side > 0.05 ? 2 * Math.sqrt(side * Math.max(0, 2 * radius - side)) + 4 : 0;
    if (Math.abs(y - t.p[1]) + carried <= 0.12 * run && run >= sNeeded) break;
  }
  return { target: best, y1 };
}

function planNextUncached(design: TrackDesign, choice: BuildChoice, ground: (x: number, z: number) => number, committed?: BakedTrack | null): NextPiece {
  const base = opened(design);
  const info = baseInfo(base);
  const g = gridFrame(base);
  // The group name records what the piece was built as, so it can be changed later in edit mode.
  const group = `${newGroup()}~${encodeChoice(choice)}`;
  const d = cloneDesign(base);
  d.closed = false;
  const start = d.nodes.length;
  const speed = info.speed;
  const headingOf = (dir: readonly number[]) => Math.atan2(-dir[2]!, dir[0]!);
  const floorAt = (x: number, z: number) => ground(x, z) + 1.4;
  const ceilLevel = (y: number) => g.y + Math.ceil((y - g.y) / LEVEL - 1e-6) * LEVEL;
  const push = (nodes: TrackNode[]) => {
    for (const n of nodes) d.nodes.push(n);
  };
  let serialId = 0;
  const prefix = () => `${group}_${serialId++}_`;
  let atGround = false;
  let needsHeight = false;
  // The automatic return always arrives along a straight brake run into the station: treat that
  // approach as existing track, so new track (and elements) keep clear of it.
  const first = d.nodes[0]!;
  const approach: TrackNode = { id: 'approach', p: [first.p[0] - first.dir[0] * 40, first.p[1], first.p[2] - first.dir[2] * 40], dir: [...first.dir] as V3, bank: 0, kind: 'track' };
  // 1. Track that ends off the grid (older coasters, or after a special piece) first joins it.
  const tail = () => d.nodes[d.nodes.length - 1]!;
  if (!onGrid(g, tail().p, tail().dir)) {
    const t = tail();
    const lo = leadOutTarget(g, t, (x, z) => Math.max(snapLevel(g, t.p[1]), ceilLevel(floorAt(x, z))));
    push(pathTo(t, lo.target, { y1: lo.y1, radius: 10, speed }, prefix(), group));
  }
  if (choice.kind === 'track') {
    // 2. Plain track: two tiles straight, or a quarter turn of radius two tiles; 4 m per climb.
    const t = tail();
    const target = gridTarget(g, { x: t.p[0], z: t.p[2], h: headingOf(t.dir) }, 2, choice.turn * 2, choice.turn);
    // Slopes are gentler for a fast train: half the height change, so the crest at the top of a
    // descent (or the dip at the foot of a climb) is half as sharp. At speed a full step would throw
    // riders out of their seats, or press them hard into them.
    const fastHere = !info.stalled && info.vEnd > 11;
    let y1 = snapLevel(g, t.p[1]) + choice.slope * (fastHere ? 1 : 2) * LEVEL;
    const floor = ceilLevel(Math.max(floorAt(target.x, target.z), floorAt((t.p[0] + target.x) / 2, (t.p[2] + target.z) / 2)));
    if (y1 < floor) {
      atGround = choice.slope < 0;
      y1 = floor;
    }
    const climbStart = d.nodes.length - 1;
    // The previous piece may end partway up (or down) a slope. Carry that slope on only when this
    // piece keeps going the same way; otherwise start level, so a level piece never overshoots.
    const dy = y1 - t.p[1];
    if (Math.abs(t.dir[1]) > 1e-3 && (Math.abs(dy) < 0.5 || Math.sign(dy) !== Math.sign(t.dir[1]))) {
      const h = Math.hypot(t.dir[0], t.dir[2]) || 1;
      d.nodes[d.nodes.length - 1] = { ...t, dir: [t.dir[0] / h, 0, t.dir[2] / h] };
    }
    // Banked for the speed the train really arrives with (the speed walk), not a rough estimate.
    const bankSpeed = info.stalled ? speed : Math.max(speed * 0.5, info.vEnd);
    push(pathTo(tail(), target, { y1, radius: choice.turn ? 2 * TILE : 10, speed: bankSpeed }, prefix(), group));
    if (choice.slope > 0 && !atGround) {
      // Climbs carry a chain (like a park builder's chain-lift slopes): the train never stalls on
      // the way up, and you hear the ratchet. The chain only ever pulls a slow train up to speed.
      for (let i = climbStart; i < d.nodes.length - 1; i++) {
        const n = d.nodes[i]!;
        if (n.kind === 'track' || n.kind === 'lift') {
          n.kind = 'lift';
          n.param = CHAIN_SPEED;
        }
      }
    }
  } else if (choice.id === 'drop' && tail().p[1] - ground(tail().p[0], tail().p[2]) < 6) {
    // A drop needs somewhere to drop to: don't force one at ground level.
    needsHeight = true;
  } else {
    // 3. A special element, then a short join back onto the grid. Elements are never bent: if one
    //    would meet other track, a gentle ramp in front raises the whole element clear.
    const piece = pieceById(choice.id);
    const preset = presetById(piece.preset);
    const params: Record<string, number> = { ...preset.defaults, ...piece.params };
    // Inversions are stretched for faster trains, the way real ones are: the forces in a corkscrew or
    // roll grow with the square of speed over length, so a fixed size is gentle when slow and brutal
    // when fast. Sized to the speed the train actually arrives with.
    const arrive = info.stalled ? 3 : info.vEnd;
    if (choice.id === 'corkscrew') params.length = Math.min(52, Math.max(params.length ?? 22, arrive * 2.5));
    if (choice.id === 'roll') params.length = Math.min(50, Math.max(params.length ?? 28, arrive * 1.9));
    if (choice.id === 'drop') {
      // Drop only as far as the ground ahead allows.
      const t = tail();
      const h = headingOf(t.dir);
      let low = ground(t.p[0], t.p[2]);
      for (let m = 10; m <= 60; m += 10) low = Math.max(low, ground(t.p[0] + Math.cos(h) * m, t.p[2] - Math.sin(h) * m));
      params.depth = Math.max(4, Math.min(params.depth ?? 15, t.p[1] - low - 2));
    }
    if (choice.id === 'helix') {
      const need = (MIN_VERTICAL + 0.6) * Math.max(1, Math.abs(params.turns ?? 1));
      if (Math.abs(params.rise ?? 0) < need) params.rise = ((params.rise ?? -1) > 0 ? 1 : -1) * need;
    }
    const before = cloneDesign(d);
    const upright = Math.round(tail().bank / (2 * Math.PI)) * 2 * Math.PI;
    // Elements are shaped (banking, drop curves) for the speed the train really arrives with.
    const arriving = info.stalled ? 3 : Math.max(3, info.vEnd);
    // Corkscrews exit in line on the grid (no sideways S-bend after them).
    const ctx = { uprightBank: upright, speedAtEnd: info.stalled ? speed : arriving, entrySpeed: arriving, autoBank: true, corkscrewShift: 0 };
    const cursorOf = (n: TrackNode) => ({ p: [...n.p] as V3, dir: [...n.dir] as V3, bank: n.bank });
    // How far the element (not its lead-in ramp or lead-out) dips below a safe height over the ground.
    const deficitOf = (x: TrackDesign, from: number, to: number) => {
      const part = new BakedTrack({ ...x, closed: false, nodes: x.nodes.slice(Math.max(0, from - 1), to + 1) }, 1);
      let worst = 0;
      for (let i = 0; i < part.count; i++) worst = Math.max(worst, ground(part.pos[i * 3]!, part.pos[i * 3 + 2]!) + 1.2 - part.pos[i * 3 + 1]!);
      return worst;
    };
    const build = (rise0: number): TrackDesign => {
      let rise = rise0;
      let x = before;
      // Elements are never bent: if one would come too close to the ground, the whole element is
      // raised on a longer, gentle ramp in front (about 11° on average) rather than lifting single
      // points, which would put a kink into it.
      for (let attempt = 0; attempt < 4; attempt++) {
        x = cloneDesign(before);
        if (rise > 0) x = appendElement(x, presetById('track').make(cursorOf(x.nodes[x.nodes.length - 1]!), { length: Math.max(24, rise / 0.2), turn: 0, rise, bank: 0 }, ctx), group);
        const elemStart = x.nodes.length;
        x = appendElement(x, preset.make(cursorOf(x.nodes[x.nodes.length - 1]!), params, ctx), group);
        const lack = deficitOf(x, elemStart, x.nodes.length - 1);
        if (lack <= 0.05) break;
        // A drop that would reach the ground just drops less; anything else is raised whole.
        if (choice.id === 'drop') params.depth = Math.max(3, (params.depth ?? 10) - lack - 0.3);
        else rise += Math.ceil(lack / LEVEL) * LEVEL;
      }
      const joinFrom = x.nodes.length;
      const t = x.nodes[x.nodes.length - 1]!;
      // Sideways bends in the lead-out are sized for the speed (about half a g at most).
      const leadR = Math.min(80, Math.max(10, (arriving * arriving) / (9.81 * 0.5)));
      const lo = leadOutTarget(g, t, (px, pz) => Math.max(snapLevel(g, t.p[1]), ceilLevel(floorAt(px, pz))), leadR);
      for (const n of pathTo(t, lo.target, { y1: lo.y1, radius: leadR, speed }, prefix(), group)) x.nodes.push(n);
      // Only the plain lead-out follows the ground.
      liftAboveGround(x, joinFrom, ground);
      return x;
    };
    let chosen: TrackDesign | null = null;
    for (const rise of [0, 6, 12, 18]) {
      const cand = build(rise);
      chosen ??= cand;
      const partC = new BakedTrack({ ...cand, closed: false, nodes: cand.nodes.slice(Math.max(0, start - 1)) }, 0.5);
      if (!fastConflicts(info, partC)) {
        chosen = cand;
        break;
      }
    }
    d.nodes = chosen!.nodes;
  }
  // Slopes run smoothly through the join and every point inside a plain piece (its end stays as
  // planned until the next piece is added).
  // Points crammed together (a sliver left by a short join back onto the grid) make the curve
  // between them kink: drop any new point that crowds the one before it. The piece's end stays.
  for (let i = d.nodes.length - 2; i >= start; i--) {
    const a = d.nodes[i]!.p;
    const b = d.nodes[i - 1]!.p;
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 2 && !d.nodes[i]!.kind.match(/station/)) d.nodes.splice(i, 1);
  }
  if (d.nodes.length > start + 1) {
    const e = d.nodes[d.nodes.length - 1]!.p;
    const b = d.nodes[d.nodes.length - 2]!.p;
    if (Math.hypot(e[0] - b[0], e[1] - b[1], e[2] - b[2]) < 2 && d.nodes.length - 2 >= start) d.nodes.splice(d.nodes.length - 2, 1);
  }
  // Roll in before a turn and out after it, like a real coaster: the joins either side carry about a
  // third of the turn's banking, so the banking leads the curve instead of lagging behind it (which
  // throws riders sideways at the start of a fast turn).
  if (choice.kind === 'track' && choice.turn !== 0 && d.nodes.length - start >= 2) {
    const join = d.nodes[start - 1]!;
    const wind = Math.round(join.bank / (2 * Math.PI)) * 2 * Math.PI;
    const firstArc = d.nodes[start]!;
    const end = d.nodes[d.nodes.length - 1]!;
    const lastArc = d.nodes[d.nodes.length - 2]!;
    const flat = (b: number) => Math.abs(b - wind) < 0.02;
    if (flat(join.bank) && join.group !== 'station' && (join.kind === 'track' || join.kind === 'lift')) d.nodes[start - 1] = { ...join, bank: wind + 0.33 * (firstArc.bank - wind) };
    if (flat(end.bank)) d.nodes[d.nodes.length - 1] = { ...end, bank: wind + 0.33 * (lastArc.bank - wind) };
  }
  if (choice.kind === 'track') {
    for (let j = start - 1; j < d.nodes.length - 1; j++) smoothJoinPitch(d, j);
    // A slope ends at half its angle rather than levelling off sharply in its last few metres; the
    // next piece (or the automatic return) carries on from there and levels out gently.
    const e = d.nodes.length - 1;
    const end = d.nodes[e]!;
    const before = d.nodes[e - 1];
    if (choice.slope !== 0 && before && end.kind !== 'station') {
      const run = Math.hypot(end.p[0] - before.p[0], end.p[2] - before.p[2]);
      if (run > 1e-3) {
        const pitch = Math.atan((end.p[1] - before.p[1]) / run / 2);
        const h = Math.hypot(end.dir[0], end.dir[2]) || 1;
        d.nodes[e] = { ...end, dir: [(end.dir[0] / h) * Math.cos(pitch), Math.sin(pitch), (end.dir[2] / h) * Math.cos(pitch)] };
      }
    }
  }
  // Plain track follows the ground; special elements were raised whole (never bent) above.
  if (choice.kind === 'track') liftAboveGround(d, start, ground);
  // Never through other track: simple track (including joins) is lifted smoothly over crossings;
  // loops, rolls and other elements are never bent. (The full check only runs when the quick one
  // finds something close.)
  const bakePart = () => new BakedTrack({ ...d, closed: false, nodes: d.nodes.slice(Math.max(0, start - 1)) }, 0.5);
  let part = d.nodes.length > start ? bakePart() : null;
  if (part && fastConflicts(info, part)) {
    separateCrossings({ ...d, nodes: [approach, ...d.nodes] }, start + 1, ground);
    // Lifted points keep the slopes they had before: re-fit them so the ramp doesn't overshoot (and
    // keep whichever version rides more smoothly).
    if (choice.kind === 'track') {
      const kept = d.nodes.slice();
      for (let j = start - 1; j < d.nodes.length - 1; j++) smoothJoinPitch(d, j);
      if (roughness(d, start, choice) && !roughness({ ...d, nodes: kept }, start, choice)) d.nodes = kept;
    }
    part = bakePart();
  }
  const r = { design: d, active: { start } };
  const nodes = d.nodes;
  const end = nodes[nodes.length - 1]!;
  const height = end.p[1] - ground(end.p[0], end.p[2]);
  // Is there committed track above or below the new piece?
  let crossing: NextPiece['crossing'] = null;
  if (committed) {
    const part = new BakedTrack({ ...r.design, closed: false, nodes: nodes.slice(Math.max(0, r.active.start - 1)) }, 1);
    // Ignore where the new piece joins the track (and where the automatic return leaves it).
    const joinS = committed.nodeS[Math.max(0, r.active.start - 1)] ?? 0;
    for (let i = 6; i < part.count; i += 2) {
      const x = part.pos[i * 3]!;
      const y = part.pos[i * 3 + 1]!;
      const z = part.pos[i * 3 + 2]!;
      for (let j = 0; j < committed.count; j += 4) {
        const sj = j * committed.ds;
        // Only the player's own track: the automatic return re-plans itself around new pieces.
        if (sj > joinS - 12) continue;
        const dx = committed.pos[j * 3]! - x;
        const dz = committed.pos[j * 3 + 2]! - z;
        // Same footprint as the clash rule: only track really overhead (or underneath) counts.
        if (dx * dx + dz * dz > PLAN_RADIUS * PLAN_RADIUS) continue;
        const dy = committed.pos[j * 3 + 1]! - y;
        if (Math.abs(dy) < 1 || Math.abs(dy) > 25) continue; // the joint itself, or far away
        if (!crossing || Math.abs(dy) < crossing.gap) crossing = { above: dy > 0, gap: Math.abs(dy) };
      }
    }
  }
  let blocked = needsHeight ? 'Needs height first: add an Up piece or a Lift' : roughness(d, start, choice);
  // A tight quarter turn taken very fast throws riders sideways however it's banked: real coasters
  // slow the train first.
  if (!blocked && choice.kind === 'track' && choice.turn !== 0 && !info.stalled && info.vEnd > 17) blocked = 'Too fast for a tight turn here. Add Brakes first to slow the train';
  // Ride check at the speed the train will really be doing: no dip that presses riders down harder
  // than about 5 g and no crest that throws them up harder than about -1.3 g. Otherwise the piece
  // isn't offered, with a nudge to slow the train first.
  if (!blocked && !info.stalled && d.nodes.length > start) {
    const part = new BakedTrack({ ...d, closed: false, nodes: d.nodes.slice(Math.max(0, start - 1)) }, 0.5);
    const y0 = part.pos[1]!;
    const v0 = info.vEnd;
    for (let i = 0; i < part.count && !blocked; i++) {
      if (part.kind[i] === KIND_LIFT) continue; // the chain carries the train slowly
      const v2 = Math.max(0, v0 * v0 + 2 * 9.81 * (y0 - part.pos[i * 3 + 1]!) * 0.95);
      // Curvature along the track's own up direction (positive: a dip that presses riders down).
      const kUp = part.curv[i * 3]! * part.up[i * 3]! + part.curv[i * 3 + 1]! * part.up[i * 3 + 1]! + part.curv[i * 3 + 2]! * part.up[i * 3 + 2]!;
      // What riders feel: the curve's push plus the part of gravity along the track's up direction.
      const felt = (v2 * kUp) / 9.81 + part.up[i * 3 + 1]!;
      if (felt > 5 || felt < -1.3) blocked = 'Too fast for this here. Add Brakes first to slow the train';
    }
  }
  // Final guarantees: never into other track (including the station approach), never into the ground.
  if (!blocked && part && fastConflicts(info, part)) blocked = 'Would run into other track here. Try another direction, or go up or down first';
  if (!blocked && minClearance(d, start, ground) < 0.8) blocked = 'Too close to the ground here. Try going up first';
  // Will the train make it? Loops and rolls need speed; a gentle climb needs a little too. The
  // walk carries on from the speed the train arrives at the end of the existing track.
  if (!blocked && part) {
    const e = energyWalk(part, d.style === 'wood' ? 1.55 : d.style === 'mine' ? 1.3 : 1, 0, info.stalled ? 0.7 : info.vEnd);
    const what = choice.kind === 'special' ? pieceById(choice.id).label.toLowerCase() : 'climb';
    if (e.stallS !== null || e.minV < 1.5 || e.minVInverted < 5) blocked = `The train won't have enough speed for this ${what}. Add a Lift or a Launch first, or go down before it`;
  }
  return { design: r.design, start: r.active.start, height, atGround, crossing, blocked };
}

/** Where to draw the building grid: the grid frame and the snapped end of the track. */
export function gridFor(design: TrackDesign): GridFrame {
  return gridFrame(design);
}

/** Re-make the newest piece with changed parameters. Earlier track is untouched. */
export function adjustPiece(design: TrackDesign, active: ActivePiece, patch: Record<string, number>, ground: (x: number, z: number) => number): { design: TrackDesign; active: ActivePiece } | null {
  // The active piece must still be the last thing on the track.
  const last = design.nodes[design.nodes.length - 1];
  if (!last || last.group !== active.group) return null;
  const base: TrackDesign = { ...cloneDesign(design), nodes: cloneDesign(design).nodes.slice(0, active.start) };
  const tail = base.nodes[base.nodes.length - 1];
  if (tail && tail.kind !== 'station') {
    tail.kind = 'track';
    tail.param = undefined;
  }
  const params = { ...active.params, ...patch };
  const next = generate(base, pieceById(active.piece), params, active.group, ground);
  return { design: next.design, active: { ...active, params: next.params } };
}

export function removePiece(design: TrackDesign): TrackDesign {
  return removeLastPiece(opened(design));
}

// ------------------------------------------------------------------ editing existing pieces

export function encodeChoice(c: BuildChoice): string {
  return c.kind === 'track' ? `t${c.turn},${c.slope}` : `s:${c.id}`;
}

/** What a piece was built as (null for pieces from older coasters or the starter layout). */
export function decodeChoice(group: string | undefined): BuildChoice | null {
  const m = group ? /~(?:t(-?[01]),(-?[01])|s:([a-z]+))$/.exec(group) : null;
  if (!m) return null;
  if (m[3]) return SPECIALS.includes(m[3] as PieceId) ? { kind: 'special', id: m[3] as PieceId } : null;
  return { kind: 'track', turn: Number(m[1]) as Turn, slope: Number(m[2]) as Slope };
}

export interface PieceInfo {
  group: string;
  /** Index of the piece's first node. */
  start: number;
  /** Index of its last node. */
  end: number;
  choice: BuildChoice | null;
}

/** The player's pieces in order (the station is not a piece). */
export function piecesOf(design: TrackDesign): PieceInfo[] {
  const out: PieceInfo[] = [];
  design.nodes.forEach((n, i) => {
    if (!n.group || n.group === 'station') return;
    const last = out[out.length - 1];
    if (last && last.group === n.group) last.end = i;
    else out.push({ group: n.group, start: i, end: i, choice: decodeChoice(n.group) });
  });
  return out;
}

/**
 * Change (or remove, with `choice` null) the piece `group`, then rebuild every piece after it in
 * order so the track flows on from the new shape, all on the grid. Pieces from older layouts
 * that can't be rebuilt are dropped from that point (reported in `dropped`).
 */
export function replacePiece(design: TrackDesign, group: string, choice: BuildChoice | null, ground: (x: number, z: number) => number, committed?: BakedTrack | null): { design: TrackDesign; start: number; dropped: number } {
  const pieces = piecesOf(design);
  const k = pieces.findIndex((p) => p.group === group);
  if (k < 0) return { design, start: design.nodes.length, dropped: 0 };
  const start = pieces[k]!.start;
  let d: TrackDesign = { ...cloneDesign(design), closed: false };
  d.nodes = d.nodes.slice(0, start);
  const tail = d.nodes[d.nodes.length - 1];
  if (tail && tail.group !== 'station') {
    tail.kind = 'track';
    tail.param = undefined;
  }
  let dropped = 0;
  if (choice) d = planNext(d, choice, ground, committed).design;
  // Everything after flows on from the new shape: pieces built from the panel are re-planned; pieces
  // that came with the coaster (or older saves) are carried along whole and re-attached at the new
  // joint. A piece that can no longer fit cleanly (a drop with no height left above it, say) is
  // left out and the rest carry on without it (counted in `dropped`).
  for (const p of pieces.slice(k + 1)) {
    const next = p.choice ? planNext(d, p.choice, ground, committed) : null;
    const moved = next ? (next.blocked ? null : next.design) : carryPiece(design, p, d, ground);
    if (moved) d = moved;
    else dropped++;
  }
  return { design: d, start, dropped };
}

/**
 * Re-attach a whole piece (one not built from the panel) to the end of `d`: turned and moved so it
 * starts where `d` now ends, its shape untouched. Returns null if it can't join smoothly there
 * (a different climb angle or banking at the joint), or would hit the ground or other track.
 */
function carryPiece(original: TrackDesign, p: PieceInfo, d: TrackDesign, ground: (x: number, z: number) => number): TrackDesign | null {
  const from = original.nodes[p.start - 1];
  const to = d.nodes[d.nodes.length - 1];
  if (!from || !to) return null;
  if (Math.abs(from.dir[1] - to.dir[1]) > 0.05 || Math.abs(from.bank - to.bank) > 0.05) return null;
  const yaw = Math.atan2(to.dir[2], to.dir[0]) - Math.atan2(from.dir[2], from.dir[0]);
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  // Rotation about the vertical axis that takes `from.dir` onto `to.dir` (x/z plane).
  const rot = (x: number, z: number): [number, number] => [x * c - z * sn, x * sn + z * c];
  const nodes: TrackNode[] = original.nodes.slice(p.start, p.end + 1).map((n) => {
    const [x, z] = rot(n.p[0] - from.p[0], n.p[2] - from.p[2]);
    const [dx, dz] = rot(n.dir[0], n.dir[2]);
    return { ...n, p: [to.p[0] + x, to.p[1] + (n.p[1] - from.p[1]), to.p[2] + z], dir: [dx, n.dir[1], dz] };
  });
  const out: TrackDesign = { ...d, nodes: [...d.nodes, ...nodes] };
  const start = d.nodes.length;
  if (minClearance(out, start - 1, ground) < 0.8) return null;
  const part = new BakedTrack({ ...out, closed: false, nodes: out.nodes.slice(start - 1) }, 0.5);
  if (fastConflicts(baseInfo(opened(d)), part)) return null;
  return out;
}

/** Clamp a parameter to the preset's allowed range. */
export function clampParam(piece: PieceId, key: string, v: number): number {
  const def = presetById(pieceById(piece).preset).params.find((p) => p.key === key);
  if (!def) return v;
  const stepped = Math.round(v / def.step) * def.step;
  return Math.max(def.min, Math.min(def.max, stepped));
}

export function paramRange(piece: PieceId, key: string): { min: number; max: number } | null {
  const def = presetById(pieceById(piece).preset).params.find((p) => p.key === key);
  return def ? { min: def.min, max: def.max } : null;
}

/** A fresh coaster for "Build your own": a station, a small lift and a drop, ready to extend. */
export function freshCoaster(base: TrackDesign, y0: number, ground: (x: number, z: number) => number): TrackDesign {
  let d: TrackDesign = {
    ...base,
    closed: false,
    nodes: [
      { id: 'st0', p: [0, y0, 0], dir: [1, 0, 0], bank: 0, kind: 'station', group: 'station' },
      { id: 'st1', p: [20, y0, 0], dir: [1, 0, 0], bank: 0, kind: 'track', group: 'station' },
    ],
  };
  // Built as two ordinary pieces, so each can be tapped, changed or removed like any other.
  for (const id of ['lift', 'drop'] as const) {
    const p = planNext(d, { kind: 'special', id }, ground);
    if (!p.blocked) d = p.design;
  }
  return d;
}
