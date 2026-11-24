import { BakedTrack } from '../src/engine/track/bake';
import { starterClosed, starterDesign } from '../src/engine/track/starter';
import { TrainSim } from '../src/engine/physics/train-sim';
import { checkClose } from '../src/engine/track/design-ops';
let t = performance.now();
const open = starterDesign(2);
const last = open.nodes[open.nodes.length-1]!;
console.log('end', last.p.map(v=>v.toFixed(1)), last.dir.map(v=>v.toFixed(2)));
console.log(checkClose(open), (performance.now()-t).toFixed(0)+'ms');
t = performance.now();
const b = new BakedTrack(starterClosed(2));
console.log('len', b.length.toFixed(1), b.diagnostics, (performance.now()-t).toFixed(0)+'ms');
const sim = new TrainSim(b, { cars: 6, style: 'steel', colours: {} as never, finish: 'matte' });
t = performance.now();
let maxV=0,minG=9,maxG=-9,maxLat=0; const log:string[]=[];
for (let i = 0; i < 120*Number(process.argv[2]??60); i++) {
  sim.step(1/120);
  maxV=Math.max(maxV,sim.v);
  if (sim.state==='running'){minG=Math.min(minG,sim.telemetry.gVert);maxG=Math.max(maxG,sim.telemetry.gVert);maxLat=Math.max(maxLat,Math.abs(sim.telemetry.gLat));}
  if (i%240===0) log.push(`${(i/120).toFixed(0)}s s=${sim.s.toFixed(1)} v=${sim.v.toFixed(2)} ${sim.state} h=${sim.telemetry.height.toFixed(1)} g=${sim.telemetry.gVert.toFixed(2)} lat=${sim.telemetry.gLat.toFixed(2)} E=${(sim.telemetry.energy/1e3).toFixed(0)}`);
  while (sim.events.length) log.push('  ev '+JSON.stringify(sim.events.shift()));
}
console.log(log.join('\n'));
console.log({maxV,minG,maxG,maxLat}, (performance.now()-t).toFixed(0)+'ms');
// G profile peaks
{
  const sim2 = new TrainSim(b, { cars: 6, style: 'steel', colours: {} as never, finish: 'matte' });
  sim2.dispatch();
  const peaks: string[] = [];
  for (let i=0;i<120*60;i++){ sim2.step(1/120); const g=sim2.telemetry.gVert; if (sim2.state==='running' && (g>3||g<-0.6||Math.abs(sim2.telemetry.gLat)>1.2)) peaks.push(`s=${sim2.s.toFixed(0)} g=${g.toFixed(2)} lat=${sim2.telemetry.gLat.toFixed(2)} v=${sim2.v.toFixed(1)}`); }
  console.log([...new Set(peaks.map(p=>p.split(' ')[0]))].slice(0,40).join(' '), peaks.slice(0,8));
}
