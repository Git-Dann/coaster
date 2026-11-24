import type { Engine, EngineCallbacks, PickResult } from '../engine/core/engine';
import type { SimEvent } from '../engine/physics/train-sim';
import type { V3 } from '../engine/core/vec3';
import { useGame } from '../stores/game';
import { checkPreview, makePreview, planDragToPiece, presetById } from '../features/builder/builder';
import { checkClose, closeCircuit, cloneDesign, removeLastNode, updateNode } from '../engine/track/design-ops';
import { TIMBER_STYLES } from '../engine/supports/support-gen';
import type { TrackDesign } from '../engine/track/types';
import { newItemId } from '../features/saves';
import { services, ui } from './services';

/** Build-mode sub-state that is not worth persisting. */
export const builder = {
  closing: null as TrackDesign | null,
  dragBase: 0,
  lastPreview: null as TrackDesign | null,
  brushStroke: 0,
};

const material = (d: TrackDesign) => (TIMBER_STYLES.has(d.supportStyle) ? 'timber' : 'steel');

const announce = (text: string) => {
  const el = document.getElementById('cc-live');
  if (el) el.textContent = text;
};

/** Engine callbacks, created before the engine exists. */
export function engineCallbacks(): EngineCallbacks {
  return {
    onSimEvent: (e: SimEvent) => onSimEvent(e),
    onHandleDrag: (kind, phase, data) => onHandleDrag(kind, phase, data),
    onTap: (hit) => onTap(hit),
    onContextLost: (lost) => {
      if (lost) useGame.getState().toast('Taking a short breather while the graphics reset…');
      else useGame.getState().toast('All set again.');
    },
    onBrush: (p, phase) => onBrush(p, phase),
  };
}

let stallShown = 0;
function onSimEvent(e: SimEvent): void {
  const g = useGame.getState();
  switch (e.type) {
    case 'stall':
      if (performance.now() - stallShown < 15000) return;
      stallShown = performance.now();
      g.toast('Your train ran out of energy and settled. A higher starting hill or a lift would carry it further.', {
        label: 'Back to station',
        run: () => services.engine?.resetTrain(),
      });
      announce('The train has stopped.');
      break;
    case 'end-of-track':
      g.toast('The train has paused before the end of the track. Keep building, or connect your circuit.', {
        label: 'Back to station',
        run: () => services.engine?.resetTrain(),
      });
      break;
    case 'numeric-error':
      g.toast('Something odd happened with this layout, so the train paused safely.', { label: 'Back to station', run: () => services.engine?.resetTrain() });
      break;
    case 'arrive':
      useGame.setState({ rideState: 'hold' });
      announce('The train is back in the station.');
      break;
    case 'dispatch':
      useGame.setState({ rideState: 'running' });
      break;
    default:
      break;
  }
}

function onHandleDrag(kind: 'plan' | 'height', phase: 'start' | 'move' | 'end' | 'cancel', data: { point?: V3; dyMetres?: number }): void {
  const g = useGame.getState();
  const d = g.design;
  const last = d.nodes[d.nodes.length - 1];
  if (!last) return;
  if (phase === 'start') {
    ui('select');
    if (kind === 'plan' && g.preset !== 'track') g.setPreset('track');
    const p = useGame.getState().params;
    const key = heightKey(useGame.getState().preset);
    builder.dragBase = key ? (p[key] ?? 0) : 0;
    useGame.setState({ previewActive: true });
    return;
  }
  if (phase === 'cancel') return;
  if (phase === 'end') {
    services.engine?.audio.build(material(d), 'preview-tick');
    return;
  }
  if (kind === 'plan' && data.point) {
    const r = planDragToPiece(last, data.point);
    useGame.setState({ params: { ...useGame.getState().params, length: r.length, turn: r.turn }, previewActive: true });
  } else if (kind === 'height' && data.dyMetres !== undefined) {
    const preset = useGame.getState().preset;
    const key = heightKey(preset);
    if (!key) return;
    const def = presetById(preset).params.find((p) => p.key === key)!;
    const v = Math.round((builder.dragBase + data.dyMetres) / def.step) * def.step;
    const clamped = Math.max(def.min, Math.min(def.max, v));
    if (clamped !== useGame.getState().params[key]) services.engine?.audio.build(material(d), 'preview-tick');
    useGame.setState({ params: { ...useGame.getState().params, [key]: clamped }, previewActive: true });
  }
}

function heightKey(preset: string): string | null {
  switch (preset) {
    case 'track':
      return 'rise';
    case 'lift':
    case 'hill':
    case 'loop':
    case 'immelmann':
    case 'diveloop':
      return 'height';
    case 'helix':
      return 'rise';
    case 'drop':
      return 'depth';
    default:
      return null;
  }
}

