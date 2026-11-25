import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BakedTrack, newSample } from '../track/bake';
import { CAR_PROFILES, type CarStyle, type TrainConfig } from './config';
import { FINISH } from '../renderer/materials';

/** Merge geometries regardless of indexing; drops UVs (materials are untextured). */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(
    parts.map((p) => {
      const g = p.index ? p.toNonIndexed() : p;
      if (g.getAttribute('uv')) g.deleteAttribute('uv');
      return g;
    }),
  )!;
}

type Mats = Record<'primary' | 'secondary' | 'seat' | 'trim' | 'wheels' | 'chassis', THREE.MeshStandardMaterial>;

const rbox = (w: number, h: number, d: number, r: number, x = 0, y = 0, z = 0) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)).translate(x, y, z);

interface StyleShape {
  bodyH: number;
  bodyW: number;
  radius: number;
  side: number;
  trimLine: boolean;
  rollBar: boolean;
  planks: boolean;
}

const SHAPES: Record<CarStyle, StyleShape> = {
  steel: { bodyH: 0.62, bodyW: 1.32, radius: 0.18, side: 0.42, trimLine: true, rollBar: false, planks: false },
  retro: { bodyH: 0.7, bodyW: 1.36, radius: 0.3, side: 0.5, trimLine: true, rollBar: false, planks: false },
  timber: { bodyH: 0.66, bodyW: 1.34, radius: 0.06, side: 0.5, trimLine: false, rollBar: false, planks: true },
  expedition: { bodyH: 0.66, bodyW: 1.4, radius: 0.12, side: 0.46, trimLine: true, rollBar: true, planks: false },
  open: { bodyH: 0.34, bodyW: 1.26, radius: 0.1, side: 0.16, trimLine: false, rollBar: false, planks: false },
  mine: { bodyH: 0.72, bodyW: 1.36, radius: 0.05, side: 0.56, trimLine: true, rollBar: false, planks: true },
};

/**
 * Builds one carriage. Local frame: +X forward, +Y up, +Z right; origin at the track centre line
 * between the bogies. Empty seats and restraints only: there are never any riders.
 */
