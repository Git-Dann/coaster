import type { V3 } from '../../engine/core/vec3';
import { BakedTrack } from '../../engine/track/bake';
import { appendElement, cloneDesign, liftAboveGround, removeLastPiece, uprightBankAtEnd } from '../../engine/track/design-ops';
import type { TrackDesign } from '../../engine/track/types';
import { MIN_VERTICAL, findClashes, separateCrossings } from '../../engine/track/clearance';
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
function generate(base: TrackDesign, piece: KidPiece, rawParams: Record<string, number>, group: string, ground: (x: number, z: number) => number): TrackDesign {
  const params = { ...rawParams };
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
    return next;
  }
  // Loops, rolls, spirals and the like are never bent: if one would clash, a gentle ramp in front
  // of it raises the whole element clear, keeping its shape exact (ramp and element are one piece).
  let result = next;
  let extra = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { conflicts } = findClashes(result, base.nodes.length, ground);
    if (conflicts.length === 0) return result;
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
  return result;
}

/** Elements whose shape must never be bent to clear other track. */
const COMPLEX: ReadonlySet<PieceId> = new Set(['loop', 'roll', 'corkscrew', 'helix', 'lift', 'drop']);

/** Open a closed (legacy) circuit so pieces can be added; the auto-return reconnects it. */
export function opened(d: TrackDesign): TrackDesign {
  return d.closed ? { ...cloneDesign(d), closed: false } : d;
}

export function addPiece(design: TrackDesign, id: PieceId, ground: (x: number, z: number) => number): { design: TrackDesign; active: ActivePiece } {
  const base = opened(design);
  const piece = pieceById(id);
  const group = newGroup();
  const next = generate(base, piece, piece.params, group, ground);
  return { design: next, active: { piece: id, group, start: base.nodes.length, params: { ...piece.params } } };
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
  return { design: next, active: { ...active, params } };
}

export function removePiece(design: TrackDesign): TrackDesign {
  return removeLastPiece(opened(design));
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
  d = addPiece(d, 'lift', ground).design;
  d.nodes[2]!.group = 'start';
  for (const n of d.nodes) if (n.group && n.group !== 'station') n.group = 'start';
  d = addPiece(d, 'drop', ground).design;
  for (const n of d.nodes) if (n.group && n.group !== 'station') n.group = 'start';
  return d;
}
