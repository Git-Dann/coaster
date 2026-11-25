import type { Engine, EngineCallbacks, PickResult } from '../engine/core/engine';
import type { SimEvent } from '../engine/physics/train-sim';
import type { V3 } from '../engine/core/vec3';
import { useGame } from '../stores/game';
import { planDragToPiece } from '../features/builder/builder';
import { SPECIALS, addPiece, adjustPiece, clampParam, pieceById, piecesOf, planNext, removePiece, replacePiece, type BuildChoice, type NextPiece, type PieceId, type Slope, type Turn } from '../features/builder/simple-builder';
import { gridFrame } from '../engine/track/grid';
import type { PieceSound } from '../engine/audio/sounds';
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
/** Has the player picked a new choice since selecting the piece? (Older pieces have no choice to compare.) */
let selTouched = false;
let pendingEdit: { design: TrackDesign; index: number } | null = null;
let ghostRaf = 0;

const sameChoice = (a: BuildChoice | null, b: BuildChoice) => !!a && JSON.stringify(a) === JSON.stringify(b);

/**
 * Edit mode shows the next piece (or the change to a selected piece) as a see-through ghost.
 * Nothing changes until "Add piece" or "Apply" commits it (one undo step).
 */
export function refreshGhost(): void {
  cancelAnimationFrame(ghostRaf);
  ghostRaf = requestAnimationFrame(() => {
    const g = useGame.getState();
    const e = services.engine;
    if (!e) return;
    if (g.panel !== 'build') {
      ghostPlan = null;
      pendingEdit = null;
      e.setPreview(null);
      e.setGrid(null);
      if (g.ghost || g.editSel) useGame.setState({ ghost: null, editSel: null });
      return;
    }
    try {
      const pieces = piecesOf(g.design);
      const k = g.editSel ? pieces.findIndex((p) => p.group === g.editSel) : -1;
      if (g.editSel && k < 0) {
        useGame.setState({ editSel: null });
        return;
      }
      if (k >= 0) {
        // Editing a selected piece.
        const piece = pieces[k]!;
        const base: TrackDesign = { ...g.design, nodes: g.design.nodes.slice(0, piece.start) };
        const down = g.buildChoice.kind === 'track' ? planNext(base, { ...g.buildChoice, slope: -1 }, ground, e.track) : null;
        const changed = piece.choice ? !sameChoice(piece.choice, g.buildChoice) : selTouched;
        ghostPlan = null;
        let height = 0;
        let crossing: NextPiece['crossing'] = null;
        let atGround = false;
        let dropped = 0;
        let blocked: string | null = null;
        if (changed) {
          const r = replacePiece(g.design, piece.group, g.buildChoice, ground, e.track);
          const first = planNext(base, g.buildChoice, ground, e.track);
          pendingEdit = { design: r.design, index: k };
          dropped = r.dropped;
          height = first.height;
          crossing = first.crossing;
          atGround = first.atGround;
          blocked = first.blocked;
          e.setPreview(r.design, { fromNode: r.start - 1, toNode: r.design.nodes.length - 1 });
        } else {
          pendingEdit = null;
          const endNode = g.design.nodes[piece.end]!;
          height = endNode.p[1] - ground(endNode.p[0], endNode.p[2]);
          e.setPreview(g.design, { fromNode: piece.start - 1, toNode: piece.end });
        }
        const at = g.design.nodes[piece.end]!.p;
        e.setGrid(gridFrame(g.design), at);
        const from = g.design.nodes[Math.max(0, piece.start - 1)]!.p;
        e.lookAt([(from[0] + at[0]) / 2, (from[1] + at[1]) / 2, (from[2] + at[2]) / 2], choiceDistance(g.buildChoice));
        useGame.setState({ ghost: { height, atGround, crossing, downBlocked: !!down?.atGround, changed, dropped, forChoice: JSON.stringify(g.buildChoice), blocked } });
        return;
      }
      // Adding to the end.
      pendingEdit = null;
      ghostPlan = planNext(g.design, g.buildChoice, ground, e.track);
      const down = g.buildChoice.kind === 'track' ? planNext(g.design, { ...g.buildChoice, slope: -1 }, ground, e.track) : null;
      const nodes = ghostPlan.design.nodes;
      const end = nodes[nodes.length - 1]!;
      const from = nodes[ghostPlan.start - 1] ?? end;
      e.setPreview(ghostPlan.design);
      e.setGrid(gridFrame(ghostPlan.design), end.p);
      e.lookAt([(from.p[0] + end.p[0]) / 2, (from.p[1] + end.p[1]) / 2, (from.p[2] + end.p[2]) / 2], choiceDistance(g.buildChoice));
      useGame.setState({ ghost: { height: ghostPlan.height, atGround: ghostPlan.atGround, crossing: ghostPlan.crossing, downBlocked: !!down?.atGround, changed: true, dropped: 0, forChoice: JSON.stringify(g.buildChoice), blocked: ghostPlan.blocked } });
    } catch (err) {
      // Never let a planning problem break the game: just show no ghost for this choice.
      console.warn('Could not plan the piece', err);
      ghostPlan = null;
      pendingEdit = null;
      e.setPreview(null);
      useGame.setState({ ghost: null });
    }
  });
}

