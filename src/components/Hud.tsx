import { useEffect, useRef } from 'react';
import { useGame, type Panel } from '../stores/game';
import { IconButton } from '../design-system/controls';
import { Icon } from '../design-system/Icon';
import { services, ui } from '../app/services';
import { G0 } from '../engine/physics/train-sim';

const NAV: Array<{ id: Exclude<Panel, 'none'>; label: string; icon: string }> = [
  { id: 'build', label: 'Build', icon: 'build' },
  { id: 'train', label: 'Train', icon: 'train' },
  { id: 'style', label: 'Style', icon: 'style' },
  { id: 'scenery', label: 'Scenery', icon: 'scenery' },
  { id: 'weather', label: 'Weather', icon: 'weather' },
  { id: 'ride', label: 'Ride', icon: 'ride' },
];

export function TopBar() {
  const canUndo = useGame((s) => s.past.length > 0);
  const canRedo = useGame((s) => s.future.length > 0);
  const name = useGame((s) => s.coasterName);
  const saveStatus = useGame((s) => s.saveStatus);
  const camera = useGame((s) => s.camera);
  const g = useGame.getState;
  return (
    <header className="cc-top">
      <button className="cc-title" onClick={() => (ui('open'), useGame.setState({ overlay: 'saves' }))} aria-label={`${name}. Open saved parks`}>
        <span className="cc-title-name">{name}</span>
        <span className={`cc-save-dot ${saveStatus}`} aria-hidden="true" />
        <span className="sr-only">Save status: {saveStatus}</span>
      </button>
      <div className="cc-top-right">
        <div className="cc-pill-group" role="group" aria-label="History">
          <IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" disabled={!canUndo} onClick={() => (ui('undo'), g().undo())} />
          <IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" disabled={!canRedo} onClick={() => (ui('redo'), g().redo())} />
        </div>
        <div className="cc-pill-group" role="group" aria-label="View">
          {camera !== 'orbit' ? (
            <IconButton icon="frame" label="Back to build view" shortcut="Esc" onClick={() => useGame.setState({ camera: 'orbit' })} />
          ) : (
            <IconButton icon="frame" label="Frame the coaster" shortcut="F" onClick={() => services.engine?.frameCoaster()} />
          )}
          <span className="cc-narrow-hide">
            <IconButton icon="camera" label="Photo mode" shortcut="P" onClick={() => useGame.setState({ overlay: 'photo', panel: 'none' })} />
          </span>
          <span className="cc-narrow-hide">
            <IconButton icon="leaf" label="Relax mode" shortcut="R" onClick={() => useGame.setState({ overlay: 'relax', panel: 'none', camera: 'relax' })} />
          </span>
          <IconButton icon="settings" label="Settings" onClick={() => (ui('open'), useGame.setState({ overlay: 'settings' }))} />
        </div>
      </div>
    </header>
  );
}

export function BottomNav() {
  const panel = useGame((s) => s.panel);
  const index = NAV.findIndex((n) => n.id === panel);
  return (
    <nav className="cc-nav" aria-label="Main tools" style={{ ['--i' as string]: Math.max(0, index), ['--n' as string]: NAV.length }}>
      <span className={`cc-nav-indicator${index < 0 ? ' hidden' : ''}`} aria-hidden="true" />
      {NAV.map((n) => (
        <button
          key={n.id}
          className={`cc-nav-btn${panel === n.id ? ' on' : ''}`}
          aria-pressed={panel === n.id}
          aria-label={n.label}
          title={n.label}
          onClick={() => {
            ui(panel === n.id ? 'close' : 'open');
            const next = panel === n.id ? 'none' : n.id;
            useGame.setState({
              panel: next,
              previewActive: next === 'build',
              selectedNode: null,
              sceneryTool: null,
              brush: null,
              sheetCompact: false,
              ...(next === 'ride' ? {} : useGame.getState().camera === 'relax' ? { camera: 'orbit' as const } : {}),
            });
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

export function Hint() {
  const hint = useGame((s) => s.hint);
  const panel = useGame((s) => s.panel);
  if (!hint || panel !== 'build') return null;
  return (
    <div className="cc-hint" role="note">
      <Icon name="info" size={18} />
      <span>{hint}</span>
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
