import { create } from 'zustand';
import type { TrackDesign } from '../engine/track/types';
import type { PhysicsParams, TrainConfig } from '../engine/train/config';
import type { CameraMode } from '../engine/camera/camera-rig';
import type { EnvironmentState, SaveData, SceneryItem, SceneryType, Settings, TerrainBrush, TerrainStroke } from '../types/world';
import { CURRENT_SCHEMA } from '../types/world';
import { cloneDesign } from '../engine/track/design-ops';
import { defaultSettings, defaultTrain, DEFAULT_ENVIRONMENT, newSaveId } from '../features/saves';
import { starterPlayable } from '../engine/track/starter';
import { freshCoaster, type ActivePiece } from '../features/builder/simple-builder';
import { PAD_HEIGHT } from '../engine/terrain/heightfield';
import type { PresetId } from '../features/builder/builder';
import { presetById } from '../features/builder/builder';

export type Panel = 'none' | 'build' | 'decorate' | 'paint' | 'sky' | 'ride';
export type Overlay = 'none' | 'menu' | 'settings' | 'saves' | 'welcome' | 'photo' | 'relax' | 'about';

interface Snapshot {
  design: TrackDesign;
  scenery: SceneryItem[];
  terrainEdits: TerrainStroke[];
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

export interface GameState {
  saveId: string;
  saveName: string;
  coasterName: string;
  created: number;
  design: TrackDesign;
  train: TrainConfig;
  physics: Partial<PhysicsParams>;
  env: EnvironmentState;
  scenery: SceneryItem[];
  terrainEdits: TerrainStroke[];
  settings: Settings;

  past: Snapshot[];
  future: Snapshot[];

  panel: Panel;
  overlay: Overlay;
  camera: CameraMode;
  toasts: Toast[];
  saveStatus: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  rideState: string;
  simPaused: boolean;
  playback: number;

