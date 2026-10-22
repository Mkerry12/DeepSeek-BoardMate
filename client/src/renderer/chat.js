// 两种连接方式产出同样的事件：thinking / queued / emotion / delta / error / done
//   official：主人的 FastAPI 服务器（转发到 Ollama）
//   apikey：用户自己的 Key，直连 OpenAI 兼容的 /chat/completions
import { StreamFilter, stripThink } from './stream-filter.js';
import { systemPrompt, memoryRequest, MEMORY_MAX_CHARS } from './persona.js';

export const API_PRESETS = {
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  custom: { label: '自定义（OpenAI 兼容）' },
};

const API_ERRORS = {
  401: 'API Key 无效',
  402: '账户余额不足',
  403: '没有权限使用这个模型',
  404: '接口地址或模型名不对',
  429: '请求太频繁或额度用完了',
};

export function serverBase(settings) {
  return (settings.serverUrl || settings.officialServerUrl).replace(/\/+$/, '');
}

export function apiTarget({ api }) {
  const preset = API_PRESETS[api.preset] || API_PRESETS.custom;
  return {
    baseUrl: (preset.baseUrl || api.baseUrl || '').trim().replace(/\/+$/, ''),
    model: (api.model || '').trim() || preset.models?.[0] || '',
  };
}

export function streamChat(settings, messages, signal, memory = '') {
  return settings.mode === 'apikey'
    ? streamApi(settings, messages, signal, memory)
    : streamOfficial(settings, messages, signal, memory);
}

async function* streamOfficial(settings, messages, signal, memory) {
  const body = { messages };
  if (settings.model) body.model = settings.model;
  if (settings.persona?.trim()) body.persona = settings.persona.trim();
  if (memory) body.memory = memory;
  const res = await request(`${serverBase(settings)}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(settings.token) },
    body: JSON.stringify(body),
    signal,
  });
  for await (const data of sseData(res)) yield JSON.parse(data);
}

async function apiCompletion(settings, body, signal) {
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

async function* streamApi(settings, messages, signal, memory) {
  const res = await apiCompletion(
    settings,
    { stream: true, messages: [{ role: 'system', content: systemPrompt(settings.persona, memory) }, ...messages] },
    signal,
  );

  const filter = new StreamFilter();
  let thinking = false;
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    const chunk = JSON.parse(data);
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
export async function summarizeMemory(settings, memory, messages, signal) {
  let text;
  if (settings.mode === 'apikey') {
    const res = await apiCompletion(settings, { stream: false, messages: memoryRequest(memory, messages) }, signal);
    text = stripThink((await res.json()).choices?.[0]?.message?.content || '');
  } else {
    const body = { messages, memory };
    if (settings.model) body.model = settings.model;
    const res = await request(`${serverBase(settings)}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(settings.token) },
      body: JSON.stringify(body),
      signal,
    });
    text = (await res.json()).memory || '';
  }
  if (text.includes('暂无') && text.length < 12) return '';
  if (text.length <= MEMORY_MAX_CHARS) return text;
  const cut = text.slice(0, MEMORY_MAX_CHARS);
  return cut.includes('\n') ? cut.slice(0, cut.lastIndexOf('\n')).trimEnd() : cut;
}

// 朗读：官方模式走服务器 /tts（朋友也能用），否则或服务器不支持时由主进程直连微软 Edge 语音
export async function synthSpeech(settings, text, voice, signal) {
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
      if (signal?.aborted || err.status === 401 || err.status === 429) throw err;
    }
  }
  const bytes = await window.desk.tts(text, voice);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// 测试连接：返回一组 { text, ok } 状态，official 模式顺便带回服务器上的模型列表
export async function checkConnection(settings) {
  if (settings.mode === 'apikey') return checkApi(settings);
  const base = serverBase(settings);
  const health = await fetch(`${base}/health`).then((r) => r.json());
  const auth = await fetch(`${base}/auth-check`, { headers: bearer(settings.token) });
  const chips = [
    { text: '服务器', ok: true },
    { text: health.ollama ? `Ollama · ${health.model}` : 'Ollama 未运行', ok: health.ollama },
    { text: auth.ok ? '令牌有效' : '令牌无效', ok: auth.ok },
  ];
  return { chips, models: auth.ok && health.ollama ? await fetchModels(settings).catch(() => null) : null };
}

async function checkApi(settings) {
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
  const ids = ((await res.json().catch(() => ({}))).data || []).map((m) => m.id);
  const chips = [
    { text: '接口可访问', ok: true },
    { text: 'Key 有效', ok: true },
  ];
  if (ids.length)
    chips.push({ text: ids.includes(model) ? `模型 ${model}` : `没找到模型 ${model}`, ok: ids.includes(model) });
  return { chips };
}

export async function fetchModels(settings) {
  const res = await request(`${serverBase(settings)}/models`, { headers: bearer(settings.token) });
  return res.json();
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function request(url, init, isApi = false) {
  const res = await fetch(url, init);
  if (res.ok) return res;
  let detail = '';
  try {
    const body = await res.json();
    detail = typeof body.detail === 'string' ? body.detail : body.error?.message || '';
  } catch {}
  const message = isApi
    ? API_ERRORS[res.status] || detail || `接口返回 ${res.status}`
    : detail || `服务器返回 ${res.status}`;
  throw httpError(res.status, message);
}

async function* sseData(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
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
