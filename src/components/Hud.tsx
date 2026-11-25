import { useEffect, useRef } from 'react';
import { useGame, type Panel } from '../stores/game';
import { IconButton } from '../design-system/controls';
import { Icon } from '../design-system/Icon';
import { services, ui } from '../app/services';
import { followEnd } from '../app/bridge';
import { G0 } from '../engine/physics/train-sim';

const NAV: Array<{ id: Exclude<Panel, 'none'>; label: string; icon: string }> = [
  { id: 'build', label: 'Edit', icon: 'build' },
  { id: 'decorate', label: 'Decorate', icon: 'scenery' },
  { id: 'paint', label: 'Paint', icon: 'style' },
  { id: 'sky', label: 'Sky', icon: 'sun' },
  { id: 'ride', label: 'Ride', icon: 'ride' },
];

export function TopBar() {
  const canUndo = useGame((s) => s.past.length > 0);
  const canRedo = useGame((s) => s.future.length > 0);
  const name = useGame((s) => s.coasterName);
  const camera = useGame((s) => s.camera);
  const muted = useGame((s) => s.settings.audio.muted);
  const g = useGame.getState;
  return (
    <header className="cc-top">
      <div className="cc-top-left">
        <IconButton icon="menu" label="Menu: parks, sound and settings" variant="solid" onClick={() => (ui('open'), useGame.setState({ overlay: 'menu' }))} />
        <span className="cc-coaster-name">{name}</span>
      </div>
      <div className="cc-top-right">
        {camera !== 'orbit' ? (
          <button
            type="button"
            className="cc-pill-btn small cc-ride-toggle"
            aria-label="Stop riding"
            onClick={() => {
              ui('close');
              useGame.setState({ camera: 'orbit' });
              services.engine?.viewNearTrain();
            }}
          >
            <Icon name="close" size={18} /> <span>Stop riding</span>
          </button>
        ) : (
          <button
            type="button"
            className="cc-pill-btn small cc-ride-toggle"
            aria-label="Ride along"
            onClick={() => {
              ui('success');
              // Put any sheet away so the ride fills the screen.
              useGame.setState({ camera: 'front', panel: 'none' });
              services.engine?.dispatch();
            }}
          >
            <Icon name="play" size={18} /> <span>Ride along</span>
          </button>
        )}
        <IconButton
          icon={muted ? 'mute' : 'speaker'}
          label={muted ? 'Sound off: tap to turn it on' : 'Sound on: tap to mute'}
          variant="solid"
          onClick={() => {
            void services.engine?.audio.unlock();
            g().setSettings((x) => ({ ...x, audio: { ...x.audio, muted: !x.audio.muted, master: x.audio.master < 0.05 ? 0.8 : x.audio.master } }));
          }}
        />
        <div className="cc-pill-group" role="group" aria-label="Undo and redo">
          <IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={() => (ui('undo'), g().undo(), followEnd())} />
          <IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" disabled={!canRedo} onClick={() => (ui('redo'), g().redo(), followEnd())} />
        </div>
      </div>
    </header>
  );
}

