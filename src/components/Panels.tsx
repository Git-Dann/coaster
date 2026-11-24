import { useState, type ReactNode } from 'react';
import { useGame } from '../stores/game';
import { Button, IconButton, Segmented, Slider, Stepper, Swatches, Tiles, Toggle } from '../design-system/controls';
import { Icon } from '../design-system/Icon';
import { PRESETS, presetById, type PresetId } from '../features/builder/builder';
import { cancelConnect, confirmConnect, nudgeSelected, openCircuit, placePreview, removeLast, startConnect } from '../app/bridge';
import { services, ui } from '../app/services';
import { CAR_PROFILES, MAX_CARS, MIN_CARS, trainLength, type CarStyle, type Finish } from '../engine/train/config';
import type { SupportStyle, TrackStyle } from '../engine/track/types';
import { BIOMES, type Biome, type SceneryType, type TerrainBrush, type TimeOfDay, type Weather } from '../types/world';
import type { CameraMode } from '../engine/camera/camera-rig';
import { autoGarden } from '../features/scenery/garden';

function Sheet(props: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="cc-sheet" aria-label={props.title}>
      <header className="cc-sheet-head">
        <h2>{props.title}</h2>
        <IconButton icon="close" label="Close panel" onClick={() => useGame.setState({ panel: 'none', previewActive: false, selectedNode: null })} />
      </header>
      <div className="cc-sheet-body">{props.children}</div>
      {props.actions && <footer className="cc-sheet-actions">{props.actions}</footer>}
    </section>
  );
}

const PRESET_ICON: Record<PresetId, string> = {
  track: 'build',
  lift: 'up',
  drop: 'down',
  hill: 'ride',
  helix: 'reset',
  loop: 'reset',
  corkscrew: 'sparkle',
  zerog: 'sparkle',
  immelmann: 'redo',
  diveloop: 'undo',
  brake: 'pause',
  launch: 'play',
  station: 'folder',
  tunnel: 'eyeOff',
};

export function BuildPanel() {
  const design = useGame((s) => s.design);
  const preset = useGame((s) => s.preset);
  const params = useGame((s) => s.params);
  const autoBank = useGame((s) => s.autoBank);
  const selected = useGame((s) => s.selectedNode);
  const connecting = useGame((s) => s.connecting);
  const simplified = useGame((s) => s.settings.accessibility.simplifiedControls);
  const [precise, setPrecise] = useState(false);
  const g = useGame.getState;

  if (connecting) {
    return (
      <Sheet
        title="Connect circuit"
        actions={
          <>
            <Button onClick={cancelConnect}>Not yet</Button>
            <Button variant="accent" icon="link" onClick={confirmConnect} sound="success">
              Connect
            </Button>
          </>
        }
      >
        <p className="cc-p">The translucent track shows how your circuit will join the station. Nothing changes until you connect.</p>
      </Sheet>
    );
  }

  if (selected) {
    const node = design.nodes.find((n) => n.id === selected);
    return (
      <Sheet title="Edit track point" actions={<Button onClick={() => (useGame.setState({ selectedNode: null, previewActive: true }), services.engine?.setSelection(null))}>Done</Button>}>
        <p className="cc-p">Raise, lower or bank this point. Supports adjust as you go, and every change can be undone.</p>
        <div className="cc-row">
          <span className="cc-row-label">Height {node ? `${node.p[1].toFixed(1)} m` : ''}</span>
          <IconButton icon="down" label="Lower 1 metre" onClick={() => nudgeSelected('height', -1)} variant="solid" />
          <IconButton icon="up" label="Raise 1 metre" onClick={() => nudgeSelected('height', 1)} variant="solid" />
        </div>
        <div className="cc-row">
          <span className="cc-row-label">Banking {node ? `${Math.round((node.bank * 180) / Math.PI)}°` : ''}</span>
          <IconButton icon="undo" label="Bank left 5 degrees" onClick={() => nudgeSelected('bank', -5)} variant="solid" />
          <IconButton icon="redo" label="Bank right 5 degrees" onClick={() => nudgeSelected('bank', 5)} variant="solid" />
        </div>
      </Sheet>
    );
  }

  if (design.closed) {
    return (
      <Sheet
        title="Circuit complete"
        actions={
          <>
            <Button icon="pencil" onClick={openCircuit}>
              Extend
            </Button>
            <Button variant="accent" icon="ride" onClick={() => useGame.setState({ panel: 'ride', camera: 'front' })}>
              Ride it
            </Button>
          </>
        }
      >
        <p className="cc-p">Tap any point on the track to raise, lower or bank it. To add more track, open the circuit at the station end.</p>
      </Sheet>
    );
  }

  const p = presetById(preset);
  const shown = simplified && !precise ? p.params.slice(0, 2) : p.params;
  return (
    <Sheet
      title="Build"
      actions={
        <>
          <IconButton icon="trash" label="Remove last piece" onClick={removeLast} />
          <Button icon="link" onClick={startConnect}>
            Connect
          </Button>
          <Button variant="accent" icon="check" onClick={placePreview} sound="select">
            Place
          </Button>
        </>
      }
    >
      <div className="cc-chips" role="radiogroup" aria-label="Pieces">
        {PRESETS.map((pr) => (
          <button
            key={pr.id}
            role="radio"
            aria-checked={pr.id === preset}
            className={`cc-chip${pr.id === preset ? ' on' : ''}`}
            onClick={() => {
              ui('select');
              g().setPreset(pr.id);
            }}
          >
            <Icon name={PRESET_ICON[pr.id]} size={18} />
            {pr.label}
          </button>
        ))}
      </div>
      <p className="cc-p small">{p.hint}</p>
      {shown.map((def) =>
        def.key === 'direction' ? (
          <Segmented
            key={def.key}
            label="Direction"
            value={(params[def.key] ?? 1) > 0 ? 'right' : 'left'}
            options={[
              { value: 'left', label: 'Roll left' },
              { value: 'right', label: 'Roll right' },
            ]}
            onChange={(v) => g().setParam('direction', v === 'right' ? 1 : -1)}
          />
        ) : def.key === 'bank' && autoBank && preset === 'track' ? null : (
          <Slider key={def.key} label={def.label} value={params[def.key] ?? p.defaults[def.key]!} min={def.min} max={def.max} step={def.step} unit={def.unit ? ` ${def.unit}` : ''} onChange={(v) => g().setParam(def.key, v)} />
        ),
      )}
      {(preset === 'track' || preset === 'helix') && <Toggle label="Automatic banking" hint="Banks turns to suit the train's speed" checked={autoBank} onChange={(v) => useGame.setState({ autoBank: v, previewActive: true })} />}
      {simplified && p.params.length > 2 && (
        <Button variant="plain" onClick={() => setPrecise(!precise)}>
          {precise ? 'Fewer controls' : 'More controls'}
        </Button>
      )}
    </Sheet>
  );
}