function buildCar(style: CarStyle, mats: Mats, lead: boolean): { group: THREE.Group; wheels: THREE.Object3D[] } {
  const p = CAR_PROFILES[style];
  const sh = SHAPES[style];
  const g = new THREE.Group();
  const L = p.bodyLength;
  const baseY = 0.42; // chassis height above rail centre line
  // Chassis
  const chassis = new THREE.Mesh(rbox(L * 0.92, 0.12, 0.9, 0.04, 0, baseY - 0.06, 0), mats.chassis);
  g.add(chassis);
  // Body tub: floor + sides + front/back walls as one merged shell.
  const parts: THREE.BufferGeometry[] = [];
  const wall = 0.07;
  parts.push(rbox(L, 0.1, sh.bodyW, sh.radius * 0.5, 0, baseY + 0.05, 0));
  for (const z of [-1, 1]) parts.push(rbox(L, sh.bodyH, wall * 2, sh.radius, 0, baseY + sh.bodyH / 2, z * (sh.bodyW / 2 - wall)));
  parts.push(rbox(wall * 2, sh.bodyH * 0.9, sh.bodyW, sh.radius, -L / 2 + wall, baseY + sh.bodyH * 0.45, 0));
  parts.push(rbox(wall * 2, sh.bodyH * (lead ? 1.1 : 0.9), sh.bodyW, sh.radius, L / 2 - wall, baseY + sh.bodyH * (lead ? 0.55 : 0.45), 0));
  if (lead) {
    // A low, raked front panel (no dome): leans forward from the front wall like a real lead car.
    const front = rbox(0.14, sh.bodyH * 0.85, sh.bodyW, 0.035, 0, 0, 0).rotateZ(-0.3).translate(L / 2 + 0.02, baseY + sh.bodyH * 0.42, 0);
    parts.push(front);
  }
  const body = new THREE.Mesh(merge(parts), mats.primary);
  body.castShadow = true;
  g.add(body);
  // Decorative stripe / planks in the secondary colour.
  if (sh.planks) {
    for (let i = 0; i < 3; i++)
      for (const z of [-1, 1]) {
        const plank = new THREE.Mesh(rbox(L * 0.96, 0.05, 0.03, 0.01, 0, baseY + 0.18 + i * 0.17, z * (sh.bodyW / 2 + 0.005)), mats.secondary);
        g.add(plank);
      }
  } else {
    for (const z of [-1, 1]) g.add(new THREE.Mesh(rbox(L * 0.94, 0.08, 0.025, 0.012, 0, baseY + sh.bodyH * 0.55, z * (sh.bodyW / 2 + 0.005)), mats.secondary));
  }
  if (sh.trimLine) {
    for (const z of [-1, 1]) g.add(new THREE.Mesh(rbox(L * 0.98, 0.035, 0.08, 0.015, 0, baseY + sh.bodyH, z * (sh.bodyW / 2 - 0.05)), mats.trim));
  }
  // Seats: rows of two bucket seats with headrests and lap bars.
  const rows = p.rows;
  for (let r = 0; r < rows; r++) {
    const x = L / 2 - 0.55 - r * ((L - 0.7) / rows);
    for (const z of [-0.3, 0.3]) {
      const seat = new THREE.Mesh(merge([rbox(0.42, 0.1, 0.44, 0.04, x, baseY + 0.17, z), rbox(0.1, 0.55, 0.44, 0.05, x - 0.22, baseY + 0.45, z)]), mats.seat);
      seat.castShadow = true;
      g.add(seat);
      // Lap bar: a soft torus segment.
      const bar = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.03, 8, 16, Math.PI).rotateY(Math.PI / 2).rotateZ(-0.35).translate(x + 0.14, baseY + 0.36, z), mats.trim);
      g.add(bar);
    }
  }
  if (sh.rollBar) {
    const rb = new THREE.Mesh(new THREE.TorusGeometry(sh.bodyW / 2 - 0.05, 0.04, 8, 20, Math.PI).translate(0, 0, 0).rotateY(Math.PI / 2).translate(-L * 0.1, baseY + sh.bodyH, 0), mats.trim);
    g.add(rb);
  }
  // Wheel assemblies at each bogie: running wheels above the rail, guide wheels beside, upstops below.
  const wheels: THREE.Object3D[] = [];
  const wheelGeo = new THREE.CylinderGeometry(p.wheelRadius, p.wheelRadius, 0.12, 16).rotateX(Math.PI / 2);
  const smallWheel = new THREE.CylinderGeometry(0.09, 0.09, 0.08, 12);
  const hub = new THREE.CylinderGeometry(0.05, 0.05, 0.14, 8).rotateX(Math.PI / 2);
  for (const bx of [p.wheelbase / 2, -p.wheelbase / 2]) {
    for (const z of [-0.55, 0.55]) {
      const yoke = new THREE.Mesh(rbox(0.36, 0.5, 0.1, 0.03, bx, 0.06, z + Math.sign(z) * 0.14), mats.chassis);
      g.add(yoke);
      const w = new THREE.Group();
      w.position.set(bx, p.wheelRadius + 0.07, z);
      w.add(new THREE.Mesh(wheelGeo, mats.wheels), new THREE.Mesh(hub, mats.chassis));
      g.add(w);
      wheels.push(w);
      const guide = new THREE.Mesh(smallWheel, mats.wheels);
      guide.position.set(bx, 0, z + Math.sign(z) * 0.12);
      g.add(guide);
      const upstop = new THREE.Mesh(wheelGeo.clone().scale(0.5, 0.5, 0.8), mats.wheels);
      upstop.position.set(bx, -0.15, z);
      g.add(upstop);
    }
  }
  // Coupling bar to the car behind.
  const coupling = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, p.pitch - L + 0.4, 8).rotateZ(Math.PI / 2).translate(-L / 2 - (p.pitch - L) / 2, baseY - 0.05, 0), mats.chassis);
  g.add(coupling);
  compact(g, wheels, mats.wheels);
  return { group: g, wheels };
}

/**
 * Merge a carriage's static meshes into one mesh per material and each wheel set into one mesh,
 * cutting draw calls from ~40 to ~10 per carriage.
 */
