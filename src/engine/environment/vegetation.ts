import * as THREE from 'three';
import { BIOME_CONFIG } from '../terrain/heightfield';
import { VEG_STRIDE, VEG_TYPES, type VegType } from '../terrain/chunk-gen';
import type { Biome, SceneryItem, SceneryType } from '../../types/world';
import {
  benchGeometry,
  birchGeometry,
  bushGeometry,
  fenceGeometry,
  flowerGeometry,
  foliageMaterial,
  grassGeometry,
  hutGeometry,
  lanternGeometry,
  lanternGlowGeometry,
  oakGeometry,
  pineGeometry,
  rockGeometry,
  signGeometry,
} from './props';

const CAPACITY: Record<VegType, number> = { pine: 5000, oak: 3000, birch: 2000, bush: 4000, rock: 1500, flowers: 6000, grass: 9000 };
const CASTS: Record<VegType, boolean> = { pine: true, oak: true, birch: true, bush: false, rock: true, flowers: false, grass: false };
/** Ground cover is only drawn close to the camera. */
const RADIUS_SCALE: Record<VegType, number> = { pine: 1, oak: 1, birch: 1, bush: 0.6, rock: 0.8, flowers: 0.45, grass: 0.35 };

export type BlockedFn = (x: number, z: number, radius: number) => boolean;

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const col = new THREE.Color();

function vegGeometries(biome: Biome): Record<VegType, THREE.BufferGeometry> {
  const cfg = BIOME_CONFIG[biome];
  const f = new THREE.Color().setRGB(...cfg.foliage, THREE.SRGBColorSpace);
  const fa = new THREE.Color().setRGB(...cfg.foliageAlt, THREE.SRGBColorSpace);
  return {
    pine: pineGeometry(f, fa),
    oak: oakGeometry(f, fa),
    birch: birchGeometry(f, fa),
    bush: bushGeometry(f, fa),
    rock: rockGeometry(),
    flowers: flowerGeometry(),
    grass: grassGeometry(),
  };
}

/**
 * Procedural vegetation drawn with one InstancedMesh per type across all nearby chunks,
 * keeping draw calls constant regardless of how many chunks are loaded.
 */
export class VegetationLayer {
  readonly group = new THREE.Group();
  readonly uniforms = { uTime: { value: 0 }, uWind: { value: 0.6 } };
  readonly material: THREE.MeshStandardMaterial;
  meshes = {} as Record<VegType, THREE.InstancedMesh>;
  biome: Biome;
  radius = 260;
  density = 1;
  private lastFocus = new THREE.Vector3(1e9, 0, 0);
  private lastRev = -1;
  private lastBlockRev = -1;
  instanceCount = 0;

  constructor(biome: Biome) {
    this.biome = biome;
    this.material = foliageMaterial(this.uniforms);
    this.group.name = 'vegetation';
    this.build(biome);
  }

  private build(biome: Biome): void {
    for (const m of Object.values(this.meshes)) {
      this.group.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    const geos = vegGeometries(biome);
    for (const t of VEG_TYPES) {
      const mesh = new THREE.InstancedMesh(geos[t], this.material, CAPACITY[t]);
      mesh.count = 0;
      mesh.castShadow = CASTS[t];
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY[t] * 3), 3);
      mesh.name = `veg-${t}`;
      this.meshes[t] = mesh;
      this.group.add(mesh);
    }
    this.lastRev = -1;
  }

  setBiome(biome: Biome): void {
    if (biome === this.biome) return;
    this.biome = biome;
    this.build(biome);
  }

  /** Rebuild instance buffers when chunks or blockers change or the focus moves far enough. */
  update(focus: THREE.Vector3, chunks: Iterable<{ vegetation: Float32Array }>, chunkRev: number, blocked: BlockedFn, blockRev: number): void {
    if (chunkRev === this.lastRev && blockRev === this.lastBlockRev && focus.distanceToSquared(this.lastFocus) < 30 * 30) return;
    this.lastRev = chunkRev;
    this.lastBlockRev = blockRev;
    this.lastFocus.copy(focus);
    const counts: Record<VegType, number> = { pine: 0, oak: 0, birch: 0, bush: 0, rock: 0, flowers: 0, grass: 0 };
    const R = this.radius;
    for (const ch of chunks) {
      const v = ch.vegetation;
      for (let i = 0; i < v.length; i += VEG_STRIDE) {
        const type = VEG_TYPES[v[i]!]!;
        const x = v[i + 1]!;
        const y = v[i + 2]!;
        const z = v[i + 3]!;
        const tint = v[i + 6]!;
        const dx = x - focus.x;
        const dz = z - focus.z;
        const rr = R * RADIUS_SCALE[type];
        if (dx * dx + dz * dz > rr * rr) continue;
        // Density setting thins deterministically using the tint hash.
        if (tint > this.density) continue;
        const n = counts[type];
        if (n >= CAPACITY[type]) continue;
        const clearance = type === 'grass' || type === 'flowers' ? 1.2 : type === 'bush' || type === 'rock' ? 2.2 : 3.6;
        if (blocked(x, z, clearance)) continue;
        const s = v[i + 5]!;
        q.setFromAxisAngle(up, v[i + 4]!);
        m4.compose(pos.set(x, y, z), q, scl.set(s, s * (0.9 + tint * 0.2), s));
        const mesh = this.meshes[type];
        mesh.setMatrixAt(n, m4);
        const shade = 0.88 + tint * 0.24;
        col.setRGB(shade, shade * (0.97 + tint * 0.05), shade * 0.96);
        mesh.setColorAt(n, col);
        counts[type] = n + 1;
      }
    }
    this.instanceCount = 0;
    for (const t of VEG_TYPES) {
      const mesh = this.meshes[t];
      mesh.count = counts[t];
      this.instanceCount += counts[t];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of Object.values(this.meshes)) {
      m.geometry.dispose();
      m.dispose();
    }
    this.material.dispose();
  }
}