const CAR_STYLES: CarStyle[] = ['steel', 'timber', 'retro', 'expedition', 'open', 'mine'];

export function TrainPanel() {
  const train = useGame((s) => s.train);
  const rideState = useGame((s) => s.rideState);
  const set = useGame.getState().setTrain;
  const parked = rideState !== 'running';
  const mass = CAR_PROFILES[train.style].mass * train.cars;
  return (
    <Sheet title="Train">
      <Stepper
        label="Carriages"
        value={train.cars}
        min={MIN_CARS}
        max={MAX_CARS}
        disabled={!parked}
        onChange={(v) => set({ cars: v })}
        render={(v) => (
          <span className="cc-cars" aria-label={`${v} carriages`}>
            {Array.from({ length: v }, (_, i) => (
              <span key={i} className="cc-car-pip" style={{ background: train.colours.primary }} />
            ))}
          </span>
        )}
      />
      <p className="cc-p small">
        {parked ? `${(mass / 1000).toFixed(1)} t empty · ${trainLength(train).toFixed(1)} m long. More carriages add mass and drag, and change how the train crests hills.` : 'The train is out on the track. Carriages can be changed once it is back in the station.'}
        {!parked && (
          <button className="cc-link" onClick={() => services.engine?.resetTrain()}>
            Return it now
          </button>
        )}
      </p>
      <Tiles label="Carriage style" value={train.style} columns={3} options={CAR_STYLES.map((s) => ({ value: s, label: CAR_PROFILES[s].label }))} onChange={(v) => parked && set({ style: v })} />
      <Swatches label="Body" value={train.colours.primary} onChange={(c) => set({ colours: { ...train.colours, primary: c } })} />
      <Swatches label="Accent" value={train.colours.secondary} onChange={(c) => set({ colours: { ...train.colours, secondary: c } })} />
      <Swatches label="Seats" value={train.colours.seat} onChange={(c) => set({ colours: { ...train.colours, seat: c } })} />
      <Swatches label="Trim and restraints" value={train.colours.trim} onChange={(c) => set({ colours: { ...train.colours, trim: c } })} />
      <Swatches label="Wheel assemblies" value={train.colours.wheels} onChange={(c) => set({ colours: { ...train.colours, wheels: c } })} />
      <Segmented<Finish>
        label="Finish"
        value={train.finish}
        options={[
          { value: 'matte', label: 'Matte' },
          { value: 'satin', label: 'Satin' },
          { value: 'gloss', label: 'Gloss' },
        ]}
        onChange={(v) => set({ finish: v })}
      />
    </Sheet>
  );
}

