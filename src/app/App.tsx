import { useEffect, useRef, useState } from 'react';
import { Engine } from '../engine/core/engine';
import { useGame } from '../stores/game';
import { addGhost, chooseBuild, connectStore, engineCallbacks, removeLast } from './bridge';
import { services, ui } from './services';
import { saves, watchForSaves } from './persistence';
import { installAudioUnlock } from './audio-unlock';
import { BottomNav, Diagnostics, Telemetry, Toasts, TopBar } from '../components/Hud';
import { BuildTray, DecorateTray, PaintTray, RideTray, SkyTray } from '../components/Trays';
import { Compatibility, MenuDialog, PhotoMode, RelaxOverlay, SavesDialog, SettingsDialog, Welcome } from '../components/Dialogs';
import '../components/ui.css';

declare global {
  interface Window {
    /** Test and debugging hook (read-only use). */
    __cozy?: { engine: Engine; store: typeof useGame };
  }
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const panel = useGame((s) => s.panel);
  const overlay = useGame((s) => s.overlay);
  const camera = useGame((s) => s.camera);
  const a11y = useGame((s) => s.settings.accessibility);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: Engine;
    let disposeStore = () => {};
    let disposeSaves = () => {};
    let disposeAudio = () => {};
    let cancelled = false;
    const boot = async () => {
      await saves.init();
      if (cancelled) return;
      const s = useGame.getState();
      try {
        engine = new Engine(canvas, { env: s.env, train: s.train, design: s.design, strokes: s.terrainEdits }, engineCallbacks());
      } catch (e) {
        console.error(e);
        setFatal(e instanceof Error ? e.message : 'unknown');
        return;
      }
      services.engine = engine;
      window.__cozy = { engine, store: useGame };
      engine.setPhysics(s.physics, s.env.environmentalPhysics);
      engine.setScenery(s.scenery);
      engine.setEnvironment(s.env);
      disposeStore = connectStore(engine);
      disposeSaves = watchForSaves();
      disposeAudio = installAudioUnlock();
      engine.start();
      setReady(true);
    };
    void boot();
    const ro = new ResizeObserver(() => services.engine?.resize());
    ro.observe(canvas);
    // Tell the camera which parts of the screen the controls cover, so it aims at the clear area.
    const measureInsets = () => {
      const e = services.engine;
      if (!e) return;
      const c = canvas.getBoundingClientRect();
      const top = document.querySelector('.cc-top')?.getBoundingClientRect();
      const rect = (sel: string) => {
        const el = document.querySelector(sel);
        const r = el?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0 ? r : null;
      };
      const tray = rect('.cc-tray');
      const nav = rect('.cc-nav');
      const lever = rect('.cc-lever');
      let bottom = nav ? c.bottom - nav.top : 0;
      let left = 0;
      if (tray && tray.width > c.width * 0.6) bottom = c.bottom - tray.top; // phone: sheet across the bottom
      else if (tray && tray.left < c.width * 0.2 && tray.height > c.height * 0.4) left = tray.right - c.left; // landscape: sheet on the left
      else if (tray) bottom = Math.max(bottom, c.bottom - tray.top); // desktop: sheet above the nav
      e.setViewInsets(top ? top.bottom - c.top : 0, bottom, left, lever ? c.right - lever.left : 0);
    };
    const insetObserver = new ResizeObserver(measureInsets);
    const watchInsets = window.setInterval(() => {
      // The dock and top bar mount after boot and change as sheets open: (re)observe them.
      for (const sel of ['.cc-top', '.cc-dock']) {
        const el = document.querySelector(sel);
        if (el && !(el as HTMLElement).dataset.insetObserved) {
          (el as HTMLElement).dataset.insetObserved = '1';
          insetObserver.observe(el);
        }
      }
      measureInsets();
    }, 500);
    // Keep the page and browser-bar colour in step with the sky (no per-frame work: every 2 s).
    let lastBg = '';
    let lastBottom = '';
    const bgTimer = window.setInterval(() => {
      const e = services.engine;
      if (!e) return;
      const hex = `#${e.atmosphere.fog.color.getHexString()}`;
      if (hex !== lastBg) {
        lastBg = hex;
        document.documentElement.style.setProperty('--scene-bg', hex);
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', hex);
      }
      // What shows under a phone's floating bottom toolbar: the colour at the bottom of the
      // picture (usually grass), sampled after the next frame and applied on the following tick.
      const bottom = e.bottomEdgeColour;
      if (bottom && bottom !== lastBottom) {
        lastBottom = bottom;
        document.documentElement.style.setProperty('--scene-bg-bottom', bottom);
      }
      e.requestEdgeSample();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(bgTimer);
      window.clearInterval(watchInsets);
      insetObserver.disconnect();
      ro.disconnect();
      disposeStore();
      disposeSaves();
      disposeAudio();
      services.engine?.dispose();
      services.engine = null;
    };
  }, []);

  // Accessibility flags as root attributes.
  useEffect(() => {
    const r = document.documentElement;
    r.dataset.largeUi = String(a11y.largerUi);
    r.dataset.contrast = a11y.highContrast ? 'high' : 'normal';
    r.dataset.reducedMotion = String(a11y.reducedMotion);
  }, [a11y]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const g = useGame.getState();
      // Nothing works until a choice is made on the opening menu.
      if (g.overlay === 'welcome') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          ui('redo');
          g.redo();
        } else {
          ui('undo');
          g.undo();
        }
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        g.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        ui('save');
        void saves.flush();
        return;
      }
      if (mod) return;
      switch (e.key) {
        case 'Escape':
          if (g.overlay !== 'none') useGame.setState({ overlay: 'none', camera: g.camera === 'relax' ? 'orbit' : g.camera });
          else if (g.camera !== 'orbit') {
            useGame.setState({ camera: 'orbit' });
            services.engine?.viewNearTrain();
          }
          else if (g.panel !== 'none') useGame.setState({ panel: 'none' });
          break;
        case 'Backspace':
        case 'Delete':
          if (g.panel === 'build') removeLast();
          break;
        case 'Enter':
          if (g.panel === 'build' && t.tagName !== 'BUTTON') {
            e.preventDefault();
            addGhost();
          }
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown':
          // Edit mode: arrows choose the next piece (left/right turn, up/down slope).
          if (g.panel === 'build' && t.getAttribute('role') !== 'slider') {
            e.preventDefault();
            const c = g.buildChoice.kind === 'track' ? g.buildChoice : { kind: 'track' as const, turn: 0 as const, slope: 0 as const };
            const clamp = (v: number) => Math.max(-1, Math.min(1, v)) as -1 | 0 | 1;
            const turn = e.key === 'ArrowLeft' ? clamp(c.turn + 1) : e.key === 'ArrowRight' ? clamp(c.turn - 1) : c.turn;
            const slope = e.key === 'ArrowUp' ? clamp(c.slope + 1) : e.key === 'ArrowDown' ? clamp(c.slope - 1) : c.slope;
            chooseBuild({ kind: 'track', turn, slope });
          } else {
            // Keyboard camera control as an accessible alternative to dragging.
            const r = services.engine?.rig;
            if (e.key === 'ArrowLeft') r?.orbitBy(-40, 0, 800);
            if (e.key === 'ArrowRight') r?.orbitBy(40, 0, 800);
            if (e.key === 'ArrowUp') r?.zoomBy(0.9);
            if (e.key === 'ArrowDown') r?.zoomBy(1.1);
          }
          break;
        case 'b':
          useGame.setState({ panel: g.panel === 'build' ? 'none' : 'build' });
          break;
        case 'f':
          services.engine?.frameCoaster();
          break;
        case 'p':
          useGame.setState({ overlay: g.overlay === 'photo' ? 'none' : 'photo', panel: 'none' });
          break;
        case 'r':
          useGame.setState({ overlay: 'relax', panel: 'none', camera: 'relax' });
          break;
        case ' ':
          e.preventDefault();
          services.engine?.dispatch();
          break;
        case 'c': {
          const order = ['orbit', 'front', 'rear', 'follow', 'side', 'cinematic', 'trackside'] as const;
          const i = order.indexOf(g.camera as (typeof order)[number]);
          useGame.setState({ camera: order[(i + 1) % order.length]! });
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (fatal) return <Compatibility reason={fatal} />;
  const immersive = overlay === 'photo' || overlay === 'relax';
  return (
    <div className={`cc-app${camera !== 'orbit' ? ' riding' : ''}`}>
      <canvas ref={canvasRef} className="cc-canvas" aria-label="Coaster world. Drag to look around, pinch or scroll to zoom." tabIndex={0} />
      {!ready && <div className="cc-loading">Unpacking the meadow…</div>}
      {ready && overlay === 'welcome' && <Welcome />}
      {ready && !immersive && overlay !== 'welcome' && (
        <>
          <TopBar />
          <Telemetry />
          <div className="cc-dock">
            {panel === 'build' && <BuildTray />}
            {panel === 'decorate' && <DecorateTray />}
            {panel === 'paint' && <PaintTray />}
            {panel === 'sky' && <SkyTray />}
            {panel === 'ride' && <RideTray />}
            <BottomNav />
          </div>
          {overlay === 'menu' && <MenuDialog />}
          {overlay === 'settings' && <SettingsDialog />}
          {overlay === 'saves' && <SavesDialog />}
        </>
      )}
      {ready && overlay === 'photo' && <PhotoMode />}
      {ready && overlay === 'relax' && <RelaxOverlay />}
      <Toasts />
      <Diagnostics />
      <div id="cc-live" className="sr-only" aria-live="polite" />
    </div>
  );
}
