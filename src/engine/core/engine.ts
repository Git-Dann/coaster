import * as THREE from 'three';
import { FixedStepLoop } from './fixed-step';
import type { V3 } from './vec3';
import { BakedTrack, newSample } from '../track/bake';
import { withReturn } from '../track/auto-return';
import type { TrackDesign } from '../track/types';
import { TrackRenderer } from '../track/track-renderer';
import { TrainSim, type SimEvent } from '../physics/train-sim';
import { TrainModel } from '../train/train-model';
import { DEFAULT_PHYSICS, type PhysicsParams, type TrainConfig } from '../train/config';
import { generateSupports, TIMBER_STYLES, type Member } from '../supports/support-gen';
import { SupportRenderer } from '../supports/support-renderer';
import { TerrainManager } from '../terrain/terrain-manager';
import { WATER_LEVEL } from '../terrain/heightfield';
import { VegetationLayer, SceneryLayer } from '../environment/vegetation';
import { Atmosphere } from '../environment/atmosphere';
import { fromGrid, toGrid, type GridFrame } from '../track/grid';
import { Water } from '../environment/water';
import { WeatherParticles } from '../environment/weather';
import { Station } from '../environment/station';
import { CameraRig, type CameraMode } from '../camera/camera-rig';
import { GestureRecogniser } from '../input/gestures';
import { LEVELS, QualityController, TIER_INDEX } from '../performance/quality';
import { AudioEngine } from '../audio/audio-engine';
import { PainterlyPipeline, PAINTERLY_BY_LEVEL } from '../renderer/painterly';
import { FLEX_STEEL, FLEX_TIMBER, StructureFlex, makeFlexUniforms, syncFlexUniforms, type FlexUniforms } from '../physics/flex';
import type { EnvironmentState, SceneryItem, Settings, TerrainStroke } from '../../types/world';
import { TIME_HOURS } from '../../types/world';

export type PickResult =
  | { type: 'end' }
  | { type: 'height' }
  | { type: 'node'; id: string; index: number }
  | { type: 'track'; node: number }
  /** The automatic return to the station (built for the player, not a piece of theirs). */
  | { type: 'return' }
  | { type: 'ground'; point: V3 }
  | { type: 'none' };

export interface EngineCallbacks {
  onSimEvent(e: SimEvent): void;
  onHandleDrag(kind: 'plan' | 'height', phase: 'start' | 'move' | 'end' | 'cancel', data: { point?: V3; dyMetres?: number }): void;
  onTap(hit: PickResult): void;
  onContextLost(lost: boolean): void;
  /** Ground drag for brush tools (only when a brush tool is active). */
  onBrush?(point: V3, phase: 'start' | 'move' | 'end'): void;
}

export interface Diagnostics {
  fps: number;
  p50: number;
  p90: number;
  p99: number;
  cpuMs: number;
  simMs: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  chunks: number;
  supports: number;
  vegetation: number;
  workerQueue: number;
  voices: number;
  quality: string;
  pixelRatio: number;
  resolution: string;
  trackRegenerated: number;
}

export interface HandleState {
  end: V3 | null;
  dir: V3 | null;
  visible: boolean;
}

/** Finger-sized hit radius for the track-end ring (CSS pixels). */
const HANDLE_PX = 64;

