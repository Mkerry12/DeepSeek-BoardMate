// 两种连接方式产出同样的事件：thinking / queued / emotion / delta / error / done
//   official：主人的 FastAPI 服务器（转发到 Ollama）
//   apikey：用户自己的 Key，直连 OpenAI 兼容的 /chat/completions
import type { ChatEvent, ChatMessage, SettingsView } from '../../shared/types';
import { memoryRequest, MEMORY_MAX_CHARS, systemPrompt } from './persona';
import { StreamFilter, stripThink } from './stream-filter';

/** 带 HTTP 状态码的错误（401 时提示去设置里填令牌 / Key） */
export interface ChatError extends Error {
  status?: number;
}

export type ConnSettings = Pick<
  SettingsView,
  'mode' | 'serverUrl' | 'officialServerUrl' | 'token' | 'model' | 'persona' | 'api'
>;

export interface ApiPreset {
  label: string;
  baseUrl?: string;
  models?: string[];
}

export const API_PRESETS: Record<string, ApiPreset> = {
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  custom: { label: '自定义（OpenAI 兼容）' },
};

const API_ERRORS: Record<number, string> = {
  401: 'API Key 无效',
  402: '账户余额不足',
  403: '没有权限使用这个模型',
  404: '接口地址或模型名不对',
  429: '请求太频繁或额度用完了',
};

export interface StatusChip {
  text: string;
  ok: boolean;
}

export interface ServerModels {
  models: string[];
  default: string;
}

export function serverBase(settings: Pick<ConnSettings, 'serverUrl' | 'officialServerUrl'>): string {
  return (settings.serverUrl || settings.officialServerUrl).replace(/\/+$/, '');
}

export function apiTarget({ api }: Pick<ConnSettings, 'api'>): { baseUrl: string; model: string } {
  const preset = API_PRESETS[api.preset] || API_PRESETS.custom;
  return {
    baseUrl: (preset.baseUrl || api.baseUrl || '').trim().replace(/\/+$/, ''),
    model: (api.model || '').trim() || preset.models?.[0] || '',
  };
}

export function streamChat(
  settings: ConnSettings,
  messages: ChatMessage[],
  signal?: AbortSignal,
  memory = '',
): AsyncGenerator<ChatEvent> {
  return settings.mode === 'apikey'
    ? streamApi(settings, messages, signal, memory)
    : streamOfficial(settings, messages, signal, memory);
}

async function* streamOfficial(
  settings: ConnSettings,
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  memory: string,
): AsyncGenerator<ChatEvent> {
  const body: Record<string, unknown> = { messages };
  if (settings.model) body.model = settings.model;
  if (settings.persona?.trim()) body.persona = settings.persona.trim();
  if (memory) body.memory = memory;
  const res = await request(`${serverBase(settings)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(settings.token) },
    body: JSON.stringify(body),
    signal,
  });
  for await (const data of sseData(res)) yield JSON.parse(data) as ChatEvent;
}

async function apiCompletion(settings: ConnSettings, body: Record<string, unknown>, signal?: AbortSignal) {
  const { baseUrl, model } = apiTarget(settings);
  if (!settings.api.key) throw httpError(401, '还没填 API Key');
  if (!baseUrl || !model) throw httpError(400, '请先在设置里填写接口地址和模型');
  return request(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(settings.api.key) },
      body: JSON.stringify({ model, ...body }),
      signal,
    },
    true,
  );
}

interface CompletionChunk {
  error?: { message?: string };
  choices?: { delta?: { content?: string; reasoning_content?: string } }[];
}

async function* streamApi(
  settings: ConnSettings,
  messages: ChatMessage[],
  signal: AbortSignal | undefined,
  memory: string,
): AsyncGenerator<ChatEvent> {
  const res = await apiCompletion(
    settings,
    { stream: true, messages: [{ role: 'system', content: systemPrompt(settings.persona, memory) }, ...messages] },
    signal,
  );

  const filter = new StreamFilter();
  let thinking = false;
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    const chunk = JSON.parse(data) as CompletionChunk;
    if (chunk.error) {
      yield { type: 'error', message: chunk.error.message || '接口返回错误' };
      return;
    }
    const delta = chunk.choices?.[0]?.delta || {};
    if (delta.reasoning_content && !thinking) {
      thinking = true;
      yield { type: 'thinking' };
    }
    if (delta.content) yield* filter.feed(delta.content);
  }
  yield* filter.flush();
  yield { type: 'done' };
}

// 长期记忆：把旧记忆 + 最近的对话整理成一段关于用户的笔记（非流式，返回 '' 表示没什么可记的）
export async function summarizeMemory(
  settings: ConnSettings,
  memory: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let text: string;
  if (settings.mode === 'apikey') {
    const res = await apiCompletion(settings, { stream: false, messages: memoryRequest(memory, messages) }, signal);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    text = stripThink(json.choices?.[0]?.message?.content || '');
  } else {
    const body: Record<string, unknown> = { messages, memory };
    if (settings.model) body.model = settings.model;
    const res = await request(`${serverBase(settings)}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(settings.token) },
      body: JSON.stringify(body),
      signal,
    });
    text = ((await res.json()) as { memory?: string }).memory || '';
  }
  if (text.includes('暂无') && text.length < 12) return '';
  if (text.length <= MEMORY_MAX_CHARS) return text;
  const cut = text.slice(0, MEMORY_MAX_CHARS);
  return cut.includes('\n') ? cut.slice(0, cut.lastIndexOf('\n')).trimEnd() : cut;
}

