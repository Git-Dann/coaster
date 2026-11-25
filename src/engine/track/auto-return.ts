import { BakedTrack } from './bake';
import type { V3 } from '../core/vec3';
import { autoBank } from './elements';
import { separateCrossings, worstGap } from './clearance';
import type { TrackDesign, TrackNode } from './types';

/**
 * Automatic return track.
 *
 * The player's track always runs back into the station: after their last piece we route a smooth
 * path home using a Dubins path (the shortest curve between two headings with a minimum turning
 * radius), so a valid route always exists whatever the player builds. The height eases from the
 * end of their track to station height, stays above the ground, the turns are banked for the
 * expected speed, and a brake run lines up with the platform. The circuit therefore can never be
 * left disconnected.
 */

export type Seg = { kind: 'L' | 'R' | 'S'; len: number };

const TAU = Math.PI * 2;
/** Angle in [0, 2π), with anything within a hair of 2π treated as 0 (rounding must never add a full circle). */
const mod2pi = (a: number) => {
  const m = ((a % TAU) + TAU) % TAU;
  return m > TAU - 1e-7 ? 0 : m;
};

export interface Pose {
  x: number;
  z: number;
  /** Heading in the x–z plane, radians, 0 = +X, positive = turning left (towards −Z). */
  h: number;
}

/** Rounding can push an exact zero slightly negative; treat it as zero. */
const clampTiny = (v: number) => (v < 0 && v > -1e-9 ? 0 : v);

/** Shortest Dubins path between poses with radius R. Returns segments with lengths in metres. */
export function dubins(a: Pose, b: Pose, R: number): Seg[] {
  // Work in a frame where a is at the origin heading +x, with standard maths orientation (CCW positive).
  // Our heading convention: dir = (cos h, −sin h) in (x, z). Map z → −y so CCW in (x, y) = left turn.
  const dx = b.x - a.x;
  const dy = -(b.z - a.z);
  const D = Math.hypot(dx, dy) / R;
  const th = Math.atan2(dy, dx);
  const alpha = mod2pi(a.h - th);
  const beta = mod2pi(b.h - th);
  const sa = Math.sin(alpha);
  const sb = Math.sin(beta);
  const ca = Math.cos(alpha);
  const cb = Math.cos(beta);
  const cab = Math.cos(alpha - beta);
  const cands: Array<[string, number, number, number]> = [];
  // LSL
  {
    const p2 = clampTiny(2 + D * D - 2 * cab + 2 * D * (sa - sb));
    if (p2 >= 0) {
      const tmp = Math.atan2(cb - ca, D + sa - sb);
      cands.push(['LSL', mod2pi(-alpha + tmp), Math.sqrt(p2), mod2pi(beta - tmp)]);
    }
  }
  // RSR
  {
    const p2 = clampTiny(2 + D * D - 2 * cab + 2 * D * (sb - sa));
    if (p2 >= 0) {
      const tmp = Math.atan2(ca - cb, D - sa + sb);
      cands.push(['RSR', mod2pi(alpha - tmp), Math.sqrt(p2), mod2pi(-beta + tmp)]);
    }
  }
  // LSR
  {
    const p2 = clampTiny(-2 + D * D + 2 * cab + 2 * D * (sa + sb));
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(-ca - cb, D + sa + sb) - Math.atan2(-2, p);
      cands.push(['LSR', mod2pi(-alpha + tmp), p, mod2pi(-mod2pi(beta) + tmp)]);
    }
  }
  // RSL
  {
    const p2 = clampTiny(D * D - 2 + 2 * cab - 2 * D * (sa + sb));
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const tmp = Math.atan2(ca + cb, D - sa - sb) - Math.atan2(2, p);
      cands.push(['RSL', mod2pi(alpha - tmp), p, mod2pi(beta - tmp)]);
    }
  }
  let best: [string, number, number, number] | null = null;
  for (const c of cands) if (!best || c[1] + c[2] + c[3] < best[1] + best[2] + best[3]) best = c;
  if (!best) {
    // Degenerate fallback (never expected with CSC words): straight line.
    return [{ kind: 'S', len: Math.hypot(b.x - a.x, b.z - a.z) }];
  }
  const word = best[0];
  return [
    { kind: word[0] as Seg['kind'], len: best[1] * R },
    { kind: word[1] as Seg['kind'], len: best[2] * R },
    { kind: word[2] as Seg['kind'], len: best[3] * R },
  ].filter((s) => s.len > 0.05);
}

