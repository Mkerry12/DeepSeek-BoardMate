// 朗读回复：边流式输出边按句切分 → 服务器 GPT-SoVITS 依次合成 → WebAudio 顺序播放，用实时音量驱动口型
// decodeAudioData 按内容识别格式，wav / ogg 都能直接播；GPT-SoVITS 一句要 1~3 秒，排队合成、按顺序播放
// 语音只有 GPT-SoVITS 一种：合成失败（服务器没开语音、GPT-SoVITS 没起）就不出声，口型交给正弦动画，
// 并在 SILENT_MS 内不再请求。另外用 pet.json 的 sounds 播放提示音（WebAudio 音调，不是语音）
import type { SettingsView, VoiceSettings } from '../../shared/types';
import { synthSpeech, voiceSupported } from '../lib/chat-api';
import type { Sounds } from '../pet/live2d';

export type ChimeKind = 'done' | 'failed' | 'waiting' | 'asking';

const SENTENCE_END = /[。！？!?～~…\n]/;
const SOFT_BREAK = /[，,；;、]/;
const MAX_SENTENCE = 80;
const MIN_SOFT = 24;
const NOISE_FLOOR = 0.01;
const GAIN = 6;
const DEFAULT_VOLUME = 80;
const SILENT_MS = 30_000;

// 设置里的百分比 → 增益，按平方走，小音量那一段调起来更细
function toGain(percent: number | undefined): number {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent as number)) : DEFAULT_VOLUME;
  return (p / 100) ** 2;
}

export function cleanForSpeech(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/```[\s\S]*?(```|$)/g, '')
    .replace(/\[\s*[a-zA-Z_]+\s*\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>|~^=]+/g, ' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const speakable = (text: string) => /[\p{L}\p{N}]/u.test(text);

function cutAt(text: string): number {
  const end = text.search(SENTENCE_END);
  if (end !== -1) {
    let i = end + 1;
    while (i < text.length && SENTENCE_END.test(text[i])) i++;
    return i;
  }
  if (text.length < MAX_SENTENCE) return 0;
  for (let i = MAX_SENTENCE - 1; i >= MIN_SOFT; i--) if (SOFT_BREAK.test(text[i])) return i + 1;
  return MAX_SENTENCE;
}

export interface Voice {
  feed(text: string): void;
  flush(): void;
  speak(text: string): void;
  stop(): void;
  level(): number | null;
  chime(kind: ChimeKind, force?: boolean): void;
  setVolume(percent: number): void;
  readonly active: boolean;
}

export function createVoice({ getSettings, sounds }: { getSettings: () => SettingsView; sounds: () => Sounds }): Voice {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let out: GainNode | null = null;
  let samples: Float32Array<ArrayBuffer> | null = null;
  let gen = 0;
  let abort = new AbortController();
  let queue: { data: Promise<ArrayBuffer | null> }[] = [];
  let pending = '';
  let pumping = false;
  let source: AudioBufferSourceNode | null = null;
  let silentUntil = 0;

  const conf = (): Partial<VoiceSettings> => getSettings().voice || {};
  const enabled = () => !!conf().on && voiceSupported(getSettings()) && Date.now() >= silentUntil;
  let volume = toGain(conf().volume);

  // 语音 → analyser（口型按原始音量算，调小声嘴也照样动）→ 音量 → 扬声器；提示音直接进音量
  function audio(): AudioContext {
    if (!ctx) {
      ctx = new AudioContext();
      out = ctx.createGain();
      out.gain.value = volume;
      out.connect(ctx.destination);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      samples = new Float32Array(analyser.fftSize);
      analyser.connect(out);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // percent：0~100，正在播的语音也立刻跟着变
  function setVolume(percent: number) {
    volume = toGain(percent);
    if (ctx) out?.gain.setTargetAtTime(volume, ctx.currentTime, 0.03);
  }

  // 流式文本：攒够一句就送去合成
  function feed(text: string) {
    if (!enabled()) return;
    pending += text;
    for (let cut; (cut = cutAt(pending)); pending = pending.slice(cut)) enqueue(pending.slice(0, cut));
  }

  function flush() {
    if (enabled() && pending) enqueue(pending);
    pending = '';
  }

  function speak(text: string) {
    if (!enabled()) return;
    feed(text);
    flush();
  }

  // 语音不可用：丢掉排队的句子，这段时间里不再请求，嘴巴交给正弦动画
  function goSilent(reason: string) {
    if (Date.now() >= silentUntil) console.info('[voice] 不朗读：', reason);
    silentUntil = Date.now() + SILENT_MS;
    queue = [];
    pending = '';
  }

  function enqueue(sentence: string) {
    if (!enabled()) return;
    const text = cleanForSpeech(sentence);
    if (!speakable(text)) return;
    const signal = abort.signal;
    const data = synthSpeech(getSettings(), text, conf().name || '', signal).catch((err: Error) => {
      if (!signal.aborted) goSilent(err.message);
      return null;
    });
    queue.push({ data });
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    const mine = gen;
    while (queue.length && mine === gen) {
      const { data } = queue.shift()!;
      const bytes = await data;
      if (mine !== gen) return;
      if (bytes) await play(bytes);
    }
    if (mine === gen) pumping = false;
  }

  async function play(bytes: ArrayBuffer): Promise<boolean> {
    try {
      const c = audio();
      const buffer = await c.decodeAudioData(bytes);
      await new Promise<void>((resolve) => {
        const src = c.createBufferSource();
        src.buffer = buffer;
        src.connect(analyser!);
        src.onended = () => {
          if (source === src) source = null;
          resolve();
        };
        source = src;
        src.start();
      });
      return true;
    } catch (err) {
      console.warn('[voice] 播放失败：', (err as Error).message);
      return false;
    }
  }

  function stop() {
    gen++;
    abort.abort();
    abort = new AbortController();
    queue = [];
    pending = '';
    pumping = false;
    try {
      source?.stop();
    } catch {}
    source = null;
  }

  // 口型：正在播语音 → 实时音量；排队合成中 → 闭嘴等着；没有语音（含语音不可用）→ null（交给正弦口型）
  function level(): number | null {
    if (source && analyser && samples) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      return Math.max(0, Math.sqrt(sum / samples.length) - NOISE_FLOOR) * GAIN;
    }
    return pumping || queue.length ? 0 : null;
  }

  // pet.json sounds：[[频率 Hz, 起始秒], …]；force：关了提示音也响（调音量时试听）
  function chime(kind: ChimeKind, force = false) {
    const notes = sounds()[kind];
    if (!notes || !(conf().sfx || force)) return;
    const c = audio();
    const t0 = c.currentTime + 0.02;
    for (const [hz, at] of notes) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(0.12, t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.28);
      osc.connect(gain).connect(out!);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.3);
    }
  }

  return {
    feed,
    flush,
    speak,
    stop,
    level,
    chime,
    setVolume,
    get active() {
      return !!source || pumping || queue.length > 0;
    },
  };
}
