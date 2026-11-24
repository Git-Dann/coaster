import type { V3 } from '../../engine/core/vec3';
import { BakedTrack, newSample } from '../../engine/track/bake';
import {
  autoBank,
  corkscrew,
  drop,
  halfLoopRoll,
  helix,
  hill,
  liftHill,
  piece,
  straight,
  verticalLoop,
  zeroGRoll,
  type Cursor,
  type ElementResult,
} from '../../engine/track/elements';
import { appendElement, uprightBankAtEnd } from '../../engine/track/design-ops';
import { MIN_RADIUS, type TrackDesign } from '../../engine/track/types';

export type PresetId =
  | 'track'
  | 'lift'
  | 'drop'
  | 'hill'
  | 'helix'
  | 'loop'
  | 'corkscrew'
  | 'zerog'
  | 'immelmann'
  | 'diveloop'
  | 'brake'
  | 'launch'
  | 'station'
  | 'tunnel';

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

export interface Preset {
  id: PresetId;
  label: string;
  hint: string;
  params: ParamDef[];
  defaults: Record<string, number>;
  make(c: Cursor, p: Record<string, number>, ctx: BuildContext): ElementResult;
}

export interface BuildContext {
  /** Bank value that renders as upright at the end of the track. */
  uprightBank: number;
  /** Estimated train speed at the end (m/s), used for auto-banking. */
  speedAtEnd: number;
  autoBank: boolean;
}

const DEG = Math.PI / 180;
const dirSign = (v: number): 1 | -1 => (v >= 0 ? 1 : -1);

