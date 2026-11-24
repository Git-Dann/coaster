/**
 * IndexedDB persistence for saves, rolling last-known-good snapshots and settings.
 *
 * Every public method resolves to a typed result; DOMExceptions never escape.
 * When IndexedDB is unavailable (`open()` resolves false) callers should run in
 * memory-only mode; the other methods then fail with `error: 'unavailable'`.
 */
import type { SaveData, Settings } from '../../types/world';
import { newSaveId } from './ids';
import { parseSave } from './pipeline';
import { sanitizeName, validateSave } from './validate';
import { sanitizeSettings } from './validate-settings';

export const DB_NAME = 'cozy-coaster';
export const DB_VERSION = 1;
export const SNAPSHOT_SLOTS = 3;

const SAVES = 'saves';
const SNAPSHOTS = 'snapshots';
const SETTINGS = 'settings';
const SETTINGS_KEY = 'settings';

export type StoreErrorCode = 'unavailable' | 'quota' | 'not-found' | 'invalid' | 'unknown';
export type StoreFailure = { ok: false; error: StoreErrorCode; message: string };
export type Result = { ok: true } | StoreFailure;
export type LoadResult = { ok: true; save: SaveData; recovered: boolean; warnings: string[] } | StoreFailure;

export interface SaveSummary {
  id: string;
  name: string;
  coasterName: string;
  updated: number;
  thumbnail?: string;
}

/** Stored in the 'snapshots' object store (keyPath ['id', 'slot']). */
interface SnapshotRecord {
  id: string;
  slot: number;
  taken: number;
  save: SaveData;
}

export const QUOTA_MESSAGE = "Your browser's storage is full. Export your coaster to keep it safe, or delete an older save.";
const UNAVAILABLE: StoreFailure = {
  ok: false,
  error: 'unavailable',
  message: "Saving isn't available in this browser window (private browsing?). Export your coaster to keep it safe.",
};
const NOT_FOUND: StoreFailure = { ok: false, error: 'not-found', message: "We couldn't find that save." };

/** True for QuotaExceededError in its various browser spellings. */
export function isQuotaError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { name, code } = e as { name?: unknown; code?: unknown };
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014;
}

/** Maps any thrown value / DOMException to a typed failure. */
export function toFailure(e: unknown): StoreFailure {
  if (isQuotaError(e)) return { ok: false, error: 'quota', message: QUOTA_MESSAGE };
  return { ok: false, error: 'unknown', message: 'Something went wrong while accessing your saves. Please try again.' };
}

// ---------------------------------------------------------------------------
// Promisify helpers

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction commits; rejects with its error on abort/error. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

function snapshotRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, SNAPSHOT_SLOTS - 1]);
}

function isSnapshot(v: unknown): v is SnapshotRecord {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as SnapshotRecord).id === 'string' &&
    typeof (v as SnapshotRecord).slot === 'number' &&
    typeof (v as SnapshotRecord).taken === 'number'
  );
}

/** Cheap summary extraction without full validation; null for unusable records. */
function summarize(v: unknown): SaveSummary | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const s: SaveSummary = {
    id: r.id,
    name: sanitizeName(r.name) ?? 'Untitled park',
    coasterName: sanitizeName(r.coasterName) ?? 'My coaster',
    updated: typeof r.updated === 'number' && Number.isFinite(r.updated) ? r.updated : 0,
  };
  if (typeof r.thumbnail === 'string' && /^data:image\/(jpeg|png);/.test(r.thumbnail) && r.thumbnail.length <= 200 * 1024) {
    s.thumbnail = r.thumbnail;
  }
  return s;
}

export interface SaveStoreOptions {
  /** Defaults to `globalThis.indexedDB`. */
  factory?: IDBFactory;
  dbName?: string;
  /** How long to wait for a blocked upgrade before giving up (ms). */
  openTimeoutMs?: number;
}