let availToken = 0;
/**
 * Work out which options fit smoothly where you're building, a few per frame so the panel stays
 * responsive. Options that don't fit are hidden; a chosen option that stops fitting moves to one
 * that does.
 */
export function refreshAvailability(): void {
  const token = ++availToken;
  const g0 = useGame.getState();
  if (g0.panel !== 'build') return;
  const pieces = piecesOf(g0.design);
  const sel = g0.editSel ? pieces.find((p) => p.group === g0.editSel) : null;
  const base: TrackDesign = sel ? { ...g0.design, nodes: g0.design.nodes.slice(0, sel.start) } : g0.design;
  const jobs: Array<() => void> = [];
  const specials: PieceId[] = [];
  const track: Record<string, boolean> = {};
  const committed = services.engine?.track;
  const needSpeed: string[] = [];
  const needHeight: string[] = [];
  let trackSpeed = false;
  // Plain track first (the default choice), then the specials.
  for (const slope of [0, 1, -1] as const)
    for (const turn of [0, -1, 1] as const)
      jobs.push(() => {
        const p = planNext(base, { kind: 'track', turn, slope }, ground, committed);
        const ok = !p.blocked && !(slope === -1 && p.atGround);
        track[`${turn},${slope}`] = ok;
        if (!ok && p.blocked && /speed/.test(p.blocked)) trackSpeed = true;
      });
  for (const id of SPECIALS) jobs.push(() => {
    const b = planNext(base, { kind: 'special', id }, ground, committed).blocked;
    if (!b) specials.push(id);
    else if (/speed/.test(b)) needSpeed.push(pieceById(id).label);
    else if (/height/.test(b)) needHeight.push(pieceById(id).label);
  });
  const step = () => {
    if (token !== availToken) return; // the track changed again: start over
    const t0 = performance.now();
    while (jobs.length && performance.now() - t0 < 12) {
      try {
        jobs.shift()!();
      } catch {
        /* an option that can't even be planned simply isn't offered */
      }
    }
    if (jobs.length) {
      requestAnimationFrame(step);
      return;
    }
    const g = useGame.getState();
    const c = g.buildChoice;
    const anyTrack = Object.values(track).some(Boolean);
    const stillOk = c.kind === 'special' ? specials.includes(c.id) : track[`${c.turn},${c.slope}`] !== false;
    // If the current choice doesn't fit, pick something that does: same direction, then any track, then a special.
    let next: BuildChoice | null = null;
    if (!stillOk) {
      const turn = c.kind === 'track' ? c.turn : 0;
      const k = [`${turn},0`, `${turn},1`, `${turn},-1`, ...Object.keys(track)].find((key) => track[key]);
      if (k) {
        const [t, sl] = k.split(',').map(Number) as [Turn, Slope];
        next = { kind: 'track', turn: t, slope: sl };
      } else if (specials.length) next = { kind: 'special', id: specials[0]! };
    }
    const list = (a: string[]) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a[0]);
    const note =
      !anyTrack && trackSpeed && specials.length
        ? 'The train leaves the station slowly: start with a Lift or a Launch to give it speed'
        : !anyTrack && !specials.length
          ? 'Nothing fits here. Remove the last piece, or change an earlier one'
          : needSpeed.length
            ? `${list(needSpeed)} ${needSpeed.length > 1 ? 'need' : 'needs'} more speed: add a Lift or a Launch first`
            : needHeight.length
              ? `${list(needHeight)} ${needHeight.length > 1 ? 'need' : 'needs'} some height first: add a Lift`
              : null;
    useGame.setState({ avail: { specials, track, note }, ...(next ? { buildChoice: next } : {}) });
  };
  requestAnimationFrame(step);
}

