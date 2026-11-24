/**
 * Look-ahead step sequencer for the lo-fi soundtrack. Pure (no Web Audio): it turns songs into timed note events on the
 * audio clock and hands them to a sink, which the `Music` class turns into sound.
 *
 * Timing model:
 * - A 16th-note grid in audio-clock seconds (`gridTime`). Each call to `advanceTo(now)` schedules every grid step that
 *   falls before `now + lookahead`, so timing is sample-accurate regardless of frame rate; no timers are involved.
 * - Swing delays odd 16ths by `(2 * swing - 1) * step`; parts sit slightly behind the beat (snare and keys most) and get
 *   a few milliseconds of humanising jitter.
 * - If ticks stall (tab in the background, long frame), missed steps are skipped silently rather than scheduled late;
 *   a long stall resumes on the next bar line. No burst of piled-up notes.
 */
import { MELODY_HIGH, MELODY_LOW, chordPitchClasses, melodyPhrase, rpick, rrange, type PhraseNote, type Rng } from './lofi-theory';
import {
  APPROACH, BASS_GROOVE, BASS_SPLIT, COMP_FINAL, COMP_GROOVE, COMP_SPARSE, COMP_SPLIT, generateSong,
  type BassHits, type Hits, type Section, type Song,
} from './lofi-song';

export type Instrument = 'kick' | 'snare' | 'rim' | 'ghost' | 'hat' | 'openhat' | 'keys' | 'bass' | 'lead' | 'pop';

export interface MusicEvent {
  inst: Instrument;
  /** Audio-clock start time (s). */
  time: number;
  /** MIDI note (pitched instruments only). */
  midi: number;
  /** 0..1. */
  vel: number;
  /** Gate length (s) for sustained instruments. */
  dur: number;
}

/** Receives a reused event object: copy it if you keep it. */
export type EventSink = (ev: Readonly<MusicEvent>) => void;

/** How late the grid may fall behind `now` before missed steps are skipped instead of played. */
const MAX_LATENESS = 0.05;
/** Up to this many missed steps are skipped in place (keeps the groove position); beyond, resume on a bar line. */
const MAX_SKIP_STEPS = 64;
const MAX_STEPS_PER_CALL = 256;

const EMPTY_SECTION: Section = { kind: 'intro', bars: 1, drums: 'none', bass: false, melody: false };

export class LofiSequencer {
  private readonly rng: Rng;
  private readonly sink: EventSink;
  private readonly ev: MusicEvent = { inst: 'kick', time: 0, midi: 0, vel: 0, dur: 0 };

  private current: Song | null = null;
  private prevKey = -1;
  private songs = 0;
  private bar = 0;
  private step = 0;
  private gridTime = 0;

  // Per-bar state, chosen at step 0 of each bar.
  private section: Section = EMPTY_SECTION;
  private sectionIndex = 0;
  private barInSection = 0;
  private comp: Hits = COMP_FINAL;
  private bassHits: BassHits = BASS_SPLIT;
  private fill = false;
  private drop = false;
  private phrase: PhraseNote[] = [];
  private lastLead = 72;

  constructor(rng: Rng, sink: EventSink) {
    this.rng = rng;
    this.sink = sink;
  }

  get song(): Song | null {
    return this.current;
  }

  /** Number of songs generated so far. */
  get songCount(): number {
    return this.songs;
  }

  get position(): { bar: number; step: number; time: number } {
    return { bar: this.bar, step: this.step, time: this.gridTime };
  }

  /** Starts a fresh song whose first downbeat is at `at`. */
  start(at: number): void {
    this.newSong();
    this.gridTime = at;
  }

  /** Schedules every step before `min(now + lookahead, stopAt)`. */
  advanceTo(now: number, lookahead: number, stopAt = Infinity): void {
    if (!this.current || !Number.isFinite(now)) return;
    if (now - this.gridTime > MAX_LATENESS) this.skipTo(now);
    const horizon = Math.min(now + lookahead, stopAt);
    for (let n = 0; this.gridTime < horizon && n < MAX_STEPS_PER_CALL; n++) {
      this.scheduleStep(this.gridTime);
      this.advance();
    }
  }

  /** Drops missed steps without scheduling them. */
  private skipTo(now: number): void {
    for (let n = 0; n < MAX_SKIP_STEPS && this.gridTime < now + 0.02; n++) this.advance();
    if (this.gridTime >= now + 0.02) return;
    // Long stall: pick up again on the next bar line, shortly after now.
    if (this.step !== 0) {
      this.step = 0;
      this.bar++;
      if (this.current && this.bar >= this.current.bars) this.newSong();
    }
    this.gridTime = now + 0.05;
    this.phrase.length = 0;
  }

