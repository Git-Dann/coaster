/**
 * Layered outdoor ambience. Continuous beds (wind, water, rain, snow air, night air) are built once and crossfaded with a
 * ~1.5 s time constant whenever the environment changes. Sparse events (birdsong, crickets, rain droplets) are scheduled
 * by countdown timers advanced from `update(dt)` — no setInterval, and nothing runs while the app isn't rendering.
 */
import type { Biome, EnvironmentAudioState, Weather } from './types';
import { SmoothParam, VoiceLimiter, clamp, clamp01, eventBus, lfo, loopNoise, pick, playNoise, playTone, rand, type NoiseBank } from './synth';

const FADE_TC = 1.5;

const WIND_BY_BIOME: Readonly<Record<Biome, number>> = { meadow: 0.25, woodland: 0.18, alpine: 0.55, coastal: 0.4, autumn: 0.3, winter: 0.5 };
const WIND_BY_WEATHER: Readonly<Record<Weather, number>> = {
  clear: 0, 'partly-cloudy': 0.05, overcast: 0.12, 'light-rain': 0.1, rain: 0.18, snow: 0.08, mist: -0.1, 'golden-haze': -0.05,
};
const BIRDS_BY_BIOME: Readonly<Record<Biome, number>> = { meadow: 1, woodland: 1.3, alpine: 0.4, coastal: 0.5, autumn: 0.7, winter: 0.25 };
const BIRDS_BY_WEATHER: Readonly<Record<Weather, number>> = {
  clear: 1, 'partly-cloudy': 0.9, overcast: 0.55, 'light-rain': 0, rain: 0, snow: 0.15, mist: 0.45, 'golden-haze': 1,
};
const INSECTS_BY_BIOME: Readonly<Record<Biome, number>> = { meadow: 1, woodland: 0.8, alpine: 0.3, coastal: 0.5, autumn: 0.5, winter: 0 };

const isNight = (h: number): boolean => h >= 21 || h < 5;

/** Bird "species": base pitch, sweep ratio, chirp length and vibrato — enough variety to avoid a single repeated call. */
interface Species { f: number; sweep: number; dur: number; vib: number; min: number; max: number }
const SPECIES: readonly [Species, ...Species[]] = [
  { f: 3200, sweep: 1.35, dur: 0.07, vib: 28, min: 2, max: 5 }, // quick rising tweets
  { f: 4200, sweep: 0.7, dur: 0.05, vib: 34, min: 3, max: 6 }, // falling twitter
  { f: 2400, sweep: 1.12, dur: 0.16, vib: 18, min: 1, max: 3 }, // slower warbled whistle
  { f: 2900, sweep: 0.85, dur: 0.11, vib: 22, min: 2, max: 4 },
];

export class Ambience {
  private readonly ctx: BaseAudioContext;
  private readonly noise: NoiseBank;
  private readonly dest: AudioNode;
  private readonly voices: VoiceLimiter;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly nodes: AudioNode[] = [];

  private readonly windGain: SmoothParam;
  private readonly waterGain: SmoothParam;
  private readonly waterCutoff: SmoothParam;
  private readonly swellDepth: SmoothParam;
  private readonly rainGain: SmoothParam;
  private readonly snowGain: SmoothParam;
  private readonly nightGain: SmoothParam;

  private birdTimer = rand(1, 4);
  private cricketTimer = rand(0.5, 2);
  private dropTimer = 0.2;

  constructor(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode, voices: VoiceLimiter) {
    this.ctx = ctx;
    this.noise = noise;
    this.dest = dest;
    this.voices = voices;

    // Wind: brown noise, band-passed, with two very slow LFOs on loudness and colour so gusts breathe.
    const wind = this.bed(noise.brown, 'bandpass', 420, 0.5);
    this.windGain = wind.level;
    this.track(lfo(ctx, 0.05, 0.35, wind.am.gain));
    this.track(lfo(ctx, 0.031, 160, wind.filter.frequency));

    // Water: pink noise; a slow swell LFO is deep for sea waves and shallow for a babbling river.
    const water = this.bed(noise.pink, 'lowpass', 1200, 0.4);
    this.waterGain = water.level;
    this.waterCutoff = new SmoothParam(water.filter.frequency, FADE_TC, 1200);
    const swell = lfo(ctx, 0.085, 0.1, water.am.gain);
    this.track(swell);
    this.swellDepth = new SmoothParam(swell.depth.gain, FADE_TC, 0.1);

    // Rain: broadband hiss shaped to sit softly (no harsh top end).
    const rain = this.bed(noise.white, 'bandpass', 2400, 0.35);
    this.rainGain = rain.level;

    // Snow / mist: very soft muffled air.
    const snow = this.bed(noise.brown, 'lowpass', 380, 0.5);
    this.snowGain = snow.level;

    // Night air: a whisper of high band noise under the crickets.
    const night = this.bed(noise.pink, 'bandpass', 5200, 2.5);
    this.nightGain = night.level;
  }

  private track(l: { osc: OscillatorNode; depth: GainNode }): void {
    this.sources.push(l.osc);
    this.nodes.push(l.depth);
  }

  /** noise → filter → am (LFO-modulatable) → level (crossfaded) → dest */
  private bed(buffer: AudioBuffer, type: BiquadFilterType, freq: number, q: number) {
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const am = this.ctx.createGain();
    am.gain.value = 0.65;
    const out = this.ctx.createGain();
    out.gain.value = 0;
    filter.connect(am).connect(out).connect(this.dest);
    this.sources.push(loopNoise(this.ctx, buffer, filter));
    this.nodes.push(filter, am, out);
    return { filter, am, level: new SmoothParam(out.gain, FADE_TC, 0) };
  }