/** Camera distance for the edit view: specials are taller, so stand back a little. */
function choiceDistance(c: BuildChoice): number {
  return c.kind === 'special' ? 62 : 46;
}

/** Choose what the next (or selected) piece will be; the ghost updates. */
export function chooseBuild(c: BuildChoice): void {
  ui('select');
  selTouched = true;
  useGame.setState({ buildChoice: c });
}

/** Build the ghost piece, or apply the change to the selected piece. */
export function addGhost(): void {
  const g = useGame.getState();
  if (g.editSel) {
    if (!pendingEdit || g.ghost?.blocked) return;
    const { design, index } = pendingEdit;
    g.commitDesign(design);
    // Keep the same position selected (the changed piece has a new name).
    useGame.setState({ editSel: piecesOf(design)[index]?.group ?? null });
    services.engine?.audio.piece(pieceSound(g.buildChoice));
    announce('Piece changed.');
    return;
  }
  // Always plan against the track as it is now (memoised, so this is the ghost's own plan when it is
  // up to date), so a quick second tap never commits a plan made for the previous track.
  const plan = planNext(g.design, g.buildChoice, ground, services.engine?.track);
  if (plan.blocked) return; // never build anything rough
  g.commitDesign(plan.design);
  services.engine?.audio.piece(pieceSound(g.buildChoice));
  announce('Piece added.');
}

/** What a piece sounds like as it's added: ratchet for climbs, whoosh for drops, and so on. */
function pieceSound(c: BuildChoice): PieceSound {
  if (c.kind === 'track') return c.slope > 0 ? 'ratchet' : c.slope < 0 ? 'whoosh' : 'track';
  switch (c.id) {
    case 'lift':
      return 'ratchet';
    case 'drop':
    case 'hill':
      return 'whoosh';
    case 'brakes':
      return 'hiss';
    case 'launch':
      return 'launch';
    default:
      return 'loop';
  }
}

/** Remove the selected piece; the pieces after it move up to close the gap. */
export function removeSelected(): void {
  const g = useGame.getState();
  if (!g.editSel) return removeLast();
  const pieces = piecesOf(g.design);
  const k = pieces.findIndex((p) => p.group === g.editSel);
  if (k < 0) return;
  const r = replacePiece(g.design, g.editSel, null, ground, services.engine?.track);
  g.commitDesign(r.design);
  const next = piecesOf(r.design)[k];
  useGame.setState({ editSel: next?.group ?? null, buildChoice: next?.choice ?? g.buildChoice });
  services.engine?.audio.build(material(r.design), 'delete');
  announce(r.dropped ? `Piece removed, with ${r.dropped} older pieces after it.` : 'Piece removed.');
}

/** Select a piece to edit (or null to go back to adding at the end). */
export function selectPiece(group: string | null): void {
  ui('select');
  selTouched = false;
  const piece = group ? piecesOf(useGame.getState().design).find((p) => p.group === group) : null;
  useGame.setState({ editSel: piece ? piece.group : null, ...(piece?.choice ? { buildChoice: piece.choice } : {}) });
}

/** Step the selection to the previous or next piece (like the arrows in a park builder). */
export function stepSelection(dir: -1 | 1): void {
  const g = useGame.getState();
  const pieces = piecesOf(g.design);
  if (!pieces.length) return;
  const k = g.editSel ? pieces.findIndex((p) => p.group === g.editSel) : pieces.length;
  const next = k + dir;
  selectPiece(next >= 0 && next < pieces.length ? pieces[next]!.group : null);
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
  if (g.panel === 'build') {
    // Edit mode: tap your track to select a piece; tap the station or open ground to go back to the end.
    if (hit.type === 'track') {
      const group = g.design.nodes[hit.node]?.group;
      selectPiece(group && group !== 'station' ? group : null);
    } else if (hit.type === 'ground' && g.editSel) selectPiece(null);
    return;
  }
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
    if (s.panel === 'build' || p.panel === 'build') if (s.design !== p.design || s.panel !== p.panel || s.buildChoice !== p.buildChoice || s.editSel !== p.editSel) refreshGhost();
    if (s.panel === 'build' && (s.design !== p.design || s.panel !== p.panel || s.editSel !== p.editSel)) refreshAvailability();
  });
  syncHandles(engine);
  return unsub;
}