/**
 * The game engine. Owns the renderer and a single requestAnimationFrame scheduler.
 * Simulation runs on a fixed 120 Hz step; rendering interpolates between steps.
 * Never stores per-frame data in React state.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly terrain: TerrainManager;
  readonly vegetation: VegetationLayer;
  readonly scenery: SceneryLayer;
  readonly atmosphere = new Atmosphere();
  readonly water = new Water();
  readonly weather = new WeatherParticles();
  readonly station = new Station();
  readonly trackRenderer = new TrackRenderer(false);
  readonly previewRenderer = new TrackRenderer(true);
  readonly supports = new SupportRenderer();
  readonly train = new TrainModel();
  readonly loop = new FixedStepLoop(1 / 120);
  readonly quality = new QualityController(2);
  readonly audio = new AudioEngine();
  readonly painterly: PainterlyPipeline;
  readonly flex = new StructureFlex();
  private readonly flexUniforms: FlexUniforms;
  sim: TrainSim;
  track: BakedTrack | null = null;
  design: TrackDesign | null = null;
  /** The player's design plus the automatic return: what is actually rendered and ridden. */
  ridden: TrackDesign | null = null;
  previewDesign: TrackDesign | null = null;
  previewTrack: BakedTrack | null = null;
  private gestures: GestureRecogniser;
  private canvas: HTMLCanvasElement;
  private cb: EngineCallbacks;
  private raf = 0;
  private last = 0;
  private elapsed = 0;
  private running = false;
  simPaused = false;
  buildMode = false;
  brushActive = false;
  private contextLost = false;
  private settings: Settings | null = null;
  private env: EnvironmentState;
  trainCfg: TrainConfig;
  private handles: HandleState = { end: null, dir: null, visible: false };
  private handleGroup = new THREE.Group();
  private endHandle: THREE.Mesh;
  private heightHandle: THREE.Group;
  private selection: THREE.Mesh;
  private drag: 'plan' | 'height' | 'brush' | null = null;
  private dragStartY = 0;
  private dragPlaneY = 0;
  private blockHash = new Map<string, number>();
  private blockRev = 0;
  private sceneryItems: readonly SceneryItem[] = [];
  private liftDistance = 0;
  private wheelDistance = 0;
  private frameTimes: number[] = [];
  private cpuMs = 0;
  private simMs = 0;
  private fpsCap = 0;
  private skipAcc = 0;
  private qualityTimer = 0;
  private adaptive = true;
  private velocity = new THREE.Vector3();
  private lastFocus = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly smp = newSample();
  private readonly tmp = new THREE.Vector3();
  private readonly bogies: Array<{ front: number; rear: number; centre: number }> = [];

  constructor(canvas: HTMLCanvasElement, init: { env: EnvironmentState; train: TrainConfig; design: TrackDesign; strokes: TerrainStroke[] }, cb: EngineCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    this.env = init.env;
    this.trainCfg = init.train;
    const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance', alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('webgl2-unavailable');
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    // Crisp maps; the painterly pass softens their edges into washes.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor('#dde6e8');

    this.flexUniforms = makeFlexUniforms(this.flex);
    this.trackRenderer.enableFlex(this.flexUniforms);
    this.supports.enableFlex(this.flexUniforms);
    this.painterly = new PainterlyPipeline(Math.max(1, canvas.width), Math.max(1, canvas.height));
    this.rig = new CameraRig(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.terrain = new TerrainManager(init.env.biome, init.env.seed, init.strokes);
    this.vegetation = new VegetationLayer(init.env.biome);
    this.scenery = new SceneryLayer(init.env.biome, this.vegetation.material);

    const s = this.scene;
    s.fog = this.atmosphere.fog;
    s.add(this.atmosphere.sky, this.atmosphere.sun, this.atmosphere.sun.target, this.atmosphere.hemi);
    s.add(this.terrain.group, this.vegetation.group, this.scenery.group, this.water.mesh);
    s.add(this.trackRenderer.mesh, this.previewRenderer.mesh, this.supports.group, this.train.group, this.station.group, this.ghostPole);
    s.add(this.weather.rain, this.weather.snow);

    // Construction handles.
    const handleMat = new THREE.MeshStandardMaterial({ color: '#F5EBDD', emissive: new THREE.Color('#E5C579'), emissiveIntensity: 0.35, roughness: 0.4 });
    this.endHandle = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.16, 12, 32), handleMat);
    const ring = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 12), handleMat);
    this.endHandle.add(ring);
    this.heightHandle = new THREE.Group();
    const arrowMat = new THREE.MeshStandardMaterial({ color: '#8DAABB', emissive: new THREE.Color('#8DAABB'), emissiveIntensity: 0.3, roughness: 0.5 });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 10).translate(0, 1.2, 0), arrowMat);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.7, 14).translate(0, 2.7, 0), arrowMat);
    const head2 = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.7, 14).rotateX(Math.PI).translate(0, -0.35, 0), arrowMat);
    this.heightHandle.add(shaft, head, head2);
    this.selection = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 10), new THREE.MeshStandardMaterial({ color: '#C77D62', emissive: new THREE.Color('#C77D62'), emissiveIntensity: 0.4, transparent: true, opacity: 0.8 }));
    this.selection.visible = false;
    this.handleGroup.add(this.endHandle, this.heightHandle);
    this.handleGroup.visible = false;
    s.add(this.handleGroup, this.selection);

    this.sim = new TrainSim(new BakedTrack(init.design), init.train, { ...DEFAULT_PHYSICS });
    this.train.configure(init.train);
    this.setDesign(init.design, false);
    this.atmosphere.setTarget({ hour: TIME_HOURS[init.env.time], weather: init.env.weather, biome: init.env.biome }, true);
    this.atmosphere.autoCycle = init.env.autoCycle;

    this.gestures = new GestureRecogniser(canvas, {
      dragStart: (x, y) => this.dragStart(x, y),
      dragMove: (x, y) => this.dragMove(x, y),
      dragEnd: (x, y, c) => this.dragEnd(x, y, c),
      tap: (x, y) => this.cb.onTap(this.pick(x, y)),
      hover: () => {},
      orbit: (dx, dy) => this.rig.orbitBy(dx, dy, this.canvas.clientHeight),
      pan: (dx, dy) => this.rig.panBy(dx, dy, this.canvas.clientHeight),
      zoom: (f) => this.rig.zoomBy(f),
      rotate: (da) => (this.rig.yaw += da),
      interact: () => {
        void this.audio.unlock();
        if (this.rig.mode === 'relax' && !(this.settings?.accessibility.disableAutoCamera ?? false)) {
          /* relax mode exits via UI, not by touching */
        }
      },
    });

    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resize();
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
    this.cb.onContextLost(true);
  };
  private onRestored = () => {
    this.contextLost = false;
    this.cb.onContextLost(false);
    // Three re-uploads resources lazily; force material recompiles.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
      else if (m) m.needsUpdate = true;
    });
  };
  private onVisibility = () => {
    if (document.hidden) {
      this.audio.suspend();
    } else {
      this.audio.resume();
      this.last = performance.now();
      this.loop.reset();
    }
  };

  start(): void {
    if (this.running) return;
    // Portrait phones open on a view that fits the whole starter coaster.
    if (this.canvas.clientWidth < this.canvas.clientHeight) this.frameCoaster();
    this.running = true;
    this.last = performance.now();
    const tick = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.applyPixelRatio();
    this.renderer.setSize(w, h, false);
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.painterly.setSize(db.x, db.y);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  private applyPixelRatio(): void {
    const lvl = LEVELS[this.quality.level]!;
    const res = this.settings?.graphics.resolution ?? 1;
    const pr = Math.min(window.devicePixelRatio || 1, lvl.pixelRatio) * res;
    this.renderer.setPixelRatio(Math.max(0.5, pr));
  }

  // ---------------------------------------------------------------- world state

  /** Commit a track design: rebake, regenerate supports and station, reset the train if needed. */
  setDesign(design: TrackDesign, animateSupports = true): void {
    const prevKey = this.design ? designKey(this.design) : '';
    this.design = design;
    const valid = design.nodes.length >= 2;
    // The ridden circuit always includes the automatic return, so the track is never disconnected.
    this.ridden = valid ? withReturn(design, { groundAt: (x, z) => this.terrain.heightAt(x, z), speed: estimateSpeed(design) }) : design;
    this.track = valid ? new BakedTrack(this.ridden) : null;
    this.trackRenderer.setColours(design.colours, design.style);
    this.previewRenderer.setColours(design.colours, design.style);
    this.trackRenderer.update(this.track, design.style);
    this.supports.setStyle(design.supportStyle, design.colours.support);
    // Material behaviour: timber structures flex more; wooden track rolls rougher.
    this.flex.profile = TIMBER_STYLES.has(design.supportStyle) ? FLEX_TIMBER : FLEX_STEEL;
    this.sim.trackRoughness = design.style === 'wood' ? 1.55 : design.style === 'mine' ? 1.3 : 1;
    this.refreshSupports(animateSupports);
    this.station.build(this.track, (x, z) => this.terrain.heightAt(x, z));
    if (this.track && designKey(design) !== prevKey) {
      this.sim.setTrack(this.track);
      this.loop.reset();
    }
    this.rebuildBlockers();
  }

  /** Show a translucent preview of proposed track (or clear it). Committed geometry is untouched. */
  /** The end of the piece the edit view is showing (new or selected), for checks and tests. */
  previewFocus: V3 | null = null;

  setPreview(design: TrackDesign | null, range?: { fromNode: number; toNode: number }): void {
    this.previewDesign = design;
    if (!design) this.previewFocus = null;
    if (!design || design.nodes.length < 2) {
      this.previewTrack = null;
      this.previewRenderer.update(null, 'tubular');
      this.ghostPole.visible = false;
      return;
    }
    this.previewTrack = new BakedTrack(design, 0.25);
    const committedNodes = this.design?.nodes.length ?? 0;
    // By default the ghost is whatever extends past the committed track; edit mode can instead
    // highlight a range of nodes (a selected piece, or a re-flowed section).
    const fromNode = range ? range.fromNode : committedNodes - 1;
    const toNode = range ? range.toNode : design.nodes.length - 1;
    const from = fromNode >= 0 ? (this.previewTrack.nodeS[fromNode] ?? 0) : 0;
    const to = this.previewTrack.nodeS[toNode] ?? Infinity;
    this.previewRenderer.update(this.previewTrack, design.style, from, toNode >= design.nodes.length - 1 ? Infinity : to);
    // A slim pole from the ghost's end down to the ground shows how high it will be.
    const end = design.nodes[Math.min(design.nodes.length - 1, Math.max(0, toNode))]!.p;
    const gy = this.terrain.heightAt(end[0], end[2]);
    const h = Math.max(0.05, end[1] - gy);
    this.ghostPole.position.set(end[0], gy + h / 2, end[2]);
    this.ghostPole.scale.set(1, h, 1);
    this.ghostPole.visible = true;
    // Supports stay as they are (the committed coaster's): the ghost floats until it is built.
  }

  private readonly groundAt = (x: number, z: number) => this.terrain.heightAt(x, z);
  private readonly watchState = { inStation: false, stationSide: 1, trackNear: (x: number, y: number, z: number) => this.trackNear(x, y, z) };
  private supportMembers: Member[] = [];

  /** What the watch cameras need to know this frame (no allocation). */
  private watchInfo(): { inStation: boolean; stationSide: number; trackNear: (x: number, y: number, z: number) => number | null } {
    const inStation = this.sim.state === 'hold' || this.sim.state === 'dispatch';
    // Arriving at the station: pick the side of the platform with a clear view of the train.
    if (inStation && !this.watchState.inStation) this.watchState.stationSide = this.clearStationSide();
    this.watchState.inStation = inStation;
    return this.watchState;
  }

  /** +1 or −1: which side of the train has no support or track between a low camera and the train. */
  private clearStationSide(): number {
    const m = this.train.leadMatrix;
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    const f = new THREE.Vector3(m.elements[0], 0, m.elements[2]).normalize();
    const side = new THREE.Vector3(-f.z, 0, f.x);
    const blocked = (sgn: number) => {
      let hits = 0;
      const cam = p.clone().addScaledVector(side, 9 * sgn).addScaledVector(f, -3).add(new THREE.Vector3(0, 2.2, 0));
      for (let k = 1; k < 10; k++) {
        const q = cam.clone().lerp(p, k / 10);
        for (const mem of this.supportMembers) {
          if (mem.kind === 'pad') continue;
          if (distToSegment(q, mem.a, mem.b) < mem.r + 0.5) hits++;
        }
        if (this.trackNear(q.x, q.y, q.z) !== null && k < 7) hits++;
      }
      return hits;
    };
    return blocked(1) <= blocked(-1) ? 1 : -1;
  }

  /** Height of the nearest track within a camera-sized space around a point, or null if clear. */
  private trackNear(x: number, y: number, z: number): number | null {
    const t = this.track;
    if (!t) return null;
    let best: number | null = null;
    let bd = Infinity;
    for (let i = 0; i < t.count; i += 4) {
      const dx = t.pos[i * 3]! - x;
      const dz = t.pos[i * 3 + 2]! - z;
      if (dx * dx + dz * dz > 3.5 * 3.5) continue;
      const dy = t.pos[i * 3 + 1]! - y;
      if (Math.abs(dy) > 4.5) continue;
      const d = dx * dx + dz * dz + dy * dy;
      if (d < bd) {
        bd = d;
        best = t.pos[i * 3 + 1]!;
      }
    }
    return best;
  }

  private gridLines: THREE.LineSegments | null = null;
  private readonly gridMat = new THREE.LineBasicMaterial({ color: '#FBF4E6', transparent: true, opacity: 0.5, depthWrite: false });

  /** Show the building grid on the ground around a point (edit mode only), or hide it. */
  setGrid(frame: GridFrame | null, centre?: V3): void {
    if (this.gridLines) {
      this.scene.remove(this.gridLines);
      this.gridLines.geometry.dispose();
      this.gridLines = null;
    }
    if (!frame || !centre) return;
    const { u, v } = toGrid(frame, centre[0], centre[2]);
    const cu = Math.round(u);
    const cv = Math.round(v);
    const N = 7;
    const seg = 4;
    const pts: number[] = [];
    const add = (u0: number, v0: number, u1: number, v1: number) => {
      for (let k = 0; k < seg; k++) {
        const a = fromGrid(frame, u0 + ((u1 - u0) * k) / seg, v0 + ((v1 - v0) * k) / seg);
        const b = fromGrid(frame, u0 + ((u1 - u0) * (k + 1)) / seg, v0 + ((v1 - v0) * (k + 1)) / seg);
        pts.push(a.x, this.terrain.heightAt(a.x, a.z) + 0.12, a.z, b.x, this.terrain.heightAt(b.x, b.z) + 0.12, b.z);
      }
    };
    for (let i = -N; i <= N; i++)
      for (let j = -N; j < N; j++) {
        add(cu + i, cv + j, cu + i, cv + j + 1);
        add(cu + j, cv + i, cu + j + 1, cv + i);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.gridLines = new THREE.LineSegments(geo, this.gridMat);
    this.gridLines.renderOrder = 1;
    this.scene.add(this.gridLines);
  }

  /** Hold the train in the station (edit mode), or let it run again. */
  holdTrain(hold: boolean): void {
    this.sim.autoDispatch = !hold;
    if (hold) this.resetTrain();
  }

  private readonly ghostPole = (() => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1, 8), new THREE.MeshBasicMaterial({ color: '#F2B98C', transparent: true, opacity: 0.75, depthWrite: false }));
    m.visible = false;
    m.renderOrder = 2;
    return m;
  })();

  private refreshSupports(animate: boolean): void {
    const d = this.ridden;
    const t = this.track;
    let members: Member[] = [];
    if (d && t) members = generateSupports(d, t, (x, z) => this.terrain.heightAt(x, z));
    this.supportMembers = members;
    this.supports.setMembers(members, animate);
  }

  setTrainConfig(cfg: TrainConfig): void {
    this.trainCfg = cfg;
    this.train.configure(cfg);
    const structural = cfg.cars !== this.sim.cfg.cars || cfg.style !== this.sim.cfg.style;
    this.sim.cfg = { ...cfg };
    if (structural) {
      // Only ever changed while parked: rebuild mass distribution and return to the station.
      this.sim.rebuildTrain();
      this.sim.resetToStation();
      this.loop.reset();
    }
  }

  setPhysics(p: Partial<PhysicsParams>, envPhysics: boolean): void {
    this.sim.params = { ...DEFAULT_PHYSICS, ...p };
    this.sim.envPhysics = envPhysics;
  }

  setEnvironment(env: EnvironmentState): void {
    const worldChanged = env.biome !== this.env.biome || env.seed !== this.env.seed;
    this.env = env;
    if (worldChanged) {
      this.terrain.setWorld(env.biome, env.seed);
      this.vegetation.setBiome(env.biome);
      this.scenery.setBiome(env.biome);
      this.scenery.rebuild(this.sceneryItems, (x, z) => this.terrain.heightAt(x, z));
      if (this.design) this.setDesign(this.design, false);
    }
    this.atmosphere.setTarget({ hour: TIME_HOURS[env.time], weather: env.weather, biome: env.biome }, false);
    this.atmosphere.autoCycle = env.autoCycle;
    // Gentle wind as an optional, documented approximation.
    const windy = env.weather === 'rain' ? 4 : env.weather === 'light-rain' ? 2.5 : env.weather === 'snow' ? 2 : 1.2;
    this.sim.params.windX = env.environmentalPhysics ? windy : 0;
    this.sim.params.windZ = env.environmentalPhysics ? windy * 0.4 : 0;
    this.sim.envPhysics = env.environmentalPhysics;
  }

  setScenery(items: readonly SceneryItem[]): void {
    this.sceneryItems = items;
    this.scenery.rebuild(items, (x, z) => this.terrain.heightAt(x, z));
    this.rebuildBlockers();
  }

  setTerrainEdits(strokes: TerrainStroke[]): void {
    this.terrain.setEdits(strokes);
    this.afterTerrainChange();
  }

  addTerrainStroke(s: TerrainStroke): void {
    this.terrain.addStroke(s);
    this.afterTerrainChange();
  }

  private afterTerrainChange(): void {
    // The return track re-routes over the new ground; supports re-anchor; scenery follows the surface.
    if (this.design) this.setDesign(this.design, true);
    this.refreshSupports(true);
    this.scenery.rebuild(this.sceneryItems, (x, z) => this.terrain.heightAt(x, z));
    this.blockRev++;
  }

  setSettings(s: Settings): void {
    this.settings = s;
    const tier = s.graphics.tier;
    this.adaptive = tier === 'auto';
    if (tier !== 'auto') this.quality.level = TIER_INDEX[tier];
    this.fpsCap = s.graphics.fpsCap;
    this.rig.reducedMotion = s.accessibility.reducedMotion;
    this.rig.stabilisation = s.accessibility.cameraStabilisation ? 0.85 : 0.25;
    this.supports.reducedMotion = s.accessibility.reducedMotion;
    this.audio.setVolumes(s.audio);
    this.applyQuality();
  }

  private applyQuality(): void {
    const lvl = LEVELS[this.quality.level]!;
    const g = this.settings?.graphics;
    const shadows = (g?.shadows ?? 'high') !== 'off' && lvl.shadows;
    this.renderer.shadowMap.enabled = shadows;
    this.atmosphere.sun.castShadow = shadows;
    const mapSize = g?.shadows === 'low' ? Math.min(1024, lvl.shadowMap) : lvl.shadowMap;
    this.atmosphere.setShadowQuality(mapSize, lvl.shadowExtent);
    this.vegetation.radius = lvl.vegRadius;
    this.vegetation.density = lvl.vegDensity * (g?.vegetation ?? 1);
    this.weather.density = lvl.weather * (g?.weatherDensity ?? 1);
    this.terrain.drawDistance = lvl.drawDistance * (g?.drawDistance ?? 1);
    // Keep atmospheric haze gentle even when a lower tier shortens the draw distance.
    this.atmosphere.baseFog = 1.25 / Math.max(this.terrain.drawDistance, 620);
    this.painterly.enabled = g?.postProcessing ?? true;
    this.painterly.apply(PAINTERLY_BY_LEVEL[this.quality.level]!);
    this.applyPixelRatio();
    this.resize();
  }

  setCameraMode(m: CameraMode): void {
    if (this.rig.mode !== 'orbit' && m === 'orbit') {
      const p = new THREE.Vector3().setFromMatrixPosition(this.train.leadMatrix);
      this.rig.syncOrbitFromCamera(this.rig.mode === 'relax' ? this.rig.target : p);
    }
    this.rig.setMode(m);
  }

  setHandles(h: HandleState): void {
    this.handles = h;
  }

  setSelection(p: V3 | null): void {
    this.selection.visible = !!p;
    if (p) this.selection.position.set(p[0], p[1], p[2]);
  }

  dispatch(): void {
    this.sim.dispatch();
  }

  resetTrain(): void {
    this.sim.resetToStation();
    this.loop.reset();
  }

  /** Screen space covered by the interface (top bar, build sheet, nav), in CSS pixels. */
  private insets = { top: 0, bottom: 0, left: 0, right: 0 };
  private appliedOffset = NaN;
  private appliedOffsetX = NaN;
  /**
   * Tell the camera which parts of the screen the controls cover. Overview cameras then centre
   * what they look at in the clear area between them, instead of behind the build sheet.
   */
  setViewInsets(top: number, bottom: number, left = 0, right = 0): void {
    const next = { top: Math.max(0, top), bottom: Math.max(0, bottom), left: Math.max(0, left), right: Math.max(0, right) };
    const old = this.insets;
    const moved = Math.abs(next.top - old.top) + Math.abs(next.bottom - old.bottom) + Math.abs(next.left - old.left) + Math.abs(next.right - old.right) > 24;
    this.insets = next;
    // A panel opened or closed after a piece was framed: fit it again to the new clear area.
    if (moved && this.lastFrame && this.buildMode) this.frameSphere(this.lastFrame.centre, this.lastFrame.radius, this.lastFrame.min);
  }

  private lastFrame: { centre: V3; radius: number; min: number } | null = null;

  /** Shift the projection so the camera's aim point sits in the middle of the clear area. */
  private applyViewOffset(): void {
    const cam = this.rig.camera;
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const overview = this.rig.mode === 'orbit' || this.rig.mode === 'relax';
    // Ease towards the target offset so opening or closing a sheet glides rather than jumps.
    const ty = overview ? Math.round((this.insets.bottom - this.insets.top) / 2) : 0;
    const tx = overview ? Math.round((this.insets.right - this.insets.left) / 2) : 0;
    const cy = Number.isFinite(this.appliedOffset) ? this.appliedOffset : ty;
    const cx = Number.isFinite(this.appliedOffsetX) ? this.appliedOffsetX : tx;
    const ny = Math.abs(ty - cy) < 0.5 ? ty : cy + (ty - cy) * 0.15;
    const nx = Math.abs(tx - cx) < 0.5 ? tx : cx + (tx - cx) * 0.15;
    if (ny === this.appliedOffset && nx === this.appliedOffsetX) return;
    this.appliedOffset = ny;
    this.appliedOffsetX = nx;
    if (Math.abs(ny) < 0.5 && Math.abs(nx) < 0.5) cam.clearViewOffset();
    else cam.setViewOffset(w, h, nx, ny, w, h);
  }

  /**
   * Glide the build camera so a sphere (a piece of track) fits in the clear part of the screen,
   * the area not covered by the panels: centred there, and far enough back that it all shows.
   */
  frameSphere(centre: V3, radius: number, minDistance = 30): void {
    this.lastFrame = { centre, radius, min: minDistance };
    if (this.rig.mode !== 'orbit') return;
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const margin = 28;
    const clearW = Math.max(80, w - this.insets.left - this.insets.right - margin * 2);
    const clearH = Math.max(80, h - this.insets.top - this.insets.bottom - margin * 2);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.rig.camera.fov) / 2);
    // Half-angles of the clear area, vertically and across.
    const half = Math.atan(Math.min(tanHalf * (clearH / h), tanHalf * (clearW / h)));
    const distance = THREE.MathUtils.clamp(radius / Math.sin(Math.max(0.05, half)), minDistance, 320);
    this.rig.focusOn(new THREE.Vector3(centre[0], centre[1], centre[2]), distance);
  }

  /** Smoothly move the build camera to look at a point, keeping the current zoom. */
  lookAt(p: V3, distance?: number): void {
    if (this.rig.mode !== 'orbit') return;
    if (distance) {
      this.rig.focusOn(new THREE.Vector3(p[0], p[1], p[2]), distance);
      return;
    }
    // The view offset centres the point in the clear area; keep a distance that shows the
    // surroundings without the newest piece becoming a speck.
    this.rig.focusOn(new THREE.Vector3(p[0], p[1], p[2]), THREE.MathUtils.clamp(this.rig.distance, 45, 85));
  }

  frameCoaster(): void {
    const t = this.track;
    if (!t) return;
    if (this.design && this.design.nodes.length <= 3 && !this.design.closed) {
      // A fresh coaster: look at the open end where building happens.
      const end = this.design.nodes[this.design.nodes.length - 1]!;
      const portrait = this.canvas.clientWidth < this.canvas.clientHeight;
      this.rig.focusOn(new THREE.Vector3(end.p[0], end.p[1], end.p[2]), portrait ? 52 : 42);
      this.rig.yaw = -0.9;
      this.rig.pitch = 0.36;
      return;
    }
    // Sample the circuit, find its centre and its long direction in plan view.
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < t.count; i += 8) pts.push(new THREE.Vector3(t.pos[i * 3]!, t.pos[i * 3 + 1]!, t.pos[i * 3 + 2]!));
    const box = new THREE.Box3().setFromPoints(pts);
    const c = box.getCenter(new THREE.Vector3());
    let sxx = 0;
    let szz = 0;
    let sxz = 0;
    for (const p of pts) {
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      sxx += dx * dx;
      szz += dz * dz;
      sxz += dx * dz;
    }
    const axis = 0.5 * Math.atan2(2 * sxz, sxx - szz); // angle of the long axis from +x
    const ux = Math.cos(axis);
    const uz = Math.sin(axis);
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const portrait = w < h;
    // Portrait screens are tall: look along the long axis so it runs up the screen. Wide screens
    // look across it. Of the two opposite views, keep the one nearest the current view.
    let yaw = Math.atan2(ux, uz) + (portrait ? 0 : Math.PI / 2);
    const near = (a: number) => Math.abs(Math.atan2(Math.sin(a - this.rig.yaw), Math.cos(a - this.rig.yaw)));
    if (near(yaw + Math.PI) < near(yaw)) yaw += Math.PI;
    const pitch = portrait ? 0.62 : Math.max(0.42, this.rig.pitch);
    // Find the closest distance at which every sampled point lands inside the clear area.
    const cam = this.rig.camera.clone();
    cam.aspect = w / h;
    const oy = Math.round((this.insets.bottom - this.insets.top) / 2);
    const ox = Math.round((this.insets.right - this.insets.left) / 2);
    if (oy || ox) cam.setViewOffset(w, h, ox, oy, w, h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    const m = Math.min(w, h) * 0.06;
    const left = this.insets.left + m;
    const right = w - this.insets.right - m;
    const top = this.insets.top + m;
    const bottom = h - this.insets.bottom - m;
    const v = new THREE.Vector3();
    const fits = (d: number) => {
      const cp = Math.cos(pitch);
      cam.position.set(c.x + Math.sin(yaw) * cp * d, c.y + Math.sin(pitch) * d, c.z + Math.cos(yaw) * cp * d);
      cam.up.set(0, 1, 0);
      cam.lookAt(c);
      cam.updateMatrixWorld();
      for (const p of pts) {
        v.copy(p).project(cam);
        const sx = ((v.x + 1) / 2) * w;
        const sy = ((1 - v.y) / 2) * h;
        if (v.z > 1 || sx < left || sx > right || sy < top || sy > bottom) return false;
      }
      return true;
    };
    let lo = 25;
    let hi = this.rig.maxDistance;
    if (fits(lo)) hi = lo;
    else for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    this.rig.yaw = yaw;
    this.rig.pitch = pitch;
    this.rig.focusOn(c, hi);
  }

  // ---------------------------------------------------------------- picking

  private project(p: V3, out: THREE.Vector2): boolean {
    this.tmp.set(p[0], p[1], p[2]).project(this.rig.camera);
    if (this.tmp.z > 1) return false;
    out.set(((this.tmp.x + 1) / 2) * this.canvas.clientWidth, ((1 - this.tmp.y) / 2) * this.canvas.clientHeight);
    return true;
  }

  private readonly scr = new THREE.Vector2();

  pick(x: number, y: number): PickResult {
    if (this.buildMode && this.handles.visible && this.handles.end) {
      const e = this.handles.end;
      if (this.project(e, this.scr) && this.scr.distanceTo({ x, y }) < HANDLE_PX) return { type: 'end' };
    }
    if (this.design && this.buildMode && this.track) {
      // Edit mode: tap anywhere along the track. The player's own track selects that piece; the
      // automatic return says what it is.
      const t = this.track;
      const userEnd = t.nodeS[this.design.nodes.length - 1] ?? 0;
      let bestS = -1;
      let bdist = 34;
      for (let i = 0; i < t.count; i += 4) {
        const s = i * t.ds;
        if (!this.project([t.pos[i * 3]!, t.pos[i * 3 + 1]!, t.pos[i * 3 + 2]!], this.scr)) continue;
        const dd = this.scr.distanceTo({ x, y });
        if (dd < bdist) {
          bdist = dd;
          bestS = s;
        }
      }
      if (bestS > userEnd + 0.5) return { type: 'return' };
      if (bestS >= 0) {
        let seg = 0;
        while (seg + 1 < t.nodeS.length && t.nodeS[seg + 1]! <= bestS) seg++;
        // Segment seg runs into node seg+1, which belongs to the piece that was tapped.
        return { type: 'track', node: Math.min(this.design.nodes.length - 1, seg + 1) };
      }
    }
    if (this.design && this.buildMode) {
      let best = -1;
      let bd = 30;
      this.design.nodes.forEach((n, i) => {
        if (this.project(n.p, this.scr)) {
          const d = this.scr.distanceTo({ x, y });
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      });
      if (best >= 0) return { type: 'node', id: this.design.nodes[best]!.id, index: best };
    }
    const g = this.groundPoint(x, y);
    return g ? { type: 'ground', point: g } : { type: 'none' };
  }

  /** Ray-march the terrain heightfield for the ground point under the cursor. */
  groundPoint(x: number, y: number): V3 | null {
    this.ndc.set((x / this.canvas.clientWidth) * 2 - 1, -(y / this.canvas.clientHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    const o = this.raycaster.ray.origin;
    const d = this.raycaster.ray.direction;
    let prevT = 0;
    let t = 0;
    for (let i = 0; i < 400; i++) {
      t += Math.max(0.5, t * 0.02);
      const px = o.x + d.x * t;
      const py = o.y + d.y * t;
      const pz = o.z + d.z * t;
      const h = Math.max(this.terrain.heightAt(px, pz), WATER_LEVEL);
      if (py <= h) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 12; k++) {
          const m = (lo + hi) / 2;
          const yy = o.y + d.y * m;
          if (yy <= Math.max(this.terrain.heightAt(o.x + d.x * m, o.z + d.z * m), WATER_LEVEL)) hi = m;
          else lo = m;
        }
        return [o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi];
      }
      prevT = t;
      if (t > 1500) break;
    }
    return null;
  }

  private dragStart(x: number, y: number): boolean {
    if (this.brushActive) {
      const g = this.groundPoint(x, y);
      if (g) {
        this.drag = 'brush';
        this.cb.onBrush?.(g, 'start');
        return true;
      }
      return false;
    }
    const hit = this.buildMode ? this.pick(x, y) : { type: 'none' as const };
    if (hit.type === 'end' || hit.type === 'height') {
      this.drag = hit.type === 'end' ? 'plan' : 'height';
      this.dragStartY = y;
      this.dragPlaneY = this.handles.end?.[1] ?? 0;
      this.cb.onHandleDrag(this.drag, 'start', {});
      return true;
    }
    return false;
  }

  private dragMove(x: number, y: number): void {
    if (this.drag === 'brush') {
      const g = this.groundPoint(x, y);
      if (g) this.cb.onBrush?.(g, 'move');
    } else if (this.drag === 'plan') {
      this.ndc.set((x / this.canvas.clientWidth) * 2 - 1, -(y / this.canvas.clientHeight) * 2 + 1);
      this.raycaster.setFromCamera(this.ndc, this.rig.camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.dragPlaneY);
      const p = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (p) this.cb.onHandleDrag('plan', 'move', { point: [p.x, p.y, p.z] });
    } else if (this.drag === 'height') {
      // Screen pixels → metres scaled by camera distance for consistent feel at any zoom.
      const dist = this.rig.camera.position.distanceTo(this.tmp.set(...(this.handles.end ?? [0, 0, 0])));
      const metresPerPx = (2 * Math.tan((this.rig.camera.fov * Math.PI) / 360) * dist) / this.canvas.clientHeight;
      this.cb.onHandleDrag('height', 'move', { dyMetres: (this.dragStartY - y) * metresPerPx });
    }
  }

  private dragEnd(x: number, y: number, cancelled: boolean): void {
    if (this.drag === 'brush') {
      const g = this.groundPoint(x, y);
      if (g) this.cb.onBrush?.(g, 'end');
    } else if (this.drag) this.cb.onHandleDrag(this.drag, cancelled ? 'cancel' : 'end', {});
    this.drag = null;
  }

  // ---------------------------------------------------------------- blockers (vegetation clearance)

  private rebuildBlockers(): void {
    const h = new Map<string, number>();
    const C = 4;
    const mark = (x: number, z: number, r: number) => {
      for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) for (let cz = Math.floor((z - r) / C); cz <= Math.floor((z + r) / C); cz++) h.set(`${cx},${cz}`, 1);
    };
    const t = this.track;
    if (t) for (let i = 0; i < t.count; i += 4) mark(t.pos[i * 3]!, t.pos[i * 3 + 2]!, 4);
    if (t) {
      const st = t.intervalsOf('station')[0];
      if (st) for (let s = st[0]; s < st[1]; s += 2) {
        t.sample(s, this.smp);
        mark(this.smp.pos[0], this.smp.pos[2], 7);
      }
    }
    for (const it of this.sceneryItems) mark(it.p[0], it.p[2], it.type === 'hut' ? 3 : 1);
    this.blockHash = h;
    this.blockRev++;
  }

  private blocked = (x: number, z: number, r: number): boolean => {
    const C = 4;
    const k = Math.max(0, Math.floor(r / C - 0.9));
    const cx = Math.floor(x / C);
    const cz = Math.floor(z / C);
    for (let dx = -k; dx <= k; dx++) for (let dz = -k; dz <= k; dz++) if (this.blockHash.has(`${cx + dx},${cz + dz}`)) return true;
    return false;
  };

  // ---------------------------------------------------------------- frame

  private frame(now: number): void {
    const dtReal = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    if (this.fpsCap > 0) {
      this.skipAcc += dtReal;
      if (this.skipAcc < 1 / this.fpsCap - 0.002) return;
    }
    const dt = this.fpsCap > 0 ? Math.min(0.25, this.skipAcc) : dtReal;
    this.skipAcc = 0;
    this.last = now;
    if (this.contextLost || document.hidden) return;
    const t0 = performance.now();
    this.elapsed += dt;

    // Simulation (fixed step; playback speed scales time, never forces).
    const ts = performance.now();
    if (!this.simPaused && this.track) {
      const tr = this.track;
      this.loop.advance(dt, (h) => {
        this.sim.step(h);
        this.flex.step(this.sim, tr, h);
      });
      while (this.sim.events.length) {
        const e = this.sim.events.shift()!;
        this.cb.onSimEvent(e);
      }
    } else this.loop.alpha = 1;
    this.simMs = performance.now() - ts;

    // Interpolated train placement.
    if (this.track) {
      const L = this.track.length;
      let delta = this.sim.s - this.sim.prevS;
      if (this.track.closed) {
        if (delta > L / 2) delta -= L;
        if (delta < -L / 2) delta += L;
      }
      const back = (1 - this.loop.alpha) * delta;
      this.bogies.length = 0;
      for (const c of this.sim.cars) {
        this.bogies.push({ front: this.track.wrap(c.front - back), rear: this.track.wrap(c.rear - back), centre: this.track.wrap(c.centre - back) });
      }
      this.wheelDistance += Math.abs(this.sim.v) * dt;
      this.train.group.visible = true;
      this.train.update(this.track, this.bogies, this.wheelDistance);
      this.flex.enabled = !(this.settings?.accessibility.reducedMotion ?? false);
      this.flex.update(this.sim, this.track, this.bogies, (x, z) => this.terrain.heightAt(x, z));
      syncFlexUniforms(this.flexUniforms, this.flex);
      const p = this.flex.profile;
      const calm = this.settings?.accessibility.disableShake ? 0 : 1;
      this.train.applyFlex((x, y, z, o) => this.flex.offsetAt(x, y, z, o), p.rattle * calm, p.rattleRoll * calm, this.wheelDistance, this.sim.v);
    } else this.train.group.visible = false;

    // Camera.
    this.rig.update(dt, this.train.leadMatrix, this.train.rearMatrix, this.sim.v, this.groundAt, this.watchInfo());
    this.applyViewOffset();
    const cam = this.rig.camera;
    const focus = this.rig.mode === 'orbit' || this.rig.mode === 'relax' ? this.rig.target : cam.position;
    this.velocity.subVectors(focus, this.lastFocus).divideScalar(Math.max(dt, 1e-3));
    this.lastFocus.copy(focus);

    // World streaming.
    this.terrain.update(cam.position, this.velocity);
    this.vegetation.update(cam.position, this.terrain.chunks.values(), this.terrain.vegetationRevision, this.blocked, this.blockRev);
    this.vegetation.uniforms.uTime.value = this.elapsed;
    const supportsMoving = this.supports.update(dt);

    // Atmosphere and weather.
    // Pulling far back to see a big coaster must not bury it in haze: thin the fog with distance.
    const viewDist = this.rig.mode === 'orbit' || this.rig.mode === 'relax' ? this.rig.distance * 3.2 : 0;
    this.atmosphere.baseFog = 1.25 / Math.max(this.terrain.drawDistance, 620, viewDist);
    this.atmosphere.update(dt, this.elapsed, focus);
    const st = this.atmosphere.state;
    this.vegetation.uniforms.uWind.value = 0.45 + st.rain * 0.5 + st.cloud * 0.2;
    this.terrain.setWetness(st.wet);
    this.water.update(this.elapsed, cam.position, st.night);
    this.weather.update(dt, this.elapsed, cam.position, st.rain, st.snow);
    this.station.setNight(st.night);
    this.scenery.setNight(st.night);
    this.renderer.setClearColor(this.atmosphere.fog.color);

    // Handles.
    const showHandles = this.buildMode && this.handles.visible && !!this.handles.end && this.rig.mode === 'orbit';
    this.handleGroup.visible = showHandles;
    if (showHandles && this.handles.end) {
      const e = this.handles.end;
      this.endHandle.position.set(e[0], e[1], e[2]);
      if (this.handles.dir) this.endHandle.lookAt(e[0] + this.handles.dir[0], e[1] + this.handles.dir[1], e[2] + this.handles.dir[2]);
      const pulse = 1 + Math.sin(this.elapsed * 3) * (this.settings?.accessibility.reducedMotion ? 0 : 0.06);
      this.endHandle.scale.setScalar(pulse);
      this.heightHandle.visible = false;
    }

    // Audio.
    this.updateAudio(dt, supportsMoving);

    this.painterly.render(this.renderer, this.scene, cam, this.elapsed, this.atmosphere.horizon, Math.max(this.terrain.drawDistance, 650, viewDist));

    // Performance bookkeeping.
    this.cpuMs = performance.now() - t0;
    this.frameTimes.push(dt * 1000);
    if (this.frameTimes.length > 240) this.frameTimes.shift();
    this.quality.push(dt * 1000);
    this.qualityTimer += dt;
    if (this.qualityTimer > 1) {
      if (this.quality.evaluate(this.qualityTimer, this.adaptive)) this.applyQuality();
      this.qualityTimer = 0;
    }
  }

  private updateAudio(dt: number, supportsMoving: boolean): void {
    if (!this.audio.unlocked) return;
    const material = this.design && TIMBER_STYLES.has(this.design.supportStyle) ? 'timber' : 'steel';
    this.audio.supportGrowth(supportsMoving && this.buildMode, material);
    const cam = this.rig.camera;
    const lead = this.tmp.setFromMatrixPosition(this.train.leadMatrix);
    const riding = this.rig.mode === 'front' || this.rig.mode === 'rear';
    const distance = riding ? 0 : cam.position.distanceTo(lead);
    // Stereo pan from the camera's right vector.
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const toTrain = lead.clone().sub(cam.position).normalize();
    const car0 = this.sim.cars[0];
    const braking = car0 && car0.section === 'brake' && Math.abs(this.sim.v) > 2 ? 1 : 0;
    this.audio.updateCoaster(
      {
        speed: this.sim.v,
        liftEngaged: this.sim.cars.some((c) => c.section === 'lift'),
        braking,
        launching: car0?.section === 'launch',
        material: this.design?.style === 'wood' || this.design?.style === 'mine' ? 'timber' : 'steel',
        distance,
        pan: riding ? 0 : Math.max(-1, Math.min(1, right.dot(toTrain))),
        riding,
        verticalG: this.sim.telemetry.gVert,
        inStation: car0?.section === 'station',
      },
      dt,
    );
    if (this.sim.cars.some((c) => c.section === 'lift') && this.sim.v > 0.1) {
      this.liftDistance += this.sim.v * dt;
      if (this.liftDistance > 0.42) {
        this.liftDistance = 0;
        this.audio.chainClack();
      }
    }
    const gx = cam.position.x;
    const gz = cam.position.z;
    const gh = this.terrain.heightAt(gx, gz);
    const rd = this.terrain.field.riverDistance(gx, gz);
    this.audio.updateEnvironment(
      {
        biome: this.env.biome,
        weather: this.env.weather,
        hour: this.atmosphere.hour,
        water: Math.max(0, 1 - rd / 70) * (cam.position.y - gh < 60 ? 1 : 0.4),
        cameraHeight: cam.position.y - gh,
      },
      dt,
    );
  }

  // ---------------------------------------------------------------- utilities

  diagnostics(): Diagnostics {
    const ft = [...this.frameTimes].sort((a, b) => a - b);
    const pct = (p: number) => (ft.length ? ft[Math.min(ft.length - 1, Math.floor(p * ft.length))]! : 0);
    const info = this.renderer.info;
    const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 16.7;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      fps: 1000 / avg,
      p50: pct(0.5),
      p90: pct(0.9),
      p99: pct(0.99),
      cpuMs: this.cpuMs,
      simMs: this.simMs,
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      chunks: this.terrain.chunks.size,
      supports: this.supports.instanceCount,
      vegetation: this.vegetation.instanceCount,
      workerQueue: this.terrain.queueLength,
      voices: this.audio.activeVoices(),
      quality: LEVELS[this.quality.level]!.name,
      pixelRatio: this.renderer.getPixelRatio(),
      resolution: `${size.x}×${size.y}`,
      trackRegenerated: this.trackRenderer.lastRegenerated,
    };
  }

  /** Render one frame and return it as a data URL (PNG or JPEG). */
  capture(type: 'image/png' | 'image/jpeg' = 'image/png', maxWidth = 0): string {
    this.painterly.render(this.renderer, this.scene, this.rig.camera, this.elapsed, this.atmosphere.horizon, this.terrain.drawDistance);
    const src = this.renderer.domElement;
    if (!maxWidth || src.width <= maxWidth) return src.toDataURL(type, 0.9);
    const c = document.createElement('canvas');
    c.width = maxWidth;
    c.height = Math.round((src.height / src.width) * maxWidth);
    c.getContext('2d')?.drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL(type, 0.78);
  }

  /** Terrain settled and supports finished animating; used by visual tests. */
  isIdle(): boolean {
    return this.terrain.isSettled() && !this.supports.growing;
  }

  dispose(): void {
    this.stop();
    this.gestures.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.terrain.dispose();
    this.vegetation.dispose();
    this.trackRenderer.dispose();
    this.previewRenderer.dispose();
    this.audio.dispose();
    this.painterly.dispose();
    this.renderer.dispose();
  }
}

