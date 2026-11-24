import type { V3 } from '../engine/core/vec3';
import type { TrackDesign } from '../engine/track/types';
import type { PhysicsParams, TrainConfig } from '../engine/train/config';

export type Biome = 'meadow' | 'woodland' | 'alpine' | 'coastal' | 'autumn' | 'winter';
export const BIOMES: readonly Biome[] = ['meadow', 'woodland', 'alpine', 'coastal', 'autumn', 'winter'];

export type Weather = 'clear' | 'partly-cloudy' | 'overcast' | 'light-rain' | 'rain' | 'snow' | 'mist' | 'golden-haze';
export const WEATHERS: readonly Weather[] = ['clear', 'partly-cloudy', 'overcast', 'light-rain', 'rain', 'snow', 'mist', 'golden-haze'];

export type TimeOfDay = 'sunrise' | 'morning' | 'midday' | 'afternoon' | 'golden' | 'blue' | 'night';
export const TIMES: readonly TimeOfDay[] = ['sunrise', 'morning', 'midday', 'afternoon', 'golden', 'blue', 'night'];

/** Hour of day represented by each preset (0–24). */
export const TIME_HOURS: Record<TimeOfDay, number> = {
  sunrise: 6.2,
  morning: 9,
  midday: 12.5,
  afternoon: 15.5,
  golden: 18.4,
  blue: 19.6,
  night: 23,
};

export interface EnvironmentState {
  biome: Biome;
  seed: number;
  weather: Weather;
  time: TimeOfDay;
  /** Optional automatic day/night cycle. */
  autoCycle: boolean;
  /** Gentle wind and weather-dependent resistance (documented approximation). Off by default. */
  environmentalPhysics: boolean;
}

export type SceneryType =
  | 'pine'
  | 'oak'
  | 'birch'
  | 'bush'
  | 'flowers'
  | 'rock'
  | 'grass'
  | 'bench'
  | 'lantern'
  | 'fence'
  | 'sign'
  | 'hut';
export const SCENERY_TYPES: readonly SceneryType[] = ['pine', 'oak', 'birch', 'bush', 'flowers', 'rock', 'grass', 'bench', 'lantern', 'fence', 'sign', 'hut'];

export interface SceneryItem {
  id: string;
  type: SceneryType;
  /** Logical world position; y is resolved from terrain when placed. */
  p: V3;
  /** Yaw in radians. */
  rot: number;
  scale: number;
}

export type TerrainBrush = 'raise' | 'lower' | 'smooth' | 'flatten' | 'paint-path' | 'clear-vegetation';

export interface TerrainStroke {
  mode: TerrainBrush;
  x: number;
  z: number;
  radius: number;
  /** Signed metres for raise/lower; target height for flatten; 0–1 for paint. */
  strength: number;
}

export interface CameraBookmark {
  target: V3;
  distance: number;
  yaw: number;
  pitch: number;
}

/** Version 1 of the persisted world. Canonical design data only: meshes are regenerated on load. */
export interface SaveDataV1 {
  schema: 1;
  id: string;
  name: string;
  created: number;
  updated: number;
  coasterName: string;
  environment: EnvironmentState;
  track: TrackDesign;
  train: TrainConfig;
  physics: Partial<PhysicsParams>;
  scenery: SceneryItem[];
  terrainEdits: TerrainStroke[];
  camera?: CameraBookmark;
  /** Small JPEG data URL for the save list. Optional. */
  thumbnail?: string;
}

export type SaveData = SaveDataV1;
export const CURRENT_SCHEMA = 1;

export type QualityTier = 'auto' | 'battery' | 'balanced' | 'high' | 'ultra';

export interface AudioSettings {
  master: number;
  ui: number;
  construction: number;
  coaster: number;
  environment: number;
  music: number;
  muted: boolean;
}

export interface AccessibilitySettings {
  reducedMotion: boolean;
  cameraStabilisation: boolean;
  largerUi: boolean;
  highContrast: boolean;
  simplifiedControls: boolean;
  haptics: boolean;
  disableShake: boolean;
  disableDof: boolean;
  disableAutoCamera: boolean;
}

export interface GraphicsSettings {
  tier: QualityTier;
  /** 0.5–1 multiplier on device pixel ratio cap. */
  resolution: number;
  shadows: 'off' | 'low' | 'high';
  vegetation: number;
  weatherDensity: number;
  drawDistance: number;
  antialias: boolean;
  postProcessing: boolean;
  fpsCap: 30 | 60 | 0;
}

export interface Settings {
  audio: AudioSettings;
  accessibility: AccessibilitySettings;
  graphics: GraphicsSettings;
  telemetry: boolean;
  showDiagnostics: boolean;
  onboardingDone: boolean;
}