  private newSong(): void {
    this.current = generateSong(this.rng, this.prevKey);
    this.prevKey = this.current.keyPc;
    this.songs++;
    this.bar = 0;
    this.step = 0;
    this.phrase.length = 0;
  }

  private advance(): void {
    const song = this.current;
    if (!song) return;
    this.gridTime += song.stepSeconds;
    this.step++;
    if (this.step >= 16) {
      this.step = 0;
      this.bar++;
      if (this.bar >= song.bars) this.newSong();
    }
  }

  private emit(inst: Instrument, time: number, midi: number, vel: number, dur: number): void {
    const ev = this.ev;
    ev.inst = inst;
    ev.time = time;
    ev.midi = midi;
    ev.vel = vel;
    ev.dur = dur;
    this.sink(ev);
  }

  private chordIndexAt(song: Song, loopStep: number): number {
    const loopLen = song.loopBars * 16;
    const s = ((loopStep % loopLen) + loopLen) % loopLen;
    return song.chordAtBeat[Math.floor(s / 4)] ?? 0;
  }

  private loopStepBase(song: Song): number {
    return (this.barInSection % song.loopBars) * 16;
  }

  /** Locates the section and chooses this bar's patterns. */
  private beginBar(song: Song): void {
    let start = 0;
    this.sectionIndex = 0;
    for (let i = 0; i < song.sections.length; i++) {
      const bars = song.sections[i]?.bars ?? 0;
      this.sectionIndex = i;
      if (this.bar < start + bars || i === song.sections.length - 1) break;
      start += bars;
    }
    this.section = song.sections[this.sectionIndex] ?? EMPTY_SECTION;
    this.barInSection = this.bar - start;

    const rng = this.rng;
    const sec = this.section;
    const base = this.loopStepBase(song);
    const split = this.chordIndexAt(song, base) !== this.chordIndexAt(song, base + 8);
    const lastBar = this.bar === song.bars - 1;
    const fresh = this.barInSection % 2 === 0 || rng() < 0.5;

    if (lastBar) this.comp = COMP_FINAL;
    else if (sec.kind === 'intro' || sec.kind === 'outro') this.comp = split ? COMP_SPARSE[2] ?? COMP_FINAL : rpick(rng, COMP_SPARSE);
    else if (split) this.comp = rpick(rng, COMP_SPLIT);
    else if (fresh || COMP_SPLIT.includes(this.comp) || COMP_SPARSE.includes(this.comp)) this.comp = COMP_GROOVE[rpick(rng, song.comp)] ?? COMP_FINAL;

    if (split) this.bassHits = BASS_SPLIT;
    else if (fresh || this.bassHits === BASS_SPLIT) this.bassHits = BASS_GROOVE[rpick(rng, song.bass)] ?? BASS_SPLIT;

    this.fill = this.barInSection % 4 === 3;
    // A classic lo-fi move: the drums stop for the last beat before a new section.
    this.drop = this.barInSection === sec.bars - 1 && this.sectionIndex < song.sections.length - 1 && rng() < 0.6;

    if (!sec.melody) this.phrase.length = 0;
    else if (this.barInSection % 2 === 0) {
      this.phrase = rng() < 0.65
        ? melodyPhrase(rng, song.keyPc, (st) => {
          const c = song.chords[this.chordIndexAt(song, base + st)];
          return c ? chordPitchClasses(c.rootPc, c.quality) : [];
        }, this.lastLead)
        : [];
      const last = this.phrase[this.phrase.length - 1];
      if (last) this.lastLead = Math.min(MELODY_HIGH - 5, Math.max(MELODY_LOW + 3, last.midi));
    }
  }

  /** Intro swells in, outro fades out; breaks sit a touch lower. */
  private dynamics(s: number): number {
    const sec = this.section;
    const p = (this.barInSection + s / 16) / Math.max(1, sec.bars);
    if (sec.kind === 'intro') return 0.6 + 0.4 * p;
    if (sec.kind === 'outro') return 1 - 0.45 * p;
    if (sec.kind === 'break') return 0.92;
    return 1;
  }

