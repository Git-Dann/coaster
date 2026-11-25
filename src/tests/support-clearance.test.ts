import { describe, expect, test } from 'vitest';
import { BakedTrack } from '../engine/track/bake';
import { withReturn } from '../engine/track/auto-return';
import { starterPlayable } from '../engine/track/starter';
import { generateSupports, OWN_TRACK_ARC, TRAIN_ENVELOPE, type Member } from '../engine/supports/support-gen';
import { Heightfield, PAD_HEIGHT } from '../engine/terrain/heightfield';
import { mulberry32 } from '../engine/terrain/noise';
import { PIECES, addPiece, adjustPiece, freshCoaster, type PieceId } from '../features/builder/simple-builder';
import type { SupportStyle, TrackDesign } from '../engine/track/types';

const hf = new Heightfield('meadow', 2026);
const ground = (x: number, z: number) => hf.height(x, z);

/**
 * Independent brute-force check: sample every member finely and test it against the train envelope
 * of every track sample. The track a member carries is the track nearest its top end.
 */
function worstIntrusion(track: BakedTrack, members: Member[]): { count: number; first?: string } {
  const E = TRAIN_ENVELOPE;
  let count = 0;
  let first: string | undefined;
  const nearestS = (p: readonly number[]) => {
    let best = Infinity;
    let s = 0;
    for (let i = 0; i < track.count; i++) {
      const d = (track.pos[i * 3]! - p[0]!) ** 2 + (track.pos[i * 3 + 1]! - p[1]!) ** 2 + (track.pos[i * 3 + 2]! - p[2]!) ** 2;
      if (d < best) [best, s] = [d, i * track.ds];
    }
    return s;
  };
  for (const m of members) {
    const top = m.a[1] > m.b[1] ? m.a : m.b;
    const selfS = nearestS(top);
    const len = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
    const n = Math.max(1, Math.ceil(len / 0.2));
    let hit = false;
    for (let k = 0; k <= n && !hit; k++) {
      const u = k / n;
      const q = [0, 1, 2].map((c) => m.a[c]! + (m.b[c]! - m.a[c]!) * u);
      for (let i = 0; i < track.count && !hit; i++) {
        const d = [0, 1, 2].map((c) => q[c]! - track.pos[i * 3 + c]!);
        if (Math.abs(d[0]!) > 5 || Math.abs(d[1]!) > 5 || Math.abs(d[2]!) > 5) continue;
        const T = [0, 1, 2].map((c) => track.tan[i * 3 + c]!);
        const U = [0, 1, 2].map((c) => track.up[i * 3 + c]!);
        const R = [T[1]! * U[2]! - T[2]! * U[1]!, T[2]! * U[0]! - T[0]! * U[2]!, T[0]! * U[1]! - T[1]! * U[0]!];
        const dot = (v: number[]) => v[0]! * d[0]! + v[1]! * d[1]! + v[2]! * d[2]!;
        if (Math.abs(dot(T)) > track.ds) continue;
        if (Math.abs(dot(R)) > E.lateral) continue;
        let ds = Math.abs(i * track.ds - selfS);
        if (track.closed) ds = Math.min(ds, track.length - ds);
        const below = ds < OWN_TRACK_ARC - 1 ? 0.3 : E.below;
        const up = dot(U);
        if (up > -below && up < E.above) {
          hit = true;
          count++;
          first ??= `${m.key} (${m.kind}) at s=${(i * track.ds).toFixed(1)} self=${selfS.toFixed(1)} up=${up.toFixed(2)} lat=${dot(R).toFixed(2)} along=${dot(T).toFixed(2)} a=${m.a.map((v) => v.toFixed(1))} b=${m.b.map((v) => v.toFixed(1))}`;
        }
      }
    }
  }
  return { count, first };
}

function check(design: TrackDesign, style: SupportStyle, label: string) {
  const circuit = withReturn({ ...design, supportStyle: style }, { groundAt: ground, speed: 15 });
  const track = new BakedTrack(circuit);
  const members = generateSupports(circuit, track, ground);
  const r = worstIntrusion(track, members);
  expect(r.count, `${label} ${style}: ${r.first}`).toBe(0);
  return members.length;
}

describe('scaffolding never clashes with track', () => {
  test('the starter coaster, in timber and steel', () => {
    const d = starterPlayable(PAD_HEIGHT + 1);
    expect(check(d, 'pine', 'starter')).toBeGreaterThan(100);
    expect(check(d, 'powder-steel', 'starter')).toBeGreaterThan(20);
  }, 60_000);

  test('random layouts with crossings, in timber and steel', () => {
    const rnd = mulberry32(7);
    const ids = PIECES.map((p) => p.id);
    for (let trial = 0; trial < 6; trial++) {
      let d = freshCoaster(starterPlayable(PAD_HEIGHT + 1), PAD_HEIGHT + 1, ground);
      for (let k = 0; k < 6; k++) {
        const r = addPiece(d, ids[Math.floor(rnd() * ids.length)] as PieceId, ground);
        d = r.design;
        if (rnd() < 0.4) d = adjustPiece(d, r.active, { rise: (rnd() - 0.5) * 20, length: 10 + rnd() * 40 }, ground)?.design ?? d;
      }
      check(d, trial % 2 ? 'pine' : 'powder-steel', `trial ${trial}`);
    }
  }, 120_000);
});