function onTap(hit: PickResult): void {
  const g = useGame.getState();
  if (g.panel === 'scenery' && g.sceneryTool && hit.type === 'ground') {
    const item = { id: newItemId('sc'), type: g.sceneryTool, p: hit.point, rot: Math.random() * Math.PI * 2, scale: 0.85 + Math.random() * 0.3 };
    g.setScenery([...g.scenery, item]);
    services.engine?.audio.build(item.type === 'rock' || item.type === 'lantern' ? 'steel' : 'timber', 'place');
    return;
  }
  if (g.panel === 'scenery' && !g.sceneryTool && !g.brush && hit.type === 'ground') {
    // Remove the nearest scenery item to a tap (eraser behaviour when no tool selected).
    let best = -1;
    let bd = 3;
    g.scenery.forEach((s, i) => {
      const d = Math.hypot(s.p[0] - hit.point[0], s.p[2] - hit.point[2]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (best >= 0) {
      g.setScenery(g.scenery.filter((_, i) => i !== best));
      services.engine?.audio.build('timber', 'delete');
    }
    return;
  }
  if (g.panel === 'build') {
    if (hit.type === 'node') {
      ui('select');
      useGame.setState({ selectedNode: hit.id, previewActive: false });
      const n = g.design.nodes[hit.index];
      services.engine?.setSelection(n ? n.p : null);
    } else if (hit.type === 'end') {
      useGame.setState({ selectedNode: null, previewActive: true });
      services.engine?.setSelection(null);
    } else {
      useGame.setState({ selectedNode: null });
      services.engine?.setSelection(null);
    }
  }
}

function onBrush(p: V3, phase: 'start' | 'move' | 'end'): void {
  const g = useGame.getState();
  if (!g.brush) return;
  const now = performance.now();
  if (phase === 'move' && now - builder.brushStroke < 70) return;
  builder.brushStroke = now;
  if (phase === 'start') {
    // One undo step per brush gesture.
    useGame.setState({ past: [...g.past, { design: g.design, scenery: g.scenery, terrainEdits: g.terrainEdits }].slice(-80), future: [] });
  }
  const r = g.brushRadius;
  const k = g.brushStrength;
  const ground = services.engine?.terrain.heightAt(p[0], p[2]) ?? p[1];
  const strength = g.brush === 'raise' ? 0.35 * k : g.brush === 'lower' ? 0.35 * k : g.brush === 'flatten' ? ground : g.brush === 'smooth' ? k : 1;
  const stroke = { mode: g.brush, x: p[0], z: p[2], radius: r, strength };
  g.addStroke(stroke);
  services.engine?.addTerrainStroke(stroke);
  if (phase === 'end') services.engine?.audio.build('timber', 'place');
}

// ------------------------------------------------------------------ builder actions

export function placePreview(): void {
  const g = useGame.getState();
  const prev = builder.lastPreview;
  if (!prev) return;
  const check = checkPreview(prev, g.design.nodes.length, (x, z) => services.engine?.terrain.heightAt(x, z) ?? 0);
  if (!check.ok) {
    ui('error-soft');
    g.toast(check.hint ?? 'That piece does not quite fit here.');
    return;
  }
  g.commitDesign(prev);
  services.engine?.audio.build(material(prev), 'place');
  useGame.setState({ previewSession: `p${Date.now().toString(36)}`, params: { ...presetById(g.preset).defaults } });
  announce(`${presetById(g.preset).label} placed.`);
  // Suggest connecting when the end comes back near the station.
  const c = checkClose(prev, (x, z) => services.engine?.terrain.heightAt(x, z) ?? 0);
  if (c.ok && c.distance < 40) {
    ui('success');
    g.toast('Your track is ready to connect.', { label: 'Connect', run: () => startConnect() });
  }
}

export function startConnect(): void {
  const g = useGame.getState();
  const c = checkClose(g.design, (x, z) => services.engine?.terrain.heightAt(x, z) ?? 0);
  if (!c.ok) {
    ui('error-soft');
    g.toast(c.reason ?? 'Not quite yet. Bring the track a little closer to the station.');
    return;
  }
  builder.closing = closeCircuit(g.design);
  useGame.setState({ previewActive: false, connecting: true, hint: 'Here is how the connection would look.' });
  services.engine?.setPreview(builder.closing);
}

export function confirmConnect(): void {
  const g = useGame.getState();
  if (!builder.closing) return;
  g.commitDesign(builder.closing);
  builder.closing = null;
  services.engine?.setPreview(null);
  useGame.setState({ hint: null, connecting: false });
  ui('circuit-complete');
  g.toast('Circuit complete! Your train is ready to ride.', { label: 'Take a ride', run: () => useGame.setState({ camera: 'front', panel: 'ride' }) });
  announce('Circuit complete.');
}

export function cancelConnect(): void {
  builder.closing = null;
  services.engine?.setPreview(null);
  useGame.setState({ hint: null, connecting: false, previewActive: true });
}

export function openCircuit(): void {
  const g = useGame.getState();
  if (!g.design.closed) return;
  g.commitDesign(removeLastNode(g.design));
  useGame.setState({ previewActive: true });
  services.engine?.audio.build(material(g.design), 'delete');
}

export function removeLast(): void {
  const g = useGame.getState();
  if (g.design.nodes.length <= 2) {
    g.toast('This is the station, so it stays.');
    return;
  }
  const d = cloneDesign(g.design);
  if (d.closed) {
    d.closed = false;
  } else {
    // Remove the last element: drop nodes back to the previous node that started an element (approximate: one node).
    d.nodes.pop();
    const end = d.nodes[d.nodes.length - 1]!;
    end.kind = 'track';
    end.param = undefined;
  }
  g.commitDesign(d);
  services.engine?.audio.build(material(d), 'delete');
}

export function nudgeSelected(field: 'height' | 'bank', delta: number): void {
  const g = useGame.getState();
  const id = g.selectedNode;
  if (!id) return;
  const n = g.design.nodes.find((x) => x.id === id);
  if (!n) return;
  const next = field === 'height' ? updateNode(g.design, id, { p: [n.p[0], Math.max(-10, Math.min(120, n.p[1] + delta)), n.p[2]] }) : updateNode(g.design, id, { bank: n.bank + (delta * Math.PI) / 180 });
  g.commitDesign(next);
  services.engine?.audio.build(material(next), 'snap');
  const moved = next.nodes.find((x) => x.id === id);
  services.engine?.setSelection(moved ? moved.p : null);
}

// ------------------------------------------------------------------ store → engine sync

/** Recompute the build preview and handles. Called whenever builder inputs change. */
export function refreshPreview(engine: Engine): void {
  const g = useGame.getState();
  const inBuild = g.panel === 'build';
  engine.buildMode = inBuild;
  if (builder.closing) return;
  if (!inBuild || !g.previewActive || g.design.closed || g.selectedNode) {
    builder.lastPreview = null;
    engine.setPreview(null);
    const last = g.design.nodes[g.design.nodes.length - 1];
    engine.setHandles({ end: !g.design.closed && last ? last.p : null, dir: last?.dir ?? null, visible: inBuild && !g.design.closed });
    useGame.setState({ hint: inBuild && g.design.closed ? null : g.hint && !g.previewActive ? null : g.hint });
    return;
  }
  const prev = makePreview(g.design, g.preset, g.params, g.autoBank, g.previewSession);
  builder.lastPreview = prev;
  engine.setPreview(prev);
  if (prev) {
    const end = prev.nodes[prev.nodes.length - 1]!;
    engine.setHandles({ end: end.p, dir: end.dir, visible: true });
    const check = checkPreview(prev, g.design.nodes.length, (x, z) => engine.terrain.heightAt(x, z));
    const hint = check.hint ?? null;
    if (hint !== useGame.getState().hint) useGame.setState({ hint });
  }
}

export function connectStore(engine: Engine): () => void {
  let prev = useGame.getState();
  engine.setSettings(prev.settings);
  services.haptics = prev.settings.accessibility.haptics;
  const unsub = useGame.subscribe((s) => {
    const p = prev;
    prev = s;
    if (s.worldRevision !== p.worldRevision) {
      engine.setEnvironment(s.env);
      engine.setTerrainEdits(s.terrainEdits);
      engine.setDesign(s.design, false);
      engine.setTrainConfig(s.train);
      engine.setPhysics(s.physics, s.env.environmentalPhysics);
      engine.setScenery(s.scenery);
      engine.frameCoaster();
    } else {
      if (s.env !== p.env) engine.setEnvironment(s.env);
      if (s.terrainEdits !== p.terrainEdits && s.terrainEdits.length < p.terrainEdits.length) engine.setTerrainEdits(s.terrainEdits);
      if (s.design !== p.design) engine.setDesign(s.design, true);
      if (s.train !== p.train) engine.setTrainConfig(s.train);
      if (s.physics !== p.physics) engine.setPhysics(s.physics, s.env.environmentalPhysics);
      if (s.scenery !== p.scenery) engine.setScenery(s.scenery);
    }
    if (s.settings !== p.settings) {
      engine.setSettings(s.settings);
      services.haptics = s.settings.accessibility.haptics;
    }
    if (s.camera !== p.camera) engine.setCameraMode(s.camera);
    if (s.simPaused !== p.simPaused) engine.simPaused = s.simPaused;
    if (s.playback !== p.playback) engine.loop.timeScale = s.playback;
    engine.brushActive = s.panel === 'scenery' && !!s.brush;
    if (
      s.design !== p.design ||
      s.panel !== p.panel ||
      s.preset !== p.preset ||
      s.params !== p.params ||
      s.previewActive !== p.previewActive ||
      s.autoBank !== p.autoBank ||
      s.selectedNode !== p.selectedNode
    ) {
      if (s.panel !== 'build' && builder.closing) cancelConnect();
      refreshPreview(engine);
    }
  });
  refreshPreview(engine);
  return unsub;
}
