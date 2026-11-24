/** Fallback values used when a save or settings record is missing data. */
import type { EnvironmentState, Settings } from '../../types/world';
import type { SupportStyle, TrackColours, TrackStyle } from '../../engine/track/types';
import type { CarStyle, Finish, TrainColours, TrainConfig } from '../../engine/train/config';

export const DEFAULT_SAVE_NAME = 'Untitled park';
export const DEFAULT_COASTER_NAME = 'My coaster';

export const DEFAULT_ENVIRONMENT: Readonly<EnvironmentState> = Object.freeze({
  biome: 'meadow',
  seed: 2026,
  weather: 'clear',
  time: 'afternoon',
  autoCycle: false,
  environmentalPhysics: false,
});

export const DEFAULT_TRACK_STYLE: TrackStyle = 'tubular';
export const DEFAULT_SUPPORT_STYLE: SupportStyle = 'powder-steel';

export const DEFAULT_TRACK_COLOURS: Readonly<TrackColours> = Object.freeze({
  rail: '#C77D62',
  spine: '#C77D62',
  sleeper: '#765B48',
  support: '#F5EBDD',
});

export const DEFAULT_CAR_STYLE: CarStyle = 'steel';
export const DEFAULT_FINISH: Finish = 'satin';
export const DEFAULT_CARS = 4;

export const DEFAULT_TRAIN_COLOURS: Readonly<TrainColours> = Object.freeze({
  primary: '#8DAABB',
  secondary: '#F5EBDD',
  seat: '#343C37',
  trim: '#E5C579',
  wheels: '#3A3F3B',
});

export function defaultTrain(): TrainConfig {
  return { cars: DEFAULT_CARS, style: DEFAULT_CAR_STYLE, colours: { ...DEFAULT_TRAIN_COLOURS }, finish: DEFAULT_FINISH };
}

export function defaultSettings(): Settings {
  return {
    audio: { master: 0.8, ui: 0.7, construction: 0.7, coaster: 0.8, environment: 0.7, music: 0.5, muted: false },
    accessibility: {
      reducedMotion: false,
      cameraStabilisation: false,
      largerUi: false,
      highContrast: false,
      simplifiedControls: false,
      haptics: true,
      disableShake: false,
      disableDof: false,
      disableAutoCamera: false,
    },
    graphics: {
      tier: 'auto',
      resolution: 1,
      shadows: 'high',
      vegetation: 1,
      weatherDensity: 1,
      drawDistance: 1,
      antialias: true,
      postProcessing: true,
      fpsCap: 0,
    },
    telemetry: false,
    showDiagnostics: false,
    onboardingDone: false,
  };
}
