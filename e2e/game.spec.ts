import { expect, test, type Page } from '@playwright/test';

/**
 * Functional tests run at the cheapest graphics tier: CI renders on a CPU (SwiftShader), where the
 * full watercolour pass drops to ~2 FPS and the bounded fixed-step loop slows simulation time.
 * The visual scenes test keeps the full look.
 */
async function fast(page: Page) {
  await page.evaluate(() => (window as any).__cozy.store.getState().setSettings((s: any) => ({ ...s, graphics: { ...s.graphics, tier: 'battery', postProcessing: false } })));
}

/** Wait until the engine exists and terrain around the camera has streamed in. */
async function ready(page: Page, full = false) {
  await page.waitForFunction(() => !!(window as unknown as { __cozy?: unknown }).__cozy, null, { timeout: 45_000 });
  await page.waitForFunction(() => (window as unknown as { __cozy: { engine: { terrain: { chunks: Map<string, unknown> } } } }).__cozy.engine.terrain.chunks.size > 8, null, { timeout: 45_000 });
  if (!full) await fast(page);
}

const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
});
test.afterEach(() => {
  expect(errors.filter((e) => !/GPU stall|WebGL-/.test(e))).toEqual([]);
});

test('launches straight into the world with a working starter coaster', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await expect(page.getByRole('dialog', { name: 'Welcome to Cozy Coaster' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore the meadow' })).toBeVisible();
  const size = await page.evaluate(() => (window as any).__cozy.engine.capture('image/png').length);
  expect(size).toBeGreaterThan(50_000);
  const s0 = await page.evaluate(() => (window as any).__cozy.engine.sim.s);
  await page.getByRole('button', { name: 'Take a ride' }).click();
  // The train must get moving. Simulation time is bounded per frame, so on CI's CPU renderer it runs
  // slower than wall time: wait for the movement instead of a fixed number of seconds.
  await page.waitForFunction((start) => Math.abs((window as any).__cozy.engine.sim.s - start) > 1, s0, { timeout: 30_000 });
  const s1 = await page.evaluate(() => (window as any).__cozy.engine.sim.s);
  expect(Math.abs(s1 - s0)).toBeGreaterThan(1);
  await page.screenshot({ path: `test-results/visual/${test.info().project.name}-ride.png` });
});

const connected = (page: Page) =>
  page.evaluate(() => {
    const e = (window as any).__cozy.engine;
    return e.ridden.closed && e.track.diagnostics.maxGap < 1e-6 && !e.track.diagnostics.seamFlip;
  });
const nodeCount = (page: Page) => page.evaluate(() => (window as any).__cozy.store.getState().design.nodes.length);

test('edit mode: the ghost shows the next piece; add, turn, climb, specials, remove, undo and redo; the track always stays connected', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await ready(page);
  // Start blank: just the station, and the edit panel opens.
  await page.getByRole('button', { name: /Start blank/ }).click();
  const btn = (name: string) => page.getByRole('button', { name, exact: true });
  // The train waits in the station while building, and a ghost piece is shown (nothing committed yet).
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.engine.sim.state)).toBe('hold');
  await expect.poll(() => page.evaluate(() => !!(window as any).__cozy.engine.previewDesign)).toBe(true);
  const n0 = await nodeCount(page);
  await btn('Add piece').click();
  await expect.poll(() => nodeCount(page)).toBeGreaterThan(n0);
  expect(await connected(page)).toBe(true);
  for (const [choice, label] of [['Turn left', 'Up'], ['Turn right', 'Level'], ['Straight', 'Down']] as const) {
    await btn(choice).click();
    await btn(label).click();
    await btn('Add piece').click();
    expect(await connected(page)).toBe(true);
  }
  // A loop needs speed: the panel offers a Launch, and the Loop appears once there's speed for it.
  await btn('Launch').click();
  await btn('Add piece').click();
  await expect(btn('Loop')).toBeVisible({ timeout: 20_000 });
  await btn('Loop').click();
  await expect(page.getByText(/Loop ends/)).toBeVisible();
  await btn('Add piece').click();
  expect(await connected(page)).toBe(true);
  const n1 = await nodeCount(page);
  await page.screenshot({ path: `test-results/visual/${test.info().project.name}-build.png` });
  await page.getByRole('button', { name: 'Remove the last piece' }).click();
  await expect.poll(() => nodeCount(page)).toBeLessThan(n1);
  const n2 = await nodeCount(page);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(() => nodeCount(page)).toBeGreaterThan(n2);
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect.poll(() => nodeCount(page)).toBe(n2);
  expect(await connected(page)).toBe(true);
  // Leaving edit mode lets the train run again and removes the ghost.
  await btn('Edit').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__cozy.engine.previewDesign)).toBe(false);
});