const headingOf = (d: Readonly<V3>) => Math.atan2(-d[2], d[0]);

export interface ReturnOptions {
  groundAt: (x: number, z: number) => number;
  /** Expected train speed through the return (m/s), for banking. */
  speed: number;
  radius?: number;
  brakeLength?: number;
  /** Leave with a short straight (no long brake run first): the fallback for busy layouts. */
  shortLead?: boolean;
}

/**
 * Nodes that carry the train from the last node of `design` back to its first (station) node.
 * Does not include either endpoint. The last returned node's outgoing segment is a brake run.
 */
export function returnNodes(design: TrackDesign, opt: ReturnOptions): TrackNode[] {
  if (design.nodes.length < 2) return [];
  // Wider turns for faster trains: aim for about 1.1 g of centripetal acceleration.
  // The return starts with a brake run that trims the train to a comfortable speed, so its turns
  // are sized for that speed rather than for however fast the train arrives.
  const cruise = Math.min(opt.speed, RETURN_SPEED + 2);
  const R = opt.radius ?? Math.min(34, Math.max(14, (cruise * cruise) / (9.81 * 1.1)));
  // If the return can't be lifted clear of the player's track (say it would have to thread
  // through a loop), try wider paths and keep the first that is clear of everything.
  const radii = opt.radius ? [R] : [R, R * 1.5, R * 2.2, R * 0.7];
  // Lining up further back from the station leaves room to climb over low track near the platform.
  const brakes = opt.brakeLength ? [opt.brakeLength] : [26, 44, 64];
  // If nothing is fully clear (a very busy layout), keep the route with the most room.
  let best: { out: TrackNode[]; gap: number } | null = null;
  // Among routes that are clear of everything, prefer one that rides comfortably: the first one
  // under the limit wins, otherwise the gentlest clear one.
  let gentlest: { out: TrackNode[]; g: number } | null = null;
  const tryPath = (o: ReturnOptions & { brakeLength: number }, r: number): TrackNode[] | null => {
    const { out, clear } = returnPath(design, o, r);
    if (clear) {
      const g = rideLoad(design, out, o);
      if (g <= COMFORT_G) return out;
      if (!gentlest || g < gentlest.g) gentlest = { out, g };
      return null;
    }
    const gap = worstGap({ ...design, nodes: [...design.nodes, ...out], closed: true });
    if (!best || gap > best.gap) best = { out, gap };
    return null;
  };
  for (const brakeLength of brakes)
    for (const r of radii) {
      const out = tryPath({ ...opt, brakeLength }, r);
      if (out) return out;
    }
  // A long straight brake run can head into earlier track on a busy layout: then leave with a short
  // straight instead, and turns wide enough for the full speed (the train is trimmed later).
  if (opt.speed > RETURN_SPEED + 2 && !opt.radius) {
    const wide = Math.min(40, Math.max(14, (opt.speed * opt.speed) / (9.81 * 1.1)));
    for (const brakeLength of brakes)
      for (const r of [wide, wide * 1.4]) {
        const out = tryPath({ ...opt, brakeLength, shortLead: true }, r);
        if (out) return out;
      }
  }
  const g = gentlest as { out: TrackNode[]; g: number } | null;
  if (g) return g.out;
  return (best as { out: TrackNode[]; gap: number } | null)!.out;
}

