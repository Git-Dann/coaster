import { BakedTrack } from './bake';
import type { TrackDesign } from './types';

/**
 * Track clearance: two parts of a coaster may never occupy the same space.
 *
 * Wherever new track (nodes from `fromIndex` onwards) passes within `PLAN_RADIUS` of earlier track
 * in plan view, it must be at least `MIN_VERTICAL` metres above or below it (rail to rail; enough
 * for a carriage, its riders' space and the structure). New track is lifted over (or, when that
 * is impossible, dropped under) crossings with a smooth window so the ride stays comfortable.
 * Earlier track is never moved.
 */
export const MIN_VERTICAL = 5.5;
/** Track centres closer than this in plan view count as the same space (train width plus margin). */
export const PLAN_RADIUS = 2.6;
const WINDOW = 28;

interface Conflict {
  s: number;
  lift: number;
}

function hashKey(x: number, z: number): string {
  return `${Math.floor(x / 4)},${Math.floor(z / 4)}`;
}

/** Arc-length separation along the track (wrapping on closed circuits). */
function arcSep(a: number, b: number, track: BakedTrack): number {
  const d = Math.abs(a - b);
  return track.closed ? Math.min(d, track.length - d) : d;
}

/**
 * Find places where new track (from node `fromIndex`) clashes with any other part of the coaster
 * that is more than `minArc` metres away along the track. Points in the protected tail (from arc
 * position `protectFromS`) are never moved: their partner moves instead.
 */
export function findClashes(design: TrackDesign, fromIndex: number, ground: (x: number, z: number) => number, protectTail = 0, minArc = 30): { baked: BakedTrack; conflicts: Conflict[]; unresolved: boolean } {
  let unresolved = false;
  const baked = new BakedTrack(design, 0.5);
  const sJoin = baked.nodeS[Math.max(0, fromIndex - 1)] ?? 0;
  const protectIdx = design.nodes.length - protectTail;
  const sProtect = protectTail > 0 ? (baked.nodeS[protectIdx] ?? baked.length) : Infinity;
  const isNew = (s: number) => s >= sJoin && s < sProtect;
  const cells = new Map<string, number[]>();
  const step = 2; // 1 m samples
  for (let i = 0; i < baked.count; i += step) {
    const k = hashKey(baked.pos[i * 3]!, baked.pos[i * 3 + 2]!);
    let l = cells.get(k);
    if (!l) cells.set(k, (l = []));
    l.push(i);
  }
  const bySample = new Map<number, number>();
  for (let i = 0; i < baked.count; i += step) {
    const si = i * baked.ds;
    const x = baked.pos[i * 3]!;
    const y = baked.pos[i * 3 + 1]!;
    const z = baked.pos[i * 3 + 2]!;
    for (let gx = -1; gx <= 1; gx++)
      for (let gz = -1; gz <= 1; gz++) {
        const l = cells.get(`${Math.floor(x / 4) + gx},${Math.floor(z / 4) + gz}`);
        if (!l) continue;
        for (const j of l) {
          if (j <= i) continue; // each pair once
          const sj = j * baked.ds;
          if (arcSep(si, sj, baked) < minArc) continue;
          const dx = baked.pos[j * 3]! - x;
          const dz = baked.pos[j * 3 + 2]! - z;
          if (dx * dx + dz * dz > PLAN_RADIUS * PLAN_RADIUS) continue;
          const yj = baked.pos[j * 3 + 1]!;
          if (Math.abs(y - yj) >= MIN_VERTICAL) continue;
          // Decide which point moves: only new, unprotected track moves; prefer the later one.
          const nI = isNew(si);
          const nJ = isNew(sj);
          if (!nI && !nJ) {
            // Neither point may move. If one is ours (in the protected tail), the clash can't be fixed
            // from here: report it so the caller can try another way.
            if ((si >= sJoin || sj >= sJoin) && protectTail > 0) unresolved = true;
            continue;
          }
          const [mover, other, my, oy] = nJ ? [j, i, yj, y] : [i, j, y, yj];
          void other;
          const mx = baked.pos[mover * 3]!;
          const mz = baked.pos[mover * 3 + 2]!;
          const under = oy - MIN_VERTICAL - 0.2;
          const canUnder = my < oy && under >= ground(mx, mz) + 1.4;
          const lift = canUnder ? under - my : oy + MIN_VERTICAL + 0.2 - my;
          const prev = bySample.get(mover) ?? 0;
          if (Math.abs(lift) > Math.abs(prev)) bySample.set(mover, lift);
        }
      }
  }
  const conflicts: Conflict[] = [...bySample.entries()].map(([i, lift]) => ({ s: i * baked.ds, lift }));
  return { baked, conflicts, unresolved };
}

/**
 * Lift (or lower) new nodes so the new track clears earlier track everywhere.
 * `protectTail` nodes at the end are kept in place (e.g. the brake run entering the station).
 * Returns true when the result is clash-free.
 */
export function separateCrossings(design: TrackDesign, fromIndex: number, ground: (x: number, z: number) => number, protectTail = 0): boolean {
  for (let iter = 0; iter < 6; iter++) {
    const { baked, conflicts, unresolved } = findClashes(design, fromIndex, ground, protectTail);
    if (conflicts.length === 0) return !unresolved;
    const last = design.nodes.length - protectTail;
    for (let i = fromIndex; i < last; i++) {
      const sNode = baked.nodeS[i] ?? baked.length;
      let lift = 0;
      for (const c of conflicts) {
        const d = Math.abs(sNode - c.s);
        // Bigger lifts spread over a longer stretch so climbs over crossings stay gentle (≈ 12°).
        const win = Math.max(WINDOW, Math.abs(c.lift) * 5);
        if (d > win) continue;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / win);
        const v = c.lift * w;
        if (Math.abs(v) > Math.abs(lift)) lift = v;
      }
      // Never bend inverted, steep or heavily banked nodes (loops, rolls): only simple track is smoothed.
      const n = design.nodes[i]!;
      // Banks can carry whole turns after a roll: compare the wrapped angle.
      const wrapped = Math.atan2(Math.sin(n.bank), Math.cos(n.bank));
      const complex = Math.abs(n.dir[1]) > 0.6 || Math.abs(wrapped) > 1.2;
      if (lift !== 0 && !complex) n.p[1] += lift * 1.08;
    }
    // Keep slopes consistent with the new heights.
    for (let i = fromIndex; i < last; i++) {
      const prev = design.nodes[i - 1];
      const next = design.nodes[i + 1] ?? (design.closed ? design.nodes[0] : undefined);
      const n = design.nodes[i]!;
      if (!prev || !next || Math.abs(n.dir[1]) > 0.6) continue; // leave steep/looping elements alone
      const run = Math.hypot(next.p[0] - prev.p[0], next.p[2] - prev.p[2]) || 1;
      const pitch = Math.atan2(next.p[1] - prev.p[1], run) * 0.85;
      const h = Math.atan2(-n.dir[2], n.dir[0]);
      n.dir = [Math.cos(h) * Math.cos(pitch), Math.sin(pitch), -Math.sin(h) * Math.cos(pitch)];
    }
  }
  const last = findClashes(design, fromIndex, ground, protectTail);
  return last.conflicts.length === 0 && !last.unresolved;
}
