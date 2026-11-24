import { describe, test, expect } from 'vitest';
import { exportFilename, exportSave, importSave, serializeSave, slugify, MAX_IMPORT_BYTES, EXPORT_FORMAT } from './portable';
import { makeTestSave } from './test-helpers';

describe('export', () => {
  test('wraps the save in a pretty JSON envelope', async () => {
    const save = makeTestSave();
    const text = serializeSave(save, new Date('2026-03-04T10:00:00Z'));
    expect(text).toContain('\n  "format": "cozy-coaster-save"');
    const parsed = JSON.parse(text) as { format: string; exported: string; save: unknown };
    expect(parsed.format).toBe(EXPORT_FORMAT);
    expect(parsed.exported).toBe('2026-03-04T10:00:00.000Z');
    expect(parsed.save).toEqual(save);
    const blob = exportSave(save);
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(await blob.text())).toMatchObject({ format: EXPORT_FORMAT });
  });

  test('suggests a slugified filename', () => {
    expect(exportFilename({ name: 'Sunny Méadow!! Park' }, new Date(2026, 0, 9))).toBe('cozy-coaster-sunny-meadow-park-2026-01-09.json');
    expect(slugify('???')).toBe('coaster');
  });
});

describe('importSave', () => {
  test('accepts the export wrapper and assigns a new id', async () => {
    const save = makeTestSave();
    const r = await importSave(serializeSave(save), { now: () => 123 });
    if (!r.ok) throw new Error(r.message);
    expect(r.save.id).not.toBe(save.id);
    expect(r.save.name).toBe(save.name);
    expect(r.save.updated).toBe(123);
    expect(r.save.track).toEqual(save.track);
  });

  test('accepts a bare save', async () => {
    const save = makeTestSave();
    const r = await importSave(JSON.stringify(save));
    if (!r.ok) throw new Error(r.message);
    expect(r.save.id).not.toBe(save.id);
    expect(r.save.coasterName).toBe(save.coasterName);
  });

  test('accepts a Blob', async () => {
    const r = await importSave(new Blob([JSON.stringify(makeTestSave())]));
    expect(r.ok).toBe(true);
  });

  test('renames on a name clash', async () => {
    const save = makeTestSave({ name: 'My Park' });
    const r = await importSave(JSON.stringify(save), { existingNames: ['My Park'] });
    if (!r.ok) throw new Error(r.message);
    expect(r.save.name).toBe('My Park (imported)');
    const r2 = await importSave(JSON.stringify(save), { existingNames: ['My Park', 'My Park (imported)'] });
    if (!r2.ok) throw new Error(r2.message);
    expect(r2.save.name).toBe('My Park (imported 2)');
  });

  test('migrates legacy saves on import', async () => {
    const b = makeTestSave();
    const r = await importSave(JSON.stringify({ version: 0, track: b.track, train: b.train, env: b.environment, name: 'Legacy' }));
    if (!r.ok) throw new Error(r.message);
    expect(r.save.schema).toBe(1);
    expect(r.save.name).toBe('Legacy');
  });

  test('enforces the size limit', async () => {
    const r = await importSave(' '.repeat(MAX_IMPORT_BYTES + 1));
    expect(r).toMatchObject({ ok: false, error: 'too-large' });
    const big = new Blob([new Uint8Array(MAX_IMPORT_BYTES + 1)]);
    expect(await importSave(big)).toMatchObject({ ok: false, error: 'too-large' });
  });

  test('rejects malformed JSON and foreign files with a friendly message', async () => {
    const bad = await importSave('{ not json');
    expect(bad).toMatchObject({ ok: false, error: 'invalid' });
    if (!bad.ok) expect(bad.message).toMatch(/doesn't look like a Cozy Coaster save/);
    expect(await importSave('{"format":"other-game","save":{}}')).toMatchObject({ ok: false, error: 'invalid' });
    expect(await importSave('[1,2,3]')).toMatchObject({ ok: false, error: 'invalid' });
    expect(await importSave('null')).toMatchObject({ ok: false, error: 'invalid' });
  });

  test('rejects saves from a newer version', async () => {
    const r = await importSave(JSON.stringify({ ...makeTestSave(), schema: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/newer version/);
  });

  test('tolerates a UTF-8 BOM', async () => {
    const r = await importSave('﻿' + JSON.stringify(makeTestSave()));
    expect(r.ok).toBe(true);
  });
});
