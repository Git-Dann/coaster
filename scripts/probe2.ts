import { BakedTrack } from '../src/engine/track/bake';
import { starterClosed } from '../src/engine/track/starter';
import { TrainSim } from '../src/engine/physics/train-sim';
import { DEFAULT_PHYSICS } from '../src/engine/train/config';
const track = new BakedTrack(starterClosed(2));
const sim = new TrainSim(track, { cars: 6, style: 'steel', colours: {} as never, finish: 'matte' }, { ...DEFAULT_PHYSICS });
console.log('station', track.intervalsOf('station'), 'brake', track.intervalsOf('brake'), 'L', track.length);
for (let i=0;i<120*70;i++){ sim.step(1/120); if (sim.cars[0]!.section==='station' && sim.state==='running' && -sim.telemetry.accel>2.5) console.log(sim.time.toFixed(2), sim.s.toFixed(2), sim.v.toFixed(2), sim.telemetry.accel.toFixed(2)); }
