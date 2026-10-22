import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../src/renderer/core/bus';
import { createStatus } from '../src/renderer/core/status';

interface TestEvents {
  ping: void;
  data: { n: number };
  maybe: { x: number } | void;
}

afterEach(() => vi.restoreAllMocks());

describe('createBus', () => {
  it('delivers payloads to every handler in registration order', () => {
    const bus = createBus<TestEvents>();
    const calls: string[] = [];
    bus.on('data', ({ n }) => calls.push(`a${n}`));
    bus.on('data', ({ n }) => calls.push(`b${n}`));
    bus.on('ping', () => calls.push('ping'));
    bus.emit('data', { n: 1 });
    bus.emit('ping');
    expect(calls).toEqual(['a1', 'b1', 'ping']);
  });

  it('supports optional payloads', () => {
    const bus = createBus<TestEvents>();
    const seen: unknown[] = [];
    bus.on('maybe', (p) => seen.push(p));
    bus.emit('maybe');
    bus.emit('maybe', { x: 2 });
    expect(seen).toEqual([undefined, { x: 2 }]);
  });

  it('returns an unsubscribe function', () => {
    const bus = createBus<TestEvents>();
    const fn = vi.fn();
    const off = bus.on('ping', fn);
    bus.emit('ping');
    off();
    bus.emit('ping');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps going when a handler throws', () => {
    const bus = createBus<TestEvents>();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    bus.on('ping', after);
    bus.emit('ping');
    expect(after).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('ignores handlers added while emitting until the next emit', () => {
    const bus = createBus<TestEvents>();
    const late = vi.fn();
    bus.on('ping', () => bus.on('ping', late));
    bus.emit('ping');
    expect(late).not.toHaveBeenCalled();
    bus.emit('ping');
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('emitting an event nobody listens to is a no-op', () => {
    expect(() => createBus<TestEvents>().emit('data', { n: 0 })).not.toThrow();
  });
});

describe('createStatus', () => {
  it('reads registered getters and defaults to false', () => {
    const status = createStatus();
    let replying = false;
    status.provide('replying', () => replying);
    expect(status.get('replying')).toBe(false);
    expect(status.get('menuOpen')).toBe(false);
    replying = true;
    expect(status.get('replying')).toBe(true);
  });

  it('busy() covers replying, dragging, menu, settings and typing but not voice or focus', () => {
    const status = createStatus();
    status.provide('voiceActive', () => true);
    status.provide('focusing', () => true);
    expect(status.busy()).toBe(false);
    for (const key of ['replying', 'dragging', 'menuOpen', 'settingsOpen', 'typing'] as const) {
      const s = createStatus();
      s.provide(key, () => true);
      expect(s.busy()).toBe(true);
    }
  });
});