test('edit mode: no dead buttons, select and change a piece in the middle, remove it, and start blank', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: /Start blank/ }).click();
  const btn = (name: string) => page.getByRole('button', { name, exact: true });
  const ghostEnd = () => page.evaluate(() => { const d = (window as any).__cozy.engine.previewDesign; const n = d?.nodes[d.nodes.length - 1]; return n ? n.p.map((v: number) => v.toFixed(2)).join(',') : ''; });
  // Every enabled direction/slope combination must give its own ghost.
  for (let i = 0; i < 2; i++) await btn('Add piece').click();
  const seen = new Map<string, string>();
  for (const dir of ['Turn left', 'Straight', 'Turn right']) {
    for (const slope of ['Down', 'Level', 'Up']) {
      await btn(dir).click();
      // Options that don't fit here are hidden (contextual), so only offered ones are checked.
      const sb = page.getByRole('group', { name: 'Slope' }).getByRole('button', { name: slope, exact: true });
      if ((await sb.count()) === 0) continue;
      await sb.click();
      // Wait until the ghost has been planned for this exact choice (slow machines lag a frame or two).
      await expect.poll(() => page.evaluate(() => { const s = (window as any).__cozy.store.getState(); return s.ghost?.forChoice === JSON.stringify(s.buildChoice); }), { timeout: 15_000 }).toBe(true);
      const end = await ghostEnd();
      expect(seen.has(end), `${dir} + ${slope} gives the same ghost as ${seen.get(end)}`).toBe(false);
      seen.set(end, `${dir} + ${slope}`);
    }
  }
  // Build a few pieces, then step back and change one in the middle.
  await btn('Straight').click();
  await page.getByRole('group', { name: 'Slope' }).getByRole('button', { name: 'Level', exact: true }).click();
  for (let i = 0; i < 3; i++) await btn('Add piece').click();
  await btn('Previous piece').click();
  await btn('Previous piece').click();
  await expect(page.getByText(/^Piece \d+ of \d+$/)).toBeVisible();
  const before = await nodeCount(page);
  // Change it into something that fits here (whatever the panel offers first among the shapes).
  await page.waitForTimeout(500);
  await btn('Turn left').click();
  await btn('Apply change').click();
  await expect.poll(() => nodeCount(page)).not.toBe(before);
  expect(await connected(page)).toBe(true);
  await btn('Remove this piece').click();
  expect(await connected(page)).toBe(true);
  // Tapping the track selects a piece.
  await btn('Go to end').click();
  const xy = await page.evaluate(() => {
    const e = (window as any).__cozy.engine;
    const d = (window as any).__cozy.store.getState().design;
    // A player taps track they can see: anywhere along their built pieces (past the station, before
    // the newest piece's end) that is on the open canvas.
    const t = e.track;
    const firstBuilt = d.nodes.findIndex((n: { group?: string }) => n.group && n.group !== 'station');
    const from = t.nodeS[Math.max(0, firstBuilt - 1)] + 2;
    const to = t.nodeS[d.nodes.length - 1] - 2;
    for (let s = to; s > from; s -= 1) {
      const i = Math.round(s / t.ds);
      const v = new e.rig.camera.position.constructor(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]).project(e.rig.camera);
      const x = ((v.x + 1) / 2) * innerWidth;
      const y = ((1 - v.y) / 2) * innerHeight;
      if (v.z < 1 && x > 8 && x < innerWidth - 8 && document.elementFromPoint(x, y)?.classList.contains('cc-canvas')) return [x, y];
    }
    return null;
  });
  expect(xy, 'some built track is visible on the open canvas').not.toBeNull();
  if (!xy) return;
  await page.mouse.click(xy[0], xy[1]);
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.store.getState().editSel)).not.toBeNull();
  await btn('Done').click();
  // Start blank: only the station, and the edit panel opens.
  await page.getByRole('button', { name: /^Menu/ }).click();
  await page.getByRole('button', { name: /New coaster/ }).click();
  await expect.poll(() => nodeCount(page)).toBe(2);
  await expect(btn('Add piece')).toBeVisible();
  await btn('Add piece').click();
  expect(await connected(page)).toBe(true);
});

