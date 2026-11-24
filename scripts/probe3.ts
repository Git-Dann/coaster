import { BakedTrack } from '../src/engine/track/bake';
import { starterPlayable } from '../src/engine/track/starter';
import { withReturn } from '../src/engine/track/auto-return';
import { TrainSim } from '../src/engine/physics/train-sim';
import { Heightfield, PAD_HEIGHT } from '../src/engine/terrain/heightfield';
import { DEFAULT_PHYSICS } from '../src/engine/train/config';
const hf = new Heightfield('meadow', 2026);
const d = withReturn(starterPlayable(PAD_HEIGHT + 1), { groundAt: (x, z) => hf.height(x, z), speed: 15 });
const t = new BakedTrack(d);
console.log('nodes', d.nodes.length, 'len', t.length.toFixed(0), t.diagnostics);
const sim = new TrainSim(t, { cars: 6, style: 'steel', colours: {} as never, finish: 'matte' }, { ...DEFAULT_PHYSICS });
let arrivals = 0, stalls = 0, maxG = 0, minG = 9, maxLat = 0;
for (let i = 0; i < 120 * 200; i++) { sim.step(1 / 120); for (const e of sim.events) { if (e.type === 'arrive') arrivals++; if (e.type === 'stall') stalls++; } sim.events.length = 0;
  if (sim.state === 'running') { maxG = Math.max(maxG, sim.telemetry.gVert); minG = Math.min(minG, sim.telemetry.gVert); maxLat = Math.max(maxLat, Math.abs(sim.telemetry.gLat)); } }
console.log({ arrivals, stalls, maxG: maxG.toFixed(2), minG: minG.toFixed(2), maxLat: maxLat.toFixed(2) });
// Random stress: append random pieces and check the return always closes cleanly.
const smp = (await import('../src/engine/track/bake')).newSample();
let prevK = 0;
for (let s = 0; s < t.length; s += 1) { t.sample(s, smp); const k = Math.hypot(...smp.curv); if (k > 0.3 && prevK <= 0.3) console.log('kink at s', s.toFixed(0), 'pos', smp.pos.map(v=>v.toFixed(1)).join(','), 'k', k.toFixed(2)); prevK = k; }
d.nodes.forEach((n, i) => { if (i >= 30) console.log(i, n.id, n.p.map(v=>v.toFixed(1)).join(','), n.dir.map(v=>v.toFixed(2)).join(','), n.kind); });
