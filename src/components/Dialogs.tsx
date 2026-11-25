import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useGame } from '../stores/game';
import { Button, IconButton, Segmented, Slider, Toggle } from '../design-system/controls';
import { Icon } from '../design-system/Icon';
import { services, ui } from '../app/services';
import { exportFilename, exportSave, importSave, type SaveSummary } from '../features/saves';
import { saves } from '../app/persistence';
import type { QualityTier, Settings } from '../types/world';
import { DEFAULT_PHYSICS } from '../engine/train/config';

/** Accessible modal: focus moves in, Escape closes, focus returns on close. */
function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, input, select')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="cc-modal-back" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`cc-modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        <header className="cc-sheet-head">
          <h2>{props.title}</h2>
          <IconButton icon="close" label="Close" onClick={props.onClose} />
        </header>
        <div className="cc-modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function Welcome() {
  const returning = useGame((s) => s.returning);
  const name = useGame((s) => s.coasterName);
  const close = () => useGame.setState({ overlay: 'none' });
  const g = useGame.getState;
  return (
    <div className="cc-welcome-wrap">
      <div className="cc-welcome" role="dialog" aria-modal="true" aria-label="Welcome to Cozy Coaster">
        <img className="cc-welcome-logo" src="/icons/icon.svg" alt="" width={88} height={88} />
        <h1>Cozy Coaster</h1>
        <p>{returning ? `Welcome back. ${name} is just as you left it.` : "Build at your own pace. There's nothing to win and nowhere to be."}</p>
        <div className="cc-welcome-actions">
          <Button variant="accent" icon="play" wide onClick={close}>
            {returning ? 'Continue' : 'Explore the meadow'}
          </Button>
          <Button
            icon="build"
            wide
            onClick={() => {
              g().newWorld({ blank: true });
              useGame.setState({ overlay: 'none', panel: 'build' });
              g().toast('Pick a piece and tap Add piece. Your track always joins back up to the station.');
            }}
          >
            {returning ? 'Start a new coaster' : 'Build your own coaster'}
          </Button>
          <Button
            icon="plus"
            wide
            onClick={() => {
              g().newWorld({ blank: true, empty: true });
              useGame.setState({ overlay: 'none', panel: 'build' });
              g().toast('Just the station. Pick a piece and tap Add piece to start your track.');
            }}
          >
            Start blank (just the station)
          </Button>
          <Button
            icon="ride"
            wide
            onClick={() => {
              useGame.setState({ overlay: 'none', panel: 'ride', camera: 'front' });
              services.engine?.dispatch();
            }}
          >
            Take a ride
          </Button>
        </div>
      </div>
    </div>
  );
}

export function MenuDialog() {
  const s = useGame((st) => st.settings);
  const name = useGame((st) => st.coasterName);
  const close = () => (ui('close'), useGame.setState({ overlay: 'none' }));
  const set = (fn: (s: Settings) => Settings) => useGame.getState().setSettings(fn);
  const musicOn = s.audio.music > 0.01 && !s.audio.muted;
  return (
    <Modal title="Menu" onClose={close}>
      <label className="cc-field">
        <span>Coaster name</span>
        <input value={name} maxLength={40} onChange={(e) => useGame.setState({ coasterName: e.target.value })} />
      </label>
      <Toggle
        label="Music"
        hint="Calm lo-fi beats"
        checked={musicOn}
        onChange={(v) => {
          void services.engine?.audio.unlock();
          set((x) => ({ ...x, audio: { ...x.audio, muted: false, music: v ? Math.max(0.5, x.audio.music) : 0 } }));
        }}
      />
      <Slider label="Volume" value={s.audio.muted ? 0 : s.audio.master} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set((x) => ({ ...x, audio: { ...x.audio, master: v, muted: v === 0 } }))} />
      <div className="cc-menu-list">
        <Button icon="folder" wide onClick={() => useGame.setState({ overlay: 'saves' })}>
          Your parks
        </Button>
        <Button
          icon="plus"
          wide
          onClick={() => {
            useGame.getState().newWorld({ blank: true, empty: true });
            useGame.setState({ overlay: 'none', panel: 'build' });
          }}
        >
          New coaster
        </Button>
        <Button icon="settings" wide onClick={() => useGame.setState({ overlay: 'settings' })}>
          Settings
        </Button>
      </div>
    </Modal>
  );
}

