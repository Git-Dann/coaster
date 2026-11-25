import type { Engine, EngineCallbacks, PickResult } from '../engine/core/engine';
import type { SimEvent } from '../engine/physics/train-sim';
import type { V3 } from '../engine/core/vec3';
import { useGame } from '../stores/game';
import { planDragToPiece } from '../features/builder/builder';
import { addPiece, adjustPiece, clampParam, pieceById, planNext, removePiece, type BuildChoice, type NextPiece, type PieceId } from '../features/builder/simple-builder';
import { TIMBER_STYLES } from '../engine/supports/support-gen';
import type { TrackDesign } from '../engine/track/types';
import { newItemId } from '../features/saves';
import { services, ui } from './services';

const material = (d: TrackDesign) => (TIMBER_STYLES.has(d.supportStyle) ? 'timber' : 'steel');
const ground = (x: number, z: number) => services.engine?.terrain.heightAt(x, z) ?? 0;

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
    },
    onBrush: (p, phase) => onBrush(p, phase),
  };
}

let stallShown = 0;
function onSimEvent(e: SimEvent): void {
  const g = useGame.getState();
  switch (e.type) {
    case 'stall':
      if (performance.now() - stallShown < 20000) return;
      stallShown = performance.now();
      g.toast('The train ran out of puff. Add a Lift or a Launch to give it more energy.', { label: 'Back to station', run: () => services.engine?.resetTrain() });
      announce('The train has stopped.');
      break;
    case 'numeric-error':
      g.toast('The train paused safely. Taking it back to the station.');
      services.engine?.resetTrain();
      break;
    case 'arrive':
      announce('The train is back in the station.');
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ building

/** Tap a piece: it is added straight away and becomes the adjustable newest piece. */
export function tapPiece(id: PieceId): void {
  const g = useGame.getState();
  const r = addPiece(g.design, id, ground);
  g.commitDesign(r.design);
  useGame.setState({ active: r.active });
  services.engine?.audio.build(material(r.design), 'place');
  // Glide the view to where the new piece ends so you can see it appear.
  const end = r.design.nodes[r.design.nodes.length - 1];
  if (end) services.engine?.lookAt(end.p);
  announce(`${pieceById(id).label} added.`);
}

// ------------------------------------------------------------------ edit mode

let ghostPlan: NextPiece | null = null;
let ghostRaf = 0;

/**
 * Edit mode shows the next piece as a see-through ghost at the end of the track. Nothing changes
 * until "Add piece" commits it (one undo step).
 */
export function refreshGhost(): void {
  cancelAnimationFrame(ghostRaf);
  ghostRaf = requestAnimationFrame(() => {
    const g = useGame.getState();
    const e = services.engine;
    if (!e) return;
    if (g.panel !== 'build') {
      ghostPlan = null;
      e.setPreview(null);
      if (g.ghost) useGame.setState({ ghost: null });
      return;
    }
    try {
      ghostPlan = planNext(g.design, g.buildChoice, ground, e.track);
    } catch (err) {
      // Never let a planning problem break the game: just show no ghost for this choice.
      console.warn('Could not plan the next piece', err);
      ghostPlan = null;
    }
    if (!ghostPlan) {
      e.setPreview(null);
      useGame.setState({ ghost: null });
      return;
    }
    const nodes = ghostPlan.design.nodes;
    const end = nodes[nodes.length - 1]!;
    const from = nodes[ghostPlan.start - 1] ?? end;
    e.setPreview(ghostPlan.design);
    // The grid stays invisible: pieces snap to it, but players only see the ghost.
    // Keep both the end of the track and the ghost in view.
    // Close enough to read the ghost clearly, far enough to see the track around it.
    e.lookAt([(from.p[0] + end.p[0]) / 2, (from.p[1] + end.p[1]) / 2, (from.p[2] + end.p[2]) / 2], choiceDistance(g.buildChoice));
    useGame.setState({ ghost: { height: ghostPlan.height, atGround: ghostPlan.atGround, crossing: ghostPlan.crossing } });
  });
}

/** Camera distance for the edit view: specials are taller, so stand back a little. */
function choiceDistance(c: BuildChoice): number {
  return c.kind === 'special' ? 62 : 46;
}

/** Choose what the next piece will be (the ghost updates). */
export function chooseBuild(c: BuildChoice): void {
  ui('select');
  useGame.setState({ buildChoice: c });
}

/** Build the ghost piece. */
export function addGhost(): void {
  const g = useGame.getState();
  const plan = ghostPlan ?? planNext(g.design, g.buildChoice, ground, services.engine?.track);
  if (!plan) return;
  g.commitDesign(plan.design);
  services.engine?.audio.build(material(plan.design), 'place');
  announce('Piece added.');
}

let pending: Record<string, number> | null = null;
let follow = 0;
let raf = 0;
/** Adjust the newest piece. Batched to one rebuild per animation frame for smooth dragging. */
export function adjustActive(patch: Record<string, number>): void {
  pending = { ...(pending ?? {}), ...patch };
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const g = useGame.getState();
    const a = g.active;
    const p = pending;
    pending = null;
    if (!a || !p) return;
    const clamped: Record<string, number> = {};
    for (const [k, v] of Object.entries(p)) clamped[k] = clampParam(a.piece, k, v);
    const r = adjustPiece(g.design, a, clamped, ground);
    if (!r) {
      useGame.setState({ active: null });
      return;
    }
    // Adjusting the newest piece is part of the same construction step as adding it: no new undo entry.
    useGame.setState({ design: r.design, active: r.active });
    // Once the lever or size settles, glide the view so the newest piece stays in sight.
    window.clearTimeout(follow);
    follow = window.setTimeout(() => {
      const end = useGame.getState().design.nodes.at(-1);
      if (end) services.engine?.lookAt(end.p);
    }, 350);
  });
}

