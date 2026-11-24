export type CarStyle = 'timber' | 'retro' | 'steel' | 'expedition' | 'open' | 'mine';

/** Physical configuration of a single carriage style. SI units. */
export interface CarProfile {
  label: string;
  /** Empty carriage mass, kg. */
  mass: number;
  /** Body length, m. */
  bodyLength: number;
  /** Centre-to-centre spacing between consecutive carriages, m (body + coupling). */
  pitch: number;
  /** Distance between front and rear bogie centres, m. */
  wheelbase: number;
  /** Running wheel radius, m. */
  wheelRadius: number;
  /** Running (load) wheels per carriage. */
  runningWheels: number;
  /** Mass of one running wheel, kg (for rotational inertia, solid disc approximation). */
  wheelMass: number;
  /** Frontal drag area of the lead carriage Cd·A, m². */
  cdA: number;
  /** Rows of seats. */
  rows: number;
}

export const CAR_PROFILES: Record<CarStyle, CarProfile> = {
  timber: { label: 'Classic timber', mass: 780, bodyLength: 2.5, pitch: 2.9, wheelbase: 1.7, wheelRadius: 0.2, runningWheels: 4, wheelMass: 14, cdA: 1.05, rows: 2 },
  retro: { label: 'Retro rounded', mass: 720, bodyLength: 2.4, pitch: 2.8, wheelbase: 1.6, wheelRadius: 0.19, runningWheels: 4, wheelMass: 13, cdA: 0.95, rows: 2 },
  steel: { label: 'Modern steel', mass: 850, bodyLength: 2.6, pitch: 3.0, wheelbase: 1.8, wheelRadius: 0.21, runningWheels: 4, wheelMass: 15, cdA: 1.0, rows: 2 },
  expedition: { label: 'Expedition', mass: 900, bodyLength: 2.8, pitch: 3.2, wheelbase: 1.9, wheelRadius: 0.22, runningWheels: 4, wheelMass: 16, cdA: 1.15, rows: 2 },
  open: { label: 'Minimal open', mass: 560, bodyLength: 2.2, pitch: 2.6, wheelbase: 1.5, wheelRadius: 0.18, runningWheels: 4, wheelMass: 12, cdA: 0.8, rows: 2 },
  mine: { label: 'Vintage mine train', mass: 820, bodyLength: 2.5, pitch: 2.9, wheelbase: 1.6, wheelRadius: 0.2, runningWheels: 4, wheelMass: 15, cdA: 1.1, rows: 2 },
};

export interface TrainColours {
  primary: string;
  secondary: string;
  seat: string;
  trim: string;
  wheels: string;
}

export type Finish = 'matte' | 'satin' | 'gloss';

export interface TrainConfig {
  cars: number;
  style: CarStyle;
  colours: TrainColours;
  finish: Finish;
}

/** Tunable physical parameters. Defaults are documented in docs/physics.md. */
export interface PhysicsParams {
  gravity: number;
  /** Rolling resistance coefficient (dimensionless, × normal force). */
  rollingCoeff: number;
  /** Multiplier on aerodynamic drag (1 = documented default). */
  dragScale: number;
  /** Air density kg/m³. */
  airDensity: number;
  /** Additional drag area contributed by each trailing carriage, as a fraction of the lead car (wake shielding). */
  trailingDragFraction: number;
  /** Chain lift speed override (m/s) — when > 0 replaces per-section values. */
  liftSpeed: number;
  /** Launch acceleration (m/s²). */
  launchAccel: number;
  /** Maximum brake deceleration (m/s²). */
  brakeDecel: number;
  /** Wind speed along +X (m/s) used only when environmental physics is enabled. */
  windX: number;
  windZ: number;
  /** Seconds the train waits in the station before automatic dispatch. */
  dwell: number;
}

export const DEFAULT_PHYSICS: Readonly<PhysicsParams> = Object.freeze({
  gravity: 9.80665,
  rollingCoeff: 0.0045,
  dragScale: 1,
  airDensity: 1.225,
  trailingDragFraction: 0.18,
  liftSpeed: 0,
  launchAccel: 9,
  brakeDecel: 6,
  windX: 0,
  windZ: 0,
  dwell: 7,
});

export const MAX_CARS = 6;
export const MIN_CARS = 1;

export function trainLength(cfg: Pick<TrainConfig, 'cars' | 'style'>): number {
  const p = CAR_PROFILES[cfg.style];
  return (cfg.cars - 1) * p.pitch + p.bodyLength;
}
