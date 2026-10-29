import { afterEach, describe, expect, it, vi } from 'vitest';
import { synthSpeech } from '../src/renderer/lib/chat-api';
import { createVoice, cutAt, type VoiceTrack } from '../src/renderer/services/voice';
import type { SettingsView } from '../src/shared/types';

vi.mock('../src/renderer/lib/chat-api', () => ({
  synthSpeech: vi.fn(async () => new ArrayBuffer(4)),
  voiceSupported: () => true,
}));

interface FakeSource {
  onended: (() => void) | null;
}

// 假的 WebAudio：decodeAudioData 由测试控制什么时候解码完，onended 由测试触发
function fakeAudio() {
  const decodes: ((buf: object) => void)[] = [];
  const started: FakeSource[] = [];
  class FakeContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume() {}
    createGain() {
      return { gain: { value: 0, setTargetAtTime() {} }, connect() {} };
    }
    createAnalyser() {
      return { fftSize: 0, connect() {}, getFloatTimeDomainData() {} };
    }
    decodeAudioData() {
      return new Promise((resolve) => decodes.push(resolve));
    }
    createBufferSource() {
      const src = { buffer: null, onended: null, connect() {}, stop() {}, start: () => started.push(src) };
      return src;
    }
  }
  vi.stubGlobal('AudioContext', FakeContext);
  return { decodes, started };
}

const makeVoice = () =>
  createVoice({ getSettings: () => ({ voice: { on: true } }) as unknown as SettingsView, sounds: () => ({}) });

function recorder() {
  const log: string[] = [];
  const t: VoiceTrack = {
    show: (text) => log.push(`show:${text}`),
    done: () => log.push('done'),
    fail: () => log.push('fail'),
  };
  return { log, t };
}

const spoken = () => vi.mocked(synthSpeech).mock.calls.map((c) => c[1]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(synthSpeech).mockClear();
});

describe('voice playback', () => {
  it('plays a sentence after it is decoded', async () => {
    const { decodes, started } = fakeAudio();
    const voice = makeVoice();
    voice.speak('你好呀朋友。');
    await vi.waitFor(() => expect(decodes).toHaveLength(1));
    decodes[0]({});
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });

  it('does not play a sentence when stop() runs while it is being decoded', async () => {
    const { decodes, started } = fakeAudio();
    const voice = makeVoice();
    voice.speak('你好呀朋友。');
    await vi.waitFor(() => expect(decodes).toHaveLength(1));
    voice.stop();
    decodes[0]({});
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toHaveLength(0);
    expect(voice.active).toBe(false);
  });

  it('keeps only a few requests in flight so the server queue never fills up', async () => {
    fakeAudio();
    const voice = makeVoice();
    voice.speak('第一句话来了。第二句话来了。第三句话来了。第四句话来了。第五句话来了。第六句话来了。');
    await new Promise((r) => setTimeout(r, 10));
    expect(spoken().length).toBeLessThanOrEqual(4);
  });

  it('merges tiny sentences into the next one', () => {
    fakeAudio();
    makeVoice().speak('嗯。今天天气不错呀。');
    expect(spoken()).toEqual(['嗯。今天天气不错呀。']);
  });
});

describe('cutAt', () => {
  it('waits for a full sentence', () => {
    expect(cutAt('今天天气')).toBe(0);
    expect(cutAt('今天天气不错。明天')).toBe(7);
    expect(cutAt('真的吗？！后面')).toBe(5);
  });

  it('cuts the first sentence early at a comma', () => {
    const text = '其实我觉得你可以先把手头的事情理一理，列个清单';
    expect(cutAt(text, true)).toBe(19);
    expect(cutAt(text)).toBe(0);
    expect(cutAt('好，我们开始吧', true)).toBe(0);
  });

  it('splits a long sentence at a soft break', () => {
    const head = '一'.repeat(30) + '，';
    expect(cutAt(head + '二'.repeat(40) + '。')).toBe(head.length);
  });
});

describe('voice track', () => {
  it('shows each sentence when its audio starts and finishes after the last one', async () => {
    const { decodes, started } = fakeAudio();
    const voice = makeVoice();
    const { log, t } = recorder();
    expect(voice.track(t)).toBe(true);
    voice.feed('今天天气不错呀。');
    voice.feed('我们出去走走吧！');
    voice.flush();
    await vi.waitFor(() => expect(decodes).toHaveLength(1));
    expect(log).toEqual([]);
    decodes[0]({});
    await vi.waitFor(() => expect(log).toEqual(['show:今天天气不错呀。']));
    started[0].onended?.();
    await vi.waitFor(() => expect(decodes).toHaveLength(2));
    decodes[1]({});
    await vi.waitFor(() => expect(log).toHaveLength(2));
    expect(log[1]).toBe('show:我们出去走走吧！');
    started[1].onended?.();
    await vi.waitFor(() => expect(log.at(-1)).toBe('done'));
  });

  it('reports fail when synthesis fails', async () => {
    fakeAudio();
    vi.mocked(synthSpeech).mockRejectedValueOnce(new Error('503'));
    const voice = makeVoice();
    const { log, t } = recorder();
    voice.track(t);
    voice.feed('今天天气不错呀。');
    voice.flush();
    await vi.waitFor(() => expect(log).toEqual(['fail']));
    expect(voice.track(recorder().t)).toBe(false);
  });

  it('reports fail when stopped', () => {
    fakeAudio();
    const voice = makeVoice();
    const { log, t } = recorder();
    voice.track(t);
    voice.feed('今天天气不错呀。');
    voice.stop();
    expect(log).toEqual(['fail']);
  });
});