/** Expected train speed at the end of the player's track, from the height it has fallen (with losses). */
function estimateSpeed(d: TrackDesign): number {
  let maxY = -Infinity;
  for (const n of d.nodes) maxY = Math.max(maxY, n.p[1]);
  const end = d.nodes[d.nodes.length - 1];
  const launch = Math.max(0, ...d.nodes.filter((n) => n.kind === 'launch').map((n) => n.param ?? 0));
  const fall = end ? maxY - end.p[1] : 0;
  return Math.min(24, Math.max(8, Math.sqrt(2 * 9.81 * Math.max(0, fall)) * 0.85, launch * 0.85));
}

/** Distance from a point to a segment a–b. */
function distToSegment(q: THREE.Vector3, a: readonly number[], b: readonly number[]): number {
  const abx = b[0]! - a[0]!;
  const aby = b[1]! - a[1]!;
  const abz = b[2]! - a[2]!;
  const len2 = abx * abx + aby * aby + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((q.x - a[0]!) * abx + (q.y - a[1]!) * aby + (q.z - a[2]!) * abz) / len2));
  return Math.hypot(q.x - (a[0]! + abx * t), q.y - (a[1]! + aby * t), q.z - (a[2]! + abz * t));
}

function designKey(d: TrackDesign): string {
  return `${d.closed}|${d.nodes.map((n) => `${n.id}:${n.p.map((v) => v.toFixed(3)).join(',')}:${n.dir.map((v) => v.toFixed(4)).join(',')}:${n.bank.toFixed(4)}:${n.kind}:${n.param ?? ''}`).join(';')}`;
}