function returnPath(design: TrackDesign, opt: ReturnOptions, R: number): { out: TrackNode[]; clear: boolean } {
  const first = design.nodes[0]!;
  const last = design.nodes[design.nodes.length - 1]!;
  const brake = opt.brakeLength ?? 26;
  const fh = headingOf(first.dir);
  const fdir = [Math.cos(fh), 0, -Math.sin(fh)];
  // Line up with the station: the brake run starts `brake` metres before the platform.
  const goal: Pose = { x: first.p[0] - fdir[0]! * brake, z: first.p[2] - fdir[2]! * brake, h: fh };
  const start: Pose = { x: last.p[0], z: last.p[2], h: headingOf(last.dir) };
  // Leave the player's track with a straight that is also a brake run when the train arrives fast
  // (magnetic brakes at about 5 m/s², like a block brake before a coaster's final turns).
  const trimRun = opt.shortLead ? 0 : Math.max(0, (opt.speed * opt.speed - RETURN_SPEED * RETURN_SPEED) / (2 * 5));
  const lead = Math.min(52, Math.max(6, trimRun + 4));
  const s0: Pose = { x: start.x + Math.cos(start.h) * lead, z: start.z - Math.sin(start.h) * lead, h: start.h };
  // Finish with a straight, level run-in lined up with the station: the descent and the last turn
  // are done before it, so the train isn't pulled out of both at once onto the brake run.
  const runIn = 14;
  const goalIn: Pose = { x: goal.x - fdir[0]! * runIn, z: goal.z - fdir[2]! * runIn, h: fh };
  const segs: Seg[] = [{ kind: 'S', len: lead }, ...dubins(s0, goalIn, R), { kind: 'S', len: runIn }];
  const total = segs.reduce((a, s) => a + s.len, 0);
  const shaped = Math.max(1, total - runIn);
  const y0 = last.p[1];
  const y1 = first.p[1];
  const startPitch = Math.asin(Math.max(-1, Math.min(1, last.dir[1])));

  const out: TrackNode[] = [];
  /** Lowest allowed height of each node: clear of the ground under and just before it. */
  const floor: number[] = [];
  const margins: number[] = [];
  let x = start.x;
  let z = start.z;
  let h = start.h;
  let travelled = 0;
  const step = 7;
  const bankMag = Math.abs(autoBank(90, R, opt.shortLead ? opt.speed : Math.min(opt.speed, RETURN_SPEED + 2))) * (Math.PI / 180);
  // After rolls the last bank can be a whole number of turns: keep the return on the same winding
  // so it never unwinds those turns as a real twist.
  const wind = Math.round((last.bank - first.bank) / (2 * Math.PI)) * 2 * Math.PI;
  for (let si = 0; si < segs.length; si++) {
    const sg = segs[si]!;
    const n = Math.max(1, Math.ceil(sg.len / step));
    const ds = sg.len / n;
    for (let k = 0; k < n; k++) {
      // Advance along the segment.
      if (sg.kind === 'S') {
        x += Math.cos(h) * ds;
        z -= Math.sin(h) * ds;
      } else {
        const sgn = sg.kind === 'L' ? 1 : -1;
        const dh = (sgn * ds) / R;
        // Exact arc chord.
        const hm = h + dh / 2;
        const chord = 2 * R * Math.sin(Math.abs(dh) / 2);
        x += Math.cos(hm) * chord;
        z -= Math.sin(hm) * chord;
        h += dh;
      }
      travelled += ds;
      const u = Math.min(1, travelled / shaped);
      // Ease height from the end of the player's track to station height, honouring the start slope.
      const ease = u * u * (3 - 2 * u);
      const slopeCarry = Math.tan(startPitch) * shaped * (u - 2 * u * u + u * u * u);
      const y = y0 + (y1 - y0) * ease + slopeCarry;
      // Clear the ground here and on the way here (terrain can rise between nodes).
      const px = out.length ? out[out.length - 1]!.p[0] : last.p[0];
      const pz = out.length ? out[out.length - 1]!.p[2] : last.p[2];
      const g = Math.max(opt.groundAt(x, z), opt.groundAt((x + px) / 2, (z + pz) / 2), opt.groundAt(x * 0.75 + px * 0.25, z * 0.75 + pz * 0.25), opt.groundAt(x * 0.25 + px * 0.75, z * 0.25 + pz * 0.75));
      // Near the station the track glides down onto the flat station pad: the clearance margin fades
      // out over the last 30 m and the floor never asks for more than a gentle glide to platform
      // height, so there's no dive at the end.
      const toGo = Math.max(0, shaped - travelled);
      // (Within the last 20 m the track may sit as low over the pad as the platform itself does.)
      floor.push(Math.max(g + (toGo < 20 ? 0.45 : 0.8), Math.min(g + GROUND_CLEARANCE, y1 + 0.12 * toGo)));
      // The extra smoothing margin also fades in over the first 30 m, so the return doesn't jump up
      // straight off the end of your track (the basic clearance always applies).
      margins.push(SMOOTH_MARGIN * Math.min(1, toGo / 30, travelled / 30));
      const nextKind = segs[si]!.kind;
      // Target banking: level on straights, banked through turns (smoothed below).
      const bank = wind + first.bank + (nextKind === 'S' ? 0 : (nextKind === 'L' ? -1 : 1) * bankMag);
      const braking = trimRun > 0 && travelled <= trimRun + 2;
      out.push({ id: `ret_${si}_${k}`, p: [x, y, z], dir: [Math.cos(h), 0, -Math.sin(h)], bank, kind: braking ? 'brake' : 'track', ...(braking ? { param: RETURN_SPEED } : {}), group: 'return' });
    }
  }
  // Leaving your track fast, the return's height can't change direction sharply: near the start,
  // keep each node within the curve the train can take at its arrival speed (about 1.8 g of dip or
  // crest), carrying on from the slope your track ends on. Ground and other track still win.
  const startSlope = Math.tan(startPitch);
  const kMax = (1.8 * 9.81) / Math.max(1, opt.speed * opt.speed);
  const ceil: number[] = [];
  {
    let dist = 0;
    let px = last.p[0];
    let pz = last.p[2];
    for (let i = 0; i < out.length; i++) {
      dist += Math.hypot(out[i]!.p[0] - px, out[i]!.p[2] - pz);
      px = out[i]!.p[0];
      pz = out[i]!.p[2];
      const reach = 0.5 * kMax * dist * dist;
      if (dist < 60) {
        const mid = y0 + startSlope * dist;
        floor[i] = Math.max(floor[i]!, mid - reach);
        ceil.push(Math.max(floor[i]! + (margins[i] ?? 0), mid + reach));
      } else ceil.push(Infinity);
    }
  }
  smoothProfile(out, floor, y0, y1, last.bank, first.bank + wind, ceil, margins);
  const floorOf = new Map<TrackNode, number>(out.map((nd, i) => [nd, floor[i]!]));
  // Give nodes slopes consistent with their neighbours' heights.
  for (let i = 0; i < out.length; i++) {
    const prev = i === 0 ? last.p : out[i - 1]!.p;
    const next = i === out.length - 1 ? [goal.x, y1, goal.z] : out[i + 1]!.p;
    const run = Math.hypot(next[0]! - prev[0]!, next[2]! - prev[2]!) || 1;
    const pitch = Math.atan2(next[1]! - prev[1]!, run);
    const n = out[i]!;
    const hh = headingOf(n.dir);
    n.dir = [Math.cos(hh) * Math.cos(pitch), Math.sin(pitch), -Math.sin(hh) * Math.cos(pitch)];
  }
  // The path ends exactly at the start of the brake run: make that node the brake run, level with
  // the platform and lined up with it (replacing it rather than adding a coincident node).
  const end = out[out.length - 1];
  const brakeNode: TrackNode = { id: 'ret_brake', p: [goal.x, y1, goal.z], dir: [fdir[0]!, 0, fdir[2]!], bank: first.bank + wind, kind: 'brake', param: 2.4, group: 'return' };
  if (end && Math.hypot(end.p[0] - goal.x, end.p[2] - goal.z) < 2.5) out[out.length - 1] = brakeNode;
  else out.push(brakeNode);
  // A Dubins path can end with a sliver of a segment, leaving two nodes almost on top of each
  // other. A curve between near-coincident nodes with different directions loops wildly, so drop
  // any node that crowds its successor (the brake node always stays).
  for (let i = out.length - 2; i >= 0; i--) {
    const a = out[i]!.p;
    const b = out[i + 1]!.p;
    if (Math.hypot(a[0] - b[0], a[2] - b[2]) < 3) out.splice(i, 1);
  }
  // The same applies to the join with the player's last node.
  while (out.length > 1 && Math.hypot(out[0]!.p[0] - last.p[0], out[0]!.p[2] - last.p[2]) < 3) out.shift();
  // The return must never pass through the player's track: lift it over (or under) crossings.
  // The final brake run into the station stays level.
  const temp: TrackDesign = { ...design, nodes: [...design.nodes.map((n) => ({ ...n, p: [...n.p] as V3, dir: [...n.dir] as V3 })), ...out], closed: true };
  const heightsBefore = new Map<TrackNode, number>(out.map((nd) => [nd, nd.p[1]]));
  let clear = separateCrossings(temp, design.nodes.length, opt.groundAt, 2, true);
  // Crossing your track lifts (or lowers) just the nodes at the crossing, which would leave a dip
  // before a hump. Re-smooth with those heights as limits, so the return stays up until it's over
  // your track and then comes down once, then check the crossings again.
  const body = out[out.length - 1]?.kind === 'brake' ? out.slice(0, -1) : out.slice();
  if (body.some((nd) => Math.abs(nd.p[1] - (heightsBefore.get(nd) ?? nd.p[1])) > 0.05)) {
    const lo = body.map((nd) => {
      const was = heightsBefore.get(nd) ?? nd.p[1];
      return nd.p[1] > was + 0.05 ? nd.p[1] : (floorOf.get(nd) ?? -Infinity);
    });
    const hi = body.map((nd) => {
      const was = heightsBefore.get(nd) ?? nd.p[1];
      return nd.p[1] < was - 0.05 ? nd.p[1] : Infinity;
    });
    smoothProfile(body, lo, y0, y1, last.bank, first.bank + wind, hi, 0);
    const again: TrackDesign = { ...design, nodes: [...design.nodes.map((n) => ({ ...n, p: [...n.p] as V3, dir: [...n.dir] as V3 })), ...out], closed: true };
    clear = separateCrossings(again, design.nodes.length, opt.groundAt, 2, true);
  }
  // Slopes follow the final heights.
  for (let i = 0; i < out.length; i++) {
    const nd = out[i]!;
    if (nd.kind === 'brake' && i === out.length - 1) continue;
    const prev = i === 0 ? last.p : out[i - 1]!.p;
    const next = out[i + 1]?.p ?? [goal.x, y1, goal.z];
    const run = Math.hypot(next[0]! - prev[0]!, next[2]! - prev[2]!) || 1;
    const pitch = Math.atan2(next[1]! - prev[1]!, run);
    const hh = headingOf(nd.dir);
    nd.dir = [Math.cos(hh) * Math.cos(pitch), Math.sin(pitch), -Math.sin(hh) * Math.cos(pitch)];
  }
  // A trim brake halfway round keeps very fast layouts from arriving too quickly.
  // Keep the whole return at a calm pace: walk the train's speed down the return (gravity, with a
  // little loss) and add a brake section wherever it would run faster than comfortable, so a long
  // descent back to the station never builds up speed into the final turns.
  let v = opt.shortLead ? opt.speed : Math.min(opt.speed, RETURN_SPEED);
  let prevY = last.p[1];
  for (let k = 0; k < out.length - 1; k++) {
    const nd = out[k]!;
    const v2 = v * v + 2 * 9.81 * (prevY - nd.p[1]) * 0.92;
    v = Math.sqrt(Math.max(1, v2));
    prevY = nd.p[1];
    if (nd.kind === 'brake') v = Math.min(v, nd.param ?? RETURN_SPEED);
    else if (v > RETURN_SPEED + 2 && nd.kind === 'track') {
      nd.kind = 'brake';
      nd.param = RETURN_SPEED;
      v = Math.max(RETURN_SPEED, Math.sqrt(Math.max(0, v * v - 2 * 5 * 7)));
    }
  }
  return { out, clear };
}