  update(s: EnvironmentAudioState, dt: number): void {
    const now = this.ctx.currentTime;
    const hour = ((s.hour % 24) + 24) % 24;
    const night = isNight(hour);
    const coastal = s.biome === 'coastal';
    const water = clamp01(s.water);

    const wind = WIND_BY_BIOME[s.biome] + WIND_BY_WEATHER[s.weather] + Math.min(0.35, Math.max(0, s.cameraHeight) / 120);
    this.windGain.set(clamp(wind, 0.05, 0.9) * 0.4, now);

    this.waterGain.set(water * (coastal ? 0.45 : 0.32), now);
    this.waterCutoff.set(coastal ? 650 : 1500, now);
    this.swellDepth.set(coastal ? 0.5 : 0.08, now);

    const rain = s.weather === 'rain' ? 0.3 : s.weather === 'light-rain' ? 0.14 : 0;
    this.rainGain.set(rain, now);
    this.snowGain.set(s.weather === 'snow' ? 0.14 : s.weather === 'mist' ? 0.05 : 0, now);

    const insects = night && s.weather !== 'rain' && s.weather !== 'snow' ? INSECTS_BY_BIOME[s.biome] * (s.weather === 'light-rain' ? 0.3 : 1) : 0;
    this.nightGain.set(insects * 0.035, now);

    const step = clamp(dt, 0, 0.5); // tolerate long frames without bursts of queued events

    // Birds: dawn chorus boost, fade at dusk, none at night or in rain.
    let birds = 0;
    if (!night) {
      const dawn = hour >= 5 && hour < 8 ? 1.5 : hour >= 19 ? 0.5 : 1;
      birds = BIRDS_BY_BIOME[s.biome] * BIRDS_BY_WEATHER[s.weather] * dawn;
    }
    this.birdTimer -= step;
    if (this.birdTimer <= 0) {
      if (birds > 0.01) {
        this.birdPhrase(now);
        this.birdTimer = rand(0.5, 1.6) * (4 / birds);
      } else this.birdTimer = 2;
    }

    this.cricketTimer -= step;
    if (this.cricketTimer <= 0) {
      if (insects > 0.01) {
        this.cricket(now);
        this.cricketTimer = rand(0.5, 1.8) / insects;
      } else this.cricketTimer = 2;
    }

    this.dropTimer -= step;
    if (this.dropTimer <= 0) {
      if (rain > 0) {
        this.droplet(now);
        this.dropTimer = rand(0.3, 1.7) / (rain > 0.2 ? 7 : 3);
      } else this.dropTimer = 1;
    }
  }

  /** A short phrase of vibrato'd sine sweeps, placed somewhere in the stereo field. */
  private birdPhrase(now: number): void {
    const sp = pick(SPECIES);
    const count = sp.min + Math.floor(Math.random() * (sp.max - sp.min + 1));
    const estimate = count * (sp.dur + 0.12) + 0.1;
    if (!this.voices.tryAcquire(now, now + estimate)) return;
    const bus = eventBus(this.ctx, this.dest, rand(-0.85, 0.85), rand(0.35, 1));
    const base = sp.f * rand(0.92, 1.08);
    let t = now + 0.02;
    for (let i = 0; i < count; i++) {
      const dur = sp.dur * rand(0.8, 1.2);
      const f = base * rand(0.95, 1.06);
      const last = i === count - 1;
      playTone(this.ctx, bus.input, {
        at: t, freq: f, glide: f * sp.sweep, glideTime: dur, gain: 0.035, attack: 0.008, decay: dur,
        vibratoHz: sp.vib * rand(0.85, 1.15), vibratoDepth: f * 0.025, lowpass: 6000,
        onEnd: last ? bus.dispose : undefined,
      });
      t += dur + rand(0.04, 0.12);
    }
  }

  /** Gentle cricket: 3–4 soft sine pulses around 4.3 kHz. */
  private cricket(now: number): void {
    if (!this.voices.tryAcquire(now, now + 0.25)) return;
    const bus = eventBus(this.ctx, this.dest, rand(-0.9, 0.9), rand(0.4, 1));
    const f = rand(4000, 4600);
    const pulses = 3 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < pulses; i++) {
      playTone(this.ctx, bus.input, {
        at: now + 0.02 + i * 0.045, freq: f, gain: 0.012, attack: 0.004, decay: 0.022, onEnd: i === pulses - 1 ? bus.dispose : undefined,
      });
    }
  }

  /** Sparse droplet tick: a tiny band-passed noise blip with a pitched hint. */
  private droplet(now: number): void {
    if (!this.voices.tryAcquire(now, now + 0.05)) return;
    const bus = eventBus(this.ctx, this.dest, rand(-1, 1), rand(0.3, 1));
    const f = rand(1800, 3600);
    playNoise(this.ctx, bus.input, { buffer: this.noise.white, at: now + 0.01, gain: 0.03, decay: 0.008, freq: f, q: 3 });
    playTone(this.ctx, bus.input, { at: now + 0.01, freq: f, glide: f * 1.3, gain: 0.012, attack: 0.001, decay: 0.025, onEnd: bus.dispose });
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of this.nodes) n.disconnect();
  }
}
