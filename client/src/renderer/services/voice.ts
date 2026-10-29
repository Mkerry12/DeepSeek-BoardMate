// 朗读回复：边流式输出边按句切分 → 服务器 GPT-SoVITS 依次合成 → WebAudio 顺序播放，用实时音量驱动口型
// decodeAudioData 按内容识别格式，wav / ogg 都能直接播；GPT-SoVITS 一句要 1~3 秒，排队合成、按顺序播放
// track 让对话气泡跟着读：每句开始出声时才显示这句，读完才收起
// 语音只有 GPT-SoVITS 一种：合成失败（服务器没开语音、GPT-SoVITS 没起）就不出声，口型交给正弦动画，
// 并在 SILENT_MS 内不再请求。另外用 pet.json 的 sounds 播放提示音（WebAudio 音调，不是语音）
import type { SettingsView, VoiceSettings } from '../../shared/types';
import { synthSpeech, voiceSupported } from '../lib/chat-api';
import type { Sounds } from '../pet/live2d';

export type ChimeKind = 'done' | 'failed' | 'waiting' | 'asking';

const SENTENCE_END = /[。！？!?～~…\n]/;
const SOFT_BREAK = /[，,；;、]/;
const MAX_SENTENCE = 60;
const MIN_SOFT = 20;
// 一段话的第一句：在前 20 字里的逗号处就切开，先合成一小段，第一声出来得快
const FIRST_MAX = 20;
const FIRST_MIN_SOFT = 6;
// 太短的句子（「嗯。」「好！」）并进下一句：每次合成都有固定开销，短句播完下一句常常还没好
const MIN_SPOKEN = 5;
// 同时最多向服务器要几句：服务器单卡串行、排队有上限（默认 8 句），排满会 503
const AHEAD = 3;
const NOISE_FLOOR = 0.01;
const GAIN = 6;
const DEFAULT_VOLUME = 80;
const SILENT_MS = 30_000;

// 设置里的百分比 → 增益，按平方走，小音量那一段调起来更细
function toGain(percent: number | undefined): number {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent as number)) : DEFAULT_VOLUME;
  return (p / 100) ** 2;
}

