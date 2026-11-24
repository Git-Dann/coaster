import { describe, test, expect } from 'vitest';
import { migrateSave, SaveFormatError, detectVersion } from './migrate';
import { parseSave } from './pipeline';
import { makeTestSave } from './test-helpers';

describe('migrateSave', () => {
  test('current saves pass through', () => {
    const s = makeTestSave();
    expect(migrateSave(s)).toBe(s);
  });

  test('upgrades legacy schema 0 to schema 1 with defaults', () => {
    const base = makeTestSave();
    const v0 = { version: 0, track: base.track, train: base.train, env: base.environment, name: 'Old Park' };
    const r = parseSave(v0);
    if (!r.ok) throw new Error(r.error);
    expect(r.save.schema).toBe(1);
    expect(r.save.name).toBe('Old Park');
    expect(r.save.track.nodes).toHaveLength(base.track.nodes.length);
    expect(r.save.environment).toEqual(base.environment);
    expect(r.save.scenery).toEqual([]);
    expect(r.save.terrainEdits).toEqual([]);
    expect(r.save.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('schema 0 without a name gets default names', () => {
    const base = makeTestSave();
    const r = parseSave({ version: 0, track: base.track, train: base.train, env: base.environment });
    if (!r.ok) throw new Error(r.error);
    expect(r.save.name).toBe('Untitled park');
  });

  test('rejects newer schemas with a friendly error', () => {
    expect(() => migrateSave({ ...makeTestSave(), schema: 7 })).toThrow(SaveFormatError);
    const r = parseSave({ ...makeTestSave(), schema: 7 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version of Cozy Coaster/);
  });

  test('rejects things that are not saves', () => {
    expect(() => migrateSave('nope')).toThrow(/doesn't look like a Cozy Coaster save/);
    expect(() => migrateSave({ schema: -1 })).toThrow(SaveFormatError);
    expect(() => migrateSave({ schema: 1.5 })).toThrow(SaveFormatError);
    expect(detectVersion({})).toBeNull();
  });
});