export const PRESETS: Preset[] = [
  {
    id: 'track',
    label: 'Track',
    hint: 'Drag the ring to steer, the arrow to raise or lower.',
    params: [
      { key: 'length', label: 'Length', min: 4, max: 80, step: 1, unit: 'm' },
      { key: 'turn', label: 'Turn', min: -180, max: 180, step: 5, unit: '°' },
      { key: 'rise', label: 'Height', min: -30, max: 30, step: 0.5, unit: 'm' },
      { key: 'bank', label: 'Banking', min: -120, max: 120, step: 5, unit: '°' },
    ],
    defaults: { length: 20, turn: 0, rise: 0, bank: 0 },
    make: (c, p, ctx) => {
      const R = Math.abs(p.turn!) > 1 ? p.length! / (Math.abs(p.turn!) * DEG) : Infinity;
      const bank = ctx.autoBank && Math.abs(p.turn!) > 1 ? autoBank(p.turn!, R, ctx.speedAtEnd) : p.bank!;
      return piece({ ...c }, { length: p.length!, turn: p.turn!, rise: p.rise!, bank: (ctx.uprightBank / DEG) + bank, ease: 'both' });
    },
  },
  {
    id: 'lift',
    label: 'Chain lift',
    hint: 'Carries the train up gently. Add a drop after the crest.',
    params: [
      { key: 'height', label: 'Height', min: 5, max: 60, step: 1, unit: 'm' },
      { key: 'angle', label: 'Angle', min: 20, max: 50, step: 1, unit: '°' },
      { key: 'speed', label: 'Chain speed', min: 1.5, max: 6, step: 0.1, unit: 'm/s' },
    ],
    defaults: { height: 20, angle: 32, speed: 3.4 },
    make: (c, p, ctx) => liftHill({ ...c, bank: ctx.uprightBank }, p.height!, p.angle!, p.speed!),
  },
  {
    id: 'drop',
    label: 'Drop',
    hint: 'A swooping fall with a smooth pull-out.',
    params: [
      { key: 'depth', label: 'Depth', min: 4, max: 60, step: 1, unit: 'm' },
      { key: 'angle', label: 'Angle', min: 30, max: 75, step: 1, unit: '°' },
    ],
    defaults: { depth: 18, angle: 50 },
    make: (c, p, ctx) => drop({ ...c, bank: ctx.uprightBank }, p.depth!, p.angle!),
  },
  {
    id: 'hill',
    label: 'Airtime hill',
    hint: 'Longer hills float, shorter ones lift you out of your seat.',
    params: [
      { key: 'height', label: 'Height', min: 2, max: 30, step: 0.5, unit: 'm' },
      { key: 'length', label: 'Length', min: 16, max: 90, step: 1, unit: 'm' },
    ],
    defaults: { height: 8, length: 48 },
    make: (c, p, ctx) => hill({ ...c, bank: ctx.uprightBank }, p.height!, p.length!),
  },
  {
    id: 'helix',
    label: 'Helix',
    hint: 'A banked spiral. Positive turns go left.',
    params: [
      { key: 'turns', label: 'Turns', min: -3, max: 3, step: 0.25, unit: '' },
      { key: 'radius', label: 'Radius', min: 8, max: 35, step: 0.5, unit: 'm' },
      { key: 'rise', label: 'Height change', min: -25, max: 25, step: 0.5, unit: 'm' },
    ],
    defaults: { turns: 1, radius: 16, rise: -6 },
    make: (c, p, ctx) => {
      const v = ctx.speedAtEnd;
      const bank = Math.min(78, Math.atan2(v * v, 9.81 * p.radius!) / DEG);
      return helix({ ...c, bank: ctx.uprightBank }, p.turns! === 0 ? 0.25 : p.turns!, p.radius!, p.rise!, ctx.autoBank ? bank : 45);
    },
  },
  {
    id: 'loop',
    label: 'Vertical loop',
    hint: 'Needs plenty of speed: aim for a drop at least as tall as the loop.',
    params: [{ key: 'height', label: 'Height', min: 10, max: 40, step: 0.5, unit: 'm' }],
    defaults: { height: 18 },
    make: (c, p, ctx) => verticalLoop({ ...c, bank: ctx.uprightBank }, p.height!),
  },
  {
    id: 'corkscrew',
    label: 'Corkscrew',
    hint: 'A full roll around the riders.',
    params: [
      { key: 'length', label: 'Length', min: 14, max: 40, step: 1, unit: 'm' },
      { key: 'direction', label: 'Direction', min: -1, max: 1, step: 2, unit: '' },
    ],
    defaults: { length: 22, direction: 1 },
    make: (c, p, ctx) => corkscrew({ ...c, bank: ctx.uprightBank }, p.length!, 3.4, dirSign(p.direction!)),
  },
  {
    id: 'zerog',
    label: 'Zero-G roll',
    hint: 'A floating roll over a gentle hump.',
    params: [
      { key: 'length', label: 'Length', min: 18, max: 45, step: 1, unit: 'm' },
      { key: 'height', label: 'Hump', min: 3, max: 14, step: 0.5, unit: 'm' },
      { key: 'direction', label: 'Direction', min: -1, max: 1, step: 2, unit: '' },
    ],
    defaults: { length: 28, height: 7, direction: 1 },
    make: (c, p, ctx) => zeroGRoll({ ...c, bank: ctx.uprightBank }, p.length!, p.height!, dirSign(p.direction!)),
  },
  {
    id: 'immelmann',
    label: 'Immelmann',
    hint: 'Half loop up, half roll out. You exit facing back the way you came.',
    params: [
      { key: 'height', label: 'Height', min: 10, max: 35, step: 0.5, unit: 'm' },
      { key: 'direction', label: 'Direction', min: -1, max: 1, step: 2, unit: '' },
    ],
    defaults: { height: 16, direction: 1 },
    make: (c, p, ctx) => halfLoopRoll({ ...c, bank: ctx.uprightBank }, p.height!, false, dirSign(p.direction!)),
  },
  {
    id: 'diveloop',
    label: 'Dive loop',
    hint: 'Half roll in, half loop down.',
    params: [
      { key: 'height', label: 'Height', min: 10, max: 35, step: 0.5, unit: 'm' },
      { key: 'direction', label: 'Direction', min: -1, max: 1, step: 2, unit: '' },
    ],
    defaults: { height: 16, direction: 1 },
    make: (c, p, ctx) => halfLoopRoll({ ...c, bank: ctx.uprightBank }, p.height!, true, dirSign(p.direction!)),
  },
  {
    id: 'brake',
    label: 'Brakes',
    hint: 'Magnetic brakes slow the train to the target speed.',
    params: [
      { key: 'length', label: 'Length', min: 6, max: 40, step: 1, unit: 'm' },
      { key: 'speed', label: 'Target speed', min: 0, max: 15, step: 0.5, unit: 'm/s' },
    ],
    defaults: { length: 16, speed: 3 },
    make: (c, p, ctx) => straight({ ...c, bank: ctx.uprightBank }, p.length!, 'brake', p.speed!),
  },
  {
    id: 'launch',
    label: 'Launch',
    hint: 'Linear motors push the train up to speed.',
    params: [
      { key: 'length', label: 'Length', min: 10, max: 60, step: 1, unit: 'm' },
      { key: 'speed', label: 'Exit speed', min: 8, max: 35, step: 0.5, unit: 'm/s' },
    ],
    defaults: { length: 30, speed: 20 },
    make: (c, p, ctx) => straight({ ...c, bank: ctx.uprightBank }, p.length!, 'launch', p.speed!),
  },
  {
    id: 'station',
    label: 'Station',
    hint: 'Where the train stops and waits between rides.',
    params: [{ key: 'length', label: 'Length', min: 8, max: 30, step: 1, unit: 'm' }],
    defaults: { length: 20 },
    make: (c, p, ctx) => straight({ ...c, bank: ctx.uprightBank }, p.length!, 'station'),
  },
  {
    id: 'tunnel',
    label: 'Tunnel',
    hint: 'A straight section marked as a tunnel.',
    params: [{ key: 'length', label: 'Length', min: 6, max: 60, step: 1, unit: 'm' }],
    defaults: { length: 20 },
    make: (c, p, ctx) => straight({ ...c, bank: ctx.uprightBank }, p.length!, 'tunnel'),
  },
];

