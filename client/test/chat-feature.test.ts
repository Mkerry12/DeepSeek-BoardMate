import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../src/renderer/core/bus';
import type { AppContext } from '../src/renderer/core/context';
import { chatFeature } from '../src/renderer/features/chat';
import { streamChat } from '../src/renderer/lib/chat-api';
import type { VoiceTrack } from '../src/renderer/services/voice';
import type { ChatEvent, ChatMessage } from '../src/shared/types';

vi.mock('../src/renderer/lib/chat-api', () => ({ streamChat: vi.fn() }));

const el = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {} });

function setup({ voiced = false } = {}) {
  const bus = createBus() as AppContext['bus'];
  const says: [string, number | undefined][] = [];
  const tracks: VoiceTrack[] = [];
  const saved: ChatMessage[][] = [];
  const store = {
    settings: {},
    history: [] as ChatMessage[],
    saveHistory() {
      saved.push(structuredClone(store.history));
    },
  };
  const noop = () => {};
  const ctx = {
    bus,
    store,
    status: { provide: noop },
    pet: {
      flash: noop,
      react: noop,
      setBase: noop,
      setNotes: noop,
      setLayer: noop,
      setTalking: noop,
      isLit: () => false,
    },
    bubble: { say: (text: string, hold?: number) => says.push([text, hold]), sayTyping: noop },
    voice: {
      stop: () => tracks.at(-1)?.fail(),
      track: (t: VoiceTrack) => {
        tracks.push(t);
        return voiced;
      },
    },
    memory: { text: '' },
    menu: { register: noop },
    character: { name: '小鲸', longReply: { chars: 9999, whenLit: [], looks: {}, backMs: 0 }, live2d: { props: {} } },
    dom: { chatForm: el(), chatInput: { value: '', focus: noop }, chatSend: { title: '', addEventListener: noop } },
  } as unknown as AppContext;
  chatFeature(ctx);
  return { bus, store, saved, says, tracks };
}

async function* twoSentences(): AsyncGenerator<ChatEvent> {
  yield { type: 'delta', text: '今天天气不错。' };
  yield { type: 'delta', text: '我们出去吧。' };
  yield { type: 'done' };
}

// （可选）先吐一段，然后一直等到被中断
async function* hangingReply(signal: AbortSignal | undefined, partial = true): AsyncGenerator<ChatEvent> {
  if (partial) yield { type: 'delta', text: '想一' };
  await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
}

async function* quickReply(): AsyncGenerator<ChatEvent> {
  yield { type: 'delta', text: '好呀' };
  yield { type: 'done' };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('chat send while a reply is streaming', () => {
  it('keeps the partial reply so user/assistant still alternate', async () => {
    const mock = vi.mocked(streamChat);
    mock.mockImplementationOnce((_s, _m, signal) => hangingReply(signal));
    mock.mockImplementationOnce(() => quickReply());
    const { bus, store, saved } = setup();

    bus.emit('chat:send', { text: '第一句' });
    await tick();
    bus.emit('chat:send', { text: '第二句' });
    await tick();
    await tick();

    expect(mock.mock.calls[1][1]).toEqual([
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '想一' },
      { role: 'user', content: '第二句' },
    ]);
    const expected = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '想一' },
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '好呀' },
    ];
    expect(store.history).toEqual(expected);
    expect(saved.at(-1)).toEqual(expected);
  });

  it('drops the dangling user message when the old request had no reply yet', async () => {
    const mock = vi.mocked(streamChat);
    mock.mockImplementationOnce((_s, _m, signal) => hangingReply(signal, false));
    mock.mockImplementationOnce(() => quickReply());
    const { bus, store } = setup();

    bus.emit('chat:send', { text: '第一句' });
    await tick();
    bus.emit('chat:send', { text: '第二句' });
    await tick();
    await tick();

    expect(store.history).toEqual([
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '好呀' },
    ]);
  });
});

describe('chat bubble while the reply is read aloud', () => {
  it('streams text as before when voice is off', async () => {
    vi.mocked(streamChat).mockImplementationOnce(() => twoSentences());
    const { bus, says } = setup();
    bus.emit('chat:send', { text: '出去吗' });
    await vi.waitFor(() => expect(says.at(-1)).toEqual(['今天天气不错。我们出去吧。', 6000]));
    expect(says[0]).toEqual(['今天天气不错。', undefined]);
  });

  it('reveals sentences with the voice and hides only after the last one', async () => {
    vi.mocked(streamChat).mockImplementationOnce(() => twoSentences());
    const { bus, store, says, tracks } = setup({ voiced: true });
    bus.emit('chat:send', { text: '出去吗' });
    await vi.waitFor(() => expect(store.history).toHaveLength(2));
    expect(store.history[1].content).toBe('今天天气不错。我们出去吧。');
    expect(says).toEqual([]);
    tracks[0].show('今天天气不错。');
    expect(says).toEqual([['今天天气不错。', undefined]]);
    tracks[0].show('我们出去吧。');
    tracks[0].done();
    expect(says.at(-1)).toEqual(['今天天气不错。我们出去吧。', 6000]);
  });

  it('shows the full text at once when the voice fails', async () => {
    vi.mocked(streamChat).mockImplementationOnce(() => twoSentences());
    const { bus, store, says, tracks } = setup({ voiced: true });
    bus.emit('chat:send', { text: '出去吗' });
    await vi.waitFor(() => expect(store.history).toHaveLength(2));
    tracks[0].fail();
    expect(says).toEqual([['今天天气不错。我们出去吧。', 6000]]);
    tracks[0].done();
    expect(says).toHaveLength(1);
  });
});