export class SaveStore {
  private db: IDBDatabase | null = null;
  private opening: Promise<boolean> | null = null;
  private readonly factory: IDBFactory | undefined;
  private readonly dbName: string;
  private readonly openTimeoutMs: number;

  constructor(opts: SaveStoreOptions = {}) {
    this.factory = opts.factory ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    this.dbName = opts.dbName ?? DB_NAME;
    this.openTimeoutMs = opts.openTimeoutMs ?? 10_000;
  }

  /** True once `open()` succeeded and the connection is still alive. */
  get available(): boolean {
    return this.db !== null;
  }

  /** Opens (and if needed creates) the database. Resolves false when IndexedDB is unusable. */
  open(): Promise<boolean> {
    if (this.db) return Promise.resolve(true);
    if (!this.opening) {
      this.opening = this.doOpen().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  private doOpen(): Promise<boolean> {
    const factory = this.factory;
    if (!factory) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), this.openTimeoutMs);
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.dbName, DB_VERSION);
      } catch {
        finish(false); // e.g. SecurityError in sandboxed iframes
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: ['id', 'slot'] });
        if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close(); // timed out meanwhile
          return;
        }
        db.onversionchange = () => {
          db.close();
          if (this.db === db) this.db = null;
        };
        db.onclose = () => {
          if (this.db === db) this.db = null;
        };
        this.db = db;
        finish(true);
      };
      request.onerror = (ev) => {
        ev.preventDefault();
        finish(false);
      };
    });
  }

  /** Returns a live connection, reopening once if it was closed. */
  private async conn(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    return (await this.open()) ? this.db : null;
  }

  /** All saves as summaries, newest first. Corrupt records are skipped. */
  async list(): Promise<SaveSummary[]> {
    const db = await this.conn();
    if (!db) return [];
    try {
      const tx = db.transaction(SAVES, 'readonly');
      const all = await req(tx.objectStore(SAVES).getAll());
      const out: SaveSummary[] = [];
      for (const rec of all as unknown[]) {
        const s = summarize(rec);
        if (s) out.push(s);
      }
      return out.sort((a, b) => b.updated - a.updated);
    } catch {
      return [];
    }
  }

  /** Loads, migrates and validates a save, falling back to the newest valid snapshot. */
  async load(id: string): Promise<LoadResult> {
    const db = await this.conn();
    if (!db) return UNAVAILABLE;
    let main: unknown;
    let snapshots: unknown[];
    try {
      const tx = db.transaction([SAVES, SNAPSHOTS], 'readonly');
      [main, snapshots] = await Promise.all([
        req(tx.objectStore(SAVES).get(id)),
        req(tx.objectStore(SNAPSHOTS).getAll(snapshotRange(id))),
      ]);
    } catch (e) {
      return toFailure(e);
    }
    let mainError: string | null = null;
    if (main !== undefined) {
      const r = parseSave(main);
      if (r.ok) return { ok: true, save: { ...r.save, id }, recovered: false, warnings: r.warnings };
      mainError = r.error;
    }
    const valid = snapshots.filter(isSnapshot).sort((a, b) => b.taken - a.taken);
    for (const snap of valid) {
      const r = parseSave(snap.save);
      if (r.ok) {
        const warnings = [...r.warnings, 'Your latest save was damaged, so we restored the most recent backup.'];
        return { ok: true, save: { ...r.save, id }, recovered: true, warnings };
      }
    }
    if (main === undefined) return NOT_FOUND;
    return { ok: false, error: 'invalid', message: mainError ?? 'This save is damaged and could not be opened.' };
  }

  /**
   * Validates and writes a save, rotating a snapshot (round-robin over
   * SNAPSHOT_SLOTS) in the same readwrite transaction.
   */
  async put(save: SaveData): Promise<Result> {
    const v = validateSave(save);
    if (!v.ok) return { ok: false, error: 'invalid', message: v.error };
    const db = await this.conn();
    if (!db) return UNAVAILABLE;
    try {
      await this.write(db, v.save);
      return { ok: true };
    } catch (e) {
      return toFailure(e);
    }
  }

  private write(db: IDBDatabase, clean: SaveData): Promise<void> {
    const tx = db.transaction([SAVES, SNAPSHOTS], 'readwrite');
    const committed = done(tx);
    tx.objectStore(SAVES).put(clean);
    const snaps = tx.objectStore(SNAPSHOTS);
    // Callback style keeps every request inside the transaction's lifetime.
    const existing = snaps.getAll(snapshotRange(clean.id));
    existing.onsuccess = () => {
      const records = (existing.result as unknown[]).filter(isSnapshot);
      let slot = 0;
      if (records.length < SNAPSHOT_SLOTS) {
        const used = new Set(records.map((r) => r.slot));
        while (used.has(slot)) slot++;
      } else {
        const oldest = records.reduce((a, b) => (b.taken < a.taken ? b : a));
        slot = oldest.slot;
      }
      const record: SnapshotRecord = { id: clean.id, slot, taken: Date.now(), save: clean };
      snaps.put(record);
    };
    return committed;
  }

  /** Renames a save (park name). */
  async rename(id: string, name: string): Promise<Result> {
    const clean = sanitizeName(name);
    if (!clean) return { ok: false, error: 'invalid', message: 'Please enter a name.' };
    const loaded = await this.load(id);
    if (!loaded.ok) return loaded;
    return this.put({ ...loaded.save, name: clean, updated: Date.now() });
  }

  /** Copies a save under a new id. Resolves to the new id, or null on failure. */
  async duplicate(id: string, newName: string): Promise<string | null> {
    const loaded = await this.load(id);
    if (!loaded.ok) return null;
    const now = Date.now();
    const copy: SaveData = {
      ...loaded.save,
      id: newSaveId(),
      name: sanitizeName(newName) ?? `${loaded.save.name} copy`,
      created: now,
      updated: now,
    };
    const r = await this.put(copy);
    return r.ok ? copy.id : null;
  }

  /** Deletes a save and all of its snapshots. */
  async remove(id: string): Promise<Result> {
    const db = await this.conn();
    if (!db) return UNAVAILABLE;
    try {
      const tx = db.transaction([SAVES, SNAPSHOTS], 'readwrite');
      const committed = done(tx);
      tx.objectStore(SAVES).delete(id);
      tx.objectStore(SNAPSHOTS).delete(snapshotRange(id));
      await committed;
      return { ok: true };
    } catch (e) {
      return toFailure(e);
    }
  }

  /** Stored settings (sanitised), or null if none / unavailable. */
  async getSettings(): Promise<Settings | null> {
    const db = await this.conn();
    if (!db) return null;
    try {
      const tx = db.transaction(SETTINGS, 'readonly');
      const raw: unknown = await req(tx.objectStore(SETTINGS).get(SETTINGS_KEY));
      return raw === undefined ? null : sanitizeSettings(raw);
    } catch {
      return null;
    }
  }

  async putSettings(s: Settings): Promise<Result> {
    const clean = sanitizeSettings(s);
    if (!clean) return { ok: false, error: 'invalid', message: 'Those settings could not be saved.' };
    const db = await this.conn();
    if (!db) return UNAVAILABLE;
    try {
      const tx = db.transaction(SETTINGS, 'readwrite');
      const committed = done(tx);
      tx.objectStore(SETTINGS).put(clean, SETTINGS_KEY);
      await committed;
      return { ok: true };
    } catch (e) {
      return toFailure(e);
    }
  }

  /** Storage usage/quota in bytes, when the browser exposes it. */
  async estimate(): Promise<{ usage: number; quota: number } | null> {
    try {
      const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
      if (!storage || typeof storage.estimate !== 'function') return null;
      const e = await storage.estimate();
      return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
    } catch {
      return null;
    }
  }

  /** Closes the connection (e.g. in tests or before deleting the DB). */
  close(): void {
    this.db?.close();
    this.db = null;
  }
}
