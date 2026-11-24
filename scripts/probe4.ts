import { BakedTrack } from '../src/engine/track/bake';
import { starterPlayable } from '../src/engine/track/starter';
import { withReturn } from '../src/engine/track/auto-return';
import { TrainSim } from '../src/engine/physics/train-sim';
import { Heightfield, PAD_HEIGHT } from '../src/engine/terrain/heightfield';
import { DEFAULT_PHYSICS } from '../src/engine/train/config';
const hf = new Heightfield('meadow', 2026);
const d = withReturn(starterPlayable(PAD_HEIGHT + 1), { groundAt: (x, z) => hf.height(x, z), speed: 17 });
const t = new BakedTrack(d);
const sim = new TrainSim(t, { cars: 6, style: 'steel', colours: {} as never, finish: 'matte' }, { ...DEFAULT_PHYSICS });
const seen = new Set<number>();
for (let i = 0; i < 120 * 80; i++) { sim.step(1/120); if (sim.state==='running' && Math.abs(sim.telemetry.gLat) > 1.0) { const b = Math.round(sim.s/10)*10; if (!seen.has(b)) { seen.add(b); console.log('s', b, 'lat', sim.telemetry.gLat.toFixed(2), 'v', sim.v.toFixed(1), 'node seg', t.segOf[Math.floor(sim.s/t.ds)], d.nodes[t.segOf[Math.floor(sim.s/t.ds)]!]?.id); } } }
