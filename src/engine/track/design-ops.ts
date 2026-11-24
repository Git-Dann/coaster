import { type V3, v3, cross, dot, normalize, clamp } from '../core/vec3';
import { BakedTrack, newSample } from './bake';
import type { Cursor, ElementResult } from './elements';
import { MIN_RADIUS, type TrackDesign, type TrackNode } from './types';

let idCounter = 0;
export function newNodeId(): string {
  idCounter = (idCounter + 1) % 1e9;
  return `n${Date.now().toString(36)}${idCounter.toString(36)}`;
}

export function cloneDesign(d: TrackDesign): TrackDesign {
  return {
    ...d,
    colours: { ...d.colours },
    nodes: d.nodes.map((n) => ({ ...n, p: [...n.p] as V3, dir: [...n.dir] as V3 })),
  };
}

/** Cursor at the open end of a track. `bank` is the absolute bank of the last node. */
export function endCursor(d: TrackDesign): Cursor | null {
  const last = d.nodes[d.nodes.length - 1];
  if (!last || d.closed) return null;
  return { p: [...last.p] as V3, dir: [...last.dir] as V3, bank: last.bank };
}

/**
 * Bank value that renders as visually upright at the end of the track.
 * After an inversion such as an Immelmann the reference frame is inverted, so
 * "upright" is bank ± π. Builder sliders are expressed relative to this.
 */
export function uprightBankAtEnd(d: TrackDesign, baked: BakedTrack): number {
  const last = d.nodes[d.nodes.length - 1];
  if (!last) return 0;
  const smp = baked.sample(baked.length, newSample());
  // Signed roll of the actual up vector away from the vertical plane through the tangent.
  const T = smp.tan;
  const lateral = cross(v3(), T, [0, 1, 0]);
  if (Math.hypot(lateral[0], lateral[1], lateral[2]) < 1e-3) return last.bank;
  normalize(lateral, lateral);
  const upPlane = cross(v3(), lateral, T);
  const roll = Math.atan2(dot(smp.up, lateral), dot(smp.up, upPlane));
  return last.bank - roll;
}

export function appendElement(d: TrackDesign, res: ElementResult, group?: string): TrackDesign {
  const next = cloneDesign(d);
  const last = next.nodes[next.nodes.length - 1];
  if (last) {
    last.kind = res.startKind;
    last.param = res.startParam;
  }
  for (const n of res.nodes) {
    next.nodes.push({ id: newNodeId(), p: [...n.p] as V3, dir: [...n.dir] as V3, bank: n.bank, kind: n.kind ?? 'track', param: n.param, tension: n.tension, group });
  }
  // The newly open end is plain track.
  const end = next.nodes[next.nodes.length - 1];
  if (end) {
    end.kind = 'track';
    end.param = undefined;
  }
  return next;
}

export interface CloseCheck {
  ok: boolean;
  /** Friendly explanation when not ok. */
  reason?: string;
  /** Tightest radius on the closing segment (m). */
  minRadius: number;
  distance: number;
}

/** Evaluate whether connecting the open end back to the start produces buildable geometry. */
export function checkClose(d: TrackDesign, groundAt?: (x: number, z: number) => number): CloseCheck {
  if (d.nodes.length < 3) return { ok: false, reason: 'Add a few more pieces before closing the circuit.', minRadius: 0, distance: 0 };
  const first = d.nodes[0]!;
  const last = d.nodes[d.nodes.length - 1]!;
  const distance = Math.hypot(first.p[0] - last.p[0], first.p[1] - last.p[1], first.p[2] - last.p[2]);
  const test: TrackDesign = { ...d, closed: true };
  const baked = new BakedTrack(test, 0.5);
  const sStart = baked.nodeS[d.nodes.length - 1]!;
  let maxK = 0;
  let minClear = Infinity;
  const smp = newSample();
  for (let s = sStart; s < baked.length; s += 0.5) {
    baked.sample(s, smp);
    maxK = Math.max(maxK, Math.hypot(smp.curv[0], smp.curv[1], smp.curv[2]));
    if (groundAt) minClear = Math.min(minClear, smp.pos[1] - groundAt(smp.pos[0], smp.pos[2]));
  }
  const minRadius = maxK > 0 ? 1 / maxK : Infinity;
  const backwards = dot(first.dir, last.dir) < -0.2 && distance < 30;
  if (distance < 2) return { ok: false, reason: 'Your track end is right on top of the station. Extend it a little further first.', minRadius, distance };
  if (backwards) return { ok: false, reason: 'The track is facing away from the start. Try turning it around first.', minRadius, distance };
  if (minRadius < MIN_RADIUS) return { ok: false, reason: 'A slightly wider turn would fit here. Extend the track a little before connecting.', minRadius, distance };
  if (minClear < -0.2) return { ok: false, reason: 'The connection would dip into the ground. A little more height will help.', minRadius, distance };
  if (baked.diagnostics.seamFlip)
    return { ok: false, reason: 'The track is upside down at the join. Add a half roll so it arrives upright.', minRadius, distance };
  return { ok: true, minRadius, distance };
}