test('building never leaks GPU memory (phones reload the page when it runs out)', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const geometries = () => page.evaluate(() => (window as any).__cozy.engine.renderer.info.memory.geometries as number);
  await page.getByRole('button', { name: 'Add piece', exact: true }).click();
  await page.waitForTimeout(500);
  const before = await geometries();
  for (let i = 0; i < 12; i++) {
    await page.getByRole('button', { name: 'Add piece', exact: true }).click();
    await page.getByRole('button', { name: 'Remove the last piece' }).click();
  }
  await page.waitForTimeout(800);
  expect(await geometries()).toBeLessThan(before + 15);
});

test('a two-finger pinch moves the camera and never builds', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const before = await page.evaluate(() => ({ n: (window as any).__cozy.store.getState().design.nodes.length, d: (window as any).__cozy.engine.rig.distance }));
  await page.evaluate(async () => {
    const c = document.querySelector('canvas')!;
    const r = c.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 3;
    const ev = (type: string, id: number, x: number, y: number) =>
      c.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', isPrimary: id === 1, bubbles: true, button: 0, buttons: 1 }));
    ev('pointerdown', 1, cx - 20, cy);
    ev('pointerdown', 2, cx + 20, cy);
    for (let i = 1; i <= 10; i++) {
      ev('pointermove', 1, cx - 20 - i * 8, cy);
      ev('pointermove', 2, cx + 20 + i * 8, cy);
      await new Promise((r) => setTimeout(r, 16));
    }
    ev('pointerup', 1, cx - 100, cy);
    ev('pointerup', 2, cx + 100, cy);
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ n: (window as any).__cozy.store.getState().design.nodes.length, d: (window as any).__cozy.engine.rig.distance }));
  expect(after.n).toBe(before.n);
  expect(after.d).toBeLessThan(before.d);
});

