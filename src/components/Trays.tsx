import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useGame } from '../stores/game';
import { Icon } from '../design-system/Icon';
import { SWATCHES } from '../design-system/controls';
import { services, ui } from '../app/services';
import { addGhost, chooseBuild, removeLast, removeSelected, selectPiece, stepSelection } from '../app/bridge';
import { SPECIALS, pieceById, piecesOf, type BuildChoice, type Slope, type Turn } from '../features/builder/simple-builder';
import { autoGarden } from '../features/scenery/garden';
import { MAX_CARS, MIN_CARS, type CarStyle } from '../engine/train/config';
import type { SupportStyle, TrackStyle } from '../engine/track/types';
import { BIOMES, type Biome, type SceneryType, type TerrainBrush, type TimeOfDay, type Weather } from '../types/world';
import type { CameraMode } from '../engine/camera/camera-rig';

/**
 * Touch-first trays. Each mode shows one compact tray above the dock: big tappable cards in a
 * horizontal row, at most one secondary row, never a wall of sliders. Everything works at any
 * time: nothing is locked behind the train's state.
 */

function Tray(props: { children: ReactNode; label: string }) {
  return (
    <section className="cc-tray" aria-label={props.label}>
      {props.children}
    </section>
  );
}

function Card(props: { label: string; icon?: string; swatch?: string; on?: boolean; onClick: () => void; small?: boolean; accent?: boolean }) {
  return (
    <button
      type="button"
      className={`cc-card${props.on ? ' on' : ''}${props.small ? ' small' : ''}${props.accent ? ' accent' : ''}`}
      aria-pressed={props.on}
      onClick={props.onClick}
    >
      {props.swatch ? <span className="cc-card-swatch" style={{ background: props.swatch }} /> : props.icon ? <Icon name={props.icon} size={props.small ? 22 : 30} /> : null}
      <span className="cc-card-label">{props.label}</span>
    </button>
  );
}

function Row(props: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Bring the selected item into view when the row opens.
  useEffect(() => {
    const row = ref.current;
    const on = row?.querySelector<HTMLElement>('.on');
    if (!row || !on) return;
    // Scroll only as far as needed to show it, keeping a comfortable margin from the edge.
    const margin = 16;
    const left = on.offsetLeft - margin;
    const right = on.offsetLeft + on.clientWidth + margin - row.clientWidth;
    if (row.scrollLeft > left) row.scrollLeft = Math.max(0, left);
    else if (row.scrollLeft < right) row.scrollLeft = right;
  }, []);
  return (
    <div ref={ref} className="cc-row-scroll" role="group" aria-label={props.label}>
      {props.children}
    </div>
  );
}