export function SettingsDialog() {
  const s = useGame((st) => st.settings);
  const physics = useGame((st) => st.physics);
  const [tab, setTab] = useState<'sim' | 'graphics' | 'audio' | 'comfort' | 'about'>('graphics');
  const set = (fn: (s: Settings) => Settings) => useGame.getState().setSettings(fn);
  const close = () => (ui('close'), useGame.setState({ overlay: 'none' }));
  const phys = { ...DEFAULT_PHYSICS, ...physics };
  const setPhys = (k: keyof typeof DEFAULT_PHYSICS, v: number) => useGame.setState({ physics: { ...useGame.getState().physics, [k]: v } });
  return (
    <Modal title="Settings" onClose={close} wide>
      <Segmented
        label="Settings section"
        value={tab}
        options={[
          { value: 'graphics', label: 'Graphics' },
          { value: 'audio', label: 'Sound' },
          { value: 'comfort', label: 'Comfort' },
          { value: 'sim', label: 'Physics' },
          { value: 'about', label: 'About' },
        ]}
        onChange={setTab}
      />
      <div className="cc-settings-body">
        {tab === 'graphics' && (
          <>
            <Segmented<QualityTier>
              label="Quality"
              value={s.graphics.tier}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'battery', label: 'Battery' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'high', label: 'High' },
                { value: 'ultra', label: 'Ultra' },
              ]}
              onChange={(v) => set((x) => ({ ...x, graphics: { ...x.graphics, tier: v } }))}
            />
            <p className="cc-p small">Auto watches how smoothly the game runs and gently adjusts detail. Physics is never reduced.</p>
            <Slider label="Render resolution" value={s.graphics.resolution} min={0.5} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set((x) => ({ ...x, graphics: { ...x.graphics, resolution: v } }))} />
            <Segmented
              label="Shadows"
              value={s.graphics.shadows}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'low', label: 'Soft' },
                { value: 'high', label: 'Detailed' },
              ]}
              onChange={(v) => set((x) => ({ ...x, graphics: { ...x.graphics, shadows: v } }))}
            />
            <Slider label="Vegetation" value={s.graphics.vegetation} min={0.2} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set((x) => ({ ...x, graphics: { ...x.graphics, vegetation: v } }))} />
            <Slider label="Weather density" value={s.graphics.weatherDensity} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set((x) => ({ ...x, graphics: { ...x.graphics, weatherDensity: v } }))} />
            <Slider label="Draw distance" value={s.graphics.drawDistance} min={0.6} max={1.3} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set((x) => ({ ...x, graphics: { ...x.graphics, drawDistance: v } }))} />
            <Segmented
              label="Frame rate"
              value={String(s.graphics.fpsCap)}
              options={[
                { value: '0', label: 'Smoothest' },
                { value: '60', label: '60' },
                { value: '30', label: '30 (saves battery)' },
              ]}
              onChange={(v) => set((x) => ({ ...x, graphics: { ...x.graphics, fpsCap: Number(v) as 0 | 30 | 60 } }))}
            />
            <Toggle label="Watercolour painting" hint="The painted look. Turn off for maximum speed on older devices." checked={s.graphics.postProcessing} onChange={(v) => set((x) => ({ ...x, graphics: { ...x.graphics, postProcessing: v } }))} />
            <Toggle label="Developer diagnostics" checked={s.showDiagnostics} onChange={(v) => set((x) => ({ ...x, showDiagnostics: v }))} />
          </>
        )}
        {tab === 'audio' && (
          <>
            <Toggle label="Mute all" checked={s.audio.muted} onChange={(v) => set((x) => ({ ...x, audio: { ...x.audio, muted: v } }))} />
            {(['master', 'ui', 'construction', 'coaster', 'environment', 'music'] as const).map((k) => (
              <Slider
                key={k}
                label={{ master: 'Master', ui: 'Interface', construction: 'Construction', coaster: 'Coaster', environment: 'Environment', music: 'Music' }[k]}
                value={s.audio[k]}
                min={0}
                max={1}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => set((x) => ({ ...x, audio: { ...x.audio, [k]: v } }))}
              />
            ))}
            <Toggle
              label="Ambient music"
              hint="Sparse, gentle and mostly quiet"
              checked={s.audio.music > 0.01}
              onChange={(v) => {
                services.engine?.audio.setMusicEnabled(v);
                set((x) => ({ ...x, audio: { ...x.audio, music: v ? 0.5 : 0 } }));
              }}
            />
          </>
        )}
        {tab === 'comfort' && (
          <>
            {(
              [
                ['reducedMotion', 'Reduced motion', 'Calmer animations and camera'],
                ['cameraStabilisation', 'Camera stabilisation', 'Keeps the horizon steadier on rides'],
                ['disableShake', 'No camera shake', ''],
                ['disableAutoCamera', 'No automatic camera movement', ''],
                ['largerUi', 'Larger interface', ''],
                ['highContrast', 'Higher contrast', ''],
                ['simplifiedControls', 'Simplified construction', 'Fewer sliders at once'],
                ['haptics', 'Haptics', 'Where your device supports it'],
              ] as const
            ).map(([k, label, hint]) => (
              <Toggle key={k} label={label} hint={hint || undefined} checked={s.accessibility[k]} onChange={(v) => set((x) => ({ ...x, accessibility: { ...x.accessibility, [k]: v } }))} />
            ))}
          </>
        )}
        {tab === 'sim' && (
          <>
            <p className="cc-p small">Realistic defaults are documented in the physics notes. This is an entertainment simulation, not an engineering tool.</p>
            <Slider label="Rolling resistance" value={phys.rollingCoeff} min={0} max={0.02} step={0.0005} format={(v) => v.toFixed(4)} onChange={(v) => setPhys('rollingCoeff', v)} />
            <Slider label="Air resistance" value={phys.dragScale} min={0} max={2} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setPhys('dragScale', v)} />
            <Slider label="Chain lift speed (0 = per section)" value={phys.liftSpeed} min={0} max={6} step={0.1} unit=" m/s" onChange={(v) => setPhys('liftSpeed', v)} />
            <Slider label="Launch acceleration" value={phys.launchAccel} min={2} max={15} step={0.5} unit=" m/s²" onChange={(v) => setPhys('launchAccel', v)} />
            <Slider label="Brake strength" value={phys.brakeDecel} min={2} max={10} step={0.5} unit=" m/s²" onChange={(v) => setPhys('brakeDecel', v)} />
            <Slider label="Station wait" value={phys.dwell} min={2} max={30} step={1} unit=" s" onChange={(v) => setPhys('dwell', v)} />
            <Slider label="Gravity (experimental, not realistic)" value={phys.gravity} min={1.6} max={20} step={0.1} unit=" m/s²" onChange={(v) => setPhys('gravity', v)} />
            <Button icon="reset" onClick={() => useGame.setState({ physics: {} })}>
              Restore realistic defaults
            </Button>
          </>
        )}
        {tab === 'about' && (
          <div className="cc-p">
            <p>Cozy Coaster is a calm coaster sandbox. Your creations are saved in this browser only, which can be cleared by the browser. Export a save file from the parks list to keep a copy.</p>
            <p>All sounds are synthesised in your browser. The train physics is a simplified, documented model for fun, not a certified engineering or ride safety tool.</p>
            <p className="small">Build {__BUILD_ID__}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function SavesDialog() {
  const [list, setList] = useState<SaveSummary[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const currentId = useGame((s) => s.saveId);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => void saves.list().then(setList);
  useEffect(refresh, []);
  const close = () => useGame.setState({ overlay: 'none' });
  const g = useGame.getState;
  return (
    <Modal title="Your parks" onClose={close} wide>
      <div className="cc-row wrap">
        <Button
          icon="plus"
          variant="accent"
          onClick={async () => {
            await saves.flush();
            g().newWorld({ blank: true });
            close();
            useGame.setState({ panel: 'build' });
          }}
        >
          New park
        </Button>
        <Button
          icon="download"
          onClick={() => {
            const s = g().toSave();
            const url = URL.createObjectURL(exportSave(s));
            const a = document.createElement('a');
            a.href = url;
            a.download = exportFilename(s);
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            ui('save');
          }}
        >
          Export this park
        </Button>
        <Button icon="upload" onClick={() => fileRef.current?.click()}>
          Import
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const r = await importSave(f, { existingNames: (list ?? []).map((x) => x.name) });
            if (!r.ok) {
              g().toast(r.message);
              return;
            }
            await saves.flush();
            await saves.store.put(r.save);
            g().loadSave(r.save);
            g().toast(`Imported ${r.save.name}.`);
            close();
          }}
        />
      </div>
      <p className="cc-p small">Parks are saved automatically in this browser. Browsers can clear local storage, so export anything you'd hate to lose.</p>
      {list === null ? (
        <p className="cc-p">Loading…</p>
      ) : list.length === 0 ? (
        <p className="cc-p">No saved parks yet. Your current park saves itself as you build.</p>
      ) : (
        <ul className="cc-saves">
          {list.map((s) => (
            <li key={s.id} className={s.id === currentId ? 'current' : ''}>
              {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <div className="cc-thumb-blank" />}
              <div className="cc-save-info">
                {renaming === s.id ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      await saves.store.rename(s.id, name);
                      if (s.id === currentId) useGame.setState({ saveName: name });
                      setRenaming(null);
                      refresh();
                    }}
                  >
                    <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Park name" autoFocus />
                  </form>
                ) : (
                  <b>{s.name}</b>
                )}
                <span>
                  {s.coasterName} · {new Date(s.updated).toLocaleDateString()}
                </span>
              </div>
              <div className="cc-save-actions">
                {s.id !== currentId && (
                  <IconButton
                    icon="play"
                    label={`Open ${s.name}`}
                    onClick={async () => {
                      await saves.flush();
                      const r = await saves.store.load(s.id);
                      if (r.ok) {
                        g().loadSave(r.save);
                        if (r.recovered) g().toast('We restored this park from its most recent good copy.');
                        close();
                      } else g().toast(r.message);
                    }}
                  />
                )}
                <IconButton icon="pencil" label={`Rename ${s.name}`} onClick={() => (setRenaming(s.id), setName(s.name))} />
                <IconButton icon="copy" label={`Duplicate ${s.name}`} onClick={async () => (await saves.store.duplicate(s.id, `${s.name} copy`), refresh())} />
                <IconButton
                  icon="trash"
                  label={`Delete ${s.name}`}
                  disabled={s.id === currentId}
                  onClick={async () => {
                    if (!window.confirm(`Delete “${s.name}”? This can't be undone.`)) return;
                    await saves.store.remove(s.id);
                    refresh();
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function PhotoMode() {
  const [fov, setFov] = useState(50);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const e = services.engine;
    if (!e) return;
    const prev = e.rig.baseFov;
    return () => {
      e.rig.baseFov = prev;
      e.rig.camera.fov = prev;
      e.rig.camera.updateProjectionMatrix();
    };
  }, []);
  const shoot = () => {
    const e = services.engine;
    if (!e) return;
    const url = e.capture('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `cozy-coaster-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
    ui('save');
  };
  if (hidden)
    return (
      <button className="cc-photo-reveal" aria-label="Show photo controls" onClick={() => setHidden(false)}>
        <Icon name="eye" />
      </button>
    );
  return (
    <div className="cc-photo" role="toolbar" aria-label="Photo mode">
      <Slider
        label="Field of view"
        value={fov}
        min={20}
        max={90}
        step={1}
        unit="°"
        onChange={(v) => {
          setFov(v);
          const e = services.engine;
          if (e) {
            e.rig.baseFov = v;
            e.rig.camera.fov = v;
            e.rig.camera.updateProjectionMatrix();
          }
        }}
      />
      <div className="cc-row">
        <IconButton icon="eyeOff" label="Hide controls" onClick={() => setHidden(true)} />
        <Button variant="accent" icon="camera" onClick={shoot}>
          Take photo
        </Button>
        <Button onClick={() => useGame.setState({ overlay: 'none' })}>Done</Button>
      </div>
    </div>
  );
}

export function RelaxOverlay() {
  const [show, setShow] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShow(false), 2500);
    return () => clearTimeout(t);
  }, []);
  return (
    <button
      className={`cc-relax${show ? ' show' : ''}`}
      onPointerMove={() => setShow(true)}
      onClick={() => {
        useGame.setState({ overlay: 'none', camera: 'orbit' });
        // Come back to a view of the whole coaster, not wherever the drifting camera ended up.
        requestAnimationFrame(() => services.engine?.frameCoaster());
      }}
      aria-label="Leave relax mode"
    >
      <Icon name="close" size={18} /> <span>Leave relax mode</span>
    </button>
  );
}

export function Compatibility(props: { reason: string }) {
  return (
    <div className="cc-compat" role="alert">
      <h1>Cozy Coaster</h1>
      <p>This browser or device can't run the 3D world just now.</p>
      <p className="small">{props.reason === 'webgl2-unavailable' ? 'Cozy Coaster needs WebGL 2. Updating your browser, enabling hardware acceleration, or trying another browser usually helps.' : 'Something went wrong while starting the graphics. A refresh usually sorts it out.'}</p>
      <Button variant="accent" onClick={() => location.reload()}>
        Try again
      </Button>
    </div>
  );
}
