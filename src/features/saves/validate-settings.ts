/** Lenient sanitiser for the persisted Settings record: merges valid fields over defaults. */
import type { QualityTier, Settings } from '../../types/world';
import { defaultSettings } from './defaults';
import { isRecord } from './validate';

function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === v) ?? fallback;
}

const TIERS: readonly QualityTier[] = ['auto', 'battery', 'balanced', 'high', 'ultra'];
const SHADOWS = ['off', 'low', 'high'] as const;
const FPS_CAPS = [30, 60, 0] as const;

/** Returns a fresh Settings object, or null when the input is not an object at all. */
export function sanitizeSettings(input: unknown): Settings | null {
  if (!isRecord(input)) return null;
  const d = defaultSettings();
  const a = isRecord(own(input, 'audio')) ? (own(input, 'audio') as Record<string, unknown>) : {};
  const x = isRecord(own(input, 'accessibility')) ? (own(input, 'accessibility') as Record<string, unknown>) : {};
  const g = isRecord(own(input, 'graphics')) ? (own(input, 'graphics') as Record<string, unknown>) : {};
  return {
    audio: {
      master: num(own(a, 'master'), d.audio.master, 0, 1),
      ui: num(own(a, 'ui'), d.audio.ui, 0, 1),
      construction: num(own(a, 'construction'), d.audio.construction, 0, 1),
      coaster: num(own(a, 'coaster'), d.audio.coaster, 0, 1),
      environment: num(own(a, 'environment'), d.audio.environment, 0, 1),
      music: num(own(a, 'music'), d.audio.music, 0, 1),
      muted: bool(own(a, 'muted'), d.audio.muted),
    },
    accessibility: {
      reducedMotion: bool(own(x, 'reducedMotion'), d.accessibility.reducedMotion),
      cameraStabilisation: bool(own(x, 'cameraStabilisation'), d.accessibility.cameraStabilisation),
      largerUi: bool(own(x, 'largerUi'), d.accessibility.largerUi),
      highContrast: bool(own(x, 'highContrast'), d.accessibility.highContrast),
      simplifiedControls: bool(own(x, 'simplifiedControls'), d.accessibility.simplifiedControls),
      haptics: bool(own(x, 'haptics'), d.accessibility.haptics),
      disableShake: bool(own(x, 'disableShake'), d.accessibility.disableShake),
      disableDof: bool(own(x, 'disableDof'), d.accessibility.disableDof),
      disableAutoCamera: bool(own(x, 'disableAutoCamera'), d.accessibility.disableAutoCamera),
    },
    graphics: {
      tier: oneOf(own(g, 'tier'), TIERS, d.graphics.tier),
      resolution: num(own(g, 'resolution'), d.graphics.resolution, 0.5, 1),
      shadows: oneOf(own(g, 'shadows'), SHADOWS, d.graphics.shadows),
      vegetation: num(own(g, 'vegetation'), d.graphics.vegetation, 0, 4),
      weatherDensity: num(own(g, 'weatherDensity'), d.graphics.weatherDensity, 0, 4),
      drawDistance: num(own(g, 'drawDistance'), d.graphics.drawDistance, 0, 4),
      antialias: bool(own(g, 'antialias'), d.graphics.antialias),
      postProcessing: bool(own(g, 'postProcessing'), d.graphics.postProcessing),
      fpsCap: oneOf(own(g, 'fpsCap'), FPS_CAPS, d.graphics.fpsCap),
    },
    telemetry: bool(own(input, 'telemetry'), d.telemetry),
    showDiagnostics: bool(own(input, 'showDiagnostics'), d.showDiagnostics),
    onboardingDone: bool(own(input, 'onboardingDone'), d.onboardingDone),
  };
}
