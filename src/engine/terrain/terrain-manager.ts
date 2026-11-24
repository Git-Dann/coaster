import * as THREE from 'three';
import { CHUNK_SIZE, Heightfield, TerrainEdits } from './heightfield';
import { generateChunk, type ChunkData, type ChunkRequest } from './chunk-gen';
import { addPaintedVariation } from '../renderer/materials';
import type { Biome, TerrainStroke } from '../../types/world';

interface Chunk {
  cx: number;
  cz: number;
  lod: number;
  mesh: THREE.Mesh;
  vegetation: Float32Array;
  rev: number;
}

interface Pending {
  key: string;
  lod: number;
  rev: number;
}

type WorkerReply = { ok: true; data: ChunkData } | { ok: false; rev: number; cx: number; cz: number; error: string };

/** Distance thresholds (m) for each terrain LOD. */
const LOD_DIST = [200, 380, 620];

/**
 * Streams deterministic terrain chunks around the camera.
 * - Generation runs in a small worker pool with transferable buffers.
 * - Stale results (older revision / LOD no longer wanted) are rejected.
 * - Old meshes stay visible until replacements arrive, so there are no holes.
 * - GPU uploads are rate-limited per frame.
 * - Chunk meshes use chunk-local vertex positions so precision holds far from the origin.
 */
export class TerrainManager {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  field: Heightfield;
  edits: TerrainEdits;
  biome: Biome;
  seed: number;
  drawDistance = 640;
  /** Maximum chunk uploads per frame. */
  uploadBudget = 2;
  readonly chunks = new Map<string, Chunk>();
  private readonly pending = new Map<string, Pending>();
  private readonly queue: ChunkRequest[] = [];
  private readonly ready: ChunkData[] = [];
  private workers: Worker[] = [];
  private busy: boolean[] = [];
  private rev = 1;
  private readonly dirty = new Set<string>();
  /** Bumped whenever the set of vegetation-bearing chunks changes. */
  vegetationRevision = 0;
  workerFailures = 0;
  private wetness = 0;

