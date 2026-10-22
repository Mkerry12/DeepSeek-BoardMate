import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnSettings } from '../src/renderer/lib/chat-api';
import type { ChatMessage, MemoryState } from '../src/shared/types';

vi.mock('../src/renderer/lib/chat-api', () => ({ summarizeMemory: vi.fn() }));

const { summarizeMemory } = await import('../src/renderer/lib/chat-api');
const { createMemory } = await import('../src/renderer/services/memory');
const summarize = vi.mocked(summarizeMemory);

let saved: MemoryState[];

beforeEach(() => {
  saved = [];
  vi.stubGlobal('window', {
    desk: {
      getMemory: vi.fn(async () => ({ text: '- 喜欢猫', pending: 0, updatedAt: 1 })),
      saveMemory: vi.fn(async (m: MemoryState) => void saved.push(structuredClone(m))),
    },
  });
  summarize.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

const history = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }));
const settings =
  (s: object = {}) =>
  () =>
    s as ConnSettings;

describe('createMemory', () => {
  it('loads saved memory', async () => {
    const memory = await createMemory({ getSettings: settings(), getHistory: () => [] });
    expect(memory.text).toBe('- 喜欢猫');
    expect(memory.busy).toBe(false);
  });

  it('summarizes in the background once enough messages accumulate', async () => {
    summarize.mockResolvedValue('- 喜欢狗');
    const msgs = history(100);
    const memory = await createMemory({ getSettings: settings({ mode: 'official' }), getHistory: () => msgs });

    memory.added(39);
    expect(summarize).not.toHaveBeenCalled();
    memory.added(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(memory.busy).toBe(true);

    const [conn, oldText, messages] = summarize.mock.calls[0];
    expect(conn).toEqual({ mode: 'official' });
    expect(oldText).toBe('- 喜欢猫');
    expect(messages).toEqual(msgs.slice(-40));

    await vi.waitFor(() => expect(memory.busy).toBe(false));
    expect(memory.text).toBe('- 喜欢狗');
    expect(saved.at(-1)).toMatchObject({ text: '- 喜欢狗', pending: 0 });
  });

  it('keeps the old text when the summary is empty', async () => {
    summarize.mockResolvedValue('');
    const memory = await createMemory({ getSettings: settings(), getHistory: () => history(5) });
    expect(await memory.summarize()).toBe('- 喜欢猫');
  });

  it('shares one in-flight summarize call', async () => {
    summarize.mockResolvedValue('x');
    const memory = await createMemory({ getSettings: settings(), getHistory: () => history(5) });
    const a = memory.summarize();
    const b = memory.summarize();
    expect(a).toBe(b);
    await a;
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('clear wipes the note', async () => {
    const memory = await createMemory({ getSettings: settings(), getHistory: () => [] });
    memory.clear();
    expect(memory.text).toBe('');
    expect(saved.at(-1)).toMatchObject({ text: '', pending: 0 });
  });
});
