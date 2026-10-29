import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../src/renderer/core/bus';
import type { AppContext } from '../src/renderer/core/context';
import { chatFeature } from '../src/renderer/features/chat';
import { streamChat } from '../src/renderer/lib/chat-api';
import type { ChatEvent, ChatMessage } from '../src/shared/types';

vi.mock('../src/renderer/lib/chat-api', () => ({ streamChat: vi.fn() }));

const el = () => ({ classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {} });

function setup() {
  const bus = createBus() as AppContext['bus'];
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
    bubble: { say: noop, sayTyping: noop },
    voice: { stop: noop },
    memory: { text: '' },
    menu: { register: noop },
    character: { name: '小鲸', longReply: { chars: 9999, whenLit: [], looks: {}, backMs: 0 }, live2d: { props: {} } },
    dom: { chatForm: el(), chatInput: { value: '', focus: noop }, chatSend: { title: '', addEventListener: noop } },
  } as unknown as AppContext;
  chatFeature(ctx);
  return { bus, store, saved };
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
