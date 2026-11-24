import * as THREE from 'three';

/**
 * Rain and snow from a single fixed-size pool of instanced streaks/flakes that wraps around the
 * camera. Density is controlled by `count`, never by allocating. No lightning, no storms.
 */
export class WeatherParticles {
  readonly rain: THREE.InstancedMesh;
  readonly snow: THREE.InstancedMesh;
  private readonly offsets: Float32Array;
  private readonly speeds: Float32Array;
  readonly capacity: number;
  density = 1;
  private readonly m4 = new THREE.Matrix4();
  private readonly box = 36;

  constructor(capacity = 2400) {
    this.capacity = capacity;
    const rainGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.6, 3, 1, true);
    const rainMat = new THREE.MeshBasicMaterial({ color: '#C9D6DF', transparent: true, opacity: 0.35, depthWrite: false });
    this.rain = new THREE.InstancedMesh(rainGeo, rainMat, capacity);
    const snowGeo = new THREE.IcosahedronGeometry(0.045, 0);
    const snowMat = new THREE.MeshBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0.85, depthWrite: false });
    this.snow = new THREE.InstancedMesh(snowGeo, snowMat, capacity);
    for (const m of [this.rain, this.snow]) {
      m.frustumCulled = false;
      m.count = 0;
      m.renderOrder = 2;
    }
    this.offsets = new Float32Array(capacity * 3);
    this.speeds = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.offsets[i * 3] = Math.random() * this.box;
      this.offsets[i * 3 + 1] = Math.random() * this.box;
      this.offsets[i * 3 + 2] = Math.random() * this.box;
      this.speeds[i] = 0.8 + Math.random() * 0.4;
    }
    this.rain.name = 'rain';
    this.snow.name = 'snow';
  }

  update(dt: number, elapsed: number, camera: THREE.Vector3, rain: number, snow: number): void {
    const B = this.box;
    const nRain = Math.floor(this.capacity * Math.min(1, rain) * this.density);
    const nSnow = Math.floor(this.capacity * 0.7 * Math.min(1, snow) * this.density);
    this.rain.count = nRain;
    this.snow.count = nSnow;
    const m4 = this.m4;
    if (nRain > 0) {
      for (let i = 0; i < nRain; i++) {
        this.offsets[i * 3 + 1] = (this.offsets[i * 3 + 1]! - dt * 16 * this.speeds[i]! + B * 10) % B;
        const x = this.offsets[i * 3]!;
        const y = camera.y - B / 2 + this.offsets[i * 3 + 1]!;
        const z = this.offsets[i * 3 + 2]!;
        m4.makeTranslation(wrap(x, camera.x, B), y, wrap(z, camera.z, B));
        this.rain.setMatrixAt(i, m4);
      }
      this.rain.instanceMatrix.needsUpdate = true;
    }
    if (nSnow > 0) {
      for (let i = 0; i < nSnow; i++) {
        this.offsets[i * 3 + 1] = (this.offsets[i * 3 + 1]! - dt * 1.3 * this.speeds[i]! + B * 10) % B;
        const sway = Math.sin(elapsed * 0.7 + i) * 0.6;
        const x = this.offsets[i * 3]! + sway;
        const y = camera.y - B / 2 + this.offsets[i * 3 + 1]!;
        const z = this.offsets[i * 3 + 2]! + Math.cos(elapsed * 0.5 + i * 1.3) * 0.4;
        m4.makeTranslation(wrap(x, camera.x, B), y, wrap(z, camera.z, B));
        this.snow.setMatrixAt(i, m4);
      }
      this.snow.instanceMatrix.needsUpdate = true;
    }
  }
}

/** Keep a coordinate within a box of size B centred on c (world-anchored so particles don't swim). */
function wrap(v: number, c: number, B: number): number {
  return c - B / 2 + ((((v - (c - B / 2)) % B) + B) % B);
}