export const presetById = (id: PresetId): Preset => PRESETS.find((p) => p.id === id)!;

/** Estimated speed at the end of an open track from the energy height available (with losses). */
export function estimateSpeedAtEnd(design: TrackDesign, baked: BakedTrack | null): number {
  if (!baked || design.nodes.length < 2) return 8;
  let maxH = -Infinity;
  for (let i = 0; i < baked.count; i++) maxH = Math.max(maxH, baked.pos[i * 3 + 1]!);
  const endH = baked.pos[(baked.count - 1) * 3 + 1]!;
  const launchSpeed = Math.max(0, ...baked.intervalsOf('launch').map(([s]) => baked.sample(s, newSample()).param));
  const vGrav = Math.sqrt(Math.max(0, 2 * 9.81 * (maxH - endH))) * 0.88;
  return Math.max(5, vGrav, launchSpeed * 0.9);
}

/** Build the preview design: committed track plus the proposed element. Committed nodes are copied untouched. */
export function makePreview(design: TrackDesign, preset: PresetId, params: Record<string, number>, autoBankOn: boolean, sessionKey: string): TrackDesign | null {
  if (design.closed || design.nodes.length < 1) return null;
  const last = design.nodes[design.nodes.length - 1]!;
  const baked = design.nodes.length >= 2 ? new BakedTrack(design, 0.5) : null;
  const ctx: BuildContext = {
    uprightBank: baked ? uprightBankAtEnd(design, baked) : last.bank,
    speedAtEnd: estimateSpeedAtEnd(design, baked),
    autoBank: autoBankOn,
  };
  const p = presetById(preset);
  const res = p.make({ p: [...last.p] as V3, dir: [...last.dir] as V3, bank: last.bank }, { ...p.defaults, ...params }, ctx);
  const next = appendElement(design, res);
  // Stable ids for this preview session: supports keep their identity while dragging and on commit.
  for (let i = design.nodes.length; i < next.nodes.length; i++) next.nodes[i]!.id = `${sessionKey}_${i}`;
  return next;
}