/** Player-placed scenery, one InstancedMesh per type. */
export class SceneryLayer {
  readonly group = new THREE.Group();
  private meshes = new Map<SceneryType, THREE.InstancedMesh>();
  private glow: THREE.InstancedMesh;
  readonly glowMaterial: THREE.MeshStandardMaterial;
  private readonly propMaterial: THREE.MeshStandardMaterial;
  private foliage: THREE.MeshStandardMaterial;
  private biome: Biome;
  static readonly CAP = 4000;

  constructor(biome: Biome, foliage: THREE.MeshStandardMaterial) {
    this.biome = biome;
    this.foliage = foliage;
    this.propMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    this.glowMaterial = new THREE.MeshStandardMaterial({ color: '#FFE2A8', emissive: new THREE.Color('#FFC873'), emissiveIntensity: 0.4, roughness: 0.6 });
    this.glow = new THREE.InstancedMesh(lanternGlowGeometry(), this.glowMaterial, 1000);
    this.glow.count = 0;
    this.glow.frustumCulled = false;
    this.group.add(this.glow);
    this.group.name = 'scenery';
    this.buildMeshes();
  }

  private buildMeshes(): void {
    for (const m of this.meshes.values()) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes.clear();
    const veg = vegGeometries(this.biome);
    const geos: Record<SceneryType, THREE.BufferGeometry> = {
      pine: veg.pine,
      oak: veg.oak,
      birch: veg.birch,
      bush: veg.bush,
      flowers: veg.flowers,
      rock: veg.rock,
      grass: veg.grass,
      bench: benchGeometry(),
      lantern: lanternGeometry(),
      fence: fenceGeometry(),
      sign: signGeometry(),
      hut: hutGeometry(),
    };
    for (const [t, g] of Object.entries(geos) as Array<[SceneryType, THREE.BufferGeometry]>) {
      const isVeg = t in veg;
      const mesh = new THREE.InstancedMesh(g, isVeg ? this.foliage : this.propMaterial, SceneryLayer.CAP);
      mesh.count = 0;
      mesh.castShadow = t !== 'flowers' && t !== 'grass';
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.meshes.set(t, mesh);
      this.group.add(mesh);
    }
  }

  setBiome(biome: Biome): void {
    if (biome === this.biome) return;
    this.biome = biome;
    this.buildMeshes();
  }

  setNight(night: number): void {
    this.glowMaterial.emissiveIntensity = 0.25 + night * 2.2;
  }

  rebuild(items: readonly SceneryItem[], heightAt: (x: number, z: number) => number): void {
    const counts = new Map<SceneryType, number>();
    let glow = 0;
    for (const it of items) {
      const mesh = this.meshes.get(it.type);
      if (!mesh) continue;
      const n = counts.get(it.type) ?? 0;
      if (n >= SceneryLayer.CAP) continue;
      const y = heightAt(it.p[0], it.p[2]);
      q.setFromAxisAngle(up, it.rot);
      m4.compose(pos.set(it.p[0], y, it.p[2]), q, scl.setScalar(it.scale));
      mesh.setMatrixAt(n, m4);
      counts.set(it.type, n + 1);
      if (it.type === 'lantern' && glow < 1000) this.glow.setMatrixAt(glow++, m4);
    }
    for (const [t, mesh] of this.meshes) {
      mesh.count = counts.get(t) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.glow.count = glow;
    this.glow.instanceMatrix.needsUpdate = true;
  }
}