  constructor(biome: Biome, seed: number, strokes: TerrainStroke[] = []) {
    this.biome = biome;
    this.seed = seed;
    this.edits = new TerrainEdits(strokes);
    this.field = new Heightfield(biome, seed);
    this.field.edits = this.edits;
    this.material = addPaintedVariation(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 }), 0.05, 0.12);
    const base = this.material.onBeforeCompile;
    // Rain darkens the ground slightly (wet look) via a uniform.
    const wet = { value: 0 };
    this.material.onBeforeCompile = (shader, r) => {
      base.call(this.material, shader, r);
      shader.uniforms.uWet = wet;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uWet;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.55, uWet);\ndiffuseColor.rgb *= 1.0 - 0.22 * uWet;');
    };
    this.wetUniform = wet;
    this.group.name = 'terrain';
    this.startWorkers();
  }

  private readonly wetUniform: { value: number };

  setWetness(w: number): void {
    this.wetness = w;
    this.wetUniform.value = w;
  }
  get wet(): number {
    return this.wetness;
  }

  private startWorkers(): void {
    if (typeof Worker === 'undefined') return;
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), { type: 'module' });
        const idx = i;
        w.onmessage = (ev: MessageEvent<WorkerReply>) => {
          this.busy[idx] = false;
          const msg = ev.data;
          if (msg.ok) this.ready.push(msg.data);
          else {
            this.workerFailures++;
            this.pending.delete(`${msg.cx},${msg.cz}`);
            console.warn('terrain worker error', msg.error);
          }
        };
        w.onerror = (e) => {
          this.workerFailures++;
          this.busy[idx] = false;
          console.warn('terrain worker failed; falling back to main thread', e.message);
        };
        this.workers.push(w);
        this.busy.push(false);
      } catch (e) {
        console.warn('Workers unavailable, generating terrain on the main thread', e);
      }
    }
  }

  /** Height at a world point including player edits. */
  heightAt(x: number, z: number): number {
    return this.field.height(x, z);
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 0.75;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }

  /** Change biome or seed: all chunks regenerate, old meshes stay until replaced. */
  setWorld(biome: Biome, seed: number): void {
    if (biome === this.biome && seed === this.seed) return;
    this.biome = biome;
    this.seed = seed;
    this.field = new Heightfield(biome, seed);
    this.field.edits = this.edits;
    this.rev++;
    for (const k of this.chunks.keys()) this.dirty.add(k);
  }

  setEdits(strokes: TerrainStroke[]): void {
    this.edits = new TerrainEdits(strokes);
    this.field.edits = this.edits;
    this.rev++;
    for (const k of this.chunks.keys()) this.dirty.add(k);
  }

  /** Add a brush stroke; only chunks it touches regenerate. */
  addStroke(s: TerrainStroke): void {
    this.edits.add(s);
    this.rev++;
    const S = CHUNK_SIZE;
    for (let cx = Math.floor((s.x - s.radius - 2) / S); cx <= Math.floor((s.x + s.radius + 2) / S); cx++)
      for (let cz = Math.floor((s.z - s.radius - 2) / S); cz <= Math.floor((s.z + s.radius + 2) / S); cz++) this.dirty.add(`${cx},${cz}`);
  }

  private request(cx: number, cz: number, lod: number, priority: number): void {
    const key = `${cx},${cz}`;
    const p = this.pending.get(key);
    if (p && p.lod === lod && p.rev === this.rev) return;
    const S = CHUNK_SIZE;
    const strokes = this.edits.query(cx * S - 2, cz * S - 2, (cx + 1) * S + 2, (cz + 1) * S + 2);
    const req: ChunkRequest = { cx, cz, lod, biome: this.biome, seed: this.seed, strokes, rev: this.rev };
    this.pending.set(key, { key, lod, rev: this.rev });
    (req as ChunkRequest & { pr: number }).pr = priority;
    // Replace any queued request for the same chunk.
    const qi = this.queue.findIndex((q) => q.cx === cx && q.cz === cz);
    if (qi >= 0) this.queue.splice(qi, 1);
    this.queue.push(req);
  }

  private pump(): void {
    if (this.queue.length === 0) return;
    this.queue.sort((a, b) => (a as ChunkRequest & { pr: number }).pr - (b as ChunkRequest & { pr: number }).pr);
    if (this.workers.length > 0 && this.workerFailures < 6) {
      for (let i = 0; i < this.workers.length && this.queue.length > 0; i++) {
        if (this.busy[i]) continue;
        const req = this.queue.shift()!;
        this.busy[i] = true;
        this.workers[i]!.postMessage(req);
      }
    } else {
      // Main-thread fallback: one chunk per frame keeps interaction responsive.
      const req = this.queue.shift()!;
      this.ready.push(generateChunk(req, this.fallbackField(req)));
    }
  }

  private fbField: Heightfield | null = null;
  private fallbackField(req: ChunkRequest): Heightfield {
    if (!this.fbField || this.fbField.biome !== req.biome || this.fbField.seed !== req.seed) this.fbField = new Heightfield(req.biome, req.seed);
    return this.fbField;
  }

  /** Stream chunks around a focus point; `heading` biases preloading in the direction of travel. */
  update(focus: THREE.Vector3, velocity: THREE.Vector3): void {
    const S = CHUNK_SIZE;
    const ahead = new THREE.Vector3(velocity.x, 0, velocity.z).multiplyScalar(2.5);
    const fx = focus.x + Math.max(-150, Math.min(150, ahead.x));
    const fz = focus.z + Math.max(-150, Math.min(150, ahead.z));
    const ccx = Math.floor(fx / S);
    const ccz = Math.floor(fz / S);
    const R = Math.ceil(this.drawDistance / S) + 1;
    const wanted = new Set<string>();
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        const mx = (cx + 0.5) * S;
        const mz = (cz + 0.5) * S;
        const d = Math.max(0, Math.hypot(mx - focus.x, mz - focus.z) - S * 0.7);
        if (d > this.drawDistance) continue;
        const lod = d < LOD_DIST[0]! ? 0 : d < LOD_DIST[1]! ? 1 : d < LOD_DIST[2]! ? 2 : 3;
        const key = `${cx},${cz}`;
        wanted.add(key);
        const have = this.chunks.get(key);
        if (!have || have.lod !== lod || this.dirty.has(key) || have.rev !== this.rev) this.request(cx, cz, lod, d + lod * 40 + (have ? 200 : 0));
      }
    }
    this.dirty.clear();
    // Unload chunks well outside the radius (hysteresis avoids thrash at the boundary).
    for (const [key, ch] of this.chunks) {
      if (wanted.has(key)) continue;
      const mx = (ch.cx + 0.5) * S;
      const mz = (ch.cz + 0.5) * S;
      if (Math.hypot(mx - focus.x, mz - focus.z) > this.drawDistance + S * 1.5) {
        this.group.remove(ch.mesh);
        ch.mesh.geometry.dispose();
        this.chunks.delete(key);
        if (ch.vegetation.length) this.vegetationRevision++;
      }
    }
    // Drop queued work for chunks no longer wanted.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i]!;
      if (!wanted.has(`${q.cx},${q.cz}`)) {
        this.queue.splice(i, 1);
        this.pending.delete(`${q.cx},${q.cz}`);
      }
    }
    this.pump();
    // Upload a bounded number of finished chunks.
    let uploads = 0;
    while (this.ready.length > 0 && uploads < this.uploadBudget) {
      const data = this.ready.shift()!;
      const key = `${data.cx},${data.cz}`;
      const p = this.pending.get(key);
      if (!p || p.rev !== data.rev || p.lod !== data.lod) continue; // stale
      this.pending.delete(key);
      this.install(data);
      uploads++;
    }
  }

  private install(data: ChunkData): void {
    const key = `${data.cx},${data.cz}`;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.index, 1));
    const S = CHUNK_SIZE;
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, data.minY, 0), new THREE.Vector3(S, data.maxY, S));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    let ch = this.chunks.get(key);
    if (ch) {
      ch.mesh.geometry.dispose();
      ch.mesh.geometry = geo;
      ch.lod = data.lod;
      ch.rev = data.rev;
      const hadVeg = ch.vegetation.length > 0;
      ch.vegetation = data.vegetation;
      if (hadVeg || data.vegetation.length) this.vegetationRevision++;
    } else {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(data.cx * S, 0, data.cz * S);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = `chunk ${key}`;
      this.group.add(mesh);
      ch = { cx: data.cx, cz: data.cz, lod: data.lod, mesh, vegetation: data.vegetation, rev: data.rev };
      this.chunks.set(key, ch);
      if (data.vegetation.length) this.vegetationRevision++;
    }
  }

  get queueLength(): number {
    return this.queue.length + this.pending.size;
  }

  /** True once every chunk near the focus has been generated at least once. */
  isSettled(): boolean {
    return this.queue.length === 0 && this.ready.length === 0 && this.pending.size === 0;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const ch of this.chunks.values()) ch.mesh.geometry.dispose();
    this.chunks.clear();
    this.material.dispose();
  }
}
