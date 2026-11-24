import { type V3, v3, dot } from '../core/vec3';
import { BakedTrack, newSample, type TrackSample } from '../track/bake';
import { CAR_PROFILES, DEFAULT_PHYSICS, MAX_CARS, MIN_CARS, type PhysicsParams, type TrainConfig, trainLength } from '../train/config';

/** Standard gravity used to express G-forces regardless of the configured gravity. */
export const G0 = 9.80665;

export type RideState = 'hold' | 'dispatch' | 'running' | 'safety-stop' | 'idle';

export type SimEvent =
  | { type: 'dispatch' }
  | { type: 'arrive' }
  | { type: 'lift-engage' }
  | { type: 'lift-release' }
  | { type: 'launch' }
  | { type: 'stall' }
  | { type: 'end-of-track' }
  | { type: 'numeric-error' };

export interface Telemetry {
  speed: number;
  accel: number;
  gVert: number;
  gLat: number;
  gLong: number;
  jerk: number;
  height: number;
  kinetic: number;
  potential: number;
  /** Total mechanical energy, J. */
  energy: number;
  /** Cumulative energy removed by resistance and brakes, J (positive). */
  dissipated: number;
  /** Cumulative energy added by lifts, launches and tyres, J. */
  powered: number;
}

interface Bogie {
  /** Offset from the front-car centre, metres along the track (≤ 0). */
  offset: number;
  mass: number;
  car: number;
}

/** Arc-length state of one carriage, written each step for rendering and audio. */
export interface CarState {
  centre: number;
  front: number;
  rear: number;
  section: TrackSample['kind'];
}

const TANH_V = 0.05; // m/s, regularisation of Coulomb-like terms around zero speed
const CHAIN_CATCH = 2.5; // m/s², rate at which a slower train is brought up to chain speed
const TYRE_ACCEL = 2.2; // m/s², station tyre drive authority
const STATION_ENTRY = 2.2; // m/s, approach speed through the platform
const STATION_BRAKE = 5; // m/s², platform friction brakes for over-speed arrivals
const DISPATCH_SPEED = 1.6; // m/s
const BUFFER = 9; // m, virtual buffer length before an unfinished end

/**
 * Rail-constrained articulated train with distributed mass.
 *
 * Generalised coordinate: `s`, the arc-length position of the front carriage centre.
 * Each carriage contributes two bogie mass points at fixed offsets. The equation of motion is
 *   M_eff · s̈ = Σ_j m_j (g · T_j) − rolling − drag + powered forces
 * where T_j is the tangent at bogie j. See docs/physics.md.
 */
export class TrainSim {
  track: BakedTrack;
  cfg: TrainConfig;
  params: PhysicsParams;
  envPhysics = false;
  autoDispatch = true;

  s = 0;
  v = 0;
  prevS = 0;
  time = 0;
  state: RideState = 'idle';
  holdTimer = 0;

  mass = 0;
  massEff = 0;
  readonly cars: CarState[] = [];
  readonly telemetry: Telemetry = {
    speed: 0,
    accel: 0,
    gVert: 1,
    gLat: 0,
    gLong: 0,
    jerk: 0,
    height: 0,
    kinetic: 0,
    potential: 0,
    energy: 0,
    dissipated: 0,
    powered: 0,
  };
  readonly events: SimEvent[] = [];

  private bogies: Bogie[] = [];
  private carOffsets: number[] = [];
  private halfWheelbase = 0;
  private stationStop: number | null = null;
  private stationInterval: [number, number] | null = null;
  private liftEngaged = false;
  private launching = false;
  private stallTimer = 0;
  private stallReported = false;
  private lastGoodS = 0;
  private prevGVert = 1;
  private readonly smp: TrackSample = newSample();
  private readonly gv: V3 = v3();

  constructor(track: BakedTrack, cfg: TrainConfig, params: PhysicsParams = { ...DEFAULT_PHYSICS }) {
    this.track = track;
    this.cfg = { ...cfg, cars: clampCars(cfg.cars) };
    this.params = sanitiseParams(params);
    this.rebuildTrain();
    this.setTrack(track);
  }

