/**
 * Continuous train sound. All nodes are built once (lazily, after unlock) and then only steered by smoothed parameter
 * targets each frame — `update` performs no allocation and no node creation.
 *
 * Signal flow:
 *   roll / rumble / ring / brake / launch / lift / clack → body ──┐
 *                                                    wind / air ──┴→ distance gain → stereo panner → coaster bus
 *
 * Layers:
 * - roll: looping pink noise through a low-pass whose cutoff and gain follow |speed| (silent at rest).
 * - rumble: brown noise + a low triangle "board" tone, low-passed — prominent for timber, faint for steel.
 * - ring: two inharmonic band-passes on pink noise — the gentle singing of steel rails, faint for timber.
 * - wind: band-passed white noise rising with speed², much stronger when riding; air: a higher whoosh during airtime.
 * - brake: soft high hiss ∝ braking; launch: rising band-passed whoosh; lift: quiet low hum while the chain pulls.
 */
import type { BuildMaterial, CoasterAudioState } from './types';
import { SmoothParam, clamp, clamp01, loopNoise, playNoise, playTone, smoothstep, vary, type NoiseBank } from './synth';

const GAIN_TC = 0.12;
const FILTER_TC = 0.08;
const SPATIAL_TC = 0.2;
/** Speed (m/s) treated as "fast" for normalisation. */
const V_REF = 30;

export class CoasterAudio {
  private readonly ctx: BaseAudioContext;
  private readonly noise: NoiseBank;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode;
  /** Mechanical layers + clacks mix here (before distance/pan). */
  private readonly body: GainNode;

  private readonly distanceGain: SmoothParam;
  private readonly pan: SmoothParam;
  private readonly rollGain: SmoothParam;
  private readonly rollCutoff: SmoothParam;
  private readonly rumbleGain: SmoothParam;
  private readonly rumbleCutoff: SmoothParam;
  private readonly rumbleTone: SmoothParam;
  private readonly ringGain: SmoothParam;
  private readonly ringFreqA: SmoothParam;
  private readonly ringFreqB: SmoothParam;
  private readonly windGain: SmoothParam;
  private readonly windFreq: SmoothParam;
  private readonly airGain: SmoothParam;
  private readonly brakeGain: SmoothParam;
  private readonly launchGain: SmoothParam;
  private readonly launchFreq: SmoothParam;
  private readonly liftGain: SmoothParam;
  /** Chain clacks get their own, gentler distance roll-off: a lift is heard right across the park. */
  private readonly clackOut: GainNode;
  private readonly clackDistance: SmoothParam;

  private material: BuildMaterial = 'timber';

  constructor(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode) {
    this.ctx = ctx;
    this.noise = noise;
    this.panner = ctx.createStereoPanner();
    this.out = ctx.createGain();
    this.out.connect(this.panner).connect(dest);
    this.distanceGain = new SmoothParam(this.out.gain, SPATIAL_TC, 0);
    this.pan = new SmoothParam(this.panner.pan, SPATIAL_TC, 0);
    this.body = ctx.createGain();
    this.body.connect(this.out);
    this.clackOut = ctx.createGain();
    this.clackOut.connect(this.panner);
    this.clackDistance = new SmoothParam(this.clackOut.gain, SPATIAL_TC, 0);

    // roll
    const roll = this.chain(noise.pink, 'lowpass', 200, 0.6);
    this.rollGain = roll.gain;
    this.rollCutoff = roll.freq;

    // rumble (noise + low board tone share one filter)
    const rumble = this.chain(noise.brown, 'lowpass', 90, 0.8);
    this.rumbleGain = rumble.gain;
    this.rumbleCutoff = rumble.freq;
    const tone = ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.value = 34;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.35;
    tone.connect(toneGain).connect(rumble.filter);
    tone.start();
    this.sources.push(tone);
    this.rumbleTone = new SmoothParam(tone.frequency, FILTER_TC, 34);

    // steel ring: two narrow inharmonic bands summed into one gain
    const ringA = this.chain(noise.pink, 'bandpass', 600, 9);
    this.ringGain = ringA.gain;
    this.ringFreqA = ringA.freq;
    const ringBFilter = ctx.createBiquadFilter();
    ringBFilter.type = 'bandpass';
    ringBFilter.Q.value = 11;
    this.ringFreqB = new SmoothParam(ringBFilter.frequency, FILTER_TC, 906);
    ringBFilter.connect(ringA.gainNode);
    this.sources.push(loopNoise(ctx, noise.pink, ringBFilter));

    // wind + airtime whoosh (go to `out` directly — they are the rider's own air, still distance-scaled)
    const wind = this.chain(noise.white, 'bandpass', 400, 0.6, this.out);
    this.windGain = wind.gain;
    this.windFreq = wind.freq;
    const air = this.chain(noise.pink, 'bandpass', 950, 0.9, this.out);
    this.airGain = air.gain;

    // brake hiss
    const brake = this.chain(noise.white, 'highpass', 2600, 0.5);
    this.brakeGain = brake.gain;
    const brakeSoften = ctx.createBiquadFilter();
    brakeSoften.type = 'lowpass';
    brakeSoften.frequency.value = 6000;
    brake.gainNode.disconnect();
    brake.gainNode.connect(brakeSoften).connect(this.body);

    // launch whoosh
    const launch = this.chain(noise.pink, 'bandpass', 250, 1.2);
    this.launchGain = launch.gain;
    this.launchFreq = launch.freq;

    // lift hum: a fundamental and soft octave, low-passed
    const liftFilter = ctx.createBiquadFilter();
    liftFilter.type = 'lowpass';
    liftFilter.frequency.value = 320;
    const liftOut = ctx.createGain();
    liftOut.gain.value = 0;
    liftFilter.connect(liftOut).connect(this.body);
    this.liftGain = new SmoothParam(liftOut.gain, 0.25, 0);
    for (const [f, type, g] of [[52, 'triangle', 0.6], [104, 'sine', 0.3]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og).connect(liftFilter);
      o.start();
      this.sources.push(o);
    }
  }