export function removeLast(): void {
  const g = useGame.getState();
  if (g.design.nodes.length <= 2) {
    g.toast('That is the station, so it stays.');
    return;
  }
  const next = removePiece(g.design);
  g.commitDesign(next);
  useGame.setState({ active: null });
  services.engine?.audio.build(material(next), 'delete');
  followEnd();
}

/** Glide the build view to the open end of the track (after removing, undoing or redoing). */
export function followEnd(): void {
  const g = useGame.getState();
  if (g.panel !== 'build' || g.camera !== 'orbit') return;
  const end = g.design.nodes.at(-1);
  if (end) services.engine?.lookAt(end.p);
}

/** Bigger / smaller for the newest piece. */
export function resizeActive(factor: number): void {
  const a = useGame.getState().active;
  if (!a) return;
  const key = pieceById(a.piece).sizeKey;
  if (!key) return;
  adjustActive({ [key]: (a.params[key] ?? 20) * factor });
  ui('slider');
}

function onHandleDrag(kind: 'plan' | 'height', phase: 'start' | 'move' | 'end' | 'cancel', data: { point?: V3; dyMetres?: number }): void {
  const g = useGame.getState();
  if (phase === 'start') {
    ui('select');
    // Dragging the end without an adjustable straight/turn piece starts a new straight one.
    const a = g.active;
    const steerable = a && pieceById(a.piece).preset === 'track' && g.design.nodes[g.design.nodes.length - 1]?.group === a.group;
    if (!steerable) tapPiece('straight');
    return;
  }
  if (phase !== 'move' || kind !== 'plan' || !data.point) return;
  const a = useGame.getState().active;
  if (!a) return;
  const cursor = useGame.getState().design.nodes[a.start - 1];
  if (!cursor) return;
  const r = planDragToPiece(cursor, data.point);
  adjustActive({ length: r.length, turn: r.turn });
}

function onTap(hit: PickResult): void {
  const g = useGame.getState();
  if (g.panel !== 'decorate' || hit.type !== 'ground') return;
  if (g.sceneryTool) {
    const item = { id: newItemId('sc'), type: g.sceneryTool, p: hit.point, rot: Math.random() * Math.PI * 2, scale: 0.85 + Math.random() * 0.3 };
    g.setScenery([...g.scenery, item]);
    services.engine?.audio.build(item.type === 'rock' || item.type === 'lantern' ? 'steel' : 'timber', 'place');
    return;
  }
  if (g.eraser) {
    let best = -1;
    let bd = 4;
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
  }
}

let brushAt = 0;
function onBrush(p: V3, phase: 'start' | 'move' | 'end'): void {
  const g = useGame.getState();
  if (!g.brush) return;
  const now = performance.now();
  if (phase === 'move' && now - brushAt < 70) return;
  brushAt = now;
  if (phase === 'start') {
    // One undo step per brush gesture.
    useGame.setState({ past: [...g.past, { design: g.design, scenery: g.scenery, terrainEdits: g.terrainEdits }].slice(-80), future: [] });
  }
  const r = g.brushRadius;
  const k = g.brushStrength;
  const h = services.engine?.terrain.heightAt(p[0], p[2]) ?? p[1];
  const strength = g.brush === 'raise' || g.brush === 'lower' ? 0.35 * k : g.brush === 'flatten' ? h : g.brush === 'smooth' ? k : 1;
  const stroke = { mode: g.brush, x: p[0], z: p[2], radius: r, strength };
  g.addStroke(stroke);
  services.engine?.addTerrainStroke(stroke);
  if (phase === 'end') services.engine?.audio.build('timber', 'place');
}

// ------------------------------------------------------------------ store → engine sync

function syncHandles(engine: Engine): void {
  const g = useGame.getState();
  const building = g.panel === 'build';
  engine.buildMode = building;
  const last = g.design.nodes[g.design.nodes.length - 1];
  // Edit mode uses the ghost and the construction panel; the old drag ring stays hidden.
  engine.setHandles({ end: building && last ? last.p : null, dir: last?.dir ?? null, visible: false });
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
      engine.audio.setMusicEnabled(s.settings.audio.music > 0.01 && !s.settings.audio.muted);
    }
    if (s.camera !== p.camera) engine.setCameraMode(s.camera);
    if (s.playback !== p.playback) engine.loop.timeScale = s.playback;
    engine.brushActive = s.panel === 'decorate' && !!s.brush;
    if (s.design !== p.design || s.panel !== p.panel) syncHandles(engine);
    // Edit mode: the train waits in the station, and the ghost follows every change.
    if (s.panel !== p.panel && (s.panel === 'build' || p.panel === 'build')) engine.holdTrain(s.panel === 'build');
    if (s.panel === 'build' || p.panel === 'build') if (s.design !== p.design || s.panel !== p.panel || s.buildChoice !== p.buildChoice) refreshGhost();
  });
  syncHandles(engine);
  return unsub;
}
