// Full playtest: presses every control on phone, desktop and landscape layouts and audits the
// track and the interface after each step. Writes a screenshot per step and issues.json.
//
//   npm run build && npm run preview -- --port 4810 &
//   node scripts/playtest.cjs test-results/playtest http://localhost:4810/ [phone|desktop|landscape]
const { chromium, devices } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2] || 'test-results/playtest';
const URL = process.argv[3] || 'http://localhost:4810/';
const only = process.argv[4];
fs.mkdirSync(OUT, { recursive: true });

const issues = [];
const note = (ctx, msg) => {
  const key = `${ctx.dev} | ${msg}`;
  if (!issues.some((i) => i.key === key)) issues.push({ key, dev: ctx.dev, step: ctx.step, msg });
};

async function audit(page, ctx) {
  const r = await page.evaluate(() => {
    const out = { ui: [], track: null };
    const vw = innerWidth, vh = innerHeight;
    const vis = (el) => { const s = getComputedStyle(el); const b = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0 && +s.opacity !== 0; };
    // Controls must be on screen, big enough to tap, and not overlapped by other controls.
    const modal = document.querySelector('[role=dialog][aria-modal=true], .cc-modal');
    const ctrls = [...document.querySelectorAll('button, [role=slider], input, select')].filter(vis).filter((el) => !modal || modal.contains(el));
    const inScroller = (el) => el.closest('.cc-row-scroll');
    for (const el of ctrls) {
      const b = el.getBoundingClientRect();
      const name = el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName;
      if (!inScroller(el) && !(modal && modal.contains(el)) && (b.left < -1 || b.top < -1 || b.right > vw + 1 || b.bottom > vh + 1)) out.ui.push(`off-screen: "${name}" ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`);
      if ((b.width < 40 || b.height < 40) && el.tagName !== 'INPUT' && !el.closest('.cc-pill-pair') && !el.closest('.cc-tabs')) out.ui.push(`small target: "${name}" ${Math.round(b.width)}x${Math.round(b.height)}`);
      if ((b.width < 36 || b.height < 34) && (el.closest('.cc-pill-pair') || el.closest('.cc-tabs'))) out.ui.push(`small target: "${name}" ${Math.round(b.width)}x${Math.round(b.height)}`);
      // Is the centre actually hittable (not covered by something else)?
      const cx = Math.min(vw - 1, Math.max(0, b.left + b.width / 2)), cy = Math.min(vh - 1, Math.max(0, b.top + b.height / 2));
      const sc = inScroller(el)?.getBoundingClientRect();
      if (!sc || (b.left >= sc.left && b.right <= sc.right)) {
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) out.ui.push(`covered: "${name}" by ${hit.className || hit.tagName}`);
      }
    }
    // Text that is cut off.
    for (const el of document.querySelectorAll('.cc-app *')) {
      if (!vis(el) || el.children.length > 0 || el.closest('.sr-only, #cc-live')) continue;
      if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') out.ui.push(`truncated text: "${el.textContent.trim().slice(0, 40)}"`);
    }
    // Track health.
    const e = window.__cozy?.engine;
    const t = e?.track;
    if (t) {
      let maxY = -1e9, minClear = 1e9;
      for (let i = 0; i < t.count; i++) maxY = Math.max(maxY, t.pos[i * 3 + 1]);
      let worst = 1e9, clashAt = '';
      const step = 8;
      for (let i = 0; i < t.count; i += step) for (let j = i + step; j < t.count; j += step) {
        let ds = (j - i) * t.ds; if (t.closed) ds = Math.min(ds, t.length - ds);
        if (ds < 40) continue;
        const dx = t.pos[i * 3] - t.pos[j * 3], dz = t.pos[i * 3 + 2] - t.pos[j * 3 + 2];
        if (dx * dx + dz * dz > 6.25) continue;
        const gap = Math.abs(t.pos[i * 3 + 1] - t.pos[j * 3 + 1]);
        if (gap < worst) { worst = gap; clashAt = `s=${(i * t.ds).toFixed(0)} & ${(j * t.ds).toFixed(0)} of ${t.length.toFixed(0)}`; }
      }
      for (let i = 0; i < t.count; i += 4) {
        const gy = e.terrain.heightAt(t.pos[i * 3], t.pos[i * 3 + 2]);
        minClear = Math.min(minClear, t.pos[i * 3 + 1] - gy);
      }
      let maxTwist = 0, twistAt = '';
      for (let i = 1; i < t.count; i++) {
        let db = t.bank[i] - t.bank[i - 1];
        db = Math.atan2(Math.sin(db), Math.cos(db)); // a roll through ±π is not a jump
        const w = Math.abs(db) / t.ds;
        if (w > maxTwist) { maxTwist = w; twistAt = `at s=${(i * t.ds).toFixed(0)}/${t.length.toFixed(0)} bank ${t.bank[i - 1].toFixed(2)}→${t.bank[i].toFixed(2)} kind ${t.kind[i]}`; }
      }
      // In build mode the newest piece's end must be visible in the clear area.
      const st = window.__cozy.store.getState();
      if (st.panel === 'build' && st.camera === 'orbit') {
        const pd = e.previewDesign;
        const end = e.previewFocus ?? (pd ?? st.design).nodes[(pd ?? st.design).nodes.length - 1].p;
        const v = new (e.rig.camera.position.constructor)(end[0], end[1], end[2]).project(e.rig.camera);
        const sx = (v.x + 1) / 2 * innerWidth, sy = (1 - v.y) / 2 * innerHeight;
        const top = document.querySelector('.cc-top')?.getBoundingClientRect().bottom ?? 0;
        const dock = document.querySelector('.cc-dock')?.getBoundingClientRect();
        const bottom = dock && dock.width > innerWidth * 0.6 ? dock.top : innerHeight;
        if (sx < 10 || sx > innerWidth - 10 || sy < top || sy > bottom) out.ui.push(`newest piece (ghost) not in clear view (${Math.round(sx)},${Math.round(sy)})`);
      }
      out.track = { closed: t.closed, length: t.length, maxY, clash: worst, clashAt, minClear, seamFlip: t.diagnostics.seamFlip, gap: t.diagnostics.maxGap, twist: maxTwist, twistAt, cam: window.__cozy.store.getState().camera };
    }
    return out;
  });
  for (const u of r.ui) note(ctx, u);
  const t = r.track;
  if (t) {
    if (!t.closed) note(ctx, `track not closed after ${ctx.step}`);
    if (t.seamFlip) note(ctx, `track flips upside down after ${ctx.step}`);
    if (t.gap > 1e-3) note(ctx, `track gap ${t.gap} after ${ctx.step}`);
    if (t.clash < 4.9) note(ctx, `TRACK CLASH gap ${t.clash.toFixed(2)} m ${t.clashAt} after ${ctx.step}`);
    if (t.maxY > 70) note(ctx, `track very high (${t.maxY.toFixed(0)} m) after ${ctx.step}`);
    if (t.minClear < 0.3) note(ctx, `track touches/under ground (${t.minClear.toFixed(2)} m) after ${ctx.step}`);
    if (t.twist > 0.7) note(ctx, `sudden twist ${t.twist.toFixed(2)} rad/m ${t.twistAt} after ${ctx.step}`);
  }
  return r;
}

