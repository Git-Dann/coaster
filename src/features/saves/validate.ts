/**
 * Defensive validation of untrusted save data (imports, possibly corrupted DB records).
 *
 * The validator never returns (or mutates) the input: it reads only the fields it
 * knows about, using own-property access, and builds a fresh sanitised object.
 * Unknown keys (including "__proto__" / "constructor") are simply never copied.
 */
import type { V3 } from '../../engine/core/vec3';
import type { SectionKind, SupportStyle, TrackColours, TrackDesign, TrackNode, TrackStyle } from '../../engine/track/types';
import { SECTION_KINDS } from '../../engine/track/types';
import type { CarStyle, Finish, PhysicsParams, TrainColours, TrainConfig } from '../../engine/train/config';
import { CAR_PROFILES, MAX_CARS, MIN_CARS } from '../../engine/train/config';
import type {
  CameraBookmark,
  EnvironmentState,
  SaveData,
  SceneryItem,
  TerrainBrush,
  TerrainStroke,
} from '../../types/world';
import { BIOMES, CURRENT_SCHEMA, SCENERY_TYPES, TIMES, WEATHERS } from '../../types/world';
import {
  DEFAULT_CAR_STYLE,
  DEFAULT_CARS,
  DEFAULT_COASTER_NAME,
  DEFAULT_ENVIRONMENT,
  DEFAULT_FINISH,
  DEFAULT_SAVE_NAME,
  DEFAULT_SUPPORT_STYLE,
  DEFAULT_TRACK_COLOURS,
  DEFAULT_TRACK_STYLE,
  DEFAULT_TRAIN_COLOURS,
} from './defaults';
import { newItemId, newSaveId } from './ids';

/** Resource limits for a single save. */
export const SAVE_LIMITS = Object.freeze({
  maxTrackNodes: 4000,
  maxScenery: 20000,
  maxTerrainStrokes: 50000,
  maxNameLength: 120,
  maxIdLength: 120,
  maxThumbnailBytes: 200 * 1024,
  /** Absolute coordinate limit in metres. */
  worldLimit: 100_000,
  /** Maximum number of values the non-finite scan will visit. */
  maxScanValues: 2_000_000,
  maxDepth: 32,
});

export type ValidateResult = { ok: true; save: SaveData; warnings: string[] } | { ok: false; error: string };

export const NOT_A_SAVE = "This file doesn't look like a Cozy Coaster save.";
export const DAMAGED_SAVE = 'This save is damaged and could not be opened.';
export const NEWER_SAVE = 'This coaster was made with a newer version of Cozy Coaster. Please update the game to open it.';

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

const TRACK_STYLES = Object.keys({ wood: 1, tubular: 1, boxspine: 1, mine: 1 } satisfies Record<TrackStyle, 1>) as TrackStyle[];
const SUPPORT_STYLES = Object.keys({
  pine: 1,
  walnut: 1,
  'painted-timber': 1,
  weathered: 1,
  'powder-steel': 1,
  galvanised: 1,
  industrial: 1,
} satisfies Record<SupportStyle, 1>) as SupportStyle[];
const CAR_STYLES = Object.keys(CAR_PROFILES) as CarStyle[];
const FINISHES = Object.keys({ matte: 1, satin: 1, gloss: 1 } satisfies Record<Finish, 1>) as Finish[];
const TERRAIN_BRUSHES = Object.keys({
  raise: 1,
  lower: 1,
  smooth: 1,
  flatten: 1,
  'paint-path': 1,
  'clear-vegetation': 1,
} satisfies Record<TerrainBrush, 1>) as TerrainBrush[];

