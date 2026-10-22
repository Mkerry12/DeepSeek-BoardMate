// 朗读（API Key 模式 / 服务器不支持时，主进程直连微软 Edge 语音）
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const TTS_MAX_CHARS = 300;
const TTS_TIMEOUT = 15000;
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$/;

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function edgeTts(text: string, voice: string): Promise<Buffer> {
  if (!VOICE_RE.test(voice)) throw new Error('不支持的音色');
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text.slice(0, TTS_MAX_CHARS)));
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('语音合成超时')), TTS_TIMEOUT);
      audioStream.on('data', (c: Buffer) => chunks.push(c));
      audioStream.on('end', () => (clearTimeout(timer), resolve()));
      audioStream.on('error', (e: Error) => (clearTimeout(timer), reject(e)));
    });
    if (!chunks.length) throw new Error('语音合成失败');
    return Buffer.concat(chunks);
  } finally {
    tts.close();
  }
}
