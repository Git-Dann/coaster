/**
 * Renders the social share image (public/og-image.jpg, 1200×630) from the game itself: the starter
 * coaster at golden hour with the train on the move, with the app icon, name and tagline on top.
 * Needs the production preview running:  npm run build && npm run preview -- --port 4810
 * Then:  node scripts/social.cjs [url]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const URL = process.argv[2] || 'http://localhost:4810/';
const OUT = path.join(__dirname, '..', 'public', 'og-image.jpg');
const W = 1200;
const H = 630;

(async () => {
  const browser = await chromium.launch();
  // 1. The scene, rendered at full quality, no interface.
  const game = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  await game.goto(URL);
  await game.waitForFunction(() => window.__cozy && window.__cozy.engine.terrain.chunks.size > 8, null, { timeout: 90000 });
  await game.getByRole('button', { name: 'Explore the meadow' }).click();
  await game.evaluate(() => {
    const s = window.__cozy.store.getState();
    s.setSettings((x) => ({ ...x, graphics: { ...x.graphics, tier: 'battery', postProcessing: false } }));
    s.setEnv({ time: 'afternoon', weather: 'clear', autoCycle: false });
  });
  await game.addStyleTag({ content: '.cc-app > :not(canvas) { display: none !important; }' });
  // Send the train off, wait until it's racing along, then frame it up close on the right of the
  // picture (the left is kept clear for the words).
  await game.evaluate(() => window.__cozy.engine.dispatch());
  await game.waitForFunction(() => window.__cozy.engine.sim.v > 9, null, { timeout: 240000, polling: 50 });
  await game.waitForTimeout(700);
  await game.evaluate(([w]) => {
    const e = window.__cozy.engine;
    e.simPaused = true; // hold the moment while the camera settles
    window.__cozy.store.getState().setSettings((x) => ({ ...x, graphics: { ...x.graphics, tier: 'high', postProcessing: true } }));
    const smp = { pos: [0, 0, 0], tan: [0, 0, 0], up: [0, 0, 0], right: [0, 0, 0], curv: [0, 0, 0], bank: 0, kind: 'track', param: 0 };
    e.track.sample(e.sim.s, smp);
    const V = e.rig.camera.position.constructor;
    e.setViewInsets(0, 0, w * 0.42, 0);
    e.rig.focusOn(new V(smp.pos[0], smp.pos[1] + 1, smp.pos[2]), 30);
    // Look across the train's path from slightly below the horizon line.
    e.rig.yaw = Math.atan2(smp.tan[0], smp.tan[2]) + 1.15;
    e.rig.pitch = 0.16;
  }, [W]);
  await game.waitForTimeout(5000);
  const scene = await game.screenshot({ type: 'png' });
  await game.close();

  // 2. The card: scene, soft wash for legibility, logo, name and tagline.
  const icon = fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon.svg'), 'utf8');
  const card = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await card.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; box-sizing: border-box; }
    body { width: ${W}px; height: ${H}px; overflow: hidden; font-family: -apple-system, 'SF Pro Rounded', 'Segoe UI', Roboto, system-ui, sans-serif; }
    .scene { position: absolute; inset: 0; background: url(data:image/png;base64,${scene.toString('base64')}) center / cover; }
    .wash { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(245,235,221,0.94) 0%, rgba(245,235,221,0.82) 34%, rgba(245,235,221,0) 62%); }
    .copy { position: absolute; left: 64px; top: 0; bottom: 0; width: 520px; display: flex; flex-direction: column; justify-content: center; gap: 22px; color: #2F3A33; }
    .brand { display: flex; align-items: center; gap: 20px; }
    .brand svg { width: 96px; height: 96px; border-radius: 22px; box-shadow: 0 6px 20px rgba(60,50,40,0.18); }
    h1 { font-size: 68px; line-height: 1; font-weight: 800; letter-spacing: -1.5px; }
    p { font-size: 30px; line-height: 1.25; font-weight: 600; color: #4A5A4F; }
    .pill { align-self: flex-start; padding: 12px 22px; border-radius: 999px; background: #C77D62; color: #FFF8EE; font-size: 22px; font-weight: 700; letter-spacing: 0.2px; }
  </style></head><body>
    <div class="scene"></div><div class="wash"></div>
    <div class="copy">
      <div class="brand">${icon}<h1>Cozy<br>Coaster</h1></div>
      <p>Build your own roller coaster, ride it, and relax in a calm little world.</p>
      <span class="pill">Free · plays in your browser</span>
    </div>
  </body></html>`);
  await card.waitForTimeout(300);
  await card.screenshot({ path: OUT, type: 'jpeg', quality: 88 });
  await browser.close();
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
})();
