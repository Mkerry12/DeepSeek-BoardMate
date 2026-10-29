import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoice } from '../src/renderer/services/voice';
import type { SettingsView } from '../src/shared/types';

vi.mock('../src/renderer/lib/chat-api', () => ({
  synthSpeech: vi.fn(async () => new ArrayBuffer(4)),
  voiceSupported: () => true,
}));

// 假的 WebAudio：decodeAudioData 由测试控制什么时候解码完
function fakeAudio() {
  const decodes: ((buf: object) => void)[] = [];
  const started: object[] = [];
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

afterEach(() => vi.unstubAllGlobals());

describe('voice playback', () => {
  it('plays a sentence after it is decoded', async () => {
    const { decodes, started } = fakeAudio();
    const voice = makeVoice();
    voice.speak('你好。');
    await vi.waitFor(() => expect(decodes).toHaveLength(1));
    decodes[0]({});
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });

  it('does not play a sentence when stop() runs while it is being decoded', async () => {
    const { decodes, started } = fakeAudio();
    const voice = makeVoice();
    voice.speak('你好。');
    await vi.waitFor(() => expect(decodes).toHaveLength(1));
    voice.stop();
    decodes[0]({});
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toHaveLength(0);
    expect(voice.active).toBe(false);
  });
});