function Tabs<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="cc-tabs" role="tablist" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === props.value}
          className={o.value === props.value ? 'on' : ''}
          onClick={() => {
            ui('select');
            props.onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Swatch(props: { colour: string; on: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`cc-dot${props.on ? ' on' : ''}`} aria-label={props.label} aria-pressed={props.on} onClick={props.onClick}>
      <span className="cc-dot-fill" style={{ background: props.colour }} />
    </button>
  );
}

// ------------------------------------------------------------------ Build (edit mode)

const DIRECTIONS: Array<{ turn: Turn; label: string; icon: string }> = [
  { turn: 1, label: 'Turn left', icon: 'p-left' },
  { turn: 0, label: 'Straight', icon: 'p-straight' },
  { turn: -1, label: 'Turn right', icon: 'p-right' },
];
const SLOPES: Array<{ slope: Slope; label: string; icon: string }> = [
  { slope: -1, label: 'Down', icon: 'p-down' },
  { slope: 0, label: 'Level', icon: 'minus' },
  { slope: 1, label: 'Up', icon: 'p-up' },
];

function ghostHint(ghost: ReturnType<typeof useGame.getState>['ghost'], choice: BuildChoice, editing: boolean): string {
  if (!ghost) return 'Choose the next piece';
  if (editing && !ghost.changed) return 'Choose a new shape for this piece, or remove it';
  if (ghost.blocked) return ghost.blocked;
  if (ghost.dropped) return `Changing this also removes ${ghost.dropped} older ${ghost.dropped === 1 ? 'piece' : 'pieces'} after it`;
  if (ghost.atGround) return 'Already at the ground, so it stays level';
  if (ghost.crossing) return ghost.crossing.above ? `Passes under the track above (${Math.round(ghost.crossing.gap)} m clear)` : `Goes over the track below (${Math.round(ghost.crossing.gap)} m clear)`;
  const h = Math.round(ghost.height);
  const what = choice.kind === 'special' ? pieceById(choice.id).label : editing ? 'This piece' : 'The next piece';
  return h <= 2 ? `${what} ends near the ground` : `${what} ends ${h} m up`;
}

export function BuildTray() {
  const choice = useGame((s) => s.buildChoice);
  const ghost = useGame((s) => s.ghost);
  const editSel = useGame((s) => s.editSel);
  const design = useGame((s) => s.design);
  const pieces = piecesOf(design);
  const k = editSel ? pieces.findIndex((p) => p.group === editSel) : -1;
  const editing = k >= 0;
  const avail = useGame((s) => s.avail);
  const track = choice.kind === 'track' ? choice : null;
  // Contextual: only offer what fits smoothly here (everything shows until the check finishes).
  const specials = avail ? SPECIALS.filter((id) => avail.specials.includes(id)) : SPECIALS;
  const slopes = SLOPES.filter((sl) => sl.slope !== -1 || !(ghost?.downBlocked || (avail && avail.down[track?.turn ?? 0] === false)));
  const pick = (turn: Turn, slope: Slope) => chooseBuild({ kind: 'track', turn, slope });
  return (
    <Tray label="Edit track">
      <div className="cc-build-head">
        <button type="button" className="cc-round" aria-label="Previous piece" disabled={pieces.length === 0 || k === 0} onClick={() => stepSelection(-1)}>
          <Icon name="left" size={20} />
        </button>
        <span className="cc-build-title">{editing ? `Piece ${k + 1} of ${pieces.length}` : 'Adding to the end'}</span>
        <button type="button" className="cc-round" aria-label="Next piece" disabled={!editing} onClick={() => stepSelection(1)}>
          <Icon name="right" size={20} />
        </button>
        {editing && (
          <button type="button" className="cc-pill-btn small" onClick={() => selectPiece(null)}>
            Go to end
          </button>
        )}
        <button type="button" className="cc-pill-btn small done" onClick={() => (ui('close'), useGame.setState({ panel: 'none' }))}>
          Done
        </button>
      </div>
      <div className="cc-build">
        <div className="cc-seg" role="group" aria-label="Direction">
          {DIRECTIONS.map((d) => (
            <button key={d.turn} type="button" className={track?.turn === d.turn ? 'on' : ''} aria-pressed={track?.turn === d.turn} onClick={() => pick(d.turn, track?.slope ?? 0)}>
              <Icon name={d.icon} size={24} />
              <span>{d.label}</span>
            </button>
          ))}
        </div>
        <div className="cc-seg" role="group" aria-label="Slope">
          {slopes.map((sl) => (
            <button key={sl.slope} type="button" className={track?.slope === sl.slope ? 'on' : ''} aria-pressed={track?.slope === sl.slope} onClick={() => pick(track?.turn ?? 0, sl.slope)}>
              <Icon name={sl.icon} size={24} />
              <span>{sl.label}</span>
            </button>
          ))}
        </div>
      </div>
      <Row label="Special pieces">
        {specials.map((id) => {
          const p = pieceById(id);
          return <Card key={id} small label={p.label} icon={p.icon} on={choice.kind === 'special' && choice.id === id} onClick={() => chooseBuild({ kind: 'special', id })} />;
        })}
      </Row>
      {avail?.note && <p className="cc-build-note">{avail.note}</p>}
      <p className="cc-build-hint" aria-live="polite">
        {ghostHint(ghost, choice, editing)}
      </p>
      <div className="cc-build-actions">
        {editing ? (
          <>
            <button type="button" className="cc-pill-btn" onClick={() => (ui('tap'), removeSelected())} aria-label="Remove this piece">
              <Icon name="trash" size={20} /> <span>Remove piece</span>
            </button>
            <button type="button" className="cc-add-btn" onClick={() => (ui('success'), addGhost())} aria-label="Apply change" disabled={!ghost?.changed || !!ghost?.blocked}>
              <Icon name="check" size={22} /> <span>Apply</span>
            </button>
          </>
        ) : (
          <>
            <button type="button" className="cc-pill-btn" onClick={() => (ui('tap'), removeLast())} aria-label="Remove the last piece">
              <Icon name="trash" size={20} /> <span>Remove</span>
            </button>
            <button type="button" className="cc-add-btn" onClick={() => (ui('success'), addGhost())} aria-label="Add piece" disabled={!ghost || !!ghost.blocked}>
              <Icon name="plus" size={22} /> <span>Add piece</span>
            </button>
          </>
        )}
      </div>
    </Tray>
  );
}

// ------------------------------------------------------------------ Decorate

const THINGS: Array<{ value: SceneryType; label: string; icon: string }> = [
  { value: 'oak', label: 'Tree', icon: 'leaf' },
  { value: 'pine', label: 'Pine', icon: 'scenery' },
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
const LAND: Array<{ value: TerrainBrush; label: string; icon: string }> = [
  { value: 'raise', label: 'Raise', icon: 'up' },
  { value: 'lower', label: 'Lower', icon: 'down' },
  { value: 'smooth', label: 'Smooth', icon: 'ride' },
  { value: 'flatten', label: 'Flatten', icon: 'minus' },
  { value: 'paint-path', label: 'Path', icon: 'brush' },
  { value: 'clear-vegetation', label: 'Clear', icon: 'eraser' },
];

export function DecorateTray() {
  const tool = useGame((s) => s.sceneryTool);
  const brush = useGame((s) => s.brush);
  const eraser = useGame((s) => s.eraser);
  const radius = useGame((s) => s.brushRadius);
  const [tab, setTab] = useState<'things' | 'land'>(brush ? 'land' : 'things');
  return (
    <Tray label="Decorate">
      <Tabs
        label="Decorate"
        value={tab}
        options={[
          { value: 'things', label: 'Things' },
          { value: 'land', label: 'Land' },
        ]}
        onChange={(v) => {
          setTab(v);
          useGame.setState({ sceneryTool: null, brush: null, eraser: false });
        }}
      />
      {tab === 'things' ? (
        <Row label="Things to place">
          {THINGS.map((t) => (
            <Card key={t.value} label={t.label} icon={t.icon} on={tool === t.value} onClick={() => (ui('select'), useGame.setState({ sceneryTool: tool === t.value ? null : t.value, eraser: false }))} />
          ))}
          <Card label="Remove" icon="eraser" on={eraser} onClick={() => (ui('select'), useGame.setState({ eraser: !eraser, sceneryTool: null }))} />
          <Card
            label="Garden"
            icon="wand"
            accent
            onClick={() => {
              const g = useGame.getState();
              g.setScenery([...g.scenery, ...autoGarden(g.design, g.scenery, (x, z) => services.engine?.terrain.heightAt(x, z) ?? 0)]);
              ui('success');
            }}
          />
        </Row>
      ) : (
        <Row label="Landscape tools">
          {LAND.map((t) => (
            <Card key={t.value} label={t.label} icon={t.icon} on={brush === t.value} onClick={() => (ui('select'), useGame.setState({ brush: brush === t.value ? null : t.value }))} />
          ))}
          {[
            { r: 5, label: 'Small' },
            { r: 10, label: 'Medium' },
            { r: 18, label: 'Large' },
          ].map((s) => (
            <Card key={s.r} small label={s.label} icon="sparkle" on={radius === s.r} onClick={() => (ui('select'), useGame.setState({ brushRadius: s.r }))} />
          ))}
        </Row>
      )}
      <p className="cc-tray-tip line">
        {tab === 'things' ? (eraser ? 'Tap something to remove it' : tool ? 'Tap the ground to place it' : 'Pick something, then tap the ground') : brush ? 'Drag on the ground · two fingers move the view' : 'Pick a tool, then drag on the ground'}
      </p>
    </Tray>
  );
}

// ------------------------------------------------------------------ Paint

const TRACKS: Array<{ value: TrackStyle; label: string; icon: string }> = [
  { value: 'tubular', label: 'Steel', icon: 'p-straight' },
  { value: 'boxspine', label: 'Box steel', icon: 'p-brake' },
  { value: 'wood', label: 'Wooden', icon: 'p-lift' },
  { value: 'mine', label: 'Mine', icon: 'p-hill' },
];
const SUPPORTS: Array<{ value: SupportStyle; label: string; swatch: string }> = [
  { value: 'powder-steel', label: 'Cream steel', swatch: '#F5EBDD' },
  { value: 'galvanised', label: 'Silver steel', swatch: '#B9BDBA' },
  { value: 'industrial', label: 'Green steel', swatch: '#55745B' },
  { value: 'painted-timber', label: 'White wood', swatch: '#F2E6D3' },
  { value: 'pine', label: 'Pine', swatch: '#D6B48A' },
  { value: 'walnut', label: 'Walnut', swatch: '#6E5040' },
  { value: 'weathered', label: 'Old wood', swatch: '#A49A8C' },
];
const TIMBER: ReadonlySet<SupportStyle> = new Set(['pine', 'walnut', 'painted-timber', 'weathered']);
const CARS: Array<{ value: CarStyle; label: string }> = [
  { value: 'steel', label: 'Modern' },
  { value: 'timber', label: 'Wooden' },
  { value: 'retro', label: 'Retro' },
  { value: 'expedition', label: 'Explorer' },
  { value: 'open', label: 'Open' },
  { value: 'mine', label: 'Mine cart' },
];

export function PaintTray() {
  const tab = useGame((s) => s.paintTab);
  const design = useGame((s) => s.design);
  const train = useGame((s) => s.train);
  const g = useGame.getState;
  const patch = (p: Partial<typeof design>) => g().commitDesign({ ...design, ...p });
  return (
    <Tray label="Paint">
      <Tabs
        label="What to paint"
        value={tab}
        options={[
          { value: 'track', label: 'Track' },
          { value: 'supports', label: 'Supports' },
          { value: 'train', label: 'Train' },
        ]}
        onChange={(v) => useGame.setState({ paintTab: v })}
      />
      {tab === 'track' && (
        <>
          <Row label="Track type">
            {TRACKS.map((t) => (
              <Card
                key={t.value}
                small
                label={t.label}
                icon={t.icon}
                on={design.style === t.value}
                onClick={() => {
                  ui('material');
                  const timber = TIMBER.has(design.supportStyle);
                  if (t.value === 'wood' && !timber) patch({ style: t.value, supportStyle: 'painted-timber', colours: { ...design.colours, support: '#F2E6D3', spine: '#B08A62', sleeper: '#8C6A4E', rail: '#9AA0A3' } });
                  else if ((t.value === 'tubular' || t.value === 'boxspine') && timber) patch({ style: t.value, supportStyle: 'powder-steel', colours: { ...design.colours, support: '#F5EBDD', spine: '#C77D62', rail: '#C77D62', sleeper: '#765B48' } });
                  else patch({ style: t.value });
                }}
              />
            ))}
          </Row>
          <Row label="Track colour">
            {SWATCHES.map((c) => (
              <Swatch key={c} colour={c} label={`Track colour ${c}`} on={design.colours.rail.toLowerCase() === c.toLowerCase()} onClick={() => (ui('colour'), patch({ colours: { ...design.colours, rail: c, spine: design.style === 'wood' ? design.colours.spine : c } }))} />
            ))}
          </Row>
        </>
      )}
      {tab === 'supports' && (
        <Row label="Supports">
          {SUPPORTS.map((s) => (
            <Card key={s.value} small label={s.label} swatch={s.swatch} on={design.supportStyle === s.value} onClick={() => (ui('material'), patch({ supportStyle: s.value, colours: { ...design.colours, support: s.swatch } }))} />
          ))}
        </Row>
      )}
      {tab === 'train' && (
        <>
          <div className="cc-cars-row">
            <button type="button" className="cc-round" aria-label="Fewer carriages" disabled={train.cars <= MIN_CARS} onClick={() => (ui('carriage-remove'), g().setTrain({ cars: train.cars - 1 }))}>
              <Icon name="minus" size={22} />
            </button>
            <div className="cc-cars" aria-live="polite" aria-label={`${train.cars} carriages`}>
              {Array.from({ length: train.cars }, (_, i) => (
                <span key={i} className="cc-car-pip" style={{ background: train.colours.primary }} />
              ))}
            </div>
            <button type="button" className="cc-round" aria-label="More carriages" disabled={train.cars >= MAX_CARS} onClick={() => (ui('carriage-add'), g().setTrain({ cars: train.cars + 1 }))}>
              <Icon name="plus" size={22} />
            </button>
          </div>
          <Row label="Train colour">
            {SWATCHES.map((c) => (
              <Swatch key={c} colour={c} label={`Train colour ${c}`} on={train.colours.primary.toLowerCase() === c.toLowerCase()} onClick={() => (ui('colour'), g().setTrain({ colours: { ...train.colours, primary: c } }))} />
            ))}
          </Row>
          <Row label="Carriage style">
            {CARS.map((c) => (
              <Card key={c.value} small label={c.label} icon="train" on={train.style === c.value} onClick={() => (ui('material'), g().setTrain({ style: c.value }))} />
            ))}
          </Row>
        </>
      )}
    </Tray>
  );
}

// ------------------------------------------------------------------ Sky

const TIMES: Array<{ value: TimeOfDay; label: string; icon: string }> = [
  { value: 'sunrise', label: 'Sunrise', icon: 'sun' },
  { value: 'midday', label: 'Day', icon: 'sun' },
  { value: 'golden', label: 'Golden', icon: 'sun' },
  { value: 'blue', label: 'Dusk', icon: 'moon' },
  { value: 'night', label: 'Night', icon: 'moon' },
];
const WEATHER: Array<{ value: Weather; label: string; icon: string }> = [
  { value: 'clear', label: 'Sunny', icon: 'sun' },
  { value: 'partly-cloudy', label: 'Clouds', icon: 'weather' },
  { value: 'light-rain', label: 'Drizzle', icon: 'weather' },
  { value: 'rain', label: 'Rain', icon: 'weather' },
  { value: 'snow', label: 'Snow', icon: 'sparkle' },
  { value: 'mist', label: 'Mist', icon: 'eyeOff' },
];
const BIOME_LABEL: Record<Biome, string> = { meadow: 'Meadow', woodland: 'Woods', alpine: 'Mountains', coastal: 'Seaside', autumn: 'Autumn', winter: 'Winter' };
const BIOME_SWATCH: Record<Biome, string> = { meadow: '#A8B58B', woodland: '#55745B', alpine: '#9C978E', coastal: '#8DAABB', autumn: '#D49A5A', winter: '#EEF0F0' };

export function SkyTray() {
  const env = useGame((s) => s.env);
  const setEnv = useGame.getState().setEnv;
  const [tab, setTab] = useState<'sky' | 'world'>('sky');
  return (
    <Tray label="Sky">
      <Tabs
        label="Sky or world"
        value={tab}
        options={[
          { value: 'sky', label: 'Sky' },
          { value: 'world', label: 'World' },
        ]}
        onChange={setTab}
      />
      {tab === 'sky' ? (
        <>
          <Row label="Time of day">
            {TIMES.map((t) => (
              <Card key={t.value} small label={t.label} icon={t.icon} on={env.time === t.value || (t.value === 'midday' && (env.time === 'morning' || env.time === 'afternoon'))} onClick={() => (ui('select'), setEnv({ time: t.value, autoCycle: false }))} />
            ))}
            <Card small label="Day cycle" icon="reset" on={env.autoCycle} onClick={() => (ui('toggle'), setEnv({ autoCycle: !env.autoCycle }))} />
          </Row>
          <Row label="Weather">
            {WEATHER.map((w) => (
              <Card key={w.value} small label={w.label} icon={w.icon} on={env.weather === w.value} onClick={() => (ui('select'), setEnv({ weather: w.value }))} />
            ))}
          </Row>
        </>
      ) : (
        <>
          <Row label="Landscape">
            {BIOMES.map((b) => (
              <Card key={b} small label={BIOME_LABEL[b]} swatch={BIOME_SWATCH[b]} on={env.biome === b} onClick={() => (ui('select'), setEnv({ biome: b }))} />
            ))}
            <Card small label="New hills" icon="sparkle" onClick={() => (ui('success'), setEnv({ seed: Math.floor(Math.random() * 999999) }))} />
          </Row>
          <p className="cc-tray-tip line">The hills change around your coaster. Your track stays exactly where it is.</p>
        </>
      )}
    </Tray>
  );
}

// ------------------------------------------------------------------ Ride

// The wide view first: it never starts inside the station building.
const WATCH: CameraMode[] = ['cinematic', 'follow', 'side', 'trackside'];

export function RideTray() {
  const camera = useGame((s) => s.camera);
  const playback = useGame((s) => s.playback);
  const watching = WATCH.includes(camera);
  return (
    <Tray label="Ride">
      <Row label="Ride">
        <Card
          label="Ride!"
          icon="play"
          accent
          on={camera === 'front'}
          onClick={() => {
            ui('success');
            // Put the sheet away so the ride fills the screen; the Ride button brings it back.
            useGame.setState({ camera: 'front', panel: 'none' });
            services.engine?.dispatch();
          }}
        />
        <Card
          label="Watch"
          icon="eye"
          on={watching}
          onClick={() => {
            ui('select');
            const next = WATCH[(WATCH.indexOf(camera) + 1) % WATCH.length]!;
            useGame.setState({ camera: next, panel: 'none' });
          }}
        />
        <Card label="Back seat" icon="train" on={camera === 'rear'} onClick={() => (ui('select'), useGame.setState({ camera: 'rear', panel: 'none' }))} />
        <Card label="Overview" icon="frame" on={camera === 'orbit'} onClick={() => (ui('select'), useGame.setState({ camera: 'orbit' }), services.engine?.frameCoaster())} />
        <Card label="To station" icon="reset" onClick={() => (ui('tap'), services.engine?.resetTrain())} />
        <Card label="Relax" icon="leaf" onClick={() => (ui('open'), useGame.setState({ overlay: 'relax', panel: 'none', camera: 'relax' }))} />
        <Card label="Photo" icon="camera" onClick={() => (ui('open'), useGame.setState({ overlay: 'photo', panel: 'none' }))} />
      </Row>
      <div className="cc-tray-actions">
        <div className="cc-pill-pair" role="group" aria-label="Speed">
          {[0.5, 1, 2].map((v) => (
            <button key={v} type="button" className={playback === v ? 'on' : ''} aria-pressed={playback === v} onClick={() => (ui('select'), useGame.setState({ playback: v }))}>
              {v === 0.5 ? 'Slow' : v === 1 ? 'Normal' : 'Fast'}
            </button>
          ))}
        </div>
      </div>
    </Tray>
  );
}

export { BIOME_LABEL };
