import * as THREE from 'three';
import { FixedStepLoop } from './fixed-step';
import type { V3 } from './vec3';
import { BakedTrack, newSample } from '../track/bake';
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
import { Water } from '../environment/water';
import { WeatherParticles } from '../environment/weather';
import { Station } from '../environment/station';
import { CameraRig, type CameraMode } from '../camera/camera-rig';
import { GestureRecogniser } from '../input/gestures';
import { LEVELS, QualityController, TIER_INDEX } from '../performance/quality';
import { AudioEngine } from '../audio/audio-engine';
import type { EnvironmentState, SceneryItem, Settings, TerrainStroke } from '../../types/world';
import { TIME_HOURS } from '../../types/world';

export type PickResult =
  | { type: 'end' }
  | { type: 'height' }
  | { type: 'node'; id: string; index: number }
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

const HANDLE_PX = 42;

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
  sim: TrainSim;
  track: BakedTrack | null = null;
  design: TrackDesign | null = null;
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
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor('#dde6e8');

    this.rig = new CameraRig(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.terrain = new TerrainManager(init.env.biome, init.env.seed, init.strokes);
    this.vegetation = new VegetationLayer(init.env.biome);
    this.scenery = new SceneryLayer(init.env.biome, this.vegetation.material);

    const s = this.scene;
    s.fog = this.atmosphere.fog;
    s.add(this.atmosphere.sky, this.atmosphere.sun, this.atmosphere.sun.target, this.atmosphere.hemi);
    s.add(this.terrain.group, this.vegetation.group, this.scenery.group, this.water.mesh);
    s.add(this.trackRenderer.mesh, this.previewRenderer.mesh, this.supports.group, this.train.group, this.station.group);
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
    this.track = valid ? new BakedTrack(design) : null;
    this.trackRenderer.setColours(design.colours, design.style);
    this.previewRenderer.setColours(design.colours, design.style);
    this.trackRenderer.update(this.track, design.style);
    this.supports.setStyle(design.supportStyle, design.colours.support);
    if (!this.previewDesign) this.refreshSupports(animateSupports);
    this.station.build(this.track, (x, z) => this.terrain.heightAt(x, z));
    if (this.track && designKey(design) !== prevKey) {
      this.sim.setTrack(this.track);
      this.loop.reset();
    }
    this.rebuildBlockers();
  }

  /** Show a translucent preview of proposed track (or clear it). Committed geometry is untouched. */
  setPreview(design: TrackDesign | null): void {
    this.previewDesign = design;
    if (!design || design.nodes.length < 2) {
      this.previewTrack = null;
      this.previewRenderer.update(null, 'tubular');
      this.refreshSupports(true);
      return;
    }
    this.previewTrack = new BakedTrack(design, 0.25);
    const committedNodes = this.design?.nodes.length ?? 0;
    const from = committedNodes >= 1 && committedNodes <= design.nodes.length ? this.previewTrack.nodeS[Math.max(0, committedNodes - 1)] ?? 0 : 0;
    this.previewRenderer.update(this.previewTrack, design.style, design.closed && !this.design?.closed ? from : from);
    this.refreshSupports(true);
  }

  private refreshSupports(animate: boolean): void {
    const d = this.previewDesign ?? this.design;
    const t = this.previewDesign ? this.previewTrack : this.track;
    let members: Member[] = [];
    if (d && t) members = generateSupports(d, t, (x, z) => this.terrain.heightAt(x, z));
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
      this.refreshSupports(false);
      if (this.track) this.station.build(this.track, (x, z) => this.terrain.heightAt(x, z));
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
    // Supports re-anchor to the new ground; scenery follows the surface.
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
    this.atmosphere.baseFog = 1.45 / this.terrain.drawDistance;
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

  frameCoaster(): void {
    const t = this.track;
    if (!t) return;
    if (this.design && this.design.nodes.length <= 3 && !this.design.closed) {
      // A fresh coaster: look at the open end where building happens.
      const end = this.design.nodes[this.design.nodes.length - 1]!;
      // Aim a little below the end so the handles sit in the upper-middle, clear of the build sheet.
      const portrait = this.canvas.clientWidth < this.canvas.clientHeight;
      this.rig.focusOn(new THREE.Vector3(end.p[0], end.p[1] - (portrait ? 11 : 4), end.p[2]), portrait ? 48 : 40);
      this.rig.yaw = -0.9;
      this.rig.pitch = 0.36;
      return;
    }
    const box = new THREE.Box3();
    for (let i = 0; i < t.count; i += 8) box.expandByPoint(this.tmp.set(t.pos[i * 3]!, t.pos[i * 3 + 1]!, t.pos[i * 3 + 2]!));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.rig.focusOn(c, Math.max(30, size * 0.85));
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
      if (this.project([e[0], e[1] + 3.2, e[2]], this.scr) && this.scr.distanceTo({ x, y }) < HANDLE_PX) return { type: 'height' };
      if (this.project(e, this.scr) && this.scr.distanceTo({ x, y }) < HANDLE_PX) return { type: 'end' };
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
      this.loop.advance(dt, (h) => this.sim.step(h));
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
    } else this.train.group.visible = false;

    // Camera.
    this.rig.update(dt, this.train.leadMatrix, this.train.rearMatrix, this.sim.v, (x, z) => this.terrain.heightAt(x, z));
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
      this.heightHandle.position.set(e[0], e[1] + 1.6, e[2]);
    }

    // Audio.
    this.updateAudio(dt, supportsMoving);

    this.renderer.render(this.scene, cam);

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
    this.renderer.render(this.scene, this.rig.camera);
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
    this.renderer.dispose();
  }
}

function designKey(d: TrackDesign): string {
  return `${d.closed}|${d.nodes.map((n) => `${n.id}:${n.p.map((v) => v.toFixed(3)).join(',')}:${n.dir.map((v) => v.toFixed(4)).join(',')}:${n.bank.toFixed(4)}:${n.kind}:${n.param ?? ''}`).join(';')}`;
}
