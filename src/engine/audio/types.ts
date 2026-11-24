/** Public audio types. Re-exported from `audio-engine.ts`; kept separate so recipe modules can import them without cycles. */

export type UiSound =
  | 'tap'
  | 'select'
  | 'toggle'
  | 'slider'
  | 'open'
  | 'close'
  | 'undo'
  | 'redo'
  | 'save'
  | 'colour'
  | 'material'
  | 'carriage-add'
  | 'carriage-remove'
  | 'error-soft'
  | 'success'
  | 'circuit-complete';

export type BuildMaterial = 'timber' | 'steel';

export type BuildSound = 'snap' | 'place' | 'delete' | 'preview-tick';

export interface CoasterAudioState {
  /** m/s, signed (train velocity along track). */
  speed: number;
  /** Chain lift pulling the train. */
  liftEngaged: boolean;
  /** 0..1 brake intensity. */
  braking: number;
  launching: boolean;
  /** Track/support material, changes timbre (timber rumble vs steel ring). */
  material: BuildMaterial;
  /** Metres from camera to train (0 when riding). */
  distance: number;
  /** -1..1 stereo position of train relative to camera. */
  pan: number;
  /** Camera is on the train (more wind, closer wheels). */
  riding: boolean;
  /** Apparent vertical G (airtime < 0.3 adds a soft whoosh). */
  verticalG: number;
  inStation: boolean;
}

export type Biome = 'meadow' | 'woodland' | 'alpine' | 'coastal' | 'autumn' | 'winter';
export type Weather = 'clear' | 'partly-cloudy' | 'overcast' | 'light-rain' | 'rain' | 'snow' | 'mist' | 'golden-haze';

export interface EnvironmentAudioState {
  biome: Biome;
  weather: Weather;
  /** 0..24 (night 21–5: insects instead of birds). */
  hour: number;
  /** 0..1 proximity to river/sea. */
  water: number;
  /** Metres above ground, more wind higher up. */
  cameraHeight: number;
}

/** Each channel 0..1. */
export interface Volumes {
  master: number;
  ui: number;
  construction: number;
  coaster: number;
  environment: number;
  music: number;
  muted: boolean;
}
