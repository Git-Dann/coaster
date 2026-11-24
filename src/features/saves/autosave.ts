/**
 * Debounced autosave with a max-wait, single in-flight write and "latest wins" queueing.
 */
import type { SaveData } from '../../types/world';

/** The subset of SaveStore that the autosaver needs (lets tests pass a fake). */
export interface SaveSink {
  put(save: SaveData): Promise<{ ok: true } | { ok: false; message: string }>;
}

export type AutosaveStatus =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'saving' }
  | { state: 'saved'; at: number }
  | { state: 'error'; message: string };

/** Injectable clock/timers for deterministic tests. */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface AutosaverOptions {
  /** Quiet period after the last change before saving (ms). */
  debounceMs?: number;
  /** Upper bound between the first unsaved change and the save starting (ms). */
  maxWaitMs?: number;
  timers?: TimerApi;
}

const defaultTimers: TimerApi = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
  now: () => Date.now(),
};

export class Autosaver {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly timers: TimerApi;
  private timer: unknown = null;
  /** Time of the first change not yet handed to a write. */
  private firstChangeAt: number | null = null;
  private pending: (() => SaveData) | null = null;
  private inFlight: Promise<void> | null = null;
  private listeners = new Set<(s: AutosaveStatus) => void>();
  private current: AutosaveStatus = { state: 'idle' };
  private disposed = false;

  constructor(
    private readonly sink: SaveSink,
    opts: AutosaverOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 1500;
    this.maxWaitMs = Math.max(opts.maxWaitMs ?? 10_000, this.debounceMs);
    this.timers = opts.timers ?? defaultTimers;
  }

  get status(): AutosaveStatus {
    return this.current;
  }

  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatus(cb: (s: AutosaveStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Notes a meaningful change. `getSave` is called lazily when the write starts,
   * so it should return the latest state.
   */
  schedule(getSave: () => SaveData): void {
    if (this.disposed) return;
    const now = this.timers.now();
    this.pending = getSave;
    this.firstChangeAt ??= now;
    this.clearTimer();
    const remaining = this.maxWaitMs - (now - this.firstChangeAt);
    const delay = Math.max(0, Math.min(this.debounceMs, remaining));
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.kick();
    }, delay);
    if (!this.inFlight) this.setStatus({ state: 'pending' });
  }

  /** Writes any pending change immediately and waits for all writes to finish. */
  async flush(): Promise<void> {
    this.clearTimer();
    while (this.inFlight || this.pending) {
      if (this.inFlight) await this.inFlight;
      else this.kick();
    }
  }

  /** Stops timers and listeners. Pending changes are discarded (call flush first). */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.pending = null;
    this.listeners.clear();
  }

  /** Starts a write unless one is already in flight (then it runs when that completes). */
  private kick(): void {
    if (this.inFlight || !this.pending) return;
    const getSave = this.pending;
    this.pending = null;
    this.firstChangeAt = null;
    this.inFlight = this.write(getSave).finally(() => {
      this.inFlight = null;
      // Queued changes whose timer already fired run now; otherwise their timer will.
      if (this.pending && this.timer === null && !this.disposed) this.kick();
    });
  }

  private async write(getSave: () => SaveData): Promise<void> {
    this.setStatus({ state: 'saving' });
    try {
      const r = await this.sink.put(getSave());
      if (r.ok) this.setStatus(this.pending ? { state: 'pending' } : { state: 'saved', at: this.timers.now() });
      else this.setStatus({ state: 'error', message: r.message });
    } catch (e) {
      this.setStatus({ state: 'error', message: e instanceof Error ? e.message : 'Autosave failed.' });
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(s: AutosaveStatus): void {
    this.current = s;
    for (const cb of [...this.listeners]) {
      try {
        cb(s);
      } catch {
        // a broken listener must not break saving
      }
    }
  }
}

/**
 * Flushes on `visibilitychange` (hidden) and `pagehide`. Returns a detach function.
 * Note: browsers may not wait for async IndexedDB work during unload; hidden usually fires early enough.
 */
export function attachLifecycleFlush(saver: Autosaver, doc: Document = document, win: Window = window): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') void saver.flush();
  };
  const onPageHide = () => void saver.flush();
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onPageHide);
  };
}
