/**
 * Schema migrations. Each entry upgrades a save from `fromVersion` to the next
 * version; `migrateSave` chains them until CURRENT_SCHEMA is reached.
 */
import { CURRENT_SCHEMA } from '../../types/world';
import { DEFAULT_COASTER_NAME, DEFAULT_SAVE_NAME } from './defaults';
import { newSaveId } from './ids';
import { NEWER_SAVE, NOT_A_SAVE, isRecord } from './validate';

/** Error with a player-facing message raised when a save cannot be migrated. */
export class SaveFormatError extends Error {
  constructor(
    message: string,
    readonly code: 'not-a-save' | 'newer' = 'not-a-save',
  ) {
    super(message);
    this.name = 'SaveFormatError';
  }
}

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Legacy schema 0: `{ version: 0, track, train, env, name? }`.
 * Missing data is filled in here or by the validator.
 */
const v0to1: Migration = (d) => {
  const now = Date.now();
  const name = typeof own(d, 'name') === 'string' ? (own(d, 'name') as string) : undefined;
  return {
    schema: 1,
    id: newSaveId(),
    name: name ?? DEFAULT_SAVE_NAME,
    created: now,
    updated: now,
    coasterName: name ?? DEFAULT_COASTER_NAME,
    environment: own(d, 'env'),
    track: own(d, 'track'),
    train: own(d, 'train'),
    physics: {},
    scenery: [],
    terrainEdits: [],
  };
};

/** fromVersion → migration to fromVersion + 1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({ 0: v0to1 });

/** Reads the schema version of a raw save (`schema`, or legacy `version`). */
export function detectVersion(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  const v = own(raw, 'schema') ?? own(raw, 'version');
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Upgrades a raw save to CURRENT_SCHEMA. Returns the input untouched when it is
 * already current (the validator builds the sanitised copy).
 * @throws SaveFormatError with a friendly message for unknown or newer schemas.
 */
export function migrateSave(raw: unknown): unknown {
  let version = detectVersion(raw);
  if (version === null || !isRecord(raw)) throw new SaveFormatError(NOT_A_SAVE);
  if (version > CURRENT_SCHEMA) throw new SaveFormatError(NEWER_SAVE, 'newer');
  let data: Record<string, unknown> = raw;
  while (version < CURRENT_SCHEMA) {
    const step = MIGRATIONS[version];
    if (!step) throw new SaveFormatError(NOT_A_SAVE);
    data = step(data);
    const next = detectVersion(data);
    if (next === null || next <= version) throw new SaveFormatError(NOT_A_SAVE);
    version = next;
  }
  return data;
}