/** Plausible ranges for each physics override; values outside are clamped. */
const PHYSICS_RANGES: Record<keyof PhysicsParams, readonly [number, number]> = {
  gravity: [0, 30],
  rollingCoeff: [0, 0.2],
  dragScale: [0, 10],
  airDensity: [0, 5],
  trailingDragFraction: [0, 1],
  liftSpeed: [0, 30],
  launchAccel: [0, 30],
  brakeDecel: [0, 30],
  windX: [-40, 40],
  windZ: [-40, 40],
  dwell: [0, 120],
};

/** Thrown internally to abort validation with a player-facing message. */
class InvalidSave extends Error {}

function fail(message: string): never {
  throw new InvalidSave(message);
}

/** Collects warnings, collapsing repeated per-item problems into one counted line. */
class Warnings {
  private readonly list: string[] = [];
  private readonly counts = new Map<string, number>();

  add(message: string): void {
    if (!this.list.includes(message)) this.list.push(message);
  }

  /** Count a repeated problem; `message` receives the count when warnings are collected. */
  count(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  collect(): string[] {
    const out = [...this.list];
    for (const [key, n] of this.counts) out.push(`${key} (${n} ${n === 1 ? 'item' : 'items'})`);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Primitive helpers

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Own-property read, so inherited members such as `constructor` are never picked up. */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Short, printable version of an untrusted value for warning messages. */
function show(v: unknown): string {
  const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : typeof v;
  return cleanText(s).slice(0, 24);
}

/** Removes control characters and trims. */
function cleanText(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)) out += ch;
  }
  return out.trim();
}

/** Truncates by code point so surrogate pairs are not split. */
function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

function readV3(v: unknown): V3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [x, y, z] = v as unknown[];
  if (!isNum(x) || !isNum(y) || !isNum(z)) return null;
  return [x, y, z];
}

function inWorld(p: V3): boolean {
  const L = SAVE_LIMITS.worldLimit;
  return Math.abs(p[0]) <= L && Math.abs(p[1]) <= L && Math.abs(p[2]) <= L;
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T, label: string, w: Warnings): T {
  const hit = allowed.find((a) => a === v);
  if (hit !== undefined) return hit;
  w.add(v === undefined ? `Missing ${label}; using "${fallback}".` : `Unknown ${label} "${show(v)}"; using "${fallback}".`);
  return fallback;
}

function readBool(v: unknown, fallback: boolean, label: string, w: Warnings): boolean {
  if (typeof v === 'boolean') return v;
  w.add(`Missing or invalid ${label}; using ${fallback ? 'on' : 'off'}.`);
  return fallback;
}

function readName(v: unknown, fallback: string, label: string, w: Warnings): string {
  if (typeof v !== 'string') {
    w.add(`Missing ${label}; using "${fallback}".`);
    return fallback;
  }
  const cleaned = cleanText(v);
  if (!cleaned) {
    w.add(`Empty ${label}; using "${fallback}".`);
    return fallback;
  }
  if (Array.from(cleaned).length > SAVE_LIMITS.maxNameLength) {
    w.add(`The ${label} was too long and has been shortened.`);
    return truncate(cleaned, SAVE_LIMITS.maxNameLength).trim();
  }
  return cleaned;
}

/** Validates a display name (for rename etc.). Returns null if unusable. */
export function sanitizeName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const cleaned = truncate(cleanText(v), SAVE_LIMITS.maxNameLength).trim();
  return cleaned || null;
}

function readColour(v: unknown, fallback: string, label: string, w: Warnings): string {
  if (typeof v === 'string' && HEX_COLOUR.test(v)) return v.toLowerCase();
  w.add(`Invalid ${label} colour; using the default.`);
  return fallback;
}

function readTimestamp(v: unknown, label: string, w: Warnings): number {
  if (isNum(v) && v >= 0) return Math.floor(v);
  w.add(`Missing ${label} date; using now.`);
  return Date.now();
}

/** True if `id` is acceptable as a stored id. */
function isGoodId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= SAVE_LIMITS.maxIdLength && cleanText(v) === v;
}