  private scheduleStep(t: number): void {
    const song = this.current;
    if (!song) return;
    if (this.step === 0) this.beginBar(song);
    const rng = this.rng;
    const s = this.step;
    const sec = this.section;
    const swingT = t + (s % 2 === 1 ? song.swingOffset : 0);
    const gain = this.dynamics(s);
    const loopStep = this.loopStepBase(song) + s;
    const lastBar = this.bar === song.bars - 1;
    const outroTail = sec.kind === 'outro' && this.barInSection >= sec.bars - 2;

    // ----- drums
    const drums = lastBar || (outroTail && sec.drums === 'light') ? 'none' : sec.drums;
    if (drums !== 'none' && !(this.drop && s >= 12)) {
      if (drums === 'full') {
        const kicks = this.fill && rng() < 0.7 ? song.kickFill : song.kick;
        if (kicks.includes(s)) this.emit('kick', swingT + rrange(rng, 0, 0.004), 0, gain * (s === 0 ? 0.95 : 0.78), 0);
        if (s === 4 || s === 12) this.emit(song.snare === 'brush' ? 'snare' : 'rim', swingT + 0.014 + rrange(rng, 0, 0.006), 0, gain * rrange(rng, 0.72, 0.85), 0);
        else if ((s === 7 || s === 15 || (this.fill && s === 13)) && rng() < (this.fill ? 0.5 : 0.16)) this.emit('ghost', swingT + 0.01, 0, gain * rrange(rng, 0.18, 0.3), 0);
      } else {
        if (s === 0) this.emit('kick', swingT, 0, gain * 0.55, 0);
        if (s === 12) this.emit('rim', swingT + 0.014, 0, gain * 0.45, 0);
      }
      const eighth = s % 2 === 0;
      if (eighth || (song.hat16 && drums === 'full' && rng() < 0.45)) {
        const accent = s % 4 === 0 ? 1 : eighth ? 0.78 : 0.55;
        const level = drums === 'full' ? 1 : 0.7;
        const open = drums === 'full' && s === 14 && (this.fill ? rng() < 0.6 : rng() < 0.06);
        this.emit(open ? 'openhat' : 'hat', swingT + rrange(rng, 0, 0.006), 0, gain * level * accent * rrange(rng, 0.7, 1), 0);
      }
    }

    // ----- keys (Rhodes comping)
    for (const [hs, len] of this.comp) {
      if (hs !== s) continue;
      const ci = this.chordIndexAt(song, loopStep + (hs >= 14 ? 16 - hs : 0));
      const chord = song.chords[ci];
      if (!chord) continue;
      const dur = lastBar ? song.barSeconds * 1.8 : len * song.stepSeconds * 0.94;
      const accent = hs === 0 ? 1 : 0.86;
      const sparse = sec.kind === 'intro' || sec.kind === 'outro';
      const roll = sparse ? rrange(rng, 0.012, 0.03) : rrange(rng, 0.003, 0.01);
      const n = chord.notes.length;
      for (let i = 0; i < n; i++) {
        const midi = chord.notes[i] ?? 60;
        const vel = gain * accent * rrange(rng, 0.5, 0.66) * (i === n - 1 ? 1.12 : 1);
        this.emit('keys', swingT + 0.012 + i * roll + rrange(rng, -0.004, 0.006), midi, vel, dur);
      }
    }

    // ----- bass
    const bassOn = sec.bass && !(sec.kind === 'outro' && outroTail);
    if (bassOn) {
      for (const [hs, deg, len] of this.bassHits) {
        if (hs !== s) continue;
        const chord = song.chords[this.chordIndexAt(song, loopStep)];
        if (!chord) continue;
        const root = chord.bassRoot;
        let midi = root + deg;
        if (deg === APPROACH) {
          const target = song.chords[this.chordIndexAt(song, loopStep + 16 - hs)]?.bassRoot ?? root;
          midi = target === root ? root + 7 : target > root ? target - 1 : target + 1;
        }
        const vel = gain * (hs === 0 ? 0.95 : 0.75) * rrange(rng, 0.9, 1.05);
        this.emit('bass', swingT + 0.006 + rrange(rng, 0, 0.006), midi, vel, len * song.stepSeconds * 0.9);
      }
    } else if (lastBar && s === 0) {
      const chord = song.chords[this.chordIndexAt(song, loopStep)];
      if (chord) this.emit('bass', swingT + 0.006, chord.bassRoot, gain * 0.8, song.barSeconds * 1.2);
    }

    // ----- melody
    if (this.phrase.length > 0) {
      const ps = (this.barInSection % 2) * 16 + s;
      for (const note of this.phrase) {
        if (note.step !== ps) continue;
        this.emit('lead', swingT + 0.01 + rrange(rng, -0.004, 0.008), note.midi, gain * note.vel, note.len * song.stepSeconds);
      }
    }

    // ----- the occasional louder vinyl pop
    if (rng() < 0.025) this.emit('pop', t + rng() * song.stepSeconds, 0, rrange(rng, 0.3, 1), 0);
  }
}