  /** Looping noise → filter → gain (starting silent) → dest. */
  private chain(buffer: AudioBuffer, type: BiquadFilterType, freq: number, q: number, dest: AudioNode = this.body) {
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    const gainNode = this.ctx.createGain();
    gainNode.gain.value = 0;
    filter.connect(gainNode).connect(dest);
    this.sources.push(loopNoise(this.ctx, buffer, filter));
    return {
      filter,
      gainNode,
      gain: new SmoothParam(gainNode.gain, GAIN_TC, 0),
      freq: new SmoothParam(filter.frequency, FILTER_TC, freq),
    };
  }

  update(s: CoasterAudioState): void {
    const now = this.ctx.currentTime;
    this.material = s.material;
    const steel = s.material === 'steel';
    const v = Math.min(60, Math.abs(Number.isFinite(s.speed) ? s.speed : 0));
    const vn = Math.min(1, v / V_REF);
    const moving = smoothstep(v / 3); // 0 at rest → 1 by ~3 m/s
    const riding = s.riding;

    this.distanceGain.set(riding ? 1 : 1 / (1 + Math.max(0, s.distance) / 15), now);
    this.clackDistance.set(riding ? 1 : 1 / (1 + Math.max(0, s.distance) / 45), now);
    this.pan.set(riding ? 0 : clamp(s.pan, -1, 1), now);

    const station = s.inStation ? 0.7 : 1;
    this.rollGain.set(moving * (0.18 + 0.32 * vn) * station * (riding ? 1.2 : 1), now);
    this.rollCutoff.set(Math.min(4500, (steel ? 260 : 180) + v * (steel ? 85 : 55)), now);

    this.rumbleGain.set(moving * (steel ? 0.08 : 0.5) * Math.pow(vn, 0.8), now);
    this.rumbleCutoff.set(70 + v * 4, now);
    this.rumbleTone.set(30 + v * 1.4, now);

    this.ringGain.set(moving * (steel ? 0.16 : 0.025) * vn, now);
    const ring = 480 + v * 18;
    this.ringFreqA.set(ring, now);
    this.ringFreqB.set(ring * 1.51, now);

    this.windGain.set(0.32 * vn * vn * (riding ? 1 : 0.3), now);
    this.windFreq.set(300 + v * 35, now);
    const airtime = s.verticalG < 0.3 && v > 4 ? clamp01((0.3 - s.verticalG) * 1.5 + 0.3) : 0;
    this.airGain.set(airtime * 0.14 * (riding ? 1 : 0.4), now, 0.08);

    this.brakeGain.set(0.16 * clamp01(s.braking) * Math.min(1, v / 3), now);
    this.launchGain.set(s.launching ? 0.2 * (0.3 + 0.7 * vn) : 0, now, s.launching ? 0.1 : 0.35);
    this.launchFreq.set(250 + v * 45, now);
    this.liftGain.set(s.liftEngaged ? 0.07 : 0, now);
  }

  /**
   * Chain-dog clack: a short click from the dog dropping into the next tooth, then a small wooden or
   * metal knock. Kept below ~2 kHz and soft-edged so it ticks along under the music, not over it.
   */
  clack(): number {
    const t = this.ctx.currentTime + 0.003;
    const steel = this.material === 'steel';
    const f = vary(steel ? 1700 : 1250, 0.06);
    playNoise(this.ctx, this.clackOut, { buffer: this.noise.white, at: t, gain: 0.2, decay: 0.012, freq: f, q: 1.6 });
    playNoise(this.ctx, this.clackOut, { buffer: this.noise.white, at: t + vary(0.03, 0.15), gain: 0.08, decay: 0.01, freq: f * 0.75, q: 1.6 });
    return playTone(this.ctx, this.clackOut, { at: t, freq: vary(steel ? 520 : 300, 0.05), gain: 0.11, decay: 0.06, attack: 0.001, type: 'triangle', lowpass: 1600 });
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.panner.disconnect();
  }
}