// 颜文字、字符表情、装饰符号读不出来，和 server/deskmate_server/tts/text.py 保持一致
const EMOTICON =
  /(?<![A-Za-z0-9])(?:[QT][wA_][QT]|owo|uwu|ovo|xd|orz|otl|o_o|o\.o|x_x|@_@|>[_w.]<|\^_?\^|-_-|=_=|\*_\*|[:;=][-']?[)(DPO3|])(?![A-Za-z0-9])/gi;
const KAOMOJI = /(?:(?<![A-Za-z])[oOヽ٩ᕕΣ\\])?[（(]([^（）()\n]{0,20})[）)](?:[oOﾉノ۶وᕗっ/](?![A-Za-z]))?/g;
// 括号里有汉字、数字或成词的字母（「（比如这样）」「(1)」「(TTS)」）就是正常文字，不当颜文字
const WORDY = /[\u3400-\u9fff0-9０-９]|[A-Za-zＡ-Ｚａ-ｚ]{2}/;
const DECOR = /[\u0300-\u036f\u2500-\u257f\u25a0-\u25ff\u2600-\u27bf\u3003\u309c\ufe35\ufe36\uff61\uff65\uff9fヽﾉ٩۶]/g;

export function cleanForSpeech(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/```[\s\S]*?(```|$)/g, '')
    .replace(/\[\s*[a-zA-Z_]+\s*\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(EMOTICON, '')
    .replace(KAOMOJI, (m, inner: string) => (WORDY.test(inner) ? m : ''))
    .replace(DECOR, '')
    .replace(/[*_`#>|~^=]+/g, ' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const speakable = (text: string) => /[\p{L}\p{N}]/u.test(text);

const spokenLength = (text: string) => cleanForSpeech(text).match(/[\p{L}\p{N}]/gu)?.length ?? 0;

/** 流式文本里第一句的长度（还不够一句返回 0）；first：一段话的开头，尽早在逗号处切 */
export function cutAt(text: string, first = false): number {
  const at = text.search(SENTENCE_END);
  let end = 0;
  if (at !== -1) {
    end = at + 1;
    while (end < text.length && SENTENCE_END.test(text[end])) end++;
  }
  if (first) {
    if (end && end <= FIRST_MAX) return end;
    const stop = Math.min(end || text.length, FIRST_MAX);
    for (let i = FIRST_MIN_SOFT; i < stop; i++) if (SOFT_BREAK.test(text[i])) return i + 1;
  }
  if (end && end <= MAX_SENTENCE) return end;
  if (!end && text.length < MAX_SENTENCE) return 0;
  for (let i = MAX_SENTENCE - 1; i >= MIN_SOFT; i--) if (SOFT_BREAK.test(text[i])) return i + 1;
  return end || MAX_SENTENCE;
}

/** 跟着朗读显示文字：每句开始出声时 show（读不出来的句子轮到时直接 show），全部读完 done，不读了 fail */
export interface VoiceTrack {
  show(text: string): void;
  done(): void;
  fail(): void;
}

export interface Voice {
  feed(text: string): void;
  flush(): void;
  speak(text: string): void;
  /** 接下来 feed 到 flush 之间的句子按 track 回报进度；语音没开 / 不可用时返回 false */
  track(t: VoiceTrack): boolean;
  stop(): void;
  level(): number | null;
  chime(kind: ChimeKind, force?: boolean): void;
  setVolume(percent: number): void;
  readonly active: boolean;
}

interface Item {
  text: string;
  shown: string;
  track: VoiceTrack | null;
  end?: boolean;
  data?: Promise<ArrayBuffer | null>;
}

export function createVoice({ getSettings, sounds }: { getSettings: () => SettingsView; sounds: () => Sounds }): Voice {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let out: GainNode | null = null;
  let samples: Float32Array<ArrayBuffer> | null = null;
  let gen = 0;
  let abort = new AbortController();
  // text：要读的（清理过，读不出来时为空）；shown：原句，跟着 track 显示；end：flush 时放进来的收尾标记
  let queue: Item[] = [];
  let pending = '';
  let fresh = true;
  let pumping = false;
  let following: VoiceTrack | null = null;
  let attaching = false;
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

  // 下一段要送去合成的长度：太短的并进下一句；一段话的第一句切得短些
  function nextCut(text: string): number {
    let n = 0;
    do {
      const cut = cutAt(text.slice(n), fresh);
      if (!cut) return 0;
      n += cut;
    } while (spokenLength(text.slice(0, n)) < MIN_SPOKEN);
    return n;
  }

  // 流式文本：攒够一句就送去合成
  function feed(text: string) {
    if (!enabled()) return;
    pending += text;
    for (let cut; (cut = nextCut(pending)); pending = pending.slice(cut)) enqueue(pending.slice(0, cut));
  }

  function flush() {
    if (enabled() && pending) enqueue(pending);
    pending = '';
    fresh = true;
    if (attaching && following) {
      queue.push({ text: '', shown: '', track: following, end: true });
      pump();
    }
    attaching = false;
  }

  function speak(text: string) {
    if (!enabled()) return;
    feed(text);
    flush();
  }

  function track(t: VoiceTrack): boolean {
    release();
    if (!enabled()) return false;
    following = t;
    attaching = true;
    return true;
  }

  // 正在跟读的那段不读了：让它把文字直接显示出来
  function release() {
    const t = following;
    following = null;
    attaching = false;
    t?.fail();
  }

  // 语音不可用：丢掉排队的句子，这段时间里不再请求，嘴巴交给正弦动画
  function goSilent(reason: string) {
    if (Date.now() >= silentUntil) console.info('[voice] 不朗读：', reason);
    silentUntil = Date.now() + SILENT_MS;
    queue = [];
    pending = '';
    fresh = true;
    release();
  }

  function enqueue(sentence: string) {
    if (!enabled()) return;
    const text = cleanForSpeech(sentence);
    fresh = false;
    queue.push({ text: speakable(text) ? text : '', shown: sentence, track: attaching ? following : null });
    request();
    pump();
  }

  // 排在前面的 AHEAD 句先送去合成（服务器那边依次合成，正好流水线）
  function request() {
    for (const item of queue.slice(0, AHEAD)) {
      if (item.data || !item.text) continue;
      const signal = abort.signal;
      item.data = synthSpeech(getSettings(), item.text, conf().name || '', signal).catch((err: Error) => {
        if (!signal.aborted) goSilent(err.message);
        return null;
      });
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    const mine = gen;
    while (queue.length && mine === gen) {
      const item = queue.shift()!;
      request();
      const bytes = await (item.data ?? Promise.resolve(null));
      if (mine !== gen) return;
      const mineTrack = item.track && item.track === following ? item.track : null;
      if (item.end) {
        if (mineTrack) {
          following = null;
          mineTrack.done();
        }
        continue;
      }
      let shown = false;
      const reveal = () => {
        shown = true;
        if (mineTrack && mineTrack === following) mineTrack.show(item.shown);
      };
      if (bytes) await play(bytes, mine, reveal);
      if (mine !== gen) return;
      if (!shown) reveal();
    }
    if (mine === gen) pumping = false;
  }

  // onStart：解码完、真正开始出声的那一刻
  async function play(bytes: ArrayBuffer, mine: number, onStart: () => void): Promise<boolean> {
    try {
      const c = audio();
      const buffer = await c.decodeAudioData(bytes);
      // 解码期间被 stop() 了：这句不再播
      if (mine !== gen) return false;
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
        onStart();
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
    fresh = true;
    pumping = false;
    release();
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
    track,
    stop,
    level,
    chime,
    setVolume,
    get active() {
      return !!source || pumping || queue.length > 0;
    },
  };
}