/** Extra g a return may put on riders through its dips and crests (beyond gravity) before a gentler route is preferred. */
const COMFORT_G = 2.2;

/**
 * Roughly how hard a return rides: the sharpest curve (up, down or sideways) times the square of
 * the speed the train will be doing there (fast where it leaves your track, then the trimmed pace),
 * in g. Used to choose between routes that are all clear.
 */
function rideLoad(design: TrackDesign, out: TrackNode[], opt: ReturnOptions): number {
  const lead = design.nodes.slice(-2);
  const t = new BakedTrack({ nodes: [...lead, ...out], closed: false }, 0.5);
  const s0 = t.nodeS[lead.length - 1] ?? 0;
  let worst = 0;
  for (let i = 0; i < t.count; i++) {
    const s = i * t.ds - s0;
    if (s < -1) continue; // only the return itself (and the join), not the end of your track
    // Brakes trim the speed over the first stretch (about 5 m/s² from the arrival speed).
    const v2 = Math.max(RETURN_SPEED * RETURN_SPEED, opt.speed * opt.speed - 2 * 5 * Math.max(0, s));
    const k = Math.hypot(t.curv[i * 3]!, t.curv[i * 3 + 1]!, t.curv[i * 3 + 2]!);
    worst = Math.max(worst, (v2 * k) / 9.81);
  }
  return worst;
}