const TRACK_STYLES: Array<{ value: TrackStyle; label: string }> = [
  { value: 'tubular', label: 'Tubular steel' },
  { value: 'boxspine', label: 'Box spine' },
  { value: 'wood', label: 'Classic wood' },
  { value: 'mine', label: 'Mine railway' },
];
const SUPPORT_STYLES: Array<{ value: SupportStyle; label: string; swatch: string }> = [
  { value: 'powder-steel', label: 'Powder steel', swatch: '#F5EBDD' },
  { value: 'galvanised', label: 'Galvanised', swatch: '#B9BDBA' },
  { value: 'industrial', label: 'Industrial', swatch: '#55745B' },
  { value: 'pine', label: 'Pine', swatch: '#D6B48A' },
  { value: 'walnut', label: 'Walnut', swatch: '#6E5040' },
  { value: 'painted-timber', label: 'Painted', swatch: '#F2E6D3' },
  { value: 'weathered', label: 'Weathered', swatch: '#A49A8C' },
];

export function StylePanel() {
  const design = useGame((s) => s.design);
  const name = useGame((s) => s.coasterName);
  const g = useGame.getState;
  const patch = (p: Partial<typeof design>) => g().commitDesign({ ...design, ...p });
  return (
    <Sheet title="Style">
      <label className="cc-field">
        <span>Coaster name</span>
        <input value={name} maxLength={40} onChange={(e) => useGame.setState({ coasterName: e.target.value })} />
      </label>
      <Tiles label="Track" value={design.style} columns={2} options={TRACK_STYLES} onChange={(v) => (ui('material'), patch({ style: v }))} />
      <Tiles
        label="Supports"
        value={design.supportStyle}
        columns={4}
        options={SUPPORT_STYLES}
        onChange={(v) => {
          ui('material');
          const sw = SUPPORT_STYLES.find((s) => s.value === v)!.swatch;
          patch({ supportStyle: v, colours: { ...design.colours, support: sw } });
        }}
      />
      <Swatches label="Rails" value={design.colours.rail} onChange={(c) => patch({ colours: { ...design.colours, rail: c } })} />
      <Swatches label="Spine" value={design.colours.spine} onChange={(c) => patch({ colours: { ...design.colours, spine: c } })} />
      <Swatches label="Sleepers" value={design.colours.sleeper} onChange={(c) => patch({ colours: { ...design.colours, sleeper: c } })} />
      <Swatches label="Supports colour" value={design.colours.support} onChange={(c) => patch({ colours: { ...design.colours, support: c } })} />
    </Sheet>
  );
}

const SCENERY: Array<{ value: SceneryType; label: string; icon: string }> = [
  { value: 'pine', label: 'Pine', icon: 'scenery' },
  { value: 'oak', label: 'Oak', icon: 'leaf' },
  { value: 'birch', label: 'Birch', icon: 'leaf' },
  { value: 'bush', label: 'Bush', icon: 'leaf' },
  { value: 'flowers', label: 'Flowers', icon: 'sparkle' },
  { value: 'grass', label: 'Grass', icon: 'leaf' },
  { value: 'rock', label: 'Rock', icon: 'scenery' },
  { value: 'bench', label: 'Bench', icon: 'minus' },
  { value: 'lantern', label: 'Lantern', icon: 'sun' },
  { value: 'fence', label: 'Fence', icon: 'pause' },
  { value: 'sign', label: 'Sign', icon: 'info' },
  { value: 'hut', label: 'Hut', icon: 'folder' },
];
const BRUSHES: Array<{ value: TerrainBrush; label: string; icon: string }> = [
  { value: 'raise', label: 'Raise', icon: 'up' },
  { value: 'lower', label: 'Lower', icon: 'down' },
  { value: 'smooth', label: 'Smooth', icon: 'ride' },
  { value: 'flatten', label: 'Flatten', icon: 'minus' },
  { value: 'paint-path', label: 'Path', icon: 'brush' },
  { value: 'clear-vegetation', label: 'Clear', icon: 'trash' },
];

