// 朗读回复：边流式输出边按句切分 → 依次合成（微软 Edge 神经网络语音）→ WebAudio 顺序播放，用实时音量驱动口型
// 合成失败时退回 Windows 自带的 speechSynthesis；另外用 pet.json 的 sounds 播放提示音
import { synthSpeech } from './chat.js';

export const VOICES = [
  ['zh-CN-XiaoyiNeural', '晓伊 · 活泼可爱'],
  ['zh-CN-XiaoxiaoNeural', '晓晓 · 温柔'],
  ['zh-CN-liaoning-XiaobeiNeural', '晓北 · 东北话'],
  ['zh-CN-shaanxi-XiaoniNeural', '晓妮 · 陕西话'],
  ['zh-TW-HsiaoYuNeural', '曉雨 · 台湾腔'],
  ['zh-CN-YunxiaNeural', '云夏 · 少年音'],
];

const SENTENCE_END = /[。！？!?～~…\n]/;
const SOFT_BREAK = /[，,；;、]/;
const MAX_SENTENCE = 80;
const MIN_SOFT = 24;
const NOISE_FLOOR = 0.01;
const GAIN = 6;

export function cleanForSpeech(text) {
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

const speakable = (text) => /[\p{L}\p{N}]/u.test(text);

function cutAt(text) {
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

export function createVoice({ getSettings, sounds }) {
  let ctx = null;
  let analyser = null;
  let samples = null;
  let gen = 0;
  let abort = new AbortController();
  let queue = [];
  let pending = '';
  let pumping = false;
  let source = null;
  let fallbackSpeaking = false;

  const conf = () => getSettings().voice || {};

  function audio() {
    if (!ctx) {
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      samples = new Float32Array(analyser.fftSize);
      analyser.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 流式文本：攒够一句就送去合成
  function feed(text) {
    if (!conf().on) return;
    pending += text;
    for (let cut; (cut = cutAt(pending)); pending = pending.slice(cut)) enqueue(pending.slice(0, cut));
  }

  function flush() {
    if (conf().on && pending) enqueue(pending);
    pending = '';
  }

  function speak(text) {
    if (!conf().on) return;
    feed(text);
    flush();
  }

  function enqueue(sentence) {
    const text = cleanForSpeech(sentence);
    if (!speakable(text)) return;
    const data = synthSpeech(getSettings(), text, conf().name, abort.signal).catch((err) => {
      if (!abort.signal.aborted) console.warn('[voice] 合成失败，改用系统语音：', err.message);
      return null;
    });
    queue.push({ text, data });
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    const mine = gen;
    while (queue.length && mine === gen) {
      const { text, data } = queue.shift();
      const bytes = await data;
      if (mine !== gen) return;
      if (!bytes || !(await play(bytes))) await speakFallback(text);
    }
    if (mine === gen) pumping = false;
  }

  async function play(bytes) {
    try {
      const c = audio();
      const buffer = await c.decodeAudioData(bytes);
      await new Promise((resolve) => {
        const src = c.createBufferSource();
        src.buffer = buffer;
        src.connect(analyser);
        src.onended = () => {
          if (source === src) source = null;
          resolve();
        };
        source = src;
        src.start();
      });
      return true;
    } catch (err) {
      console.warn('[voice] 播放失败：', err.message);
      return false;
    }
  }

  function speakFallback(text) {
    if (!window.speechSynthesis) return;
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.1;
      u.pitch = 1.3;
      const zh = speechSynthesis.getVoices().find((v) => v.lang.startsWith('zh'));
      if (zh) u.voice = zh;
      u.onend = u.onerror = () => {
        fallbackSpeaking = false;
        resolve();
      };
      fallbackSpeaking = true;
      speechSynthesis.speak(u);
    });
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
    if (fallbackSpeaking) speechSynthesis.cancel();
    fallbackSpeaking = false;
  }

  // 口型：正在播语音 → 实时音量；排队合成中 → 闭嘴等着；没有语音 → null（交给正弦口型）
  function level() {
    if (source) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      return Math.max(0, Math.sqrt(sum / samples.length) - NOISE_FLOOR) * GAIN;
    }
    if (fallbackSpeaking) {
      const t = performance.now() / 1000;
      return 0.45 + 0.4 * Math.sin(t * 15) * Math.sin(t * 6.1);
    }
    return pumping || queue.length ? 0 : null;
  }

  // pet.json sounds：[[频率 Hz, 起始秒], …]
  function chime(kind) {
    const notes = sounds()[kind];
    if (!notes || !conf().sfx) return;
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
      osc.connect(gain).connect(c.destination);
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
    get active() {
      return !!source || fallbackSpeaking || pumping || queue.length > 0;
    },
  };
}
