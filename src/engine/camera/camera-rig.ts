import * as THREE from 'three';

export type CameraMode = 'orbit' | 'front' | 'rear' | 'follow' | 'side' | 'cinematic' | 'trackside' | 'relax';
export const RIDE_MODES: readonly CameraMode[] = ['front', 'rear', 'follow', 'side', 'cinematic', 'trackside'];

const ORIGIN = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const fwd = new THREE.Vector3();
const upv = new THREE.Vector3();
const right = new THREE.Vector3();

/**
 * All camera behaviour. Cameras read the train's interpolated transform; they never influence
 * the simulation. Smoothing is frame-rate independent (exponential decay on real dt).
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'orbit';
  // Orbit state (targets and smoothed values).
  target = new THREE.Vector3(36, 9, -14);
  distance = 72;
  yaw = -0.55;
  pitch = 0.3;
  private sTarget = new THREE.Vector3(36, 9, -14);
  private sDistance = 72;
  private sYaw = -0.55;
  private sPitch = 0.3;
  minDistance = 6;
  maxDistance = 700;
  /** Comfort: 0 = full banking, 1 = horizon locked. */
  stabilisation = 0.35;
  reducedMotion = false;
  shake = true;
  private rideQ = new THREE.Quaternion();
  private ridePos = new THREE.Vector3();
  private rideInit = false;
  private relaxT = 0;
  private trackside = new THREE.Vector3();
  private tracksideTimer = 0;
  orthoMiniature = false;
  baseFov = 50;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.15, 6000);
    this.apply(1);
  }

  setMode(m: CameraMode): void {
    if (m === this.mode) return;
    this.mode = m;
    this.rideInit = false;
    this.tracksideTimer = 0;
    this.camera.fov = m === 'front' || m === 'rear' ? 72 : this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  orbitBy(dx: number, dy: number, viewportH: number): void {
    const k = 3.2 / Math.max(300, viewportH);
    this.yaw -= dx * k;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, 0.05, 1.45);
  }

  panBy(dx: number, dy: number, viewportH: number): void {
    const scale = (this.distance * 1.1) / Math.max(300, viewportH);
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    // Screen right / forward projected onto the ground.
    // Screen-right on the ground is (cos yaw, 0, −sin yaw); forward is (−sin yaw, 0, −cos yaw).
    this.target.x += (-dx * cy - dy * sy) * scale;
    this.target.z += (dx * sy - dy * cy) * scale;
  }

  zoomBy(f: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance * f, this.minDistance, this.maxDistance);
  }

  focusOn(p: THREE.Vector3, distance?: number): void {
    this.target.copy(p);
    if (distance) this.distance = THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance);
  }

  /** Smoothed orbit camera placement. */
  private apply(k: number): void {
    this.sTarget.lerp(this.target, k);
    this.sDistance += (this.distance - this.sDistance) * k;
    let dy = this.yaw - this.sYaw;
    if (dy > Math.PI) dy -= 2 * Math.PI;
    if (dy < -Math.PI) dy += 2 * Math.PI;
    this.sYaw += dy * k;
    this.sPitch += (this.pitch - this.sPitch) * k;
    const cp = Math.cos(this.sPitch);
    this.camera.position.set(
      this.sTarget.x + Math.sin(this.sYaw) * cp * this.sDistance,
      this.sTarget.y + Math.sin(this.sPitch) * this.sDistance,
      this.sTarget.z + Math.cos(this.sYaw) * cp * this.sDistance,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.sTarget);
  }

  /**
   * Per-frame update.
   * @param lead world matrix of the lead carriage (basis: X forward, Y up, Z right)
   * @param rear world matrix of the last carriage
   * @param speed train speed (m/s) for subtle FOV breathing
   * @param ground terrain height lookup to keep cameras above ground
   */
  update(
    dt: number,
    lead: THREE.Matrix4,
    rear: THREE.Matrix4,
    speed: number,
    ground: (x: number, z: number) => number,
    /** Watch cameras: is the train at the station, and the height of any track the camera would sit in. */
    watch?: { inStation: boolean; stationSide: number; trackNear: (x: number, y: number, z: number) => number | null },
  ): void {
    const k = 1 - Math.exp(-dt * (this.reducedMotion ? 6 : 10));
    const cam = this.camera;
    switch (this.mode) {
      case 'orbit':
        this.apply(k);
        break;
      case 'relax': {
        this.relaxT += dt;
        // Slow drift around the coaster with gentle height variation.
        this.yaw += dt * (this.reducedMotion ? 0.012 : 0.03);
        this.pitch = 0.32 + Math.sin(this.relaxT * 0.05) * 0.12;
        this.distance += (110 + Math.sin(this.relaxT * 0.037) * 35 - this.distance) * 0.01;
        this.apply(1 - Math.exp(-dt * 1.2));
        break;
      }
      case 'front':
      case 'rear': {
        const m = this.mode === 'front' ? lead : rear;
        m.extractBasis(fwd, upv, right);
        const pos = tmpV.setFromMatrixPosition(m).addScaledVector(upv, this.mode === 'front' ? 1.78 : 1.6).addScaledVector(fwd, this.mode === 'front' ? 0.45 : -0.6);
        // Rider-like view with optional horizon stabilisation (comfort setting).
        const lookUp = tmpV2.copy(upv).lerp(new THREE.Vector3(0, Math.sign(upv.y) || 1, 0), this.stabilisation).normalize();
        tmpM.lookAt(ORIGIN, fwd, lookUp);
        tmpQ.setFromRotationMatrix(tmpM);
        if (!this.rideInit) {
          this.rideQ.copy(tmpQ);
          this.ridePos.copy(pos);
          this.rideInit = true;
        }
        // Position is exact (the camera is mounted on the train); rotation is lightly smoothed.
        this.rideQ.slerp(tmpQ, 1 - Math.exp(-dt * (this.reducedMotion ? 8 : 25)));
        cam.position.copy(pos);
        cam.quaternion.copy(this.rideQ);
        if (this.mode === 'rear') cam.rotateY(Math.PI);
        const targetFov = 72 + (this.reducedMotion ? 0 : Math.min(8, Math.abs(speed) * 0.25));
        cam.fov += (targetFov - cam.fov) * k;
        cam.updateProjectionMatrix();
        break;
      }
      case 'follow':
      case 'side':
      case 'cinematic': {
        lead.extractBasis(fwd, upv, right);
        const p = tmpV.setFromMatrixPosition(lead);
        const flatF = tmpV2.set(fwd.x, 0, fwd.z);
        if (flatF.lengthSq() < 1e-4) flatF.set(1, 0, 0);
        flatF.normalize();
        const side = new THREE.Vector3(-flatF.z, 0, flatF.x);
        let desired: THREE.Vector3;
        if (watch?.inStation) {
          // At the station: low beside the platform (under the roof line), looking at the train.
          desired = p.clone().addScaledVector(side, 9 * watch.stationSide).addScaledVector(flatF, -3).add(new THREE.Vector3(0, 2.2, 0));
        } else if (this.mode === 'follow') desired = p.clone().addScaledVector(flatF, -14).add(new THREE.Vector3(0, 6, 0));
        else if (this.mode === 'side') desired = p.clone().addScaledVector(side, 12).add(new THREE.Vector3(0, 2.5, 0));
        else desired = p.clone().addScaledVector(side, 30).addScaledVector(flatF, 14).add(new THREE.Vector3(0, 10, 0));
        const floor = ground(desired.x, desired.z) + 1.5;
        desired.y = Math.max(desired.y, floor);
        // Never sit inside other track: hop over it, or dip under it when there's room.
        this.avoidTrack(desired, floor, watch?.trackNear);
        if (!this.rideInit) {
          this.ridePos.copy(desired);
          this.rideInit = true;
        }
        this.ridePos.lerp(desired, 1 - Math.exp(-dt * (this.mode === 'cinematic' ? 1.2 : 4)));
        cam.position.copy(this.ridePos);
        cam.up.set(0, 1, 0);
        cam.lookAt(p);
        break;
      }
      case 'trackside': {
        lead.extractBasis(fwd, upv, right);
        const p = tmpV.setFromMatrixPosition(lead);
        this.tracksideTimer -= dt;
        if (this.tracksideTimer <= 0 || this.trackside.distanceTo(p) > 90) {
          // Plant a new observer spot ahead of the train, at eye height on the ground.
          const flat = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
          const side = new THREE.Vector3(-flat.z, 0, flat.x);
          this.trackside.copy(p).addScaledVector(flat, 45).addScaledVector(side, 16);
          this.trackside.y = ground(this.trackside.x, this.trackside.z) + 1.7;
          this.tracksideTimer = 9;
        }
        cam.position.copy(this.trackside);
        cam.up.set(0, 1, 0);
        cam.lookAt(p);
        break;
      }
    }
    // Keep orbit-type cameras above the terrain.
    if (this.mode === 'orbit' || this.mode === 'relax') {
      const gy = ground(cam.position.x, cam.position.z) + 1.2;
      if (cam.position.y < gy) cam.position.y = gy;
    }
  }

  /** Move a watch-camera position clear of any track it would sit in (above it, or below with room). */
  private avoidTrack(p: THREE.Vector3, floor: number, trackNear?: (x: number, y: number, z: number) => number | null): void {
    if (!trackNear) return;
    for (let i = 0; i < 3; i++) {
      const ty = trackNear(p.x, p.y, p.z);
      if (ty === null) return;
      const below = ty - 4.5;
      p.y = p.y < ty && below >= floor ? below : ty + 4.5;
    }
  }

  /** Sync orbit state to the current camera after leaving a ride camera. */
  syncOrbitFromCamera(lookAt: THREE.Vector3): void {
    const d = this.camera.position.distanceTo(lookAt);
    this.target.copy(lookAt);
    this.sTarget.copy(lookAt);
    this.distance = this.sDistance = THREE.MathUtils.clamp(d, this.minDistance, this.maxDistance);
    const off = this.camera.position.clone().sub(lookAt);
    this.yaw = this.sYaw = Math.atan2(off.x, off.z);
    this.pitch = this.sPitch = THREE.MathUtils.clamp(Math.asin(off.y / Math.max(d, 1e-3)), 0.05, 1.45);
  }
}