/** Returns `raw` if it is a good, unused id, else a fresh one (calling `onRegenerate`). Records it in `used`. */
function uniqueId(raw: unknown, used: Set<string>, prefix: string, onRegenerate: () => void): string {
  let id: string;
  if (isGoodId(raw) && !used.has(raw)) id = raw;
  else {
    onRegenerate();
    do id = newItemId(prefix);
    while (used.has(id));
  }
  used.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Non-finite / structure scan

/**
 * Walks the raw value once and rejects NaN/±Infinity anywhere, excessive nesting,
 * and absurdly large payloads. Iterative to avoid stack overflows.
 */
function scanStructure(root: unknown): void {
  const stack: { v: unknown; depth: number; path: string }[] = [{ v: root, depth: 0, path: 'save' }];
  let visited = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    const { v, depth, path } = item;
    if (++visited > SAVE_LIMITS.maxScanValues) fail('This save is too large to open.');
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail(`This save contains invalid numbers and can't be opened (at ${path}).`);
      continue;
    }
    if (typeof v !== 'object' || v === null) continue;
    if (depth >= SAVE_LIMITS.maxDepth) fail(DAMAGED_SAVE);
    if (Array.isArray(v)) {
      if (visited + v.length > SAVE_LIMITS.maxScanValues) fail('This save is too large to open.');
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i] as unknown, depth: depth + 1, path: `${path}[${i}]` });
    } else {
      for (const key of Object.keys(v)) {
        stack.push({ v: (v as Record<string, unknown>)[key], depth: depth + 1, path: `${path}.${truncate(key, 32)}` });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Section validators

function readEnvironment(v: unknown, w: Warnings): EnvironmentState {
  if (!isRecord(v)) {
    w.add('Missing environment settings; using defaults.');
    return { ...DEFAULT_ENVIRONMENT };
  }
  const seedRaw = own(v, 'seed');
  let seed = DEFAULT_ENVIRONMENT.seed;
  if (isNum(seedRaw)) seed = clamp(Math.trunc(seedRaw), 0, 0xffffffff);
  else w.add('Missing world seed; using the default.');
  return {
    biome: pickEnum(own(v, 'biome'), BIOMES, DEFAULT_ENVIRONMENT.biome, 'biome', w),
    seed,
    weather: pickEnum(own(v, 'weather'), WEATHERS, DEFAULT_ENVIRONMENT.weather, 'weather', w),
    time: pickEnum(own(v, 'time'), TIMES, DEFAULT_ENVIRONMENT.time, 'time of day', w),
    autoCycle: readBool(own(v, 'autoCycle'), DEFAULT_ENVIRONMENT.autoCycle, 'day/night cycle setting', w),
    environmentalPhysics: readBool(own(v, 'environmentalPhysics'), DEFAULT_ENVIRONMENT.environmentalPhysics, 'environmental physics setting', w),
  };
}

function readNode(v: unknown, index: number, usedIds: Set<string>, w: Warnings): TrackNode {
  const where = `track point ${index + 1}`;
  if (!isRecord(v)) fail(`This save is damaged: ${where} is not valid.`);
  const p = readV3(own(v, 'p'));
  if (!p) fail(`This save is damaged: ${where} has an invalid position.`);
  if (!inWorld(p)) fail(`This save is damaged: ${where} is outside the world.`);
  const rawDir = readV3(own(v, 'dir'));
  if (!rawDir) fail(`This save is damaged: ${where} has an invalid direction.`);
  const l = Math.hypot(rawDir[0], rawDir[1], rawDir[2]);
  if (!(l > 1e-9) || !Number.isFinite(l)) fail(`This save is damaged: ${where} has no direction.`);
  // Leave already-unit vectors bit-for-bit alone so round trips are stable.
  const exact = Math.abs(l - 1) <= 1e-9;
  if (Math.abs(l - 1) > 1e-6) w.count('Some track directions were re-normalised');
  const dir: V3 = exact ? rawDir : [rawDir[0] / l, rawDir[1] / l, rawDir[2] / l];

  const id = uniqueId(own(v, 'id'), usedIds, 'n', () =>
    w.count('Some track points had missing or duplicate ids and were given new ones'),
  );

  const bankRaw = own(v, 'bank');
  let bank = 0;
  if (isNum(bankRaw)) bank = clamp(bankRaw, -1000, 1000);
  else if (bankRaw !== undefined) fail(`This save is damaged: ${where} has an invalid bank angle.`);
  else w.count('Some track points were missing a bank angle and were set level');

  const node: TrackNode = {
    id,
    p,
    dir,
    bank,
    kind: pickEnum<SectionKind>(own(v, 'kind'), SECTION_KINDS, 'track', 'track section type', w),
  };
  const param = own(v, 'param');
  if (isNum(param)) node.param = clamp(param, 0, 200);
  else if (param !== undefined) w.count('Some invalid section settings were removed');
  const tension = own(v, 'tension');
  if (isNum(tension)) node.tension = clamp(tension, 0.05, 5);
  else if (tension !== undefined) w.count('Some invalid curve tensions were removed');
  return node;
}

function readTrackColours(v: unknown, w: Warnings): TrackColours {
  const src = isRecord(v) ? v : {};
  if (!isRecord(v)) w.add('Missing track colours; using defaults.');
  return {
    rail: readColour(own(src, 'rail'), DEFAULT_TRACK_COLOURS.rail, 'rail', w),
    spine: readColour(own(src, 'spine'), DEFAULT_TRACK_COLOURS.spine, 'spine', w),
    sleeper: readColour(own(src, 'sleeper'), DEFAULT_TRACK_COLOURS.sleeper, 'sleeper', w),
    support: readColour(own(src, 'support'), DEFAULT_TRACK_COLOURS.support, 'support', w),
  };
}

function readTrack(v: unknown, w: Warnings): TrackDesign {
  if (!isRecord(v)) fail("This save is damaged: the coaster track is missing.");
  const nodesRaw = own(v, 'nodes');
  if (!Array.isArray(nodesRaw)) fail("This save is damaged: the coaster track is missing.");
  if (nodesRaw.length > SAVE_LIMITS.maxTrackNodes) {
    fail(`This coaster has too many track points (${nodesRaw.length}, the limit is ${SAVE_LIMITS.maxTrackNodes}).`);
  }
  const usedIds = new Set<string>();
  const nodes = (nodesRaw as unknown[]).map((n, i) => readNode(n, i, usedIds, w));
  return {
    nodes,
    closed: readBool(own(v, 'closed'), false, 'track loop setting', w),
    style: pickEnum(own(v, 'style'), TRACK_STYLES, DEFAULT_TRACK_STYLE, 'track style', w),
    supportStyle: pickEnum(own(v, 'supportStyle'), SUPPORT_STYLES, DEFAULT_SUPPORT_STYLE, 'support style', w),
    colours: readTrackColours(own(v, 'colours'), w),
  };
}

function readTrainColours(v: unknown, w: Warnings): TrainColours {
  const src = isRecord(v) ? v : {};
  if (!isRecord(v)) w.add('Missing train colours; using defaults.');
  const d = DEFAULT_TRAIN_COLOURS;
  return {
    primary: readColour(own(src, 'primary'), d.primary, 'primary train', w),
    secondary: readColour(own(src, 'secondary'), d.secondary, 'secondary train', w),
    seat: readColour(own(src, 'seat'), d.seat, 'seat', w),
    trim: readColour(own(src, 'trim'), d.trim, 'trim', w),
    wheels: readColour(own(src, 'wheels'), d.wheels, 'wheel', w),
  };
}

function readTrain(v: unknown, w: Warnings): TrainConfig {
  if (!isRecord(v)) w.add('Missing train settings; using defaults.');
  const src = isRecord(v) ? v : {};
  const carsRaw = own(src, 'cars');
  let cars = DEFAULT_CARS;
  if (isNum(carsRaw)) {
    cars = clamp(Math.round(carsRaw), MIN_CARS, MAX_CARS);
    if (cars !== carsRaw) w.add(`Carriage count adjusted to ${cars}.`);
  } else if (isRecord(v)) {
    w.add(`Missing carriage count; using ${DEFAULT_CARS}.`);
  }
  return {
    cars,
    style: pickEnum(own(src, 'style'), CAR_STYLES, DEFAULT_CAR_STYLE, 'carriage style', w),
    colours: readTrainColours(own(src, 'colours'), w),
    finish: pickEnum(own(src, 'finish'), FINISHES, DEFAULT_FINISH, 'paint finish', w),
  };
}

function readPhysics(v: unknown, w: Warnings): Partial<PhysicsParams> {
  const out: Partial<PhysicsParams> = {};
  if (v === undefined) return out;
  if (!isRecord(v)) {
    w.add('Invalid physics settings were reset.');
    return out;
  }
  for (const key of Object.keys(PHYSICS_RANGES) as (keyof PhysicsParams)[]) {
    const raw = own(v, key);
    if (raw === undefined) continue;
    if (!isNum(raw)) {
      w.add(`Invalid physics value "${key}" was reset.`);
      continue;
    }
    const [lo, hi] = PHYSICS_RANGES[key];
    const c = clamp(raw, lo, hi);
    if (c !== raw) w.add(`Physics value "${key}" was out of range and has been adjusted.`);
    out[key] = c;
  }
  return out;
}

function readScenery(v: unknown, w: Warnings): SceneryItem[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    w.add('Invalid scenery list was removed.');
    return [];
  }
  if (v.length > SAVE_LIMITS.maxScenery) {
    fail(`This park has too many scenery items (${v.length}, the limit is ${SAVE_LIMITS.maxScenery}).`);
  }
  const used = new Set<string>();
  const out: SceneryItem[] = [];
  for (const raw of v as unknown[]) {
    if (!isRecord(raw)) {
      w.count('Some damaged scenery items were removed');
      continue;
    }
    const p = readV3(own(raw, 'p'));
    if (!p || !inWorld(p)) {
      w.count('Some damaged scenery items were removed');
      continue;
    }
    const rawType = own(raw, 'type');
    const type = SCENERY_TYPES.find((t) => t === rawType);
    if (type === undefined) w.count('Some unknown scenery types were replaced with pine trees');
    const id = uniqueId(own(raw, 'id'), used, 's', () =>
      w.count('Some scenery items had missing or duplicate ids and were given new ones'),
    );
    const rot = own(raw, 'rot');
    const scale = own(raw, 'scale');
    out.push({
      id,
      type: type ?? 'pine',
      p,
      rot: isNum(rot) ? rot % (Math.PI * 2) : 0,
      scale: isNum(scale) ? clamp(scale, 0.1, 10) : 1,
    });
  }
  return out;
}

function readTerrain(v: unknown, w: Warnings): TerrainStroke[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    w.add('Invalid terrain edits were removed.');
    return [];
  }
  if (v.length > SAVE_LIMITS.maxTerrainStrokes) {
    fail(`This park has too many terrain edits (${v.length}, the limit is ${SAVE_LIMITS.maxTerrainStrokes}).`);
  }
  const L = SAVE_LIMITS.worldLimit;
  const out: TerrainStroke[] = [];
  for (const raw of v as unknown[]) {
    // Unknown brushes are dropped rather than defaulted: guessing would reshape the terrain.
    const mode = isRecord(raw) ? TERRAIN_BRUSHES.find((m) => m === own(raw, 'mode')) : undefined;
    if (!isRecord(raw) || mode === undefined) {
      w.count('Some damaged terrain edits were removed');
      continue;
    }
    const x = own(raw, 'x');
    const z = own(raw, 'z');
    const radius = own(raw, 'radius');
    const strength = own(raw, 'strength');
    if (!isNum(x) || !isNum(z) || !isNum(radius) || !isNum(strength) || Math.abs(x) > L || Math.abs(z) > L) {
      w.count('Some damaged terrain edits were removed');
      continue;
    }
    out.push({ mode, x, z, radius: clamp(radius, 0.1, 500), strength: clamp(strength, -1000, 1000) });
  }
  return out;
}

