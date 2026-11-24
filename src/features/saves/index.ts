/** Public API of the saves feature. */
export { newSaveId, newItemId } from './ids';
export { validateSave, sanitizeName, SAVE_LIMITS, NOT_A_SAVE, NEWER_SAVE, DAMAGED_SAVE } from './validate';
export type { ValidateResult } from './validate';
export { sanitizeSettings } from './validate-settings';
export { migrateSave, detectVersion, MIGRATIONS, SaveFormatError } from './migrate';
export { parseSave } from './pipeline';
export { SaveStore, isQuotaError, toFailure, QUOTA_MESSAGE, DB_NAME, DB_VERSION, SNAPSHOT_SLOTS } from './save-store';
export type { SaveSummary, Result, LoadResult, StoreFailure, StoreErrorCode, SaveStoreOptions } from './save-store';
export { Autosaver, attachLifecycleFlush } from './autosave';
export type { AutosaveStatus, AutosaverOptions, SaveSink, TimerApi } from './autosave';
export { exportSave, serializeSave, exportFilename, slugify, importSave, EXPORT_FORMAT, MAX_IMPORT_BYTES } from './portable';
export type { ExportWrapper, ImportResult, ImportErrorCode, ImportOptions } from './portable';
export { defaultSettings, defaultTrain, DEFAULT_ENVIRONMENT } from './defaults';