  /** Recompute mass distribution after a configuration change. Caller must ensure the train is parked. */
  rebuildTrain(): void {
    const p = CAR_PROFILES[this.cfg.style];
    const n = clampCars(this.cfg.cars);
    this.cfg.cars = n;
    this.bogies = [];
    this.carOffsets = [];
    this.halfWheelbase = p.wheelbase / 2;
    for (let i = 0; i < n; i++) {
      const c = -i * p.pitch;
      this.carOffsets.push(c);
      this.bogies.push({ offset: c + p.wheelbase / 2, mass: p.mass / 2, car: i });
      this.bogies.push({ offset: c - p.wheelbase / 2, mass: p.mass / 2, car: i });
    }
    this.mass = p.mass * n;
    // Rotational inertia of solid-disc running wheels: I/r² = ½ m_w per wheel.
    this.massEff = this.mass + n * p.runningWheels * 0.5 * p.wheelMass;
    this.cars.length = 0;
    for (let i = 0; i < n; i++) this.cars.push({ centre: 0, front: 0, rear: 0, section: 'track' });
  }

  setTrack(track: BakedTrack): void {
    this.track = track;
    const st = track.intervalsOf('station');
    this.stationInterval = st[0] ?? null;
    this.stationStop = this.stationInterval ? this.stationInterval[1] - 0.6 : null;
    this.resetToStation();
  }

  get trainLength(): number {
    return trainLength(this.cfg);
  }

  /** Whether the station platform is long enough for the configured train. */
  stationFits(): boolean {
    if (!this.stationInterval) return true;
    return this.stationInterval[1] - this.stationInterval[0] >= this.trainLength + 0.4;
  }

  resetToStation(): void {
    this.v = 0;
    this.time = 0;
    this.stallTimer = 0;
    this.stallReported = false;
    this.liftEngaged = false;
    this.launching = false;
    this.telemetry.dissipated = 0;
    this.telemetry.powered = 0;
    if (this.stationStop !== null) {
      this.s = this.track.wrap(this.stationStop);
      this.state = 'hold';
      this.holdTimer = this.params.dwell;
    } else {
      // No station: park the train at the start of the track, fully on the rails.
      const p = CAR_PROFILES[this.cfg.style];
      this.s = this.track.wrap(this.trainLength - p.bodyLength / 2 + 0.5);
      this.state = 'idle';
    }
    this.prevS = this.s;
    this.lastGoodS = this.s;
    this.updateCars();
    this.updateTelemetry(0, 0);
  }

  /** Start the train (manual dispatch). */
  dispatch(): void {
    if (this.state === 'hold') {
      this.state = 'dispatch';
      this.events.push({ type: 'dispatch' });
    } else if (this.state === 'idle' || this.state === 'safety-stop') {
      this.state = 'running';
      this.stallTimer = 0;
      this.stallReported = false;
      this.events.push({ type: 'dispatch' });
    }
  }

  /** Arc position of bogie / car offset, respecting wrap on closed circuits. */
  private at(off: number, s: number): number {
    return this.track.closed ? this.track.wrap(s + off) : s + off;
  }