  // Builder
  preset: PresetId;
  params: Record<string, number>;
  autoBank: boolean;
  previewActive: boolean;
  previewSession: string;
  hint: string | null;
  connecting: boolean;
  /** True when a previous park was restored on launch (welcome says Continue). */
  returning: boolean;
  /** The newest piece, adjustable until another is added. */
  active: ActivePiece | null;
  /** Decorate mode eraser. */
  eraser: boolean;
  /** Paint mode sub-tab. */
  paintTab: 'track' | 'supports' | 'train';
  /** Bottom sheet minimised to a compact strip so the world stays reachable. */
  sheetCompact: boolean;
  selectedNode: string | null;
  sceneryTool: SceneryType | null;
  brush: TerrainBrush | null;
  brushRadius: number;
  brushStrength: number;
  /** Bumped when the world should be re-sent to the engine wholesale (load / new). */
  worldRevision: number;
}

export interface GameActions {
  set: (p: Partial<GameState>) => void;
  commitDesign: (d: TrackDesign, label?: string) => void;
  setScenery: (items: SceneryItem[]) => void;
  addStroke: (s: TerrainStroke) => void;
  undo: () => void;
  redo: () => void;
  setTrain: (t: Partial<TrainConfig>) => void;
  setEnv: (e: Partial<EnvironmentState>) => void;
  setSettings: (fn: (s: Settings) => Settings) => void;
  setPreset: (p: PresetId) => void;
  setParam: (k: string, v: number) => void;
  toast: (text: string, action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
  loadSave: (s: SaveData) => void;
  newWorld: (opts?: { blank?: boolean; biome?: EnvironmentState['biome']; seed?: number }) => void;
  toSave: (thumbnail?: string) => SaveData;
}

const HISTORY = 80;
let toastId = 0;

/** A blank coaster: a lone station waiting for track. */
export function blankDesign(base: TrackDesign): TrackDesign {
  return {
    ...base,
    closed: false,
    nodes: [
      { id: 'b0', p: [0, PAD_HEIGHT + 1, 0], dir: [1, 0, 0], bank: 0, kind: 'station' },
      { id: 'b1', p: [20, PAD_HEIGHT + 1, 0], dir: [1, 0, 0], bank: 0, kind: 'track' },
    ],
  };
}

const starter = () => starterPlayable(PAD_HEIGHT + 1);

export const useGame = create<GameState & GameActions>()((set, get) => ({
  saveId: newSaveId(),
  saveName: 'Meadow park',
  coasterName: 'Bramble Flyer',
  created: Date.now(),
  design: starter(),
  train: defaultTrain(),
  physics: {},
  env: { ...DEFAULT_ENVIRONMENT },
  scenery: [],
  terrainEdits: [],
  settings: defaultSettings(),
  past: [],
  future: [],
  panel: 'none',
  overlay: 'welcome',
  camera: 'orbit',
  toasts: [],
  saveStatus: 'idle',
  rideState: 'hold',
  simPaused: false,
  playback: 1,
  preset: 'track',
  params: { ...presetById('track').defaults },
  autoBank: true,
  previewActive: false,
  previewSession: 'p0',
  hint: null,
  connecting: false,
  returning: false,
  active: null,
  eraser: false,
  paintTab: 'track',
  sheetCompact: false,
  selectedNode: null,
  sceneryTool: null,
  brush: null,
  brushRadius: 8,
  brushStrength: 1,
  worldRevision: 0,

  set: (p) => set(p),

  commitDesign: (d) => {
    const s = get();
    const snap: Snapshot = { design: s.design, scenery: s.scenery, terrainEdits: s.terrainEdits };
    set({ design: cloneDesign(d), past: [...s.past.slice(-HISTORY + 1), snap], future: [] });
  },
  setScenery: (items) => {
    const s = get();
    set({ scenery: items, past: [...s.past.slice(-HISTORY + 1), { design: s.design, scenery: s.scenery, terrainEdits: s.terrainEdits }], future: [] });
  },
  addStroke: (stroke) => {
    // Strokes during one drag are grouped by the caller; here each call appends.
    set({ terrainEdits: [...get().terrainEdits, stroke] });
  },
  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({
      ...prev,
      past: s.past.slice(0, -1),
      future: [{ design: s.design, scenery: s.scenery, terrainEdits: s.terrainEdits }, ...s.future].slice(0, HISTORY),
      previewActive: false,
      selectedNode: null,
      active: null,
    });
  },
  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({
      ...next,
      future: s.future.slice(1),
      past: [...s.past, { design: s.design, scenery: s.scenery, terrainEdits: s.terrainEdits }].slice(-HISTORY),
      previewActive: false,
      selectedNode: null,
      active: null,
    });
  },
  setTrain: (t) => set({ train: { ...get().train, ...t, colours: { ...get().train.colours, ...(t.colours ?? {}) } } }),
  setEnv: (e) => set({ env: { ...get().env, ...e } }),
  setSettings: (fn) => set({ settings: fn(get().settings) }),
  setPreset: (p) => set({ preset: p, params: { ...presetById(p).defaults }, previewActive: true, previewSession: `p${Date.now().toString(36)}` }),
  setParam: (k, v) => set({ params: { ...get().params, [k]: v }, previewActive: true }),
  toast: (text, action) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.filter((t) => t.text !== text).slice(-2), { id, text, action }] });
    setTimeout(() => get().dismissToast(id), action ? 9000 : 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  loadSave: (sv) =>
    set({
      saveId: sv.id,
      saveName: sv.name,
      coasterName: sv.coasterName,
      created: sv.created,
      design: sv.track,
      train: sv.train,
      physics: sv.physics,
      env: sv.environment,
      scenery: sv.scenery,
      terrainEdits: sv.terrainEdits,
      past: [],
      future: [],
      previewActive: false,
      selectedNode: null,
      worldRevision: get().worldRevision + 1,
    }),
  newWorld: (opts) => {
    const s = get();
    const base = starter();
    set({
      saveId: newSaveId(),
      saveName: opts?.blank ? 'New park' : 'Meadow park',
      coasterName: opts?.blank ? 'New coaster' : 'Bramble Flyer',
      created: Date.now(),
      design: opts?.blank ? freshCoaster(base, PAD_HEIGHT + 1, () => PAD_HEIGHT + 0.5) : base,
      active: null,
      train: defaultTrain(),
      physics: {},
      env: { ...s.env, biome: opts?.biome ?? s.env.biome, seed: opts?.seed ?? s.env.seed },
      scenery: [],
      terrainEdits: [],
      past: [],
      future: [],
      previewActive: false,
      selectedNode: null,
      worldRevision: s.worldRevision + 1,
    });
  },
  toSave: (thumbnail) => {
    const s = get();
    return {
      schema: CURRENT_SCHEMA as 1,
      id: s.saveId,
      name: s.saveName,
      created: s.created,
      updated: Date.now(),
      coasterName: s.coasterName,
      environment: s.env,
      track: s.design,
      train: s.train,
      physics: s.physics,
      scenery: s.scenery,
      terrainEdits: s.terrainEdits,
      thumbnail,
    };
  },
}));
