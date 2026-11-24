import { describe, test, expect } from 'vitest';
import { SaveStore, isQuotaError, toFailure, QUOTA_MESSAGE } from './save-store';
import { newSaveId, newItemId } from './ids';
import { makeTestSave } from './test-helpers';

describe('store error mapping', () => {
  test('detects quota errors by name and code', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
    expect(isQuotaError(new Error('nope'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(toFailure({ name: 'QuotaExceededError' })).toEqual({ ok: false, error: 'quota', message: QUOTA_MESSAGE });
    expect(toFailure(new Error('x')).error).toBe('unknown');
  });
});

describe('SaveStore without IndexedDB', () => {
  test('open resolves false and methods return typed failures', async () => {
    const store = new SaveStore();
    expect(await store.open()).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await store.load('x')).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await store.put(makeTestSave())).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await store.remove('x')).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await store.duplicate('x', 'y')).toBeNull();
    expect(await store.getSettings()).toBeNull();
  });

  test('put rejects invalid saves before touching storage', async () => {
    const store = new SaveStore();
    const bad = makeTestSave();
    bad.track.nodes[0]!.p[0] = Number.NaN;
    expect(await store.put(bad)).toMatchObject({ ok: false, error: 'invalid' });
  });
});

describe('ids', () => {
  test('newSaveId is a v4 UUID and unique', () => {
    const a = newSaveId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newSaveId()).not.toBe(a);
    expect(newItemId('n')).toMatch(/^n-/);
  });
});