  /** Continuous forces (N) along the track at state (s, v). Also returns dissipative part via out param. */
  private force(s: number, v: number, out: { diss: number; powered: number }): number {
    const g = this.params.gravity;
    const track = this.track;
    const smp = this.smp;
    let fGrav = 0;
    let normalSum = 0;
    for (let j = 0; j < this.bogies.length; j++) {
      const b = this.bogies[j]!;
      track.sample(this.at(b.offset, s), smp);
      fGrav += -b.mass * g * smp.dyds;
      // Normal (constraint) force magnitude: m |v²κ − g⊥|
      const gt = -g * smp.tan[1];
      const gx = 0 - gt * smp.tan[0];
      const gy = -g - gt * smp.tan[1];
      const gz = 0 - gt * smp.tan[2];
      const nx = v * v * smp.curv[0] - gx;
      const ny = v * v * smp.curv[1] - gy;
      const nz = v * v * smp.curv[2] - gz;
      normalSum += b.mass * Math.sqrt(nx * nx + ny * ny + nz * nz);
    }
    const dir = Math.tanh(v / TANH_V);
    const fRoll = -this.params.rollingCoeff * normalSum * dir;

    // Aerodynamic drag on the lead car plus shielded trailing cars.
    const prof = CAR_PROFILES[this.cfg.style];
    const cdA = prof.cdA * (1 + this.params.trailingDragFraction * (this.cfg.cars - 1)) * this.params.dragScale;
    let vRel = v;
    if (this.envPhysics) {
      track.sample(this.at(0, s), smp);
      vRel = v - (this.params.windX * smp.tan[0] + this.params.windZ * smp.tan[2]);
    }
    const fDrag = -0.5 * this.params.airDensity * cdA * vRel * Math.abs(vRel);

    // Section forces per carriage (launch motors and magnetic brakes act on fins under each car).
    let fLaunch = 0;
    let fBrake = 0;
    const carMass = prof.mass;
    for (let i = 0; i < this.carOffsets.length; i++) {
      track.sample(this.at(this.carOffsets[i]!, s), smp);
      if (smp.kind === 'launch') {
        const target = smp.param > 0 ? smp.param : 20;
        const k = Math.min(1, Math.max(0, (target - v) / 1.5));
        fLaunch += carMass * this.params.launchAccel * k;
      } else if (smp.kind === 'brake') {
        const target = Math.max(0, smp.param);
        const over = Math.abs(v) - target;
        if (over > 0) fBrake += -Math.sign(v) * carMass * Math.min(this.params.brakeDecel, 3 * over);
      }
    }

    // Virtual buffer before an unfinished end of an open track.
    if (!track.closed) {
      const front = s + this.halfWheelbase;
      const rear = s + this.bogies[this.bogies.length - 1]!.offset;
      const toEnd = track.length - front;
      const toStart = rear;
      if (toEnd < BUFFER && v > 0) fBrake += -this.massEff * Math.min(8, (v * v) / (2 * Math.max(toEnd - 0.5, 0.25)) + 0.5) * dir;
      if (toStart < BUFFER && v < 0) fBrake += -this.massEff * Math.min(8, (v * v) / (2 * Math.max(toStart - 0.5, 0.25)) + 0.5) * dir;
    }

    out.diss = (fRoll + fDrag + fBrake) * v;
    out.powered = fLaunch * v;
    return fGrav + fRoll + fDrag + fLaunch + fBrake;
  }

  private readonly fo = { diss: 0, powered: 0 };