export function SceneryPanel() {
  const tool = useGame((s) => s.sceneryTool);
  const brush = useGame((s) => s.brush);
  const radius = useGame((s) => s.brushRadius);
  const strength = useGame((s) => s.brushStrength);
  const count = useGame((s) => s.scenery.length);
  return (
    <Sheet title="Scenery">
      <Segmented
        label="Mode"
        value={brush ? 'terrain' : 'place'}
        options={[
          { value: 'place', label: 'Place' },
          { value: 'terrain', label: 'Landscape' },
        ]}
        onChange={(v) => useGame.setState(v === 'terrain' ? { brush: 'raise', sceneryTool: null } : { brush: null, sceneryTool: 'oak' })}
      />
      {!brush ? (
        <>
          <Tiles label="Scenery item" value={tool} columns={4} options={SCENERY} onChange={(v) => useGame.setState({ sceneryTool: tool === v ? null : v })} />
          <p className="cc-p small">{tool ? 'Tap the ground to place. Tap the tile again to switch to removing.' : 'Tap an item in the world to remove it.'} {count > 0 && `${count} placed.`}</p>
          <Button
            icon="sparkle"
            onClick={() => {
              const g = useGame.getState();
              const items = autoGarden(g.design, g.scenery, (x, z) => services.engine?.terrain.heightAt(x, z) ?? 0);
              g.setScenery([...g.scenery, ...items]);
              ui('success');
            }}
          >
            Plant a coaster garden
          </Button>
        </>
      ) : (
        <>
          <Tiles label="Landscape brush" value={brush} columns={3} options={BRUSHES} onChange={(v) => useGame.setState({ brush: v })} />
          <Slider label="Brush size" value={radius} min={3} max={30} step={1} unit=" m" onChange={(v) => useGame.setState({ brushRadius: v })} />
          <Slider label="Strength" value={strength} min={0.2} max={2} step={0.1} onChange={(v) => useGame.setState({ brushStrength: v })} />
          <p className="cc-p small">Drag across the ground to sculpt. Two fingers still move the camera. Supports re-anchor automatically.</p>
        </>
      )}
    </Sheet>
  );
}

const WEATHER_OPTS: Array<{ value: Weather; label: string; icon: string }> = [
  { value: 'clear', label: 'Clear', icon: 'sun' },
  { value: 'partly-cloudy', label: 'Some cloud', icon: 'weather' },
  { value: 'overcast', label: 'Overcast', icon: 'weather' },
  { value: 'light-rain', label: 'Drizzle', icon: 'weather' },
  { value: 'rain', label: 'Rain', icon: 'weather' },
  { value: 'snow', label: 'Snow', icon: 'sparkle' },
  { value: 'mist', label: 'Mist', icon: 'eyeOff' },
  { value: 'golden-haze', label: 'Haze', icon: 'sun' },
];
const TIME_OPTS: Array<{ value: TimeOfDay; label: string; icon: string }> = [
  { value: 'sunrise', label: 'Sunrise', icon: 'sun' },
  { value: 'morning', label: 'Morning', icon: 'sun' },
  { value: 'midday', label: 'Midday', icon: 'sun' },
  { value: 'afternoon', label: 'Afternoon', icon: 'sun' },
  { value: 'golden', label: 'Golden hour', icon: 'sun' },
  { value: 'blue', label: 'Blue hour', icon: 'moon' },
  { value: 'night', label: 'Night', icon: 'moon' },
];
const BIOME_LABEL: Record<Biome, string> = { meadow: 'Meadow', woodland: 'Woodland', alpine: 'Alpine', coastal: 'Coastal', autumn: 'Autumn', winter: 'Winter' };
const BIOME_SWATCH: Record<Biome, string> = { meadow: '#A8B58B', woodland: '#55745B', alpine: '#9C978E', coastal: '#8DAABB', autumn: '#D49A5A', winter: '#EEF0F0' };

