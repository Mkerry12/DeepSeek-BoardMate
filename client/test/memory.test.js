import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/chat.js', () => ({ summarizeMemory: vi.fn() }));

const { summarizeMemory } = await import('../src/renderer/chat.js');
const { createMemory } = await import('../src/renderer/memory.js');

let saved;

beforeEach(() => {
  saved = [];
  vi.stubGlobal('window', {
    desk: {
      getMemory: vi.fn(async () => ({ text: '- 喜欢猫', pending: 0, updatedAt: 1 })),
      saveMemory: vi.fn(async (m) => saved.push(structuredClone(m))),
    },
  });
  summarizeMemory.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

const history = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }));

describe('createMemory', () => {
  it('loads saved memory', async () => {
    const memory = await createMemory({ getSettings: () => ({}), getHistory: () => [] });
    expect(memory.text).toBe('- 喜欢猫');
    expect(memory.busy).toBe(false);
  });

  it('summarizes in the background once enough messages accumulate', async () => {
    summarizeMemory.mockResolvedValue('- 喜欢狗');
    const msgs = history(100);
    const memory = await createMemory({ getSettings: () => ({ mode: 'official' }), getHistory: () => msgs });

    memory.added(39);
    expect(summarizeMemory).not.toHaveBeenCalled();
    memory.added(1);
    expect(summarizeMemory).toHaveBeenCalledTimes(1);
    expect(memory.busy).toBe(true);

    const [settings, oldText, messages] = summarizeMemory.mock.calls[0];
    expect(settings).toEqual({ mode: 'official' });
    expect(oldText).toBe('- 喜欢猫');
    expect(messages).toEqual(msgs.slice(-40));

    await vi.waitFor(() => expect(memory.busy).toBe(false));
    expect(memory.text).toBe('- 喜欢狗');
    expect(saved.at(-1)).toMatchObject({ text: '- 喜欢狗', pending: 0 });
  });

  it('keeps the old text when the summary is empty', async () => {
    summarizeMemory.mockResolvedValue('');
    const memory = await createMemory({ getSettings: () => ({}), getHistory: () => history(5) });
    expect(await memory.summarize()).toBe('- 喜欢猫');
  });

  it('shares one in-flight summarize call', async () => {
    summarizeMemory.mockResolvedValue('x');
    const memory = await createMemory({ getSettings: () => ({}), getHistory: () => history(5) });
    const a = memory.summarize();
    const b = memory.summarize();
    expect(a).toBe(b);
    await a;
    expect(summarizeMemory).toHaveBeenCalledTimes(1);
  });

  it('clear wipes the note', async () => {
    const memory = await createMemory({ getSettings: () => ({}), getHistory: () => [] });
    memory.clear();
    expect(memory.text).toBe('');
    expect(saved.at(-1)).toMatchObject({ text: '', pending: 0 });
  });
});
