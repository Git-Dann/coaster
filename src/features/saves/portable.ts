/** Export to / import from portable JSON files. */
import type { SaveData } from '../../types/world';
import { newSaveId } from './ids';
import { parseSave } from './pipeline';
import { NOT_A_SAVE, SAVE_LIMITS, isRecord } from './validate';

export const EXPORT_FORMAT = 'cozy-coaster-save';
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface ExportWrapper {
  format: typeof EXPORT_FORMAT;
  exported: string;
  save: SaveData;
}

export type ImportErrorCode = 'too-large' | 'unreadable' | 'invalid';
export type ImportResult =
  | { ok: true; save: SaveData; warnings: string[] }
  | { ok: false; error: ImportErrorCode; message: string };

export interface ImportOptions {
  /** Names already in use; a clashing import is renamed "<name> (imported)". */
  existingNames?: Iterable<string>;
  /** Clock for tests. */
  now?: () => number;
}

/** Pretty-printed JSON text of the export wrapper. */
export function serializeSave(save: SaveData, now: Date = new Date()): string {
  const wrapper: ExportWrapper = { format: EXPORT_FORMAT, exported: now.toISOString(), save };
  return JSON.stringify(wrapper, null, 2);
}

/** A JSON Blob ready for download. Pair with `exportFilename` for the file name. */
export function exportSave(save: SaveData, now: Date = new Date()): Blob {
  return new Blob([serializeSave(save, now)], { type: 'application/json' });
}

/** Lowercase ASCII slug; "coaster" when nothing usable remains. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'coaster';
}

/** `cozy-coaster-<slug>-<yyyy-mm-dd>.json` using the local date. */
export function exportFilename(save: Pick<SaveData, 'name'>, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `cozy-coaster-${slugify(save.name)}-${date}.json`;
}

const TOO_LARGE: ImportResult = {
  ok: false,
  error: 'too-large',
  message: `That file is too big to be a Cozy Coaster save (the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB).`,
};

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function importedName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  const suffix = ' (imported)';
  const base = Array.from(name).slice(0, SAVE_LIMITS.maxNameLength - suffix.length).join('').trimEnd();
  let candidate = `${base}${suffix}`;
  for (let i = 2; existing.has(candidate) && i < 1000; i++) candidate = `${base} (imported ${i})`;
  return candidate;
}

/**
 * Reads a save file (or its text), accepting the export wrapper or a bare save,
 * then migrates + validates it and assigns a fresh id so it never overwrites anything.
 */
export async function importSave(file: File | Blob | string, opts: ImportOptions = {}): Promise<ImportResult> {
  let text: string;
  try {
    if (typeof file === 'string') {
      if (file.length > MAX_IMPORT_BYTES || byteLength(file) > MAX_IMPORT_BYTES) return TOO_LARGE;
      text = file;
    } else {
      if (file.size > MAX_IMPORT_BYTES) return TOO_LARGE;
      text = await file.text();
    }
  } catch {
    return { ok: false, error: 'unreadable', message: "We couldn't read that file." };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, error: 'invalid', message: NOT_A_SAVE };
  }

  let candidate: unknown = raw;
  if (isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, 'format')) {
    if (raw.format !== EXPORT_FORMAT) return { ok: false, error: 'invalid', message: NOT_A_SAVE };
    candidate = Object.prototype.hasOwnProperty.call(raw, 'save') ? raw.save : undefined;
  }

  const parsed = parseSave(candidate);
  if (!parsed.ok) return { ok: false, error: 'invalid', message: parsed.error };

  const now = (opts.now ?? Date.now)();
  const save: SaveData = {
    ...parsed.save,
    id: newSaveId(),
    name: importedName(parsed.save.name, new Set(opts.existingNames ?? [])),
    updated: now,
  };
  return { ok: true, save, warnings: parsed.warnings };
}