export function WeatherPanel() {
  const env = useGame((s) => s.env);
  const setEnv = useGame.getState().setEnv;
  const [pending, setPending] = useState<{ biome: Biome; seed: number } | null>(null);
  return (
    <Sheet title="Weather and world">
      <Tiles label="Weather" value={env.weather} columns={4} options={WEATHER_OPTS} onChange={(v) => setEnv({ weather: v })} />
      <Tiles label="Time of day" value={env.time} columns={4} options={TIME_OPTS} onChange={(v) => setEnv({ time: v })} />
      <Toggle label="Day and night cycle" hint="A gentle ten-minute day" checked={env.autoCycle} onChange={(v) => setEnv({ autoCycle: v })} />
      <h3 className="cc-h3">Landscape</h3>
      <Tiles label="Environment" value={pending?.biome ?? env.biome} columns={3} options={BIOMES.map((b) => ({ value: b, label: BIOME_LABEL[b], swatch: BIOME_SWATCH[b] }))} onChange={(v) => v !== env.biome && setPending({ biome: v, seed: env.seed })} />
      <div className="cc-row">
        <span className="cc-row-label">Seed {pending?.seed ?? env.seed}</span>
        <Button icon="sparkle" onClick={() => setPending({ biome: pending?.biome ?? env.biome, seed: Math.floor(Math.random() * 999999) })}>
          New landscape
        </Button>
      </div>
      {pending && (
        <div className="cc-confirm" role="alertdialog" aria-label="Change landscape">
          <p>The hills around your coaster will reshape. Your track, train and scenery stay exactly where they are.</p>
          <div className="cc-row">
            <Button onClick={() => setPending(null)}>Keep current</Button>
            <Button
              variant="accent"
              onClick={() => {
                setEnv({ biome: pending.biome, seed: pending.seed });
                setPending(null);
              }}
            >
              Change landscape
            </Button>
          </div>
        </div>
      )}
      <Toggle label="Environmental physics" hint="Gentle wind affects the train. An approximation, off by default." checked={env.environmentalPhysics} onChange={(v) => setEnv({ environmentalPhysics: v })} />
    </Sheet>
  );
}

const CAMS: Array<{ value: CameraMode; label: string; icon: string }> = [
  { value: 'front', label: 'Front seat', icon: 'eye' },
  { value: 'rear', label: 'Back seat', icon: 'eye' },
  { value: 'follow', label: 'Follow', icon: 'train' },
  { value: 'side', label: 'Alongside', icon: 'train' },
  { value: 'cinematic', label: 'Cinematic', icon: 'camera' },
  { value: 'trackside', label: 'Trackside', icon: 'hand' },
  { value: 'orbit', label: 'Build view', icon: 'frame' },
];

export function RidePanel() {
  const camera = useGame((s) => s.camera);
  const paused = useGame((s) => s.simPaused);
  const playback = useGame((s) => s.playback);
  const telemetry = useGame((s) => s.settings.telemetry);
  const closed = useGame((s) => s.design.closed);
  const train = useGame((s) => s.train);
  const fits = services.engine ? services.engine.sim.stationFits() : true;
  void train;
  return (
    <Sheet
      title="Ride"
      actions={
        <>
          <IconButton icon="reset" label="Back to station" onClick={() => services.engine?.resetTrain()} />
          <Button icon={paused ? 'play' : 'pause'} onClick={() => useGame.setState({ simPaused: !paused })}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button variant="accent" icon="play" onClick={() => services.engine?.dispatch()}>
            Dispatch
          </Button>
        </>
      }
    >
      {!closed && <p className="cc-p small">Your track isn't a full circuit yet, so the train will pause safely before the end.</p>}
      {!fits && <p className="cc-p small">This train is longer than the station platform. A longer station or fewer carriages will help it stop neatly.</p>}
      <Tiles label="Camera" value={camera} columns={4} options={CAMS} onChange={(v) => useGame.setState({ camera: v })} />
      <Segmented
        label="Playback speed"
        value={String(playback)}
        options={[
          { value: '0.5', label: '½×' },
          { value: '1', label: '1×' },
          { value: '2', label: '2×' },
        ]}
        onChange={(v) => useGame.setState({ playback: Number(v) })}
      />
      <div className="cc-row wrap">
        <Button icon="leaf" onClick={() => useGame.setState({ overlay: 'relax', panel: 'none', camera: 'relax' })}>
          Relax mode
        </Button>
        <Button icon="camera" onClick={() => useGame.setState({ overlay: 'photo', panel: 'none' })}>
          Photo mode
        </Button>
      </div>
      <Toggle label="Ride telemetry" hint="Speed, height and forces" checked={telemetry} onChange={(v) => useGame.getState().setSettings((s) => ({ ...s, telemetry: v }))} />
      <Toggle
        label="Automatic dispatch"
        checked={services.engine?.sim.autoDispatch ?? true}
        onChange={(v) => {
          if (services.engine) services.engine.sim.autoDispatch = v;
          useGame.setState({});
        }}
      />
    </Sheet>
  );
}
