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
  // The canvas is not blank: sample pixel variance.
  const variance = await page.evaluate(() => {
    const e = (window as any).__cozy.engine;
    const url: string = e.capture('image/png');
    return url.length;
  });
  expect(variance).toBeGreaterThan(50_000);
  // The starter train is genuinely simulated: dispatch and watch it move.
  const s0 = await page.evaluate(() => (window as any).__cozy.engine.sim.s);
  await page.getByRole('button', { name: 'Take a ride' }).click();
  await page.waitForTimeout(4000);
  const s1 = await page.evaluate(() => (window as any).__cozy.engine.sim.s);
  expect(Math.abs(s1 - s0)).toBeGreaterThan(1);
  await page.screenshot({ path: `test-results/visual/${test.info().project.name}-ride.png` });
});

test('build: raise the track end, watch supports grow, place, undo and redo', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Build your own coaster' }).click();
  const start = await page.evaluate(() => (window as any).__cozy.store.getState().design.nodes.length);
  const project = () =>
    page.evaluate(() => {
      const e = (window as any).__cozy.engine;
      const h = e.handles.end;
      const v = e.rig.camera.position.clone().set(h[0], h[1] + 3.2, h[2]).project(e.rig.camera);
      const r = e.renderer.domElement.getBoundingClientRect();
      return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height] as [number, number];
    });
  // Wait for the camera to finish easing into place before grabbing the handle.
  let handle = await project();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const next = await project();
    const still = Math.hypot(next[0] - handle[0], next[1] - handle[1]) < 0.5;
    handle = next;
    if (still) break;
  }
  const vp = page.viewportSize()!;
  expect(handle[0]).toBeGreaterThan(0);
  expect(handle[0]).toBeLessThan(vp.width);
  expect(handle[1]).toBeGreaterThan(70);
  expect(handle[1]).toBeLessThan(vp.height * 0.55);
  const topY = () =>
    page.evaluate(() => {
      const t = (window as any).__cozy.engine.previewTrack;
      let m = -Infinity;
      for (let i = 0; i < t.count; i++) m = Math.max(m, t.pos[i * 3 + 1]);
      return m;
    });
  const heightBefore = await topY();
  await page.mouse.move(handle[0], handle[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(handle[0], handle[1] - i * 15);
  await page.mouse.up();
  await page.waitForTimeout(800);
  const rise = await page.evaluate(() => (window as any).__cozy.store.getState().params.rise);
  expect(rise).toBeGreaterThan(1);
  expect(await topY()).toBeGreaterThan(heightBefore + 1);
  expect(await page.evaluate(() => (window as any).__cozy.engine.supports.instanceCount)).toBeGreaterThan(0);
  await page.screenshot({ path: `test-results/visual/${test.info().project.name}-build.png` });
  await page.getByRole('button', { name: 'Place' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.store.getState().design.nodes.length)).toBeGreaterThan(start);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.store.getState().design.nodes.length)).toBe(start);
  await page.getByRole('button', { name: /^Redo/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.store.getState().design.nodes.length)).toBeGreaterThan(start);
});

test('a two-finger pinch moves the camera and never places track', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Build your own coaster' }).click();
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => ({ n: (window as any).__cozy.store.getState().design.nodes.length, d: (window as any).__cozy.engine.rig.distance }));
  // Synthesise a pinch with two pointers on the canvas.
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

test('six carriages, timber supports, gentle rain and a ride', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  await page.getByRole('button', { name: 'Train', exact: true }).click();
  const more = page.getByRole('button', { name: 'More carriages' });
  while (await more.isEnabled()) await more.click();
  expect(await page.evaluate(() => (window as any).__cozy.engine.sim.cfg.cars)).toBe(6);
  expect(await page.evaluate(() => (window as any).__cozy.engine.sim.mass)).toBeGreaterThan(4000);
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  await page.getByRole('radio', { name: 'Pine', exact: true }).click();
  await page.getByRole('button', { name: 'Weather', exact: true }).click();
  await page.getByRole('radio', { name: 'Rain', exact: true }).click();
  await page.waitForTimeout(3000);
  const rain = await page.evaluate(() => (window as any).__cozy.engine.atmosphere.state.rain);
  expect(rain).toBeGreaterThan(0.3);
  await page.getByRole('button', { name: 'Ride', exact: true }).click();
  await page.getByRole('radio', { name: 'Follow' }).click();
  await page.getByRole('button', { name: 'Dispatch' }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `test-results/visual/${test.info().project.name}-rain-six-cars.png` });
});

test('progress saves automatically and survives a reload', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  await page.getByRole('button', { name: 'Style', exact: true }).click();
  const name = page.getByLabel('Coaster name');
  await name.fill('Willow Whirl');
  await expect.poll(() => page.evaluate(() => (window as any).__cozy.store.getState().saveStatus), { timeout: 20_000 }).toBe('saved');
  await page.reload();
  await ready(page);
  await expect(page.getByRole('button', { name: /Willow Whirl/ })).toBeVisible();
});

test('recovers from WebGL context loss without losing the world', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.getByRole('button', { name: 'Explore the meadow' }).click();
  const nodes = await page.evaluate(() => (window as any).__cozy.store.getState().design.nodes.length);
  await page.evaluate(async () => {
    const gl = (window as any).__cozy.engine.renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
    await new Promise((r) => setTimeout(r, 500));
    ext?.restoreContext();
    await new Promise((r) => setTimeout(r, 1500));
  });
  expect(await page.evaluate(() => (window as any).__cozy.store.getState().design.nodes.length)).toBe(nodes);
  expect(await page.evaluate(() => (window as any).__cozy.engine.renderer.getContext().isContextLost())).toBe(false);
});

test('seeded visual scenes render without errors', async ({ page }) => {
  test.setTimeout(360_000);
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
