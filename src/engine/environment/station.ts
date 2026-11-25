import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { BakedTrack, newSample } from '../track/bake';
import { addPaintedVariation } from '../renderer/materials';

/**
 * A small timber station built along the first station section: a deck on both sides of the
 * track, posts, a gently pitched roof and warm lamps that glow at night.
 */
export class Station {
  readonly group = new THREE.Group();
  private readonly timber = addPaintedVariation(new THREE.MeshStandardMaterial({ color: '#C9A27C', roughness: 0.85 }), 0.08, 1.5);
  private readonly deck = addPaintedVariation(new THREE.MeshStandardMaterial({ color: '#B88E68', roughness: 0.9 }), 0.1, 2.2);
  private readonly roof = addPaintedVariation(new THREE.MeshStandardMaterial({ color: '#C77D62', roughness: 0.8 }), 0.06, 0.8);
  private readonly cream = new THREE.MeshStandardMaterial({ color: '#F5EBDD', roughness: 0.8 });
  readonly lamp = new THREE.MeshStandardMaterial({ color: '#FFE7B8', emissive: new THREE.Color('#FFC46E'), emissiveIntensity: 0.3 });
  private lights: THREE.PointLight[] = [];

  constructor() {
    this.group.name = 'station';
  }

  setNight(n: number): void {
    this.lamp.emissiveIntensity = 0.3 + n * 2.4;
    for (const l of this.lights) l.intensity = n * 6;
  }

  private builtKey = '';

  build(track: BakedTrack | null, ground: (x: number, z: number) => number): void {
    const iv = track?.intervalsOf('station')[0];
    const a = iv && track ? track.sample(iv[0], newSample()) : null;
    const b = iv && track ? track.sample(Math.min(iv[1], track.closed ? iv[1] : track.length), newSample()) : null;
    // The station only depends on where the platform is (and the ground under it): editing the rest
    // of the coaster must not rebuild it.
    const key = a && b ? `${a.pos.map((v) => v.toFixed(2))}|${b.pos.map((v) => v.toFixed(2))}|${ground(a.pos[0], a.pos[2]).toFixed(2)}` : '';
    if (key === this.builtKey) return;
    this.builtKey = key;
    // Free every mesh, including those nested in sub-groups (the old code only freed direct children,
    // leaking ~90 geometries per track edit until phones ran out of GPU memory and reloaded the page).
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const c of [...this.group.children]) this.group.remove(c);
    this.lights = [];
    if (!track || !a || !b) return;
    const len = Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]);
    if (len < 4) return;
    const heading = Math.atan2(-(b.pos[2] - a.pos[2]), b.pos[0] - a.pos[0]);
    const root = new THREE.Group();
    root.position.set((a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2, (a.pos[2] + b.pos[2]) / 2);
    root.rotation.y = heading;
    this.group.add(root);
    const L = len + 3;
    const deckY = -0.05;
    const add = (g: THREE.BufferGeometry, m: THREE.Material, cast = true) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      root.add(mesh);
      return mesh;
    };
    // Platforms either side.
    for (const z of [-1, 1]) {
      add(new RoundedBoxGeometry(L, 0.18, 2.6, 2, 0.05).translate(0, deckY, z * 2.25), this.deck);
      add(new RoundedBoxGeometry(L, 0.06, 0.12, 2, 0.02).translate(0, deckY + 0.12, z * 0.98), this.cream);
    }
    // Stilts down to the ground.
    const step = 3.2;
    for (let x = -L / 2 + 0.6; x <= L / 2 - 0.5; x += step) {
      for (const z of [-3.4, -1.1, 1.1, 3.4]) {
        const wx = root.position.x + Math.cos(heading) * x + Math.sin(heading) * z;
        const wz = root.position.z - Math.sin(heading) * x + Math.cos(heading) * z;
        const gy = ground(wx, wz) - root.position.y;
        const h = deckY - gy;
        if (h > 0.1) add(new RoundedBoxGeometry(0.22, h + 0.3, 0.22, 1, 0.04).translate(x, gy + h / 2 - 0.15, z), this.timber);
      }
      // Roof posts (only under the canopy).
      if (Math.abs(x) <= Math.min(L * 0.25, 7)) for (const z of [-3.3, 3.3]) add(new RoundedBoxGeometry(0.18, 3.8, 0.18, 1, 0.04).translate(x, deckY + 1.9, z), this.timber);
    }
    // Pitched canopy over the middle of the platform, leaving the train visible at both ends.
    const roofW = 4.2;
    const roofL = Math.min(L * 0.5, 14);
    for (const z of [-1, 1]) {
      const slab = new RoundedBoxGeometry(roofL, 0.12, roofW, 2, 0.05);
      const m = add(slab, this.roof);
      m.position.set(0, deckY + 4.3, z * 1.9);
      m.rotation.x = z * 0.32;
    }
    add(new RoundedBoxGeometry(roofL + 0.1, 0.16, 0.3, 2, 0.06).translate(0, deckY + 4.95, 0), this.timber);
    // Railings on the outer edges.
    for (const z of [-3.5, 3.5]) {
      add(new RoundedBoxGeometry(L, 0.06, 0.06, 1, 0.02).translate(0, deckY + 1.0, z), this.timber, false);
      for (let x = -L / 2 + 0.3; x <= L / 2; x += 1.2) add(new RoundedBoxGeometry(0.05, 0.9, 0.05, 1, 0.015).translate(x, deckY + 0.55, z), this.timber, false);
    }
    // Lamps under the roof.
    for (let x = -Math.min(L * 0.2, 5); x <= Math.min(L * 0.2, 5) + 0.01; x += Math.max(2.5, Math.min(L * 0.2, 5))) {
      add(new THREE.SphereGeometry(0.16, 12, 8).translate(x, deckY + 3.55, 0), this.lamp, false);
    }
    // Two cheap point lights for the whole station (not one per lamp).
    for (const x of [-L / 4, L / 4]) {
      const pl = new THREE.PointLight('#FFC97A', 0, 14, 2);
      pl.position.set(x, deckY + 3, 0);
      root.add(pl);
      this.lights.push(pl);
    }
    // Name board.
    add(new RoundedBoxGeometry(3.2, 0.7, 0.1, 2, 0.05).translate(0, deckY + 3.75, 3.35), this.cream, false);
  }
}