export function BottomNav() {
  const panel = useGame((s) => s.panel);
  const index = NAV.findIndex((n) => n.id === panel);
  return (
    <nav className="cc-nav" aria-label="Modes" style={{ ['--i' as string]: Math.max(0, index), ['--n' as string]: NAV.length }}>
      <span className={`cc-nav-indicator${index < 0 ? ' hidden' : ''}`} aria-hidden="true" />
      {NAV.map((n) => (
        <button
          key={n.id}
          className={`cc-nav-btn${panel === n.id ? ' on' : ''}`}
          aria-pressed={panel === n.id}
          aria-label={n.label}
          title={n.label}
          onClick={() => {
            const next = panel === n.id ? 'none' : n.id;
            ui(next === 'none' ? 'close' : 'open');
            const cam = useGame.getState().camera;
            useGame.setState({
              panel: next,
              sceneryTool: null,
              brush: null,
              eraser: false,
              // Menus never change the view. Only Edit and Decorate, which work by tapping the world,
              // bring you back to the builder view.
              ...((next === 'build' || next === 'decorate') && cam !== 'orbit' ? { camera: 'orbit' as const } : {}),
            });
            // Leaving a ride for Decorate: a normal close view, not the far overview.
            if (next === 'decorate' && cam !== 'orbit') services.engine?.viewNearTrain();
          }}
        >
          <Icon name={n.icon} size={24} />
          <span className="cc-nav-label" aria-hidden="true">
            {n.label}
          </span>
        </button>
      ))}
    </nav>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  return (
    <div className="cc-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="cc-toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                ui('tap');
                t.action!.run();
                useGame.getState().dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="cc-toast-x" aria-label="Dismiss" onClick={() => useGame.getState().dismissToast(t.id)}>
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Ride telemetry, written straight to the DOM at 10 Hz (no React re-renders). */
export function Telemetry() {
  const on = useGame((s) => s.settings.telemetry);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => {
      const e = services.engine;
      const el = ref.current;
      if (!e || !el) return;
      const t = e.sim.telemetry;
      const set = (k: string, v: string) => {
        const n = el.querySelector(`[data-k="${k}"]`);
        if (n) n.textContent = v;
      };
      set('speed', `${(Math.abs(t.speed) * 3.6).toFixed(0)} km/h`);
      set('height', `${t.height.toFixed(1)} m`);
      set('gv', `${t.gVert.toFixed(2)} G`);
      set('gl', `${t.gLat.toFixed(2)} G`);
      set('gx', `${t.gLong.toFixed(2)} G`);
      set('jerk', `${(t.jerk).toFixed(1)} G/s`);
      set('energy', `${(t.energy / 1000).toFixed(0)} kJ`);
      set('mass', `${(e.sim.mass / 1000).toFixed(1)} t`);
      void G0;
    }, 100);
    return () => window.clearInterval(id);
  }, [on]);
  if (!on) return null;
  const rows = [
    ['speed', 'Speed'],
    ['height', 'Height'],
    ['gv', 'Vertical'],
    ['gl', 'Lateral'],
    ['gx', 'Longitudinal'],
    ['jerk', 'Jerk'],
    ['energy', 'Energy'],
    ['mass', 'Train mass'],
  ];
  return (
    <div className="cc-telemetry" ref={ref} aria-label="Ride telemetry">
      {rows.map(([k, l]) => (
        <div key={k}>
          <span>{l}</span>
          <b data-k={k}>–</b>
        </div>
      ))}
    </div>
  );
}

/** Developer diagnostics overlay (Settings → Advanced). */
export function Diagnostics() {
  const on = useGame((s) => s.settings.showDiagnostics);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => {
      const e = services.engine;
      if (!e || !ref.current) return;
      const d = e.diagnostics();
      ref.current.textContent = [
        `FPS ${d.fps.toFixed(0)}  p50 ${d.p50.toFixed(1)}  p90 ${d.p90.toFixed(1)}  p99 ${d.p99.toFixed(1)} ms`,
        `main ${d.cpuMs.toFixed(1)} ms  sim ${d.simMs.toFixed(2)} ms`,
        `draws ${d.calls}  tris ${(d.triangles / 1000).toFixed(0)}k`,
        `geo ${d.geometries}  tex ${d.textures}`,
        `chunks ${d.chunks}  queue ${d.workerQueue}`,
        `supports ${d.supports}  veg ${d.vegetation}`,
        `voices ${d.voices}  track segs rebuilt ${d.trackRegenerated}`,
        `quality ${d.quality}  dpr ${d.pixelRatio.toFixed(2)}  ${d.resolution}`,
      ].join('\n');
    }, 500);
    return () => window.clearInterval(id);
  }, [on]);
  if (!on) return null;
  return <pre className="cc-diag" ref={ref} aria-hidden="true" />;
}
