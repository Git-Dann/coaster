/**
 * Music theory helpers for the generative lo-fi soundtrack. Pure functions with no Web Audio dependency, so they are unit
 * tested in Node.
 *
 * - A tiny seedable RNG (mulberry32) so songs are reproducible in tests.
 * - Jazzy chord qualities (maj7, maj9, 6/9, m7, m9, m11, 7, 9, 13, 9sus4) and rootless keyboard voicings.
 * - Voice leading: every chord is voiced by searching all octave placements of its pitch classes inside a warm low-mid
 *   register and picking the one that moves the fewest semitones from the previous voicing (with gentle penalties for
 *   wide spans, muddy low intervals and register drift).
 * - Progression templates in a major key (ii–V–I–vi, I–vi–ii–V, IV–iii–vi–ii–V, ...) with per-song quality substitutions.
 * - A pentatonic melody phrase generator: a random walk that lands on chord tones on strong beats and leaves lots of space.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Randomness

/** Returns a float in [0, 1). */
export type Rng = () => number;

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rrange = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo);

/** Integer in [lo, hi] inclusive. */
export const rint = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

/** Picks an element of a non-empty constant table. */
export function rpick<T>(rng: Rng, items: readonly T[]): T {
  const v = items[Math.floor(rng() * items.length)] ?? items[0];
  if (v === undefined) throw new Error('rpick: empty table');
  return v;
}

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

// ---------------------------------------------------------------------------------------------------------------------
// Chords

export type Quality = 'maj7' | 'maj9' | '6/9' | 'm7' | 'm9' | 'm11' | '7' | '9' | '13' | '9sus4';

/** Chord intervals in semitones above the root. */
export const QUALITY_INTERVALS: Readonly<Record<Quality, readonly number[]>> = {
  maj7: [0, 4, 7, 11],
  maj9: [0, 4, 7, 11, 14],
  '6/9': [0, 4, 7, 9, 14],
  m7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14],
  m11: [0, 3, 7, 10, 14, 17],
  '7': [0, 4, 7, 10],
  '9': [0, 4, 7, 10, 14],
  '13': [0, 4, 10, 14, 21],
  '9sus4': [0, 5, 7, 10, 14],
};

/** Colour substitutions used to vary a progression between songs and between loop halves. */
const QUALITY_ALTERNATIVES: Readonly<Record<Quality, readonly Quality[]>> = {
  maj7: ['maj9', '6/9'],
  maj9: ['maj7', '6/9'],
  '6/9': ['maj9', 'maj7'],
  m7: ['m9', 'm11'],
  m9: ['m7', 'm11'],
  m11: ['m9'],
  '7': ['9', '13'],
  '9': ['13', '9sus4'],
  '13': ['9'],
  '9sus4': ['9'],
};

/** All pitch classes (0–11) of a chord. */
export function chordPitchClasses(rootPc: number, quality: Quality): number[] {
  const out: number[] = [];
  for (const i of QUALITY_INTERVALS[quality]) {
    const pc = mod12(rootPc + i);
    if (!out.includes(pc)) out.push(pc);
  }
  return out;
}

/**
 * Pitch classes for a 4-note keyboard voicing. Five-plus-note chords are played rootless (the bass has the root), and the
 * fifth is the first colour tone dropped after that, as a jazz pianist would.
 */
export function voicingPitchClasses(rootPc: number, quality: Quality): number[] {
  let iv = [...QUALITY_INTERVALS[quality]];
  if (iv.length >= 5) iv = iv.slice(1);
  if (iv.length > 4) {
    const fifth = iv.indexOf(7);
    iv.splice(fifth >= 0 ? fifth : iv.length - 1, 1);
  }
  return iv.map((i) => mod12(rootPc + i));
}

// ---------------------------------------------------------------------------------------------------------------------
// Voice leading

/** Keys register: D3..E5 (≈147–659 Hz), so chords carry the 150–400 Hz warmth that phone speakers can reproduce. */
export const VOICING_LOW = 50;
export const VOICING_HIGH = 76;
const VOICING_CENTRE = 62;

/** Average semitone movement per voice between two voicings (nearest-note matching when sizes differ). */
export function voiceMovement(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let sum = 0;
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    return sum / a.length;
  }
  for (const n of b) {
    let best = Infinity;
    for (const m of a) best = Math.min(best, Math.abs(n - m));
    sum += best;
  }
  return sum / b.length;
}

