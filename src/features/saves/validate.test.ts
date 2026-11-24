import { describe, test, expect } from 'vitest';
import { validateSave, SAVE_LIMITS, NOT_A_SAVE } from './validate';
import { sanitizeSettings } from './validate-settings';
import { defaultSettings } from './defaults';
import { cloneLoose, makeTestSave } from './test-helpers';

type Loose = Record<string, unknown>;
const track = (s: Loose) => s.track as Loose;
const nodes = (s: Loose) => track(s).nodes as Loose[];
const firstNode = (s: Loose) => nodes(s)[0] as Loose;

function expectOk(input: unknown) {
  const r = validateSave(input);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r;
}

function expectFail(input: unknown) {
  const r = validateSave(input);
  if (r.ok) throw new Error('expected failure');
  return r.error;
}

describe('validateSave', () => {
  test('a good save passes unchanged and without warnings', () => {
    const save = makeTestSave();
    const r = expectOk(save);
    expect(r.warnings).toEqual([]);
    expect(r.save).toEqual(save);
  });

  test('returns a fresh object, never the input', () => {
    const save = makeTestSave();
    const r = expectOk(save);
    expect(r.save).not.toBe(save);
    expect(r.save.track).not.toBe(save.track);
    expect(r.save.track.nodes[0]).not.toBe(save.track.nodes[0]);
    expect(r.save.track.nodes[0]?.p).not.toBe(save.track.nodes[0]?.p);
  });

  test.each([null, undefined, 42, 'hello', [], true])('rejects top-level non-object %s', (v) => {
    expect(expectFail(v)).toBe(NOT_A_SAVE);
  });

  test('rejects objects without a schema', () => {
    const s = cloneLoose(makeTestSave());
    delete s.schema;
    expect(expectFail(s)).toBe(NOT_A_SAVE);
  });

  test('rejects a newer schema with a friendly message', () => {
    expect(expectFail({ ...cloneLoose(makeTestSave()), schema: 99 })).toMatch(/newer version/);
  });

  test('rejects NaN and Infinity anywhere', () => {
    const a = makeTestSave();
    a.track.nodes[3]!.p[1] = Number.NaN;
    expect(expectFail(a)).toMatch(/invalid numbers/);

    const b = makeTestSave();
    b.physics.gravity = Number.POSITIVE_INFINITY;
    expect(expectFail(b)).toMatch(/invalid numbers/);

    const c = makeTestSave();
    (c as unknown as Loose).someUnknownField = { deep: [1, -Infinity] };
    expect(expectFail(c)).toMatch(/invalid numbers/);
  });

  test('rejects huge arrays', () => {
    const s = cloneLoose(makeTestSave());
    const base = firstNode(s);
    track(s).nodes = Array.from({ length: SAVE_LIMITS.maxTrackNodes + 1 }, (_, i) => ({ ...base, id: `n${i}` }));
    expect(expectFail(s)).toMatch(/too many track points/);

    const t = cloneLoose(makeTestSave());
    t.scenery = Array.from({ length: SAVE_LIMITS.maxScenery + 1 }, () => ({ id: 'x', type: 'oak', p: [0, 0, 0], rot: 0, scale: 1 }));
    expect(expectFail(t)).toMatch(/too many scenery/);

    const u = cloneLoose(makeTestSave());
    u.terrainEdits = new Array(SAVE_LIMITS.maxTerrainStrokes + 1).fill({ mode: 'raise', x: 0, z: 0, radius: 1, strength: 1 });
    expect(expectFail(u)).toMatch(/too many terrain/);
  });

  test('rejects overly deep nesting', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(expectFail({ ...cloneLoose(makeTestSave()), junk: deep })).toMatch(/damaged/);
  });

  test('rejects wrong types for required track data', () => {
    const a = cloneLoose(makeTestSave());
    firstNode(a).p = 'here';
    expect(expectFail(a)).toMatch(/track point 1 has an invalid position/);

    const b = cloneLoose(makeTestSave());
    firstNode(b).p = [1, '2', 3];
    expect(expectFail(b)).toMatch(/invalid position/);

    const c = cloneLoose(makeTestSave());
    track(c).nodes = 'lots';
    expect(expectFail(c)).toMatch(/track is missing/);

    const d = cloneLoose(makeTestSave());
    firstNode(d).bank = 'steep';
    expect(expectFail(d)).toMatch(/bank/);
  });

  test('rejects missing track', () => {
    const s = cloneLoose(makeTestSave());
    delete s.track;
    expect(expectFail(s)).toMatch(/track is missing/);
  });

  test('re-normalises direction vectors and rejects zero vectors', () => {
    const a = makeTestSave();
    a.track.nodes[0]!.dir = [0, 0, 5];
    const r = expectOk(a);
    expect(r.save.track.nodes[0]?.dir).toEqual([0, 0, 1]);
    expect(r.warnings.some((w) => w.includes('re-normalised'))).toBe(true);

    const b = makeTestSave();
    b.track.nodes[2]!.dir = [0, 0, 0];
    expect(expectFail(b)).toMatch(/track point 3 has no direction/);
  });

  test('regenerates duplicate and empty node ids with a warning', () => {
    const s = makeTestSave();
    s.track.nodes[1]!.id = s.track.nodes[0]!.id;
    s.track.nodes[2]!.id = '';
    const r = expectOk(s);
    const ids = r.save.track.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('node-0');
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(r.warnings.some((w) => w.includes('duplicate ids') && w.includes('2 items'))).toBe(true);
  });

  test('replaces bad colours with defaults', () => {
    const s = makeTestSave();
    s.track.colours.rail = 'red';
    s.train.colours.primary = '#12345';
    s.train.colours.seat = '#ABCDEF';
    const r = expectOk(s);
    expect(r.save.track.colours.rail).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(r.save.track.colours.rail).not.toBe('red');
    expect(r.save.train.colours.primary).not.toBe('#12345');
    expect(r.save.train.colours.seat).toBe('#abcdef');
    expect(r.warnings.filter((w) => w.includes('colour'))).toHaveLength(2);
  });

  test('drops oversized or non-image thumbnails with a warning', () => {
    const big = makeTestSave({ thumbnail: 'data:image/jpeg;base64,' + 'A'.repeat(SAVE_LIMITS.maxThumbnailBytes) });
    const r1 = expectOk(big);
    expect(r1.save.thumbnail).toBeUndefined();
    expect(r1.warnings.some((w) => w.includes('preview image'))).toBe(true);

    const r2 = expectOk(makeTestSave({ thumbnail: 'javascript:alert(1)' }));
    expect(r2.save.thumbnail).toBeUndefined();

    const r3 = expectOk(makeTestSave({ thumbnail: 'data:image/svg+xml;base64,AAAA' }));
    expect(r3.save.thumbnail).toBeUndefined();

    const r4 = expectOk(makeTestSave({ thumbnail: 'data:image/png;base64,iVBORw0KGgo=' }));
    expect(r4.save.thumbnail).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  test('replaces unknown enum values with defaults and warns', () => {
    const s = cloneLoose(makeTestSave());
    (s.environment as Loose).biome = 'volcano';
    (s.train as Loose).style = 'rocket';
    firstNode(s).kind = 'teleporter';
    track(s).style = 'glass';
    const r = expectOk(s);
    expect(r.save.environment.biome).toBe('meadow');
    expect(r.save.train.style).toBe('steel');
    expect(r.save.track.nodes[0]?.kind).toBe('track');
    expect(r.save.track.style).toBe('tubular');
    expect(r.warnings.some((w) => w.includes('volcano'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('rocket'))).toBe(true);
  });

  test('clamps carriage count to 1..6', () => {
    expect(expectOk(makeTestSave({ train: { ...makeTestSave().train, cars: 40 } })).save.train.cars).toBe(6);
    expect(expectOk(makeTestSave({ train: { ...makeTestSave().train, cars: 0 } })).save.train.cars).toBe(1);
    expect(expectOk(makeTestSave({ train: { ...makeTestSave().train, cars: 2.6 } })).save.train.cars).toBe(3);
  });

  test('fills missing optional sections with defaults and warnings', () => {
    const s = cloneLoose(makeTestSave());
    delete s.environment;
    delete s.train;
    delete s.scenery;
    delete s.terrainEdits;
    delete s.physics;
    delete s.camera;
    delete s.name;
    const r = expectOk(s);
    expect(r.save.environment.biome).toBe('meadow');
    expect(r.save.train.cars).toBeGreaterThanOrEqual(1);
    expect(r.save.scenery).toEqual([]);
    expect(r.save.terrainEdits).toEqual([]);
    expect(r.save.physics).toEqual({});
    expect(r.save.camera).toBeUndefined();
    expect(r.save.name).toBe('Untitled park');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test('truncates long names and strips control characters', () => {
    const r = expectOk(makeTestSave({ name: 'A'.repeat(500), coasterName: 'Zoom\u0000\u0007 Ride' }));
    expect(r.save.name.length).toBe(SAVE_LIMITS.maxNameLength);
    expect(r.save.coasterName).toBe('Zoom Ride');
  });

  test('drops damaged scenery and terrain items instead of failing', () => {
    const s = cloneLoose(makeTestSave());
    (s.scenery as unknown[]).push('tree', { id: 'q', type: 'oak', p: [0, 'x', 0], rot: 0, scale: 1 });
    (s.terrainEdits as unknown[]).push({ mode: 'explode', x: 0, z: 0, radius: 1, strength: 1 }, { mode: 'raise', x: 0 });
    const r = expectOk(s);
    expect(r.save.scenery).toHaveLength(2);
    expect(r.save.terrainEdits).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes('scenery'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('terrain'))).toBe(true);
  });

  test('clamps out-of-range physics and ignores unknown physics keys', () => {
    const s = cloneLoose(makeTestSave());
    s.physics = { gravity: 1000, hackSpeed: 3, dwell: 'long' };
    const r = expectOk(s);
    expect(r.save.physics).toEqual({ gravity: 30 });
  });

  test('prototype-pollution keys do not leak', () => {
    const json =
      '{"schema":1,"id":"abc","name":"P","created":1,"updated":2,"coasterName":"C",' +
      '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},' +
      '"environment":{"__proto__":{"polluted":true},"biome":"alpine","seed":1,"weather":"snow","time":"night","autoCycle":true,"environmentalPhysics":false},' +
      '"track":{"nodes":[{"id":"a","p":[0,0,0],"dir":[1,0,0],"bank":0,"kind":"station","__proto__":{"polluted":true}}],' +
      '"closed":false,"style":"mine","supportStyle":"weathered","colours":{"rail":"#000000","spine":"#111111","sleeper":"#222222","support":"#333333"}},' +
      '"train":{"cars":2,"style":"mine","colours":{"primary":"#000000","secondary":"#000000","seat":"#000000","trim":"#000000","wheels":"#000000"},"finish":"matte"},' +
      '"physics":{"__proto__":{"gravity":1}},"scenery":[],"terrainEdits":[]}';
    const r = expectOk(JSON.parse(json));
    const out = r.save as unknown as Loose;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'constructor')).toBe(false);
    expect(out.polluted).toBeUndefined();
    expect((r.save.environment as unknown as Loose).polluted).toBeUndefined();
    expect((r.save.track.nodes[0] as unknown as Loose).polluted).toBeUndefined();
    expect(r.save.physics).toEqual({});
    expect(({} as Loose).polluted).toBeUndefined();
  });

  test('regenerates an invalid save id', () => {
    const r = expectOk(makeTestSave({ id: '' }));
    expect(r.save.id.length).toBeGreaterThan(0);
    expect(r.warnings.some((w) => w.includes('new one'))).toBe(true);
  });
});

describe('sanitizeSettings', () => {
  test('returns null for non-objects and fills defaults for partial input', () => {
    expect(sanitizeSettings('x')).toBeNull();
    const s = sanitizeSettings({ audio: { master: 5, muted: true }, graphics: { tier: 'mega', fpsCap: 30 } });
    expect(s?.audio.master).toBe(1);
    expect(s?.audio.muted).toBe(true);
    expect(s?.graphics.tier).toBe('auto');
    expect(s?.graphics.fpsCap).toBe(30);
    expect(sanitizeSettings(defaultSettings())).toEqual(defaultSettings());
  });
});
