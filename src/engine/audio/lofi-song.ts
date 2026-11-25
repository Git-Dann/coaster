/**
 * Song generator for the lo-fi soundtrack: picks tempo, swing, key, progression, groove and section layout for one
 * 2–3 minute "song". Pure (no Web Audio), unit tested.
 *
 * Structure: intro (keys + crackle) → groove → variation (drums dropped with a melody, or full groove with a melody)
 * → groove → outro (drums thin out, velocities fade, a final chord rings into the next song's intro).
 *
 * Rhythm tables are in 16th-note steps within a 4/4 bar (0..15). Swing is applied later, at scheduling time.
 */
import { PROGRESSIONS, buildProgression, rint, rpick, rrange, type Rng, type VoicedChord } from './lofi-theory';

export const BPM_MIN = 72;
export const BPM_MAX = 82;
export const SONG_MIN_SECONDS = 120;
export const SONG_MAX_SECONDS = 180;

/** Keys comping: [step, length in steps]. A hit at step 14 anticipates the next bar's chord. */
export type Hits = readonly (readonly [number, number])[];
/** Bass: [step, interval above the chord root (or APPROACH), length in steps]. */
export type BassHits = readonly (readonly [number, number, number])[];
/** Chromatic approach note into the next chord's root. */
export const APPROACH = -1;

export const COMP_GROOVE: readonly Hits[] = [
  [[0, 7], [7, 9]],
  [[0, 5], [6, 4], [10, 6]],
  [[2, 6], [8, 3], [11, 5]],
  [[0, 3], [3, 7], [14, 2]],
  [[0, 6], [6, 8], [14, 2]],
  [[0, 10], [10, 6]],
];
/** For bars with a chord change on beat 3: always a hit on step 8. */
export const COMP_SPLIT: readonly Hits[] = [
  [[0, 6], [6, 2], [8, 8]],
  [[0, 4], [4, 4], [8, 6], [14, 2]],
  [[0, 8], [8, 8]],
  [[0, 3], [3, 5], [8, 3], [11, 5]],
];
/** Intro / outro: long, airy chords. */
export const COMP_SPARSE: readonly Hits[] = [
  [[0, 16]],
  [[0, 10], [10, 6]],
  [[0, 8], [8, 8]],
];
export const COMP_FINAL: Hits = [[0, 16]];

export const BASS_GROOVE: readonly BassHits[] = [
  [[0, 0, 6], [7, 7, 2], [10, 0, 4]],
  [[0, 0, 9], [10, 12, 2], [14, APPROACH, 2]],
  [[0, 0, 3], [3, 0, 4], [10, 7, 3], [14, APPROACH, 2]],
  [[0, 0, 6], [6, 0, 2], [10, 7, 4]],
];
export const BASS_SPLIT: BassHits = [[0, 0, 6], [6, 7, 2], [8, 0, 6], [14, APPROACH, 2]];

/** Kick steps per bar (boom-bap feel), and the variant used on phrase-ending "fill" bars. */
export const KICK_PATTERNS: readonly (readonly number[])[] = [[0, 10], [0, 7, 10], [0, 3, 10], [0, 8, 10], [0, 6, 10]];
export const KICK_FILLS: readonly (readonly number[])[] = [[0, 10, 11], [0, 7], [0, 6, 9]];

export type SectionKind = 'intro' | 'groove' | 'break' | 'melody' | 'outro';
export type DrumLevel = 'none' | 'light' | 'full';

export interface Section {
  kind: SectionKind;
  bars: number;
  drums: DrumLevel;
  bass: boolean;
  melody: boolean;
}

export interface Song {
  bpm: number;
  /** 16th-note swing ratio (0.5 = straight). */
  swing: number;
  keyPc: number;
  progression: string;
  loopBars: 4 | 8;
  chords: VoicedChord[];
  /** Chord index for each beat of the loop (length loopBars * 4). */
  chordAtBeat: number[];
  sections: Section[];
  bars: number;
  barSeconds: number;
  stepSeconds: number;
  /** Delay applied to off-beat 16ths. */
  swingOffset: number;
  duration: number;
  kick: readonly number[];
  kickFill: readonly number[];
  snare: 'brush' | 'rim';
  /** Extra swung 16th hats between the 8ths. */
  hat16: boolean;
  /** Indices into COMP_GROOVE / BASS_GROOVE this song draws from, so it keeps a consistent feel. */
  comp: number[];
  bass: number[];
}

/** Picks `n` distinct indices from 0..size-1. */
function subset(rng: Rng, size: number, n: number): number[] {
  const all = Array.from({ length: size }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = all[i] ?? 0;
    all[i] = all[j] ?? 0;
    all[j] = t;
  }
  return all.slice(0, Math.max(1, Math.min(size, n)));
}

/** Generates a new song. `prevKeyPc` (if any) is avoided so consecutive songs change key. */
export function generateSong(rng: Rng, prevKeyPc = -1): Song {
  const bpm = Math.round(rrange(rng, BPM_MIN, BPM_MAX) * 10) / 10;
  const swing = rrange(rng, 0.55, 0.6);
  let keyPc = rint(rng, 0, 11);
  if (keyPc === prevKeyPc) keyPc = (keyPc + rint(rng, 2, 10)) % 12;
  const template = rpick(rng, PROGRESSIONS);
  const loopBars: 4 | 8 = rng() < 0.5 ? 4 : 8;
  const chords = buildProgression(rng, keyPc, template, loopBars === 8);
  const chordAtBeat: number[] = [];
  chords.forEach((c, i) => {
    for (let b = 0; b < c.beats; b++) chordAtBeat.push(i);
  });

  const barSeconds = 240 / bpm;
  const stepSeconds = barSeconds / 16;
  // Whole 4-bar phrases, landing between 2 and 3 minutes.
  let bars = Math.round(rrange(rng, 130, 170) / barSeconds / 4) * 4;
  while (bars * barSeconds < SONG_MIN_SECONDS) bars += 4;
  while (bars * barSeconds > SONG_MAX_SECONDS) bars -= 4;

  const intro = 4;
  const outro = 4;
  const variation = 8;
  const middle = bars - intro - outro - variation;
  const grooveA = Math.max(4, Math.floor(middle / 8) * 4);
  const grooveB = middle - grooveA;
  const breakdown = rng() < 0.55;
  const sections: Section[] = [
    { kind: 'intro', bars: intro, drums: 'none', bass: false, melody: false },
    { kind: 'groove', bars: grooveA, drums: 'full', bass: true, melody: false },
    breakdown
      ? { kind: 'break', bars: variation, drums: rng() < 0.5 ? 'none' : 'light', bass: true, melody: true }
      : { kind: 'melody', bars: variation, drums: 'full', bass: true, melody: true },
    { kind: 'groove', bars: grooveB, drums: 'full', bass: true, melody: rng() < 0.4 },
    { kind: 'outro', bars: outro, drums: 'light', bass: true, melody: false },
  ];

  return {
    bpm,
    swing,
    keyPc,
    progression: template.name,
    loopBars,
    chords,
    chordAtBeat,
    sections,
    bars,
    barSeconds,
    stepSeconds,
    swingOffset: (2 * swing - 1) * stepSeconds,
    duration: bars * barSeconds,
    kick: rpick(rng, KICK_PATTERNS),
    kickFill: rpick(rng, KICK_FILLS),
    snare: rng() < 0.6 ? 'brush' : 'rim',
    hat16: rng() < 0.4,
    comp: subset(rng, COMP_GROOVE.length, 3),
    bass: subset(rng, BASS_GROOVE.length, 2),
  };
}