/** Cost of a sorted candidate voicing; Infinity rejects it. */
function voicingCost(v: readonly number[], prev: readonly number[] | null): number {
  const lo = v[0] ?? 0;
  const hi = v[v.length - 1] ?? 0;
  const span = hi - lo;
  if (span > 16) return Infinity;
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1] ?? 0;
    const b = v[i] ?? 0;
    if (b - a < 1) return Infinity;
    // Low-interval limit: seconds below G3 turn to mud.
    if (a < 55 && b - a < 3) return Infinity;
  }
  let mean = 0;
  for (const n of v) mean += n;
  mean /= v.length;
  let cost = Math.abs(mean - VOICING_CENTRE) * (prev ? 0.35 : 1);
  if (span > 12) cost += (span - 12) * 0.6;
  if (prev) cost += voiceMovement(prev, v) * v.length;
  return cost;
}

/**
 * Voices `pcs` in the keys register, choosing the placement closest to `prev` (or near the centre for a first chord).
 * Returns a sorted array of distinct MIDI notes.
 */
export function voiceLead(pcs: readonly number[], prev: readonly number[] | null, rng: Rng): number[] {
  const options = pcs.map((pc) => {
    const o: number[] = [];
    for (let m = VOICING_LOW; m <= VOICING_HIGH; m++) if (mod12(m) === mod12(pc)) o.push(m);
    return o;
  });
  const cur = new Array<number>(pcs.length).fill(0);
  let best: number[] | null = null;
  let bestCost = Infinity;
  const search = (i: number): void => {
    if (i === pcs.length) {
      const v = [...cur].sort((x, y) => x - y);
      const c = voicingCost(v, prev);
      if (c === Infinity) return;
      const jittered = c + rng() * 0.25; // tiny tie-break so equal options don't always resolve the same way
      if (jittered < bestCost) {
        bestCost = jittered;
        best = v;
      }
      return;
    }
    for (const m of options[i] ?? []) {
      cur[i] = m;
      search(i + 1);
    }
  };
  search(0);
  if (best) return best;
  // Fallback (not expected): close position stacked upwards from the bottom of the range.
  const out: number[] = [];
  let floor = VOICING_LOW + 5;
  for (const pc of pcs) {
    let m = floor;
    while (mod12(m) !== mod12(pc)) m++;
    out.push(m);
    floor = m + 1;
  }
  return out.sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------------------------------------------------
// Progressions

/** [scale degree in semitones above the tonic, quality, beats]. */
export type ChordSpec = readonly [number, Quality, number];

export interface ProgressionTemplate {
  name: string;
  /** Exactly 16 beats (4 bars of 4/4). */
  chords: readonly ChordSpec[];
}

export const PROGRESSIONS: readonly ProgressionTemplate[] = [
  { name: 'ii-V-I-vi', chords: [[2, 'm9', 4], [7, '9', 4], [0, 'maj9', 4], [9, 'm7', 4]] },
  { name: 'I-vi-ii-V', chords: [[0, 'maj7', 4], [9, 'm9', 4], [2, 'm7', 4], [7, '9sus4', 2], [7, '9', 2]] },
  { name: 'IV-iii-vi-ii-V', chords: [[5, 'maj7', 4], [4, 'm7', 4], [9, 'm7', 4], [2, 'm9', 2], [7, '13', 2]] },
  { name: 'IV-V-iii-vi', chords: [[5, 'maj9', 4], [7, '9sus4', 4], [4, 'm7', 4], [9, 'm9', 4]] },
  { name: 'I-IV', chords: [[0, 'maj9', 8], [5, 'maj9', 8]] },
  { name: 'vi-ii-V-I', chords: [[9, 'm9', 4], [2, 'm7', 4], [7, '9', 4], [0, '6/9', 4]] },
  { name: 'ii-V-iii-VI', chords: [[2, 'm9', 4], [7, '13', 4], [4, 'm7', 4], [9, '7', 4]] },
  { name: 'I-iii-IV-iv', chords: [[0, 'maj7', 4], [4, 'm7', 4], [5, 'maj9', 4], [5, 'm9', 4]] },
];

export interface VoicedChord {
  rootPc: number;
  quality: Quality;
  beats: number;
  /** Beat offset of the chord within the loop. */
  startBeat: number;
  /** Sorted MIDI notes for the keys. */
  notes: number[];
  /** Bass root, D2..C#3 (≈73–139 Hz). */
  bassRoot: number;
}

const BASS_LOW = 38;
export const bassRootFor = (pc: number): number => BASS_LOW + mod12(pc - BASS_LOW);

function mutate(rng: Rng, specs: readonly ChordSpec[], p: number): ChordSpec[] {
  return specs.map(([deg, q, beats]) => (rng() < p ? [deg, rpick(rng, QUALITY_ALTERNATIVES[q]), beats] : [deg, q, beats]));
}

/**
 * Builds a voiced, voice-led 4- or 8-bar loop in `keyPc` from a template. The 8-bar form repeats the template with fresh
 * colour substitutions and, sometimes, a V9sus4 → V9 turnaround in the last bar.
 */
export function buildProgression(rng: Rng, keyPc: number, template: ProgressionTemplate, eightBars: boolean): VoicedChord[] {
  let specs = mutate(rng, template.chords, 0.3);
  if (eightBars) {
    const second = mutate(rng, template.chords, 0.5);
    const last = second[second.length - 1];
    if (last && last[2] === 4 && rng() < 0.5) {
      second.pop();
      second.push([7, '9sus4', 2], [7, '9', 2]);
    }
    specs = specs.concat(second);
  }
  const chords: VoicedChord[] = [];
  let beat = 0;
  for (const [deg, quality, beats] of specs) {
    const rootPc = mod12(keyPc + deg);
    chords.push({ rootPc, quality, beats, startBeat: beat, notes: [], bassRoot: bassRootFor(rootPc) });
    beat += beats;
  }
  // Two passes: the second voices the first chord from the last one, so the loop's wrap-around is smooth too.
  let prev: number[] | null = null;
  for (let pass = 0; pass < 2; pass++) {
    for (const c of chords) {
      c.notes = voiceLead(voicingPitchClasses(c.rootPc, c.quality), prev, rng);
      prev = c.notes;
    }
  }
  return chords;
}

// ---------------------------------------------------------------------------------------------------------------------
// Melody

export interface PhraseNote {
  /** 16th step within a two-bar window (0..31). */
  step: number;
  midi: number;
  /** Length in 16th steps. */
  len: number;
  vel: number;
}

/** Lead register: G4..C6. */
export const MELODY_LOW = 67;
export const MELODY_HIGH = 84;
const PENTATONIC = [0, 2, 4, 7, 9] as const;

/**
 * One sparse pentatonic phrase (3–6 notes, finished within the first ~1.7 bars of a 2-bar window so there is always
 * breathing room). Strong steps snap to chord tones. `chordPcsAt(step)` gives the chord pitch classes at a window step.
 */
export function melodyPhrase(rng: Rng, keyPc: number, chordPcsAt: (step: number) => readonly number[], startMidi: number): PhraseNote[] {
  const pool: number[] = [];
  for (let m = MELODY_LOW; m <= MELODY_HIGH; m++) if ((PENTATONIC as readonly number[]).includes(mod12(m - keyPc))) pool.push(m);
  let idx = 0;
  for (let i = 0; i < pool.length; i++) if (Math.abs((pool[i] ?? 0) - startMidi) < Math.abs((pool[idx] ?? 0) - startMidi)) idx = i;

  const out: PhraseNote[] = [];
  const count = rint(rng, 3, 6);
  let step = rpick(rng, [0, 2, 4, 6, 8]);
  for (let i = 0; i < count && step <= 26; i++) {
    const last = i === count - 1 || step >= 22;
    const move = rpick(rng, [-2, -1, -1, 1, 1, 2, 0]);
    idx = Math.min(pool.length - 1, Math.max(0, idx + move));
    if (step % 8 === 0 || last) {
      // Land on the nearest chord tone within two pool steps.
      const pcs = chordPcsAt(step);
      for (const d of [0, 1, -1, 2, -2]) {
        const m = pool[idx + d];
        if (m !== undefined && pcs.includes(mod12(m))) {
          idx += d;
          break;
        }
      }
    }
    const len = last ? rint(rng, 6, 10) : rpick(rng, [2, 2, 3, 4, 6]);
    out.push({ step, midi: pool[idx] ?? startMidi, len, vel: rrange(rng, 0.55, 0.75) * (1 - i * 0.05) });
    if (last) break;
    step += len + (rng() < 0.3 ? 2 : 0);
  }
  return out;
}