function readCamera(v: unknown, w: Warnings): CameraBookmark | undefined {
  if (v === undefined) return undefined;
  const target = isRecord(v) ? readV3(own(v, 'target')) : null;
  const distance = isRecord(v) ? own(v, 'distance') : undefined;
  const yaw = isRecord(v) ? own(v, 'yaw') : undefined;
  const pitch = isRecord(v) ? own(v, 'pitch') : undefined;
  if (!target || !inWorld(target) || !isNum(distance) || !isNum(yaw) || !isNum(pitch)) {
    w.add('The saved camera view was damaged and has been reset.');
    return undefined;
  }
  return { target, distance: clamp(distance, 0.5, 5000), yaw, pitch: clamp(pitch, -Math.PI / 2, Math.PI / 2) };
}

function readThumbnail(v: unknown, w: Warnings): string | undefined {
  if (v === undefined) return undefined;
  if (
    typeof v === 'string' &&
    (v.startsWith('data:image/jpeg') || v.startsWith('data:image/png')) &&
    v.length <= SAVE_LIMITS.maxThumbnailBytes &&
    /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(v)
  ) {
    return v;
  }
  w.add('The preview image was invalid or too large and has been removed.');
  return undefined;
}

// ---------------------------------------------------------------------------

/**
 * Validates and sanitises an (already migrated) save. Never returns the input object.
 */
