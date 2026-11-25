import { useEffect, useRef, useState } from 'react';
import { Engine } from '../engine/core/engine';
import { useGame } from '../stores/game';
import { connectStore, engineCallbacks, removeLast } from './bridge';
import { services, ui } from './services';
import { saves, watchForSaves } from './persistence';
import { installAudioUnlock } from './audio-unlock';
import { BottomNav, Diagnostics, Telemetry, Toasts, TopBar } from '../components/Hud';
import { BuildTray, DecorateTray, HeightLever, PaintTray, RideTray, SkyTray } from '../components/Trays';
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
    // Keep the page and browser-bar colour in step with the sky (no per-frame work: every 2 s).
    let lastBg = '';
    const bgTimer = window.setInterval(() => {
      const e = services.engine;
      if (!e) return;
      const hex = `#${e.atmosphere.fog.color.getHexString()}`;
      if (hex === lastBg) return;
      lastBg = hex;
      document.documentElement.style.setProperty('--scene-bg', hex);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', hex);
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(bgTimer);
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
          if (g.overlay !== 'none' && g.overlay !== 'welcome') useGame.setState({ overlay: 'none', camera: g.camera === 'relax' ? 'orbit' : g.camera });
          else if (g.camera !== 'orbit') useGame.setState({ camera: 'orbit' });
          else if (g.panel !== 'none') useGame.setState({ panel: 'none' });
          break;
        case 'Backspace':
        case 'Delete':
          if (g.panel === 'build') removeLast();
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
        // Keyboard camera control as an accessible alternative to dragging.
        case 'ArrowLeft':
          services.engine?.rig.orbitBy(-40, 0, 800);
          break;
        case 'ArrowRight':
          services.engine?.rig.orbitBy(40, 0, 800);
          break;
        case 'ArrowUp':
          services.engine?.rig.zoomBy(0.9);
          break;
        case 'ArrowDown':
          services.engine?.rig.zoomBy(1.1);
          break;
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
      {ready && !immersive && (
        <>
          <TopBar />
          <HeightLever />
          <Telemetry />
          <div className="cc-dock">
            {panel === 'build' && <BuildTray />}
            {panel === 'decorate' && <DecorateTray />}
            {panel === 'paint' && <PaintTray />}
            {panel === 'sky' && <SkyTray />}
            {panel === 'ride' && <RideTray />}
            <BottomNav />
          </div>
          {overlay === 'welcome' && <Welcome />}
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
