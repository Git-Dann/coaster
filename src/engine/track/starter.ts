import type { V3 } from '../core/vec3';
import { appendElement } from './design-ops';
import { type Cursor, type ElementResult, drop, hill, liftHill, piece, straight } from './elements';
import type { TrackDesign } from './types';

/**
 * The hand-tuned starter coaster that greets the player: a timber-station family coaster with
 * a lift, a swooping drop, a climbing turnaround, an airtime hill, a gentle helix and a brake run.
 * Built entirely from builder elements so it exercises the same code path as player creations.
 */
export function starterDesign(y0: number): TrackDesign {
  let d: TrackDesign = {
    nodes: [{ id: 'start', p: [0, y0, 0], dir: [1, 0, 0], bank: 0, kind: 'station' }],
    closed: false,
    style: 'tubular',
    supportStyle: 'powder-steel',
    colours: { rail: '#C77D62', spine: '#C77D62', sleeper: '#765B48', support: '#F5EBDD' },
  };
  let n = 0;
  const add = (fn: (c: Cursor) => ElementResult) => {
    const last = d.nodes[d.nodes.length - 1]!;
    const res = fn({ p: [...last.p] as V3, dir: [...last.dir] as V3, bank: last.bank });
    d = appendElement(d, res);
    // Deterministic ids for the starter so supports and saves are stable.
    for (let i = d.nodes.length - res.nodes.length; i < d.nodes.length; i++) d.nodes[i]!.id = `s${n++}`;
  };

  add((c) => straight(c, 20, 'station'));
  add((c) => straight(c, 5));
  add((c) => liftHill(c, 20, 32, 3.4));
  add((c) => drop(c, 18.5, 50));
  // Climbing banked turnaround to the left.
  add((c) => piece(c, { length: 64, turn: 180, rise: 4, bank: -55 }));
  add((c) => piece(c, { length: 26, turn: 0, rise: -4, bank: 0, ease: 'none' }));
  add((c) => hill(c, 6, 46));

  // Solve the return leg so the final eased half-turn lands exactly in line with the station.
  const end = d.nodes[d.nodes.length - 1]!;
  const cur = { p: [...end.p] as V3, dir: [...end.dir] as V3, bank: end.bank };
  const probe = (len: number) => {
    const r = piece(cur, { length: len, turn: 180, rise: -1.5, bank: -58 });
    return r.nodes[r.nodes.length - 1]!.p;
  };
  const p100 = probe(100);
  const lateral100 = p100[2] - cur.p[2];
  const turnLen = (100 * (0 - cur.p[2])) / lateral100;
  const forward = probe(turnLen)[0] - cur.p[0];
  // After the turn the train heads +X; leave room for a 26 m brake run plus a short join.
  const straightLen = Math.max(16, cur.p[0] + forward - -32);
  add((c) => piece(c, { length: straightLen - 12, turn: 0, rise: 0, bank: 0, ease: 'none' }));
  add((c) => straight(c, 12, 'brake', 11));
  add((c) => piece(c, { length: turnLen, turn: 180, rise: -1.5, bank: -58 }));
  add((c) => straight(c, 26, 'brake', 2.4));
  return d;
}

/** Apply the closing connection and a final brake segment for the starter. */
export function starterClosed(y0: number): TrackDesign {
  const d = starterDesign(y0);
  const last = d.nodes[d.nodes.length - 1]!;
  last.kind = 'brake';
  last.param = 1.5;
  return { ...d, closed: true };
}