const GROUND_CLEARANCE = 1.3;
/** Extra height kept while smoothing, so rounding the profile never dips below the clearance. */
const SMOOTH_MARGIN = 1.2;
/** Speed the return's brake run trims the train to (m/s): its turns are sized for this. */
const RETURN_SPEED = 11;

/**
 * Make the return ride smoothly: a coaster's track never copies every rise and dip of the ground.
 * Heights become a smooth curve that floats over the terrain (a taut, rounded line above it, with a
 * little margin so the rounding never dips below the clearance), and banking eases in and out of
 * each turn over a couple of nodes instead of switching at a single node. Both ends stay pinned to
 * the player's track and to the station.
 */
function smoothProfile(nodes: TrackNode[], floor: number[], yStart: number, yEnd: number, bankStart: number, bankEnd: number, ceil?: number[], marginIn: number | number[] = SMOOTH_MARGIN): void {
  const n = nodes.length;
  if (n === 0) return;
  const m = (i: number) => (typeof marginIn === 'number' ? marginIn : (marginIn[i] ?? SMOOTH_MARGIN));
  const cap = (i: number, v: number) => (ceil ? Math.min(ceil[i]!, v) : v);
  const y = nodes.map((nd, i) => cap(i, Math.max(nd.p[1], floor[i]! + m(i))));
  const at = (a: number[], i: number, lo: number, hi: number) => (i < 0 ? lo : i >= n ? hi : a[i]!);
  // Lift over the terrain like a string pulled taut over it, rounded off at each contact.
  // Enough passes for the shape to settle across the whole return (it spreads about one node per
  // pass, so long returns need more).
  const passes = Math.min(4000, Math.max(80, Math.ceil((n * n) / 2)));
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      const avg = (at(y, i - 1, yStart, yEnd) + 2 * y[i]! + at(y, i + 1, yStart, yEnd)) / 4;
      y[i] = cap(i, Math.max(floor[i]! + m(i), avg));
    }
  }
  // A few free passes round off the contact points; the margin keeps them above the clearance.
  for (let pass = 0; pass < 4; pass++) {
    const prev = y.slice();
    for (let i = 0; i < n; i++) y[i] = (at(prev, i - 1, yStart, yEnd) + 2 * prev[i]! + at(prev, i + 1, yStart, yEnd)) / 4;
  }
  for (let i = 0; i < n; i++) nodes[i]!.p[1] = cap(i, Math.max(y[i]!, floor[i]!));
  // Banking: ease between level and banked over neighbouring nodes.
  let b = nodes.map((nd) => nd.bank);
  for (let pass = 0; pass < 6; pass++) {
    const prev = b;
    b = prev.map((v, i) => (at(prev, i - 1, bankStart, bankEnd) + 2 * v + at(prev, i + 1, bankStart, bankEnd)) / 4);
  }
  for (let i = 0; i < n; i++) nodes[i]!.bank = b[i]!;
}

/** The ridden circuit: the player's design plus the automatic return (closed). */
export function withReturn(design: TrackDesign, opt: ReturnOptions): TrackDesign {
  if (design.closed || design.nodes.length < 2) return design;
  const ret = returnNodes(design, opt);
  return { ...design, nodes: [...design.nodes.map((n) => ({ ...n })), ...ret], closed: true };
}