test('carriages change at any time, even mid-ride; timber, rain and riding all work', async ({ page }) => {
  // Many steps (paint, supports, rain, ride, sheet open/close) on CI's CPU renderer.
  test.setTimeout(180_000);
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  await page.evaluate(() => (window as any).__cozy.engine.dispatch());
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Paint', exact: true }).click();
  await page.getByRole('tab', { name: 'Train' }).click();
  const more = page.getByRole('button', { name: 'More carriages' });
  while (await more.isEnabled()) await more.click();
  expect(await page.evaluate(() => (window as any).__cozy.engine.sim.cfg.cars)).toBe(6);
  await page.getByRole('button', { name: 'Fewer carriages' }).click();
  expect(await page.evaluate(() => (window as any).__cozy.engine.sim.cfg.cars)).toBe(5);
  await page.getByRole('tab', { name: 'Supports' }).click();
  await page.getByRole('button', { name: 'Pine', exact: true }).click();
  await page.getByRole('button', { name: 'Sky', exact: true }).click();
  await page.getByRole('button', { name: 'Rain', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.engine.atmosphere.state.rain), { timeout: 15_000 }).toBeGreaterThan(0.3);
  await page.getByRole('button', { name: 'Ride', exact: true }).click();
  await page.getByRole('button', { name: 'Front seat' }).click();
  const cam = () => page.evaluate(() => (window as any).__cozy.store.getState().camera);
  expect(await cam()).toBe('front');
  // Riding puts the sheet away for a clear view; opening and closing it never ends the ride.
  await expect(page.getByRole('button', { name: 'Front seat' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ride', exact: true }).click();
  await page.getByRole('button', { name: 'Watch' }).click();
  expect(await cam()).not.toBe('orbit');
  // Menus never change the view: opening Sky while watching keeps watching.
  const watchingCam = await cam();
  await page.getByRole('button', { name: 'Sky', exact: true }).click();
  expect(await cam()).toBe(watchingCam);
  await page.getByRole('button', { name: 'Sky', exact: true }).click();
  await page.getByRole('button', { name: 'Ride', exact: true }).click();
  await page.getByRole('button', { name: 'Ride', exact: true }).click();
  expect(await cam()).not.toBe('orbit');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `test-results/visual/${test.info().project.name}-rain-six-cars.png` });
});

test('decorate: pick a tree and tap the ground to place it', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  await page.getByRole('button', { name: 'Decorate', exact: true }).click();
  await page.getByRole('button', { name: 'Tree', exact: true }).click();
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height * 0.3);
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.store.getState().scenery.length)).toBe(1);
});

test('menu switches toggle, and progress survives a reload', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  await page.getByRole('button', { name: /^Menu/ }).click();
  const music = page.getByRole('switch', { name: /Music/ });
  const was = await music.getAttribute('aria-checked');
  await music.click();
  await expect(music).toHaveAttribute('aria-checked', was === 'true' ? 'false' : 'true');
  await page.getByLabel('Coaster name').fill('Willow Whirl');
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.store.getState().saveStatus), { timeout: 20_000 }).toBe('saved');
  await page.reload();
  await ready(page);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
  await expect(page.getByText('Willow Whirl').first()).toBeVisible();
});

test('recovers from WebGL context loss without losing the world', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  const nodes = await nodeCount(page);
  await page.evaluate(async () => {
    const gl = (window as any).__cozy.engine.renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    await new Promise((r) => setTimeout(r, 500));
    ext?.restoreContext();
    await new Promise((r) => setTimeout(r, 1500));
  });
  expect(await nodeCount(page)).toBe(nodes);
  expect(await page.evaluate(() => (window as any).__cozy.engine.renderer.getContext().isContextLost())).toBe(false);
});

test('seeded visual scenes render without errors', async ({ page }) => {
  // Six full-quality scenes on CI's CPU renderer: ~4 min on a typical runner, twice that on a slow one.
  test.setTimeout(720_000);
  await page.goto('/');
  await ready(page, true);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  const scenes: Array<[string, Record<string, unknown>, Record<string, unknown>?]> = [
    ['woodland-timber', { biome: 'woodland', weather: 'mist', time: 'morning' }, { style: 'wood', supportStyle: 'walnut' }],
    ['alpine-steel', { biome: 'alpine', weather: 'clear', time: 'midday' }, { style: 'boxspine', supportStyle: 'galvanised' }],
    ['winter-snow', { biome: 'winter', weather: 'snow', time: 'afternoon' }],
    ['night-station', { biome: 'meadow', weather: 'clear', time: 'night' }],
    ['autumn-golden', { biome: 'autumn', weather: 'golden-haze', time: 'golden' }],
    ['coastal', { biome: 'coastal', weather: 'partly-cloudy', time: 'afternoon' }],
  ];
  for (const [name, env, design] of scenes) {
    await page.evaluate(
      ([env, design]) => {
        const s = (window as any).__cozy.store.getState();
        s.setEnv(env);
        if (design) s.commitDesign({ ...s.design, ...design });
      },
      [env, design] as const,
    );
    await page.waitForTimeout(7000);
    await page.screenshot({ path: `test-results/visual/${test.info().project.name}-${name}.png` });
  }
});
