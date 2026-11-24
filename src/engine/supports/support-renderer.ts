import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Member, MemberKind } from './support-gen';
import { addPaintedVariation, SUPPORT_MATERIALS } from '../renderer/materials';
import type { SupportStyle } from '../track/types';

interface Live {
  m: Member;
  /** Current animated endpoints. */
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  /** 0..1 growth (new supports grow up out of the ground). */
  grow: number;
  removing: boolean;
}

const CAP = 12000;
const up = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();
const mid = new THREE.Vector3();
const q = new THREE.Quaternion();
const s = new THREE.Vector3();
const m4 = new THREE.Matrix4();
const bTmp = new THREE.Vector3();

/**
 * Instanced support structure with short, restrained growth animations (≈180 ms).
 * Members are keyed by stable ids: unchanged supports stay put, changed ones interpolate to their
 * new shape, new ones grow from the ground, removed ones sink away. No objects are created
 * per pointer move; only instance matrices are rewritten.
 */
export class SupportRenderer {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private meshes: Record<MemberKind, THREE.InstancedMesh>;
  private live = new Map<string, Live>();
  /** Time constant of the shape interpolation, seconds. */
  tau = 0.05;
  growing = false;
  reducedMotion = false;

  constructor() {
    this.material = addPaintedVariation(new THREE.MeshStandardMaterial({ color: '#F5EBDD', roughness: 0.6, metalness: 0.1 }), 0.05, 0.6);
    const tube = new THREE.CylinderGeometry(1, 1, 1, 10, 1).translate(0, 0.5, 0);
    const beam = new RoundedBoxGeometry(2, 1, 2, 1, 0.25).translate(0, 0.5, 0);
    const pad = new THREE.CylinderGeometry(1, 1.08, 1, 12, 1).translate(0, 0.5, 0);
    const mk = (g: THREE.BufferGeometry, name: string) => {
      const m = new THREE.InstancedMesh(g, this.material, CAP);
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.name = name;
      this.group.add(m);
      return m;
    };
    this.meshes = { tube: mk(tube, 'support-tubes'), beam: mk(beam, 'support-beams'), pad: mk(pad, 'support-pads') };
    this.meshes.pad.material = new THREE.MeshStandardMaterial({ color: '#CFC7B8', roughness: 0.95 });
    this.group.name = 'supports';
  }

  setStyle(style: SupportStyle, colour?: string): void {
    const def = SUPPORT_MATERIALS[style];
    this.material.color.set(colour ?? def.colour);
    this.material.roughness = def.roughness;
    this.material.metalness = def.metalness;
  }

  /** Set the target structure. `animate=false` snaps (used when loading). */
  setMembers(members: Member[], animate = true): void {
    const seen = new Set<string>();
    for (const m of members) {
      seen.add(m.key);
      const l = this.live.get(m.key);
      if (l) {
        l.m = m;
        l.removing = false;
      } else {
        const a = new THREE.Vector3(...m.a);
        // New members grow from their base.
        this.live.set(m.key, { m, a, b: animate ? a.clone() : new THREE.Vector3(...m.b), r: m.r, grow: animate ? 0 : 1, removing: false });
      }
    }
    for (const [k, l] of this.live) {
      if (seen.has(k)) continue;
      if (!animate || this.reducedMotion) this.live.delete(k);
      else l.removing = true;
    }
    if (!animate) this.snap();
  }

  private snap(): void {
    for (const l of this.live.values()) {
      l.a.set(...l.m.a);
      l.b.set(...l.m.b);
      l.grow = 1;
    }
    this.write();
  }

  /** Advance animations; returns true while anything is still moving. */
  update(dt: number): boolean {
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt / this.tau);
    let moving = false;
    for (const [key, l] of this.live) {
      if (l.removing) {
        // Sink back into the ground.
        l.b.lerp(l.a, k);
        if (l.b.distanceToSquared(l.a) < 0.01) this.live.delete(key);
        moving = true;
        continue;
      }
      const ta = l.m.a;
      const tb = l.m.b;
      const da = Math.abs(l.a.x - ta[0]) + Math.abs(l.a.y - ta[1]) + Math.abs(l.a.z - ta[2]);
      const db = Math.abs(l.b.x - tb[0]) + Math.abs(l.b.y - tb[1]) + Math.abs(l.b.z - tb[2]);
      if (da + db > 0.002) {
        l.a.lerp(bTmp.set(...ta), k);
        l.b.lerp(bTmp.set(...tb), k);
        moving = true;
      } else {
        l.a.set(...ta);
        l.b.set(...tb);
      }
    }
    this.write();
    this.growing = moving;
    return moving;
  }

  private write(): void {
    const counts: Record<MemberKind, number> = { tube: 0, beam: 0, pad: 0 };
    for (const l of this.live.values()) {
      const kind = l.m.kind;
      const n = counts[kind];
      if (n >= CAP) continue;
      dir.subVectors(l.b, l.a);
      const len = dir.length();
      if (len < 1e-3) continue;
      dir.divideScalar(len);
      q.setFromUnitVectors(up, dir);
      mid.copy(l.a);
      s.set(l.m.r, len, l.m.r);
      m4.compose(mid, q, s);
      this.meshes[kind].setMatrixAt(n, m4);
      counts[kind] = n + 1;
    }
    for (const kind of Object.keys(counts) as MemberKind[]) {
      this.meshes[kind].count = counts[kind];
      this.meshes[kind].instanceMatrix.needsUpdate = true;
    }
  }

  get instanceCount(): number {
    return this.live.size;
  }
}