export function closeCircuit(d: TrackDesign): TrackDesign {
  const next = cloneDesign(d);
  next.closed = true;
  // Ensure the closing node's bank matches the start without an extra full roll.
  const first = next.nodes[0]!;
  const last = next.nodes[next.nodes.length - 1]!;
  const turns = Math.round((last.bank - first.bank) / (2 * Math.PI));
  void turns;
  return next;
}

export function removeLastNode(d: TrackDesign): TrackDesign {
  const next = cloneDesign(d);
  if (next.closed) {
    next.closed = false;
    return next;
  }
  if (next.nodes.length > 2) next.nodes.pop();
  const end = next.nodes[next.nodes.length - 1];
  if (end) {
    end.kind = 'track';
    end.param = undefined;
  }
  return next;
}

/** Translate the whole coaster in the horizontal plane (and optionally vertically). */
export function translateDesign(d: TrackDesign, dx: number, dy: number, dz: number): TrackDesign {
  const next = cloneDesign(d);
  for (const n of next.nodes) {
    n.p[0] += dx;
    n.p[1] += dy;
    n.p[2] += dz;
  }
  return next;
}

/** Mirror the design across the vertical plane containing the first node's direction. */
export function mirrorDesign(d: TrackDesign): TrackDesign {
  const next = cloneDesign(d);
  const o = next.nodes[0];
  if (!o) return next;
  const f = normalize(v3(), [o.dir[0], 0, o.dir[2]]);
  const r = cross(v3(), f, [0, 1, 0]);
  const reflect = (p: V3, origin: V3 | null) => {
    const q: V3 = origin ? [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]] : [...p] as V3;
    const k = dot(q, r);
    q[0] -= 2 * k * r[0];
    q[2] -= 2 * k * r[2];
    if (origin) {
      q[0] += origin[0];
      q[1] += origin[1];
      q[2] += origin[2];
    }
    return q;
  };
  const origin: V3 = [...o.p] as V3;
  for (const n of next.nodes) {
    n.p = reflect(n.p, origin);
    n.dir = reflect(n.dir, null);
    n.bank = -n.bank;
  }
  return next;
}

/** Edit a node's height (used by the raise/lower handle). */
export function setNodeHeight(d: TrackDesign, id: string, y: number): TrackDesign {
  const next = cloneDesign(d);
  const n = next.nodes.find((x) => x.id === id);
  if (n) n.p[1] = clamp(y, -20, 120);
  return next;
}

export function updateNode(d: TrackDesign, id: string, patch: Partial<Omit<TrackNode, 'id'>>): TrackDesign {
  const next = cloneDesign(d);
  const n = next.nodes.find((x) => x.id === id);
  if (n) Object.assign(n, patch);
  return next;
}

/** Remove the most recently placed piece (all nodes of the last group). The station always stays. */
export function removeLastPiece(d: TrackDesign): TrackDesign {
  const next = cloneDesign(d);
  next.closed = false;
  const last = next.nodes[next.nodes.length - 1];
  if (!last || next.nodes.length <= 2) return next;
  const g = last.group;
  if (!g || g === 'station') {
    if (next.nodes.length > 2) next.nodes.pop();
  } else {
    while (next.nodes.length > 2 && next.nodes[next.nodes.length - 1]!.group === g) next.nodes.pop();
  }
  const end = next.nodes[next.nodes.length - 1]!;
  end.kind = end.group === 'station' && next.nodes.length === 2 ? 'track' : end.kind === 'station' ? 'station' : 'track';
  end.param = undefined;
  return next;
}

/** Keep placed track above the ground (tunnels excepted). */
export function liftAboveGround(d: TrackDesign, fromIndex: number, groundAt: (x: number, z: number) => number, clearance = 1.1): TrackDesign {
  for (let i = Math.max(1, fromIndex); i < d.nodes.length; i++) {
    const n = d.nodes[i]!;
    const g = groundAt(n.p[0], n.p[2]) + clearance;
    if (n.p[1] < g && n.kind !== 'tunnel') n.p[1] = g;
  }
  return d;
}