function compact(g: THREE.Group, wheels: THREE.Object3D[], wheelMat: THREE.Material): void {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const child of [...g.children]) {
    const m = child as THREE.Mesh;
    if (!m.isMesh) continue;
    m.updateMatrix();
    const geo = m.geometry.clone().applyMatrix4(m.matrix);
    const mat = m.material as THREE.Material;
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat)!.push(geo);
    g.remove(m);
    m.geometry.dispose();
  }
  for (const [mat, geos] of byMat) {
    const mesh = new THREE.Mesh(merge(geos), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  for (const w of wheels) {
    const geos: THREE.BufferGeometry[] = [];
    for (const c of [...w.children]) {
      const m = c as THREE.Mesh;
      m.updateMatrix();
      geos.push(m.geometry.clone().applyMatrix4(m.matrix));
      w.remove(m);
    }
    const mesh = new THREE.Mesh(merge(geos), wheelMat);
    mesh.castShadow = true;
    w.add(mesh);
  }
}

const smpF = newSample();
const smpR = newSample();
const fwd = new THREE.Vector3();
const upV = new THREE.Vector3();
const right = new THREE.Vector3();
const basis = new THREE.Matrix4();
const rollM = new THREE.Matrix4();

/** Visual train. Reads bogie arc positions from the simulation; never feeds back into physics. */
export class TrainModel {
  readonly group = new THREE.Group();
  readonly mats: Mats;
  private cars: Array<{ group: THREE.Group; wheels: THREE.Object3D[] }> = [];
  private cfgKey = '';
  private wheelRadius = 0.2;
  /** World transforms of the lead car for cameras. */
  readonly leadMatrix = new THREE.Matrix4();
  readonly rearMatrix = new THREE.Matrix4();

  constructor() {
    const m = (c: string, r = 0.6, mt = 0.05) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: mt });
    this.mats = {
      primary: m('#C77D62', 0.5, 0.08),
      secondary: m('#F5EBDD', 0.6),
      seat: m('#343C37', 0.8),
      trim: m('#E5C579', 0.35, 0.5),
      wheels: m('#3A3F3B', 0.5, 0.3),
      chassis: m('#4A4F4B', 0.6, 0.4),
    };
    this.group.name = 'train';
  }

  configure(cfg: TrainConfig): void {
    const key = `${cfg.style}:${cfg.cars}`;
    const f = FINISH[cfg.finish];
    this.mats.primary.color.set(cfg.colours.primary);
    this.mats.primary.roughness = f.roughness;
    this.mats.primary.metalness = f.metalness;
    this.mats.secondary.color.set(cfg.colours.secondary);
    this.mats.seat.color.set(cfg.colours.seat);
    this.mats.trim.color.set(cfg.colours.trim);
    this.mats.wheels.color.set(cfg.colours.wheels);
    if (key === this.cfgKey) return;
    this.cfgKey = key;
    for (const c of this.cars) {
      this.group.remove(c.group);
      c.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    this.cars = [];
    for (let i = 0; i < cfg.cars; i++) {
      const car = buildCar(cfg.style, this.mats, i === 0);
      car.group.matrixAutoUpdate = false;
      this.cars.push(car);
      this.group.add(car.group);
    }
    this.wheelRadius = CAR_PROFILES[cfg.style].wheelRadius;
  }

  /**
   * Shift carriages with the structure's deflection and add a small speed-dependent rattle.
   * The rattle phase comes from distance travelled, so it is frame-rate independent.
   */
  applyFlex(offset: (x: number, y: number, z: number, out: [number, number, number]) => [number, number, number], rattle: number, rattleRoll: number, distance: number, speed: number): void {
    const o: [number, number, number] = [0, 0, 0];
    const k = Math.min(1, Math.abs(speed) / 14);
    for (let i = 0; i < this.cars.length; i++) {
      const g = this.cars[i]!.group;
      const e = g.matrix.elements;
      offset(e[12]!, e[13]!, e[14]!, o);
      const d = distance + i * 1.7;
      const jy = rattle * k * (Math.sin(d * 9.7) * 0.6 + Math.sin(d * 23.3 + 1.3) * 0.4);
      const roll = rattleRoll * k * Math.sin(d * 6.1 + i);
      e[12] = e[12]! + o[0];
      e[13] = e[13]! + o[1] + jy;
      e[14] = e[14]! + o[2];
      if (roll !== 0) {
        rollM.makeRotationX(roll);
        g.matrix.multiply(rollM);
      }
      if (i === 0) this.leadMatrix.copy(g.matrix);
      if (i === this.cars.length - 1) this.rearMatrix.copy(g.matrix);
    }
  }

  /**
   * Place every carriage from its bogie arc positions. Orientation comes from the chord between
   * front and rear bogies, so carriages articulate naturally through curves and inversions.
   */
  update(track: BakedTrack, bogies: Array<{ front: number; rear: number; centre: number }>, distance: number): void {
    for (let i = 0; i < this.cars.length && i < bogies.length; i++) {
      const b = bogies[i]!;
      track.sample(b.front, smpF);
      track.sample(b.rear, smpR);
      fwd.set(smpF.pos[0] - smpR.pos[0], smpF.pos[1] - smpR.pos[1], smpF.pos[2] - smpR.pos[2]);
      if (fwd.lengthSq() < 1e-8) fwd.set(...smpF.tan);
      fwd.normalize();
      upV.set(smpF.up[0] + smpR.up[0], smpF.up[1] + smpR.up[1], smpF.up[2] + smpR.up[2]);
      upV.addScaledVector(fwd, -upV.dot(fwd)).normalize();
      right.crossVectors(fwd, upV);
      const car = this.cars[i]!;
      basis.makeBasis(fwd, upV, right);
      basis.setPosition((smpF.pos[0] + smpR.pos[0]) / 2, (smpF.pos[1] + smpR.pos[1]) / 2, (smpF.pos[2] + smpR.pos[2]) / 2);
      car.group.matrix.copy(basis);
      car.group.matrixWorldNeedsUpdate = true;
      if (i === 0) this.leadMatrix.copy(basis);
      if (i === bogies.length - 1) this.rearMatrix.copy(basis);
      // Wheel spin matches distance travelled.
      const ang = -distance / this.wheelRadius;
      for (const w of car.wheels) w.rotation.z = ang;
    }
  }
}