// 朗读：官方模式走服务器 /tts（朋友也能用），否则或服务器不支持时由主进程直连微软 Edge 语音
export async function synthSpeech(
  settings: ConnSettings,
  text: string,
  voice: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (settings.mode !== 'apikey') {
    try {
      const res = await request(`${serverBase(settings)}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer(settings.token) },
        body: JSON.stringify({ text, voice }),
        signal,
      });
      return await res.arrayBuffer();
    } catch (err) {
      const status = (err as ChatError).status;
      if (signal?.aborted || status === 401 || status === 429) throw err;
    }
  }
  const bytes = await window.desk.tts(text, voice);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// 测试连接：返回一组 { text, ok } 状态，official 模式顺便带回服务器上的模型列表
export async function checkConnection(
  settings: ConnSettings,
): Promise<{ chips: StatusChip[]; models?: ServerModels | null }> {
  if (settings.mode === 'apikey') return checkApi(settings);
  const base = serverBase(settings);
  const health = (await fetch(`${base}/health`).then((r) => r.json())) as { ollama?: boolean; model?: string };
  const auth = await fetch(`${base}/auth-check`, { headers: bearer(settings.token) });
  const chips = [
    { text: '服务器', ok: true },
    { text: health.ollama ? `Ollama · ${health.model}` : 'Ollama 未运行', ok: !!health.ollama },
    { text: auth.ok ? '令牌有效' : '令牌无效', ok: auth.ok },
  ];
  return { chips, models: auth.ok && health.ollama ? await fetchModels(settings).catch(() => null) : null };
}

async function checkApi(settings: ConnSettings): Promise<{ chips: StatusChip[] }> {
  const { baseUrl, model } = apiTarget(settings);
  if (!baseUrl) throw new Error('请填写接口地址');
  if (!settings.api.key) return { chips: [{ text: '还没填 API Key', ok: false }] };
  const res = await fetch(`${baseUrl}/models`, { headers: bearer(settings.api.key) });
  if (res.status === 401 || res.status === 403) {
    return {
      chips: [
        { text: '接口可访问', ok: true },
        { text: API_ERRORS[res.status], ok: false },
      ],
    };
  }
  if (!res.ok) return { chips: [{ text: `接口返回 ${res.status}`, ok: false }] };
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[] };
  const ids = (body.data || []).map((m) => m.id);
  const chips = [
    { text: '接口可访问', ok: true },
    { text: 'Key 有效', ok: true },
  ];
  if (ids.length)
    chips.push({ text: ids.includes(model) ? `模型 ${model}` : `没找到模型 ${model}`, ok: ids.includes(model) });
  return { chips };
}

export async function fetchModels(settings: Pick<ConnSettings, 'serverUrl' | 'officialServerUrl' | 'token'>) {
  const res = await request(`${serverBase(settings)}/models`, { headers: bearer(settings.token) });
  return (await res.json()) as ServerModels;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function httpError(status: number, message: string): ChatError {
  return Object.assign(new Error(message), { status });
}

async function request(url: string, init: RequestInit, isApi = false): Promise<Response> {
  const res = await fetch(url, init);
  if (res.ok) return res;
  let detail = '';
  try {
    const body = (await res.json()) as { detail?: unknown; error?: { message?: string } };
    detail = typeof body.detail === 'string' ? body.detail : body.error?.message || '';
  } catch {}
  const message = isApi
    ? API_ERRORS[res.status] || detail || `接口返回 ${res.status}`
    : detail || `服务器返回 ${res.status}`;
  throw httpError(res.status, message);
}

async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }
}
