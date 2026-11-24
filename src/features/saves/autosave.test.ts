import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Autosaver } from './autosave';
import type { AutosaveStatus, SaveSink } from './autosave';
import type { SaveData } from '../../types/world';
import { makeTestSave } from './test-helpers';

type PutResult = { ok: true } | { ok: false; message: string };

/** Fake store whose writes complete only when the test resolves them. */
class FakeSink implements SaveSink {
  calls: SaveData[] = [];
  private resolvers: ((r: PutResult) => void)[] = [];
  auto = true;
  put(save: SaveData): Promise<PutResult> {
    this.calls.push(save);
    if (this.auto) return Promise.resolve({ ok: true });
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  resolveNext(r: PutResult = { ok: true }) {
    this.resolvers.shift()?.(r);
  }
  get waiting() {
    return this.resolvers.length;
  }
}

let version = 0;
const nextSave = () => makeTestSave({ updated: ++version });

describe('Autosaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    version = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('debounces bursts of changes into one save', async () => {
    const sink = new FakeSink();
    const saver = new Autosaver(sink, { debounceMs: 1500, maxWaitMs: 10_000 });
    for (let i = 0; i < 5; i++) {
      saver.schedule(nextSave);
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(sink.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.updated).toBe(1); // getSave called lazily, once
  });

  test('getSave is evaluated lazily at write time', async () => {
    const sink = new FakeSink();
    const saver = new Autosaver(sink, { debounceMs: 100 });
    let n = 0;
    saver.schedule(() => makeTestSave({ updated: n }));
    n = 42;
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.calls[0]?.updated).toBe(42);
  });

  test('max-wait forces a save during continuous editing', async () => {
    const sink = new FakeSink();
    const saver = new Autosaver(sink, { debounceMs: 1500, maxWaitMs: 10_000 });
    for (let i = 0; i < 9; i++) {
      saver.schedule(nextSave);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(sink.calls).toHaveLength(0); // t = 9000: debounce never elapsed
    saver.schedule(nextSave);
    await vi.advanceTimersByTimeAsync(999);
    expect(sink.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); // t = 10000: max-wait reached
    expect(sink.calls).toHaveLength(1);
  });

  test('flush writes immediately and waits for completion', async () => {
    const sink = new FakeSink();
    const saver = new Autosaver(sink, { debounceMs: 1500 });
    saver.schedule(nextSave);
    await saver.flush();
    expect(sink.calls).toHaveLength(1);
    expect(saver.status.state).toBe('saved');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sink.calls).toHaveLength(1); // the debounce timer was cancelled
  });

  test('flush with nothing pending is a no-op', async () => {
    const sink = new FakeSink();
    const saver = new Autosaver(sink);
    await saver.flush();
    expect(sink.calls).toHaveLength(0);
  });

  test('only one write in flight; changes during it are queued and coalesced', async () => {
    const sink = new FakeSink();
    sink.auto = false;
    const saver = new Autosaver(sink, { debounceMs: 100 });
    saver.schedule(nextSave);
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.calls).toHaveLength(1);

    saver.schedule(() => makeTestSave({ updated: 2 }));
    await vi.advanceTimersByTimeAsync(100);
    saver.schedule(() => makeTestSave({ updated: 3 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(sink.calls).toHaveLength(1); // still waiting on the first write
    expect(sink.waiting).toBe(1);

    sink.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.calls).toHaveLength(2);
    expect(sink.calls[1]?.updated).toBe(3); // the latest state
    sink.resolveNext();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.calls).toHaveLength(2);
    expect(saver.status.state).toBe('saved');
  });

  test('flush waits for an in-flight write then writes queued changes', async () => {
    const sink = new FakeSink();
    sink.auto = false;
    const saver = new Autosaver(sink, { debounceMs: 100 });
    saver.schedule(nextSave);
    await vi.advanceTimersByTimeAsync(100);
    saver.schedule(nextSave);
    let flushed = false;
    const p = saver.flush().then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);
    sink.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.calls).toHaveLength(2);
    sink.resolveNext();
    await p;
    expect(flushed).toBe(true);
  });

  test('reports statuses, including errors', async () => {
    const sink = new FakeSink();
    sink.auto = false;
    const saver = new Autosaver(sink, { debounceMs: 100 });
    const seen: AutosaveStatus['state'][] = [];
    const messages: string[] = [];
    saver.onStatus((s) => {
      seen.push(s.state);
      if (s.state === 'error') messages.push(s.message);
    });
    saver.schedule(nextSave);
    await vi.advanceTimersByTimeAsync(100);
    sink.resolveNext({ ok: false, message: 'quota!' });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(['pending', 'saving', 'error']);
    expect(messages).toEqual(['quota!']);

    saver.schedule(nextSave);
    await vi.advanceTimersByTimeAsync(100);
    sink.resolveNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.slice(3)).toEqual(['pending', 'saving', 'saved']);
  });

  test('a throwing getSave or sink becomes an error status, not an exception', async () => {
    const saver = new Autosaver({ put: () => Promise.reject(new Error('boom')) }, { debounceMs: 10 });
    saver.schedule(nextSave);
    await saver.flush();
    expect(saver.status).toEqual({ state: 'error', message: 'boom' });
    saver.schedule(() => {
      throw new Error('no state');
    });
    await saver.flush();
    expect(saver.status).toEqual({ state: 'error', message: 'no state' });
  });

  test('works with injected timers', async () => {
    let now = 0;
    const queue: { at: number; fn: () => void; id: number }[] = [];
    let ids = 0;
    const timers = {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++ids;
        queue.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (h: unknown) => {
        const i = queue.findIndex((q) => q.id === h);
        if (i >= 0) queue.splice(i, 1);
      },
    };
    const sink = new FakeSink();
    const saver = new Autosaver(sink, { debounceMs: 1000, maxWaitMs: 3000, timers });
    saver.schedule(nextSave);
    now = 900;
    saver.schedule(nextSave);
    now = 1800;
    saver.schedule(nextSave);
    // Third schedule: remaining max-wait = 3000 - 1800 = 1200 > debounce, so 1000 ms.
    expect(queue).toHaveLength(1);
    expect(queue[0]?.at).toBe(2800);
    now = 2700;
    saver.schedule(nextSave);
    expect(queue[0]?.at).toBe(3000); // capped by max-wait
    now = 3000;
    queue.shift()?.fn();
    await Promise.resolve();
    expect(sink.calls).toHaveLength(1);
  });

  test('dispose cancels pending saves', async () => {
    const sink = new FakeSink();
    const saver = new Autosaver(sink, { debounceMs: 100 });
    saver.schedule(nextSave);
    saver.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.calls).toHaveLength(0);
  });
});
