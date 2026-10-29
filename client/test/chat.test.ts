import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiTarget,
  checkConnection,
  DEFAULT_EDGE_VOICE,
  edgeVoice,
  fetchVoices,
  serverBase,
  streamChat,
  summarizeMemory,
  type ConnSettings,
} from '../src/renderer/lib/chat-api';
import { MEMORY_MAX_CHARS } from '../src/renderer/lib/persona';
import type { ChatEvent } from '../src/shared/types';

function streamResponse(chunks: string[], init: ResponseInit = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' }, ...init });
}

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function collect(iter: AsyncIterable<ChatEvent>) {
  const out: ChatEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

type FetchArgs = [url: string, init: RequestInit & { headers: Record<string, string>; body: string }];
const conn = (s: object) => s as ConnSettings;
const official = conn({
  mode: 'official',
  serverUrl: 'http://srv/',
  officialServerUrl: 'http://default',
  token: 'tok',
});
const apikey = conn({ mode: 'apikey', api: { preset: 'deepseek', key: 'sk-1', model: '' } });

afterEach(() => vi.unstubAllGlobals());

describe('serverBase / apiTarget', () => {
  it('prefers the custom server url and strips trailing slashes', () => {
    expect(serverBase(official)).toBe('http://srv');
    expect(serverBase({ serverUrl: '', officialServerUrl: 'http://default//' })).toBe('http://default');
  });

  it('resolves preset and custom api targets', () => {
    expect(apiTarget(apikey)).toEqual({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
    expect(apiTarget(conn({ api: { preset: 'custom', baseUrl: ' https://x.ai/v1/ ', model: ' m ' } }))).toEqual({
      baseUrl: 'https://x.ai/v1',
      model: 'm',
    });
  });
});

describe('streamChat (official server)', () => {
  it('parses SSE events split across chunks and CRLF line endings', async () => {
    const fetch = vi.fn(async () =>
      streamResponse([
        'data: {"type":"emo',
        'tion","value":"happy"}\r\n\r\ndata: {"type":"delta","text":"你',
        '好"}\n\n: comment\n\ndata: {"type":"done"}\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetch);

    const events = await collect(streamChat({ ...official, model: 'm1', persona: ' 猫 ' }, [], undefined, '记忆'));
    expect(events).toEqual([{ type: 'emotion', value: 'happy' }, { type: 'delta', text: '你好' }, { type: 'done' }]);

    const [url, init] = fetch.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe('http://srv/chat');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ messages: [], model: 'm1', persona: '猫', memory: '记忆' });
  });

  it('throws the server detail on HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: '令牌无效' }, 401)),
    );
    await expect(collect(streamChat(official, []))).rejects.toMatchObject({ status: 401, message: '令牌无效' });
  });
});

describe('streamChat (own API key)', () => {
  it('maps OpenAI-style chunks through the stream filter', async () => {
    const chunk = (delta: Record<string, string>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    const fetch = vi.fn(async () =>
      streamResponse([
        chunk({ reasoning_content: '想' }),
        chunk({ reasoning_content: '想想' }),
        chunk({ content: '[pr' }),
        chunk({ content: 'oud]搞定' }),
        'data: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetch);

    const events = await collect(streamChat(apikey, [{ role: 'user', content: 'hi' }]));
    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'emotion', value: 'proud' },
      { type: 'delta', text: '搞定' },
      { type: 'done' },
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as FetchArgs;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('yields an error event from an in-stream error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse([`data: ${JSON.stringify({ error: { message: '炸了' } })}\n\n`])),
    );
    expect(await collect(streamChat(apikey, []))).toEqual([{ type: 'error', message: '炸了' }]);
  });

  it('maps known HTTP status codes to friendly messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'insufficient' } }, 402)),
    );
    await expect(collect(streamChat(apikey, []))).rejects.toMatchObject({ status: 402, message: '账户余额不足' });
  });

  it('requires an API key before calling the network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      collect(streamChat(conn({ ...apikey, api: { preset: 'deepseek', key: '' } }), [])),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('summarizeMemory', () => {
  it('returns empty string when the model has nothing to remember', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ memory: '（暂无）' })),
    );
    expect(await summarizeMemory(official, '', [{ role: 'user', content: 'hi' }])).toBe('');
  });

  it('strips think blocks in API key mode and clips at a line boundary', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `- 第${i}条记忆内容内容内容`).join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: `<think>嗯</think>${lines}` } }] })),
    );
    const text = await summarizeMemory(apikey, '', [{ role: 'user', content: 'hi' }]);
    expect(text.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS);
    expect(text.startsWith('- 第0条')).toBe(true);
    expect(lines.startsWith(text)).toBe(true);
    expect(lines[text.length]).toBe('\n');
  });
});

describe('server voices', () => {
  it('fetches the voice list with the token', async () => {
    const body = { provider: 'gpt_sovits', default: '穗', voices: [{ id: '穗', label: '满穗' }] };
    const fetch = vi.fn(async (..._args: FetchArgs) => jsonResponse(body));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchVoices(official)).toEqual(body);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://srv/tts/voices');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('returns null for older servers without /tts/voices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'Not Found' }, 404)),
    );
    expect(await fetchVoices(official)).toBeNull();
  });

  it('maps non-Edge voice names to the default Edge voice', () => {
    expect(edgeVoice('zh-CN-XiaoxiaoNeural')).toBe('zh-CN-XiaoxiaoNeural');
    expect(edgeVoice('满穗')).toBe(DEFAULT_EDGE_VOICE);
    expect(edgeVoice('')).toBe(DEFAULT_EDGE_VOICE);
  });

  it('shows a GPT-SoVITS chip when the server uses it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/health')
          ? jsonResponse({ ollama: true, model: 'm', tts_provider: 'gpt_sovits', gsv: false })
          : url.endsWith('/models')
            ? jsonResponse({ models: ['m'], default: 'm' })
            : jsonResponse({ ok: true }),
      ),
    );
    const { chips } = await checkConnection(official);
    expect(chips.at(-1)).toEqual({ text: 'GPT-SoVITS 未运行', ok: false });
  });
});