export interface PreviewCheck {
  ok: boolean;
  /** Friendly guidance, never alarming. */
  hint?: string;
  minRadius: number;
}

/** Validate the proposed part of a preview: tightness, ground clearance and energy. */
export function checkPreview(preview: TrackDesign, committedCount: number, ground: (x: number, z: number) => number): PreviewCheck {
  const baked = new BakedTrack(preview, 0.5);
  const s0 = baked.nodeS[Math.max(0, committedCount - 1)] ?? 0;
  const smp = newSample();
  let maxK = 0;
  let minClear = Infinity;
  let maxH = -Infinity;
  let powered = false;
  for (let s = s0; s <= baked.length; s += 0.5) {
    baked.sample(s, smp);
    maxK = Math.max(maxK, Math.hypot(smp.curv[0], smp.curv[1], smp.curv[2]));
    if (smp.up[1] > 0) minClear = Math.min(minClear, smp.pos[1] - ground(smp.pos[0], smp.pos[2]));
    maxH = Math.max(maxH, smp.pos[1]);
    if (smp.kind === 'lift' || smp.kind === 'launch') powered = true;
  }
  let prevMax = -Infinity;
  for (let s = 0; s < s0; s += 1) prevMax = Math.max(prevMax, baked.sample(s, smp).pos[1]);
  const minRadius = maxK > 0 ? 1 / maxK : Infinity;
  if (minRadius < 2.2) return { ok: false, hint: 'A slightly wider turn would fit here. Try a longer piece.', minRadius };
  if (minRadius < MIN_RADIUS) return { ok: true, hint: 'This turn is very tight. A longer piece will ride more smoothly.', minRadius };
  if (minClear < -0.4) return { ok: true, hint: 'This dips into the ground. A little more height will lift it clear, or it can become a tunnel.', minRadius };
  if (!powered && committedCount > 1 && maxH > prevMax - 1) {
    let anyPower = false;
    for (let s = 0; s < s0; s += 1) {
      const k = baked.sample(s, smp).kind;
      if (k === 'lift' || k === 'launch') anyPower = true;
    }
    return { ok: true, hint: anyPower ? 'A little more height earlier on will help your train reach this hill.' : 'A chain lift or launch will carry your train up here.', minRadius };
  }
  return { ok: true, minRadius };
}

/** Map a plan-view drag point to piece length and turn so the end follows the finger. */
export function planDragToPiece(cursor: { p: V3; dir: V3 }, point: V3): { length: number; turn: number } {
  const fx = cursor.dir[0];
  const fz = cursor.dir[2];
  const fl = Math.hypot(fx, fz) || 1;
  const f = [fx / fl, fz / fl];
  // Right vector = forward × up = (−fz, fx) in (x, z)… with heading convention right = (sin h, cos h).
  const r = [-f[1]!, f[0]!];
  const dx = point[0] - cursor.p[0];
  const dz = point[2] - cursor.p[2];
  const x = dx * f[0]! + dz * f[1]!;
  const z = dx * r[0]! + dz * r[1]!;
  const chord = Math.hypot(x, z);
  if (chord < 2) return { length: 4, turn: 0 };
  // Circular arc tangent to the cursor through the point: turn = 2·atan2(lateral, forward); left is positive.
  let theta = 2 * Math.atan2(-z, Math.max(x, -1e9));
  theta = Math.max(-Math.PI, Math.min(Math.PI, theta));
  const half = Math.abs(theta) / 2;
  const length = half > 1e-3 ? (chord * half) / Math.sin(half) : chord;
  return { length: Math.max(4, Math.min(80, Math.round(length))), turn: Math.round(theta / DEG / 5) * 5 };
}