export function validateSave(input: unknown): ValidateResult {
  try {
    if (!isRecord(input)) return { ok: false, error: NOT_A_SAVE };
    const schema = own(input, 'schema');
    if (typeof schema !== 'number') return { ok: false, error: NOT_A_SAVE };
    if (schema > CURRENT_SCHEMA) return { ok: false, error: NEWER_SAVE };
    if (schema !== CURRENT_SCHEMA) return { ok: false, error: NOT_A_SAVE };

    scanStructure(input);
    const w = new Warnings();

    const rawId = own(input, 'id');
    let id: string;
    if (isGoodId(rawId)) id = rawId;
    else {
      w.add('The save had no valid id, so it was given a new one.');
      id = newSaveId();
    }

    const save: SaveData = {
      schema: CURRENT_SCHEMA,
      id,
      name: readName(own(input, 'name'), DEFAULT_SAVE_NAME, 'park name', w),
      created: readTimestamp(own(input, 'created'), 'created', w),
      updated: readTimestamp(own(input, 'updated'), 'last saved', w),
      coasterName: readName(own(input, 'coasterName'), DEFAULT_COASTER_NAME, 'coaster name', w),
      environment: readEnvironment(own(input, 'environment'), w),
      track: readTrack(own(input, 'track'), w),
      train: readTrain(own(input, 'train'), w),
      physics: readPhysics(own(input, 'physics'), w),
      scenery: readScenery(own(input, 'scenery'), w),
      terrainEdits: readTerrain(own(input, 'terrainEdits'), w),
    };
    const camera = readCamera(own(input, 'camera'), w);
    if (camera) save.camera = camera;
    const thumbnail = readThumbnail(own(input, 'thumbnail'), w);
    if (thumbnail) save.thumbnail = thumbnail;
    return { ok: true, save, warnings: w.collect() };
  } catch (e) {
    if (e instanceof InvalidSave) return { ok: false, error: e.message };
    return { ok: false, error: DAMAGED_SAVE };
  }
}