  /** Advance the simulation by exactly `dt` seconds. */
  step(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.prevS = this.s;
    this.time += dt;
    const M = this.massEff;

    if (this.state === 'hold') {
      this.v = 0;
      this.holdTimer -= dt;
      if (this.autoDispatch && this.holdTimer <= 0) {
        this.state = 'dispatch';
        this.events.push({ type: 'dispatch' });
      }
      this.updateCars();
      this.updateTelemetry(0, dt);
      return;
    }
    if (this.state === 'idle' || this.state === 'safety-stop') {
      this.v = 0;
      this.updateCars();
      this.updateTelemetry(0, dt);
      return;
    }

    // RK4 on (s, v) for the continuous forces.
    const s0 = this.s;
    const v0 = this.v;
    const fo = this.fo;
    const a1 = this.force(s0, v0, fo) / M;
    const d1 = fo.diss;
    const p1 = fo.powered;
    const a2 = this.force(s0 + 0.5 * dt * v0, v0 + 0.5 * dt * a1, fo) / M;
    const d2 = fo.diss;
    const p2 = fo.powered;
    const a3 = this.force(s0 + 0.5 * dt * (v0 + 0.5 * dt * a1), v0 + 0.5 * dt * a2, fo) / M;
    const d3 = fo.diss;
    const p3 = fo.powered;
    const a4 = this.force(s0 + dt * (v0 + 0.5 * dt * a2), v0 + dt * a3, fo) / M;
    const d4 = fo.diss;
    const p4 = fo.powered;
    let s1 = s0 + (dt / 6) * (v0 + 2 * (v0 + 0.5 * dt * a1) + 2 * (v0 + 0.5 * dt * a2) + (v0 + dt * a3));
    let v1 = v0 + (dt / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
    this.telemetry.dissipated -= (dt / 6) * (d1 + 2 * d2 + 2 * d3 + d4);
    this.telemetry.powered += (dt / 6) * (p1 + 2 * p2 + 2 * p3 + p4);

    // Velocity constraints: chain lift (with anti-rollback) and station tyres.
    const vFree = v1;
    let engaged = false;
    let liftSpeed = 0;
    let inStation = false;
    for (let i = 0; i < this.carOffsets.length; i++) {
      this.track.sample(this.at(this.carOffsets[i]!, s1), this.smp);
      if (this.smp.kind === 'lift') {
        engaged = true;
        liftSpeed = Math.max(liftSpeed, this.params.liftSpeed > 0 ? this.params.liftSpeed : this.smp.param > 0 ? this.smp.param : 3);
      } else if (this.smp.kind === 'station') inStation = true;
    }
    if (engaged) {
      // The chain is a velocity constraint: it carries the train at chain speed regardless of gravity,
      // catching up from the previous speed at a limited rate. The ratchet prevents rollback.
      if (v1 < liftSpeed) v1 = Math.min(liftSpeed, Math.max(v0, 0) + CHAIN_CATCH * dt);
      if (!this.liftEngaged) this.events.push({ type: 'lift-engage' });
    } else if (this.liftEngaged) this.events.push({ type: 'lift-release' });
    this.liftEngaged = engaged;

    if (inStation && this.stationStop !== null) {
      if (this.state === 'dispatch') {
        if (v1 < DISPATCH_SPEED) v1 = approach(v1, DISPATCH_SPEED, TYRE_ACCEL * dt);
      } else {
        let dist = this.stationStop - s1;
        if (this.track.closed) {
          const L = this.track.length;
          dist = ((dist % L) + L + L / 2) % L - L / 2;
        }
        const target = Math.sign(dist) * Math.min(STATION_ENTRY, Math.sqrt(2 * 1.2 * Math.abs(dist)));
        // Tyres trim the approach; friction brakes assist if the train arrives too fast.
        const authority = Math.abs(v1) > Math.abs(target) + 0.8 ? STATION_BRAKE : TYRE_ACCEL;
        v1 = approach(v1, target, authority * dt);
        if (Math.abs(dist) < 0.03 && Math.abs(v1) < 0.12) {
          s1 = this.stationStop;
          v1 = 0;
          this.state = 'hold';
          this.holdTimer = this.params.dwell;
          this.events.push({ type: 'arrive' });
        }
      }
    } else if (this.state === 'dispatch' && !inStation) {
      this.state = 'running';
    }
    // Energy bookkeeping for constraint impulses (positive = energy added).
    const dE = 0.5 * M * (v1 * v1 - vFree * vFree);
    if (dE > 0) this.telemetry.powered += dE;
    else this.telemetry.dissipated -= dE;

    // Launch event (edge-triggered).
    this.track.sample(this.at(0, s1), this.smp);
    const launching = this.smp.kind === 'launch';
    if (launching && !this.launching) this.events.push({ type: 'launch' });
    this.launching = launching;

    if (this.track.closed) s1 = this.track.wrap(s1);

    // Numerical safety.
    if (!Number.isFinite(s1) || !Number.isFinite(v1) || Math.abs(v1) > 200) {
      this.s = this.lastGoodS;
      this.v = 0;
      this.state = 'safety-stop';
      this.events.push({ type: 'numeric-error' });
      this.updateCars();
      return;
    }

    const accel = (v1 - v0) / dt;
    this.s = s1;
    this.v = v1;
    this.lastGoodS = s1;

    // Unfinished end of an open track: stop gently once the buffer has done its job.
    if (!this.track.closed) {
      const front = s1 + this.halfWheelbase;
      const rear = s1 + this.bogies[this.bogies.length - 1]!.offset;
      if ((front > this.track.length - 0.6 && v1 >= 0) || (rear < 0.6 && v1 <= 0)) {
        this.v = 0;
        this.s = Math.min(Math.max(s1, 0.6 - this.bogies[this.bogies.length - 1]!.offset), this.track.length - 0.6 - this.halfWheelbase);
        this.state = 'safety-stop';
        this.events.push({ type: 'end-of-track' });
      }
    }

    // Stall detection: slow, unpowered, away from the station for a sustained period.
    if (this.state === 'running' && !engaged && !inStation && Math.abs(this.v) < 0.6) {
      this.stallTimer += dt;
      if (this.stallTimer > 5 && !this.stallReported) {
        this.stallReported = true;
        this.events.push({ type: 'stall' });
      }
    } else if (Math.abs(this.v) > 1.5) this.stallTimer = 0;

    this.updateCars();
    this.updateTelemetry(accel, dt);
  }

  private updateCars(): void {
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i]!;
      const off = this.carOffsets[i]!;
      c.centre = this.at(off, this.s);
      c.front = this.at(off + this.halfWheelbase, this.s);
      c.rear = this.at(off - this.halfWheelbase, this.s);
      c.section = this.track.sample(c.centre, this.smp).kind;
    }
  }

  /** Mechanical energy: ½ M_eff v² + Σ m_j g y_j. */
  energyAt(s: number, v: number): { kinetic: number; potential: number } {
    let pe = 0;
    for (const b of this.bogies) {
      this.track.sample(this.at(b.offset, s), this.smp);
      pe += b.mass * this.params.gravity * this.smp.pos[1];
    }
    return { kinetic: 0.5 * this.massEff * v * v, potential: pe };
  }

  private updateTelemetry(accel: number, dt: number): void {
    const t = this.telemetry;
    const e = this.energyAt(this.s, this.v);
    t.kinetic = e.kinetic;
    t.potential = e.potential;
    t.energy = e.kinetic + e.potential;
    t.speed = this.v;
    t.accel = accel;
    // Apparent force on a rider in the front carriage.
    const smp = this.track.sample(this.cars[0]?.centre ?? this.s, this.smp);
    const gv = this.gv;
    const v = this.v;
    gv[0] = accel * smp.tan[0] + v * v * smp.curv[0];
    gv[1] = accel * smp.tan[1] + v * v * smp.curv[1] + this.params.gravity;
    gv[2] = accel * smp.tan[2] + v * v * smp.curv[2];
    t.gVert = dot(gv, smp.up) / G0;
    t.gLat = dot(gv, smp.right) / G0;
    t.gLong = dot(gv, smp.tan) / G0;
    t.height = smp.pos[1];
    if (dt > 0) {
      const j = (t.gVert - this.prevGVert) / dt;
      t.jerk = t.jerk + (j - t.jerk) * Math.min(1, dt * 20);
    }
    this.prevGVert = t.gVert;
  }

  /** Snapshot for determinism checks and save/restore. */
  snapshot(): { s: number; v: number; state: RideState; holdTimer: number; time: number } {
    return { s: this.s, v: this.v, state: this.state, holdTimer: this.holdTimer, time: this.time };
  }
}

function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return Math.min(target, v + maxDelta);
  return Math.max(target, v - maxDelta);
}

export function clampCars(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.min(MAX_CARS, Math.max(MIN_CARS, Math.round(n)));
}

export function sanitiseParams(p: Partial<PhysicsParams>): PhysicsParams {
  const out = { ...DEFAULT_PHYSICS } as PhysicsParams;
  const ranges: Record<keyof PhysicsParams, [number, number]> = {
    gravity: [1, 30],
    rollingCoeff: [0, 0.05],
    dragScale: [0, 4],
    airDensity: [0.5, 2],
    trailingDragFraction: [0, 1],
    liftSpeed: [0, 10],
    launchAccel: [1, 20],
    brakeDecel: [1, 12],
    windX: [-20, 20],
    windZ: [-20, 20],
    dwell: [1, 60],
  };
  for (const k of Object.keys(ranges) as Array<keyof PhysicsParams>) {
    const v = p[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(ranges[k][1], Math.max(ranges[k][0], v));
  }
  return out;
}
