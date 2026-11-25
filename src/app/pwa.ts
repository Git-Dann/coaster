import { useGame } from '../stores/game';
import { saves } from './persistence';

/**
 * Registers the service worker in production. New versions wait politely: the player gets a
 * gentle "update" action, saves are flushed first, and the page never reloads mid-build.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      // Only reload when the player tapped "Update". The first install also changes the
      // controller (the worker claims the page), and that must never reload a fresh visit.
      let updateAccepted = false;
      const offer = (worker: ServiceWorker) => {
        useGame.getState().toast('A fresh version of Cozy Coaster is ready.', {
          label: 'Update',
          run: async () => {
            await saves.flush();
            updateAccepted = true;
            worker.postMessage({ type: 'SKIP_WAITING' });
          },
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) offer(nw);
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading || !updateAccepted) return;
        reloading = true;
        location.reload();
      });
      // Check for updates occasionally while open.
      setInterval(() => void reg.update(), 30 * 60 * 1000);
    } catch (e) {
      console.warn('Service worker registration failed', e);
    }
  });
}