const T0 = Date.now();
async function run(devName, devOpts) {
  const browser = await chromium.launch();
  const page = await browser.newPage(devOpts);
  const ctx = { dev: devName, step: 'load' };
  page.on('pageerror', (e) => note(ctx, `page error: ${e.message}`));
  page.on('crash', () => note(ctx, `PAGE CRASHED during ${ctx.step}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|WebGL-/.test(m.text())) note(ctx, `console error: ${m.text()}`); });
  let n = 0;
  const shot = async (name) => { await page.screenshot({ path: `${OUT}/${devName}-${String(n++).padStart(3, '0')}-${name}.png` }); };
  const step = async (name, fn, wait = 700) => {
    ctx.step = name;
    const t0 = Date.now();
    if (process.env.PT_TRACE) console.log(`[${devName}] ${name} (+${((Date.now() - T0) / 1000).toFixed(0)}s)`);
    try { await fn(); } catch (e) { note(ctx, `FAILED step "${name}": ${String(e.message).split('\n')[0]}`); }
    await page.waitForTimeout(wait);
    await audit(page, ctx);
    await shot(name.replace(/[^a-z0-9]+/gi, '_'));
  };
  const btn = (name, exact = true) => page.getByRole('button', { name, exact }).first();
  let hidden = 0;
  const slopeBtn = (name) => page.getByRole('group', { name: 'Slope' }).getByRole('button', { name, exact: true });
  // Is this option on offer right now? (Contextual building hides what doesn't fit.) Waits briefly
  // for the panel to finish checking.
  const offered = async (name, group) => {
    await page.waitForFunction(() => window.__cozy.store.getState().avail !== null, null, { timeout: 15000 }).catch(() => {});
    const loc = group ? slopeBtn(name) : btn(name);
    return (await loc.count()) > 0 && (await loc.isVisible().catch(() => false));
  };
  // An offered option must be addable: Add enabled once its ghost is planned.
  const addOffered = async (label = 'Add piece') => {
    await page.waitForFunction(() => { const s = window.__cozy.store.getState(); return s.ghost?.forChoice === JSON.stringify(s.buildChoice); }, null, { timeout: 20000 }).catch(() => {});
    const add = btn(label);
    if (await add.isDisabled()) note(ctx, `offered option can't be added: ${await page.evaluate(() => window.__cozy.store.getState().ghost?.blocked)}`);
    else await add.click();
  };
  const fast = () => page.evaluate(() => window.__cozy.store.getState().setSettings((s) => ({ ...s, graphics: { ...s.graphics, tier: 'battery', postProcessing: false } })));

  await page.goto(URL);
  await page.waitForFunction(() => window.__cozy && window.__cozy.engine.terrain.chunks.size > 8, null, { timeout: 60000 });
  await step('welcome', async () => {}, 1500);
  await fast();
  await step('explore', () => btn('Explore the meadow').click(), 1500);

  // Top bar
  await step('mute', () => btn(/Sound on/, false).click());
  await step('unmute', () => btn(/Sound off/, false).click());
  await step('menu open', () => btn(/^Menu/, false).click(), 900);
  await step('menu close', () => page.keyboard.press('Escape'), 600);

  // Build (edit mode): every direction/slope combination and every special piece, each added.
  await step('build tab', () => btn('Edit').click(), 1200);
  // The panel only offers what fits here, so options that are hidden right now are skipped (and
  // counted), never clicked. Add must then be enabled for every option that is offered.
  for (const dir of ['Straight', 'Turn left', 'Turn right']) {
    for (const slope of ['Level', 'Up', 'Down']) {
      if (!(await offered(dir)) || !(await offered(slope, 'Slope'))) { hidden++; continue; }
      await step(`choose ${dir} ${slope}`, async () => { await btn(dir).click(); if (await offered(slope, 'Slope')) await slopeBtn(slope).click(); }, 700);
      await step(`add ${dir} ${slope}`, () => addOffered(), 900);
    }
  }
  for (const p of ['Hill', 'Lift', 'Drop', 'Loop', 'Roll', 'Corkscrew', 'Spiral', 'Brakes', 'Launch']) {
    if (!(await offered(p))) { hidden++; continue; }
    await step(`choose ${p}`, () => btn(p).click(), 900);
    await step(`add ${p}`, () => addOffered(), 1000);
  }
  // Edit existing pieces: step back, change one, remove one, back to the end.
  await step('select previous piece', async () => { await btn('Previous piece').click(); await btn('Previous piece').click(); }, 1200);
  // Change it to whatever special the panel offers there (only offered options are tapped).
  for (const pick of ['Hill', 'Brakes', 'Launch', 'Turn left']) {
    if (!(await offered(pick))) continue;
    await step(`change selected to ${pick}`, () => btn(pick).click(), 1200);
    await step('apply change', () => addOffered('Apply change'), 1200);
    break;
  }
  await step('remove selected piece', () => btn('Remove this piece').click(), 1200);
  await step('go to end', () => btn('Go to end').click(), 1200);
  // Keyboard building (laptops): arrows choose, Enter adds, Backspace removes.
  await step('keyboard build', async () => {
    await page.mouse.click(5, 300);
    for (const k of ['ArrowLeft', 'Enter', 'ArrowUp', 'Enter', 'ArrowRight', 'ArrowRight', 'Enter', 'Backspace']) await page.keyboard.press(k);
  }, 1200);
  for (let i = 0; i < 4; i++) await step(`remove last ${i}`, () => btn('Remove the last piece').click(), 600);
  await step('undo', () => btn(/^Undo/, false).click());
  await step('redo', () => btn(/^Redo/, false).click());
  await step('frame overview', async () => { await page.evaluate(() => window.__cozy.engine.frameCoaster()); }, 1500);

  // Decorate
  await step('decorate tab', () => btn('Decorate').click());
  for (const t of ['Tree', 'Pine', 'Flowers', 'Bench', 'Hut']) {
    await step(`pick ${t}`, () => btn(t).click());
    await step(`place ${t}`, async () => { const vs = page.viewportSize(); await page.mouse.click(vs.width * 0.35, vs.height * 0.3); });
  }
  await step('eraser', () => btn('Remove').click());
  await step('erase tap', async () => { const vs = page.viewportSize(); await page.mouse.click(vs.width * 0.35, vs.height * 0.3); });
  await step('land tab', () => page.getByRole('tab', { name: 'Land' }).click());
  for (const t of ['Raise', 'Smooth', 'Path']) await step(`land ${t}`, () => btn(t).click());
  await step('brush stroke', async () => {
    const vs = page.viewportSize();
    await page.mouse.move(vs.width * 0.2, vs.height * 0.3); await page.mouse.down();
    await page.mouse.move(vs.width * 0.5, vs.height * 0.32, { steps: 10 }); await page.mouse.up();
  }, 1500);

  // Paint
  await step('paint tab', () => btn('Paint').click());
  for (const t of ['Steel', 'Box steel', 'Wooden', 'Mine']) await step(`track type ${t}`, () => page.getByRole('group', { name: 'Track type' }).getByRole('button', { name: t, exact: true }).click(), 900);
  await step('supports tab', () => page.getByRole('tab', { name: 'Supports' }).click());
  for (const t of ['Pine', 'Walnut', 'Silver steel', 'Cream steel']) await step(`supports ${t}`, () => btn(t).click(), 900);
  await step('train tab', () => page.getByRole('tab', { name: 'Train' }).click());
  await step('more cars', async () => { for (let i = 0; i < 3; i++) if (await btn('More carriages').isEnabled()) await btn('More carriages').click(); });
  await step('fewer cars', async () => { for (let i = 0; i < 6; i++) if (await btn('Fewer carriages').isEnabled()) await btn('Fewer carriages').click(); });
  for (const t of ['Retro', 'Mine cart', 'Modern']) await step(`car style ${t}`, () => btn(t).click(), 800);

  // Sky
  await step('sky tab', () => btn('Sky').click());
  for (const t of ['Sunrise', 'Golden', 'Night', 'Day']) await step(`time ${t}`, () => btn(t).click(), 1500);
  for (const t of ['Rain', 'Snow', 'Mist', 'Sunny']) await step(`weather ${t}`, () => btn(t).click(), 1500);

  // Ride
  await step('ride tab', () => btn('Ride').click());
  await step('ride!', () => btn('Front seat').click(), 3500);
  await step('reopen ride sheet', () => btn('Ride').click());
  await step('watch', () => btn(/^Watch/, false).click(), 3000);
  await step('reopen + watch again', async () => { await btn('Ride').click(); await btn(/^Watch/, false).click(); }, 3000);
  await step('back seat', async () => { await btn('Ride').click(); await btn('Back seat').click(); }, 3000);
  await step('fast speed', async () => { await btn('Ride').click(); await btn('Fast').click(); }, 1500);
  await step('overview', () => btn('Builder view').click(), 1500);
  await step('to station', () => btn('Train to station').click(), 1500);
  await step('relax', () => btn('Relax').click(), 2500);
  await step('leave relax', async () => { await page.mouse.click(10, 300); const b = page.getByRole('button', { name: /back|done|stop|leave|exit/i }).first(); if (await b.isVisible().catch(() => false)) await b.click(); }, 1500);
  await step('photo', async () => { await btn('Ride').click().catch(() => {}); await btn('Photo').click(); }, 1500);
  await step('leave photo', async () => { const b = page.getByRole('button', { name: /back|done|close|leave|exit/i }).first(); await b.click(); }, 1200);

  // Menu
  await step('menu again', () => btn(/^Menu/, false).click(), 900);
  await step('music toggle', () => page.getByRole('switch', { name: /Music/ }).click());
  await step('your parks', () => btn(/Your parks/, false).click(), 1000);
  await step('close parks', () => page.keyboard.press('Escape'));
  await step('settings', async () => { await btn(/^Menu/, false).click(); await btn(/Settings/, false).click(); }, 1000);
  await step('close settings', () => page.keyboard.press('Escape'));
  await step('new coaster', async () => { await btn(/^Menu/, false).click(); await btn(/New coaster/, false).click(); }, 1500);
  await step('after new coaster', async () => { const b = page.getByRole('button', { name: /Build your own|Start|blank|fresh/i }).first(); if (await b.isVisible().catch(() => false)) await b.click(); }, 2000);

  // Build again on a fresh coaster: a quick kid-style session.
  await step('build tab 2', async () => { if (!(await btn('Add piece').isVisible().catch(() => false))) await btn('Edit').click(); });
  for (const p of ['Turn left', 'Hill', 'Loop', 'Turn right', 'Spiral', 'Turn left', 'Drop', 'Straight']) {
    if (!(await offered(p))) { hidden++; continue; }
    await step(`fresh add ${p}`, async () => { await btn(p).click(); await addOffered(); }, 900);
  }
  await step('fresh overview', async () => { await page.evaluate(() => window.__cozy.engine.frameCoaster()); }, 1500);
  await step('fresh ride', async () => { await btn('Ride').click(); await btn('Front seat').click(); }, 4000);
  console.log(`[${devName}] ${hidden} options were hidden (didn't fit) and skipped`);
  await browser.close();
}

(async () => {
  const devs = [['phone', { ...devices['iPhone 13'] }], ['desktop', { viewport: { width: 1280, height: 800 } }], ['landscape', { ...devices['iPhone 13 landscape'] }]];
  for (const [n, o] of devs) if (!only || only === n) await run(n, o);
  fs.writeFileSync(`${OUT}/issues.json`, JSON.stringify(issues, null, 1));
  console.log(`${issues.length} issues`);
  for (const i of issues) console.log(`- [${i.dev}] (${i.step}) ${i.msg}`);
})();
