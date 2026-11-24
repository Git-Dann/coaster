import type { Engine } from '../engine/core/engine';
import type { UiSound } from '../engine/audio/types';

/**
 * Late-bound handles to long-lived services so UI components can trigger sounds or engine
 * actions without threading props everywhere. Never used for per-frame data.
 */
export const services: { engine: Engine | null; haptics: boolean } = { engine: null, haptics: true };

export function ui(sound: UiSound): void {
  services.engine?.audio.ui(sound);
  if (services.haptics && (sound === 'select' || sound === 'success' || sound === 'circuit-complete') && 'vibrate' in navigator) {
    // Best effort only: supported on some Android browsers, ignored elsewhere (including iOS Safari).
    try {
      navigator.vibrate(sound === 'select' ? 6 : 14);
    } catch {
      /* unsupported */
    }
  }
}
