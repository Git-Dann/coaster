/** Shared "raw unknown → validated SaveData" pipeline used by the store and importer. */
import { SaveFormatError, migrateSave } from './migrate';
import type { ValidateResult } from './validate';
import { DAMAGED_SAVE, validateSave } from './validate';

/** Migrates then validates. Never throws. */
export function parseSave(raw: unknown): ValidateResult {
  let migrated: unknown;
  try {
    migrated = migrateSave(raw);
  } catch (e) {
    return { ok: false, error: e instanceof SaveFormatError ? e.message : DAMAGED_SAVE };
  }
  return validateSave(migrated);
}
