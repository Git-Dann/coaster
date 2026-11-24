import { Autosaver, SaveStore, attachLifecycleFlush, sanitizeSettings } from '../features/saves';
import { useGame } from '../stores/game';
import { services } from './services';

const LAST_KEY = 'cozy-coaster:last-save';

function lastId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
function setLastId(id: string): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* storage unavailable: fine */
  }
}

let thumbAt = 0;
let thumb: string | undefined;

/** Thin app-level wrapper around the saves module: one store, one autosaver. */
export const saves = {
  store: new SaveStore(),
  saver: null as Autosaver | null,
  available: false,
  async init(): Promise<void> {
    this.available = await this.store.open();
    if (!this.available) {
      useGame.getState().toast("Saving isn't available in this browser mode, so your park won't be kept. Export it to keep a copy.");
      return;
    }
    this.saver = new Autosaver(this.store, { debounceMs: 1500, maxWaitMs: 10000 });
    this.saver.onStatus((st) => {
      useGame.setState({ saveStatus: st.state });
      if (st.state === 'error') useGame.getState().toast(st.message);
    });
    attachLifecycleFlush(this.saver);
    const settings = await this.store.getSettings();
    const clean = settings ? sanitizeSettings(settings) : null;
    if (clean) useGame.setState({ settings: clean });
    const id = lastId();
    if (id) {
      const r = await this.store.load(id);
      if (r.ok) {
        useGame.getState().loadSave(r.save);
        useGame.setState({ returning: true });
        if (r.recovered) {
          useGame.getState().toast('We restored your park from its most recent good copy.');
          void this.store.put(r.save);
        }
      }
    }
  },
  schedule(): void {
    if (!this.saver) return;
    const now = performance.now();
    if (services.engine && now - thumbAt > 60000) {
      thumbAt = now;
      try {
        thumb = services.engine.capture('image/jpeg', 256);
      } catch {
        /* thumbnails are optional */
      }
    }
    setLastId(useGame.getState().saveId);
    this.saver.schedule(() => useGame.getState().toSave(thumb));
  },
  async flush(): Promise<void> {
    await this.saver?.flush();
  },
  list() {
    return this.store.list();
  },
};

/** Watch the store for meaningful changes and autosave; settings save separately. */
export function watchForSaves(): () => void {
  let prev = useGame.getState();
  let settingsTimer = 0;
  return useGame.subscribe((s) => {
    const p = prev;
    prev = s;
    if (
      s.design !== p.design ||
      s.train !== p.train ||
      s.env !== p.env ||
      s.scenery !== p.scenery ||
      s.terrainEdits !== p.terrainEdits ||
      s.physics !== p.physics ||
      s.coasterName !== p.coasterName ||
      s.saveName !== p.saveName ||
      s.saveId !== p.saveId
    )
      saves.schedule();
    if (s.settings !== p.settings && saves.available) {
      window.clearTimeout(settingsTimer);
      settingsTimer = window.setTimeout(() => void saves.store.putSettings(useGame.getState().settings), 600);
    }
  });
}
