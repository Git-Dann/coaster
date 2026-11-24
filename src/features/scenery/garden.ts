import { BakedTrack, newSample } from '../../engine/track/bake';
import type { TrackDesign } from '../../engine/track/types';
import { mulberry32 } from '../../engine/terrain/noise';
import type { SceneryItem, SceneryType } from '../../types/world';
import { newItemId } from '../saves';

/**
 * "Coaster garden": scatters flowers, bushes, the odd tree and lanterns along the track and
 * around the station, keeping clear of the track itself. Deterministic per design so pressing
 * it twice plants the same garden (with existing items avoided).
 */
export function autoGarden(design: TrackDesign, existing: readonly SceneryItem[], ground: (x: number, z: number) => number): SceneryItem[] {
  if (design.nodes.length < 2) return [];
  const track = new BakedTrack(design, 0.5);
  const rnd = mulberry32(design.nodes.length * 7919 + Math.round(track.length));
  const smp = newSample();
  const out: SceneryItem[] = [];
  const taken = (x: number, z: number, r: number) =>
    existing.some((e) => Math.hypot(e.p[0] - x, e.p[2] - z) < r) || out.some((e) => Math.hypot(e.p[0] - x, e.p[2] - z) < r);
  const nearTrack = (x: number, z: number, r: number) => {
    for (let i = 0; i < track.count; i += 4) if (Math.hypot(track.pos[i * 3]! - x, track.pos[i * 3 + 2]! - z) < r) return true;
    return false;
  };
  const station = track.intervalsOf('station')[0];
  for (let s = 0; s < track.length; s += 7) {
    track.sample(s, smp);
    const rx = smp.right[0];
    const rz = smp.right[2];
    const l = Math.hypot(rx, rz) || 1;
    for (const side of [-1, 1]) {
      if (rnd() > 0.55) continue;
      const off = 4.5 + rnd() * 6;
      const x = smp.pos[0] + (rx / l) * off * side;
      const z = smp.pos[2] + (rz / l) * off * side;
      if (nearTrack(x, z, 3.6) || taken(x, z, 1.6)) continue;
      const r = rnd();
      const type: SceneryType = r < 0.45 ? 'flowers' : r < 0.7 ? 'bush' : r < 0.82 ? 'grass' : r < 0.92 ? 'oak' : 'birch';
      out.push({ id: newItemId('g'), type, p: [x, ground(x, z), z], rot: rnd() * Math.PI * 2, scale: 0.8 + rnd() * 0.4 });
    }
  }
  if (station) {
    for (let s = station[0]; s <= station[1]; s += 6) {
      track.sample(s, smp);
      const rx = smp.right[0];
      const rz = smp.right[2];
      const l = Math.hypot(rx, rz) || 1;
      for (const side of [-1, 1]) {
        const x = smp.pos[0] + (rx / l) * 5.2 * side;
        const z = smp.pos[2] + (rz / l) * 5.2 * side;
        if (taken(x, z, 2)) continue;
        out.push({ id: newItemId('g'), type: 'lantern', p: [x, ground(x, z), z], rot: 0, scale: 1 });
      }
    }
  }
  return out.slice(0, 400);
}
