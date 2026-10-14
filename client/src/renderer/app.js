import { streamChat, checkConnection, fetchModels, serverBase, API_PRESETS } from './chat.js';
import { createIdle } from './idle.js';
import { createAssistant } from './assistant.js';
import { createMenu } from './menu.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const bubble = $('bubble');
const bubbleText = $('bubble-text');
const hint = $('hint');
const chatForm = $('chat');
const chatInput = $('chat-input');
const chatSend = $('chat-send');
const settingsForm = $('settings');
const settingsStatus = $('settings-status');
const settingsTest = $('settings-test');
const modelSelect = $('set-model');
const presetSelect = $('set-preset');
const apiModelSelect = $('set-api-model');

const MAX_CONTEXT = 20;
const MAX_STORED = 200;
const CLIPBOARD_MAX = 900;
const ERASE_CONFIRM_MS = 4000;
// 换装用到的 pet.json 槽位（其余槽位是随对话变化的表情）
const OUTFIT_SLOTS = ['glasses', 'sticker', 'hair', 'rhand', 'whale', 'claw', 'cloth', 'desk', 'other'];
const OUTFIT_LABELS = { rhand: '手势', desk: '桌面巴菲' };
// 「桌面巴菲」表情实际是把默认摆着的巴菲收起来
const OPTION_LABELS = { desk: { none: '摆着', 巴菲: '收起来' } };
const DEFAULT_OUTFIT = { whale: '头顶鲸' };
const CLICK_LINES = [
  ['happy', '嘿嘿，被你发现啦～'],
  ['surprised', '哇！吓我一跳！'],
  ['wave', '你好呀！双击我可以聊天哦'],
  ['relaxed', '今天也辛苦啦～'],
];

let settings = await window.desk.getSettings();
let history = await window.desk.getHistory();
let abortCtrl = null;
let bubbleTimer = null;
let eraseArmedAt = 0;
const pet = await createPet();
pet.setOutfit(settings.outfit);

const idle = createIdle({
  pet,
  say,
  isBusy: () => !!abortCtrl || !!drag || menu.isOpen || !settingsForm.classList.contains('hidden') || !!chatInput.value,
  isQuiet: () => assistant.focusing,
  canSpeak: () => bubble.classList.contains('hidden'),
  has: (what) => what === 'parfait' && !settings.outfit.desk,
});

const assistant = createAssistant({
  pet,
  say,
  notify: window.desk.notify,
  isBusy: () => !!abortCtrl,
  wake: () => idle.poke(),
});
assistant.configure(settings.reminders);

// ---------- 模型 ----------

// live2d.js 在导入时就要求 Cubism Core 已存在，所以先加载 Core 再动态导入
async function createPet() {
  try {
    await loadScript('../../vendor/live2dcubismcore.min.js');
    const { Live2DPet } = await import('./live2d.js');
    const live2d = new Live2DPet(canvas);
    await live2d.load(await window.desk.getModelUrl());
    return live2d;
  } catch (err) {
    console.error(err);
    showHint(`模型加载失败：${err.message}`);
    window.desk.setIgnoreMouse(false);
    throw err;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`缺少 ${src.split('/').pop()}`));
    document.head.appendChild(script);
  });
}

function showHint(text) {
  hint.textContent = text;
  hint.classList.remove('hidden');
}

// ---------- 气泡 ----------

const BUBBLE_GAP = 12;

function say(text, holdMs) {
  showBubble([text], holdMs);
}

function sayTyping(label = '') {
  const dots = document.createElement('span');
  dots.className = 'dots';
  dots.append(...[0, 1, 2].map(() => document.createElement('i')));
  const parts = [dots];
  if (label) {
    const span = document.createElement('span');
    span.className = 'typing-label';
    span.textContent = label;
    parts.unshift(span);
  }
  showBubble(parts);
}

function showBubble(nodes, holdMs) {
  clearTimeout(bubbleTimer);
  bubbleText.replaceChildren(...nodes);
  bubble.classList.remove('hidden', 'leaving');
  bubbleText.scrollTop = bubbleText.scrollHeight;
  bubble.style.top = `${Math.max(8, (pet.topY ?? 0) - bubble.offsetHeight - BUBBLE_GAP)}px`;
  if (holdMs) bubbleTimer = setTimeout(hideBubble, holdMs);
}

function hideBubble() {
  bubble.classList.add('leaving');
  bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), 180);
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}…` : text);

// ---------- 记忆 ----------

function saveHistory() {
  history = history.slice(-MAX_STORED);
  window.desk.saveHistory(history);
}

// 只把最近几轮发给模型，且以用户消息开头（部分接口要求 user/assistant 交替）
function context() {
  const recent = history.slice(-MAX_CONTEXT);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return recent;
}

function undoExchange() {
  if (abortCtrl) return stopReply();
  let i = history.length - 1;
  if (history[i]?.role === 'assistant') i--;
  pet.flash('撤回');
  if (history[i]?.role !== 'user') return say('没有可以撤回的对话哦', 2500);
  const [{ content }] = history.splice(i);
  saveHistory();
  say(`撤回了上一轮：「${clip(content, 14)}」`, 3500);
}

function clearHistory() {
  abortCtrl?.abort();
  history = [];
  saveHistory();
  pet.react('relaxed');
  say('擦干净啦，我们重新开始吧～', 3500);
}

function eraseClick() {
  pet.flash('橡皮');
  if (!history.length) return say('现在没有对话要擦哦', 2500);
  if (performance.now() - eraseArmedAt < ERASE_CONFIRM_MS) {
    eraseArmedAt = 0;
    return clearHistory();
  }
  eraseArmedAt = performance.now();
  say('再点一下橡皮，就把聊天记录全部擦掉哦', ERASE_CONFIRM_MS);
}

// ---------- 对话 ----------

async function send(text) {
  idle.poke();
  abortCtrl?.abort();
  const ctrl = (abortCtrl = new AbortController());
  const log = history;
  chatForm.classList.add('busy');
  chatSend.title = '停止';

  log.push({ role: 'user', content: text });
  pet.setBase('thinking');
  sayTyping();

  let reply = '';
  try {
    for await (const ev of streamChat(settings, context(), ctrl.signal)) {
      if (ev.type === 'thinking') {
        sayTyping('小鲸思考中');
      } else if (ev.type === 'queued') {
        sayTyping('有人在和我聊天，排队中');
      } else if (ev.type === 'emotion') {
        pet.react(ev.value);
      } else if (ev.type === 'delta') {
        if (!reply) {
          ev.text = ev.text.trimStart();
          if (!ev.text) continue;
          pet.setTalking(true);
        }
        reply += ev.text;
        say(reply);
      } else if (ev.type === 'error') {
        throw new Error(ev.message);
      }
    }
    if (reply) log.push({ role: 'assistant', content: reply });
    else log.pop();
    pet.flash('橡皮');
    say(reply || '（小鲸没想好说什么…）', Math.max(6000, reply.length * 180));
  } catch (err) {
    if (ctrl.signal.aborted) {
      if (abortCtrl !== ctrl) return;
      if (reply) log.push({ role: 'assistant', content: reply });
      else log.pop();
      say(reply || '好吧，那我先不说啦～', reply ? Math.max(4000, reply.length * 120) : 3000);
      return;
    }
    log.pop();
    pet.react('sad');
    if (err.status === 401) {
      reportAuthError(err);
    } else {
      say(`连接失败：${err.message}`, 8000);
    }
  } finally {
    if (log === history) saveHistory();
    if (abortCtrl === ctrl) {
      abortCtrl = null;
      chatForm.classList.remove('busy');
      chatSend.title = '发送';
      setTimeout(() => pet.setTalking(false), 400);
    }
  }
}

function reportAuthError(err) {
  const apiMode = settings.mode === 'apikey';
  if (apiMode) say(`${err.message}，请在设置里检查 API Key`, 8000);
  else say(settings.token ? '令牌不对哦，请在设置里重新填写' : '还没填访问令牌哦，请在设置里填写', 8000);
  openSettings();
  (apiMode ? settingsForm.apiKey : settingsForm.token).focus();
}

function stopReply() {
  abortCtrl?.abort();
  pet.flash('撤回');
}

chatSend.addEventListener('click', (e) => {
  if (!abortCtrl) return;
  e.preventDefault();
  stopReply();
});

function toggleChat(show = chatForm.classList.contains('hidden')) {
  chatForm.classList.toggle('hidden', !show);
  if (show) chatInput.focus();
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  send(text);
});

async function explainClipboard() {
  const text = (await window.desk.readClipboard()).trim();
  if (!text) {
    pet.react('surprised');
    return say('剪贴板里没有文字哦，先复制一段再叫我～', 3500);
  }
  send(`帮我看看剪贴板里的这段内容，简单解释或总结一下：\n${clip(text, CLIPBOARD_MAX)}`);
}

// ---------- 设置 ----------

for (const [id, { label }] of Object.entries(API_PRESETS)) presetSelect.add(new Option(label, id));

function syncFormMode() {
  settingsForm.dataset.mode = settingsForm.mode.value;
  settingsForm.dataset.preset = presetSelect.value;
  const models = API_PRESETS[presetSelect.value].models || [];
  if ([...apiModelSelect.options].map((o) => o.value).join() !== models.join()) {
    apiModelSelect.replaceChildren(...models.map((m) => new Option(m, m)));
  }
}

function fillModelSelect(models, defaultModel, selected) {
  const options = [new Option(defaultModel ? `服务器默认（${defaultModel}）` : '服务器默认', '')];
  for (const m of models || []) if (m !== defaultModel) options.push(new Option(m, m));
  if (selected && !options.some((o) => o.value === selected)) options.push(new Option(selected, selected));
  modelSelect.replaceChildren(...options);
  modelSelect.value = selected || '';
}

async function loadServerModels() {
  const selected = modelSelect.value;
  try {
    const { models, default: def } = await fetchModels(formSettings());
    fillModelSelect(models, def, selected);
  } catch {}
}

function openSettings() {
  const f = settingsForm;
  f.mode.value = settings.mode;
  f.token.value = settings.token;
  f.serverUrl.value = settings.serverUrl;
  f.serverUrl.placeholder = settings.officialServerUrl;
  f.querySelector('.adv').open = !!settings.serverUrl;
  presetSelect.value = API_PRESETS[settings.api.preset] ? settings.api.preset : 'deepseek';
  syncFormMode();
  f.apiKey.value = settings.api.key;
  f.apiBase.value = settings.api.baseUrl;
  f.apiModelName.value = settings.api.model;
  if ([...apiModelSelect.options].some((o) => o.value === settings.api.model)) apiModelSelect.value = settings.api.model;
  f.persona.value = settings.persona;
  f.waterOn.checked = settings.reminders.water.on;
  f.waterMin.value = settings.reminders.water.minutes;
  f.restOn.checked = settings.reminders.rest.on;
  f.restMin.value = settings.reminders.rest.minutes;
  fillModelSelect([], '', settings.model);
  for (const btn of f.querySelectorAll('.eye-toggle')) setSecretVisible(btn, false);
  setStatus('');
  f.classList.remove('hidden');
  f.querySelector('.panel-body').scrollTop = 0;
  if (settings.mode === 'official' && settings.token) loadServerModels();
}

function setSecretVisible(btn, visible) {
  btn.previousElementSibling.type = visible ? 'text' : 'password';
  btn.classList.toggle('on', visible);
  btn.title = visible ? '隐藏' : '显示';
}

function setStatus(kind, content = []) {
  settingsStatus.className = `status ${kind}`.trim();
  settingsStatus.replaceChildren(...[content].flat());
}

function chip({ text, ok }) {
  const el = document.createElement('span');
  el.className = `chip ${ok ? 'ok' : 'bad'}`;
  el.textContent = `${ok ? '✓' : '✕'} ${text}`;
  return el;
}

function closeSettings() {
  settingsForm.classList.add('hidden');
}

const minutes = (input, fallback) => Math.min(600, Math.max(1, Math.round(Number(input.value)) || fallback));

function formSettings() {
  const f = settingsForm;
  const preset = presetSelect.value;
  return {
    mode: f.mode.value,
    token: f.token.value.trim(),
    serverUrl: f.serverUrl.value.trim(),
    model: modelSelect.value,
    persona: f.persona.value.trim(),
    api: {
      preset,
      key: f.apiKey.value.trim(),
      baseUrl: f.apiBase.value.trim(),
      model: preset === 'custom' ? f.apiModelName.value.trim() : apiModelSelect.value,
    },
    reminders: {
      water: { on: f.waterOn.checked, minutes: minutes(f.waterMin, 45) },
      rest: { on: f.restOn.checked, minutes: minutes(f.restMin, 60) },
    },
    officialServerUrl: settings.officialServerUrl,
  };
}

settingsForm.addEventListener('change', (e) => {
  if (e.target.name === 'mode' || e.target === presetSelect) syncFormMode();
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  settings = await window.desk.setSettings(formSettings());
  assistant.configure(settings.reminders);
  closeSettings();
  say('设置已保存～', 3000);
});

$('settings-close').addEventListener('click', closeSettings);
for (const btn of settingsForm.querySelectorAll('.eye-toggle')) {
  btn.addEventListener('click', () => setSecretVisible(btn, btn.previousElementSibling.type === 'password'));
}

settingsTest.addEventListener('click', async () => {
  const form = formSettings();
  settingsTest.disabled = true;
  setStatus('pending', '正在测试连接…');
  try {
    const { chips, models } = await checkConnection(form);
    setStatus('', chips.map(chip));
    if (models) fillModelSelect(models.models, models.default, modelSelect.value);
  } catch (err) {
    const where = form.mode === 'apikey' ? '接口' : serverBase(form);
    setStatus('bad', `无法连接 ${where}：${err.message}`);
  } finally {
    settingsTest.disabled = false;
  }
});

// ---------- 右键菜单 ----------

const menu = createMenu($('menu'), { onToggle: (open) => open && setIgnore(false) });

function outfitSlots() {
  return pet.slots
    .filter((slot) => OUTFIT_SLOTS.includes(slot.id))
    .map((slot) => ({ ...slot, options: slot.options.filter((o) => o.expressions?.length && !o.motion && !o.clears) }))
    .filter((slot) => slot.options.length);
}

async function applyOutfit(outfit) {
  settings = await window.desk.setSettings({ outfit });
  pet.setOutfit(settings.outfit);
  pet.react('happy');
}

function outfitItems() {
  const slots = outfitSlots().map((slot) => {
    const names = OPTION_LABELS[slot.id] || {};
    const current = settings.outfit[slot.id] || '';
    const option = (label, value) => ({
      label,
      checked: (settings.outfit[slot.id] || '') === value,
      stay: true,
      action: () => applyOutfit({ ...settings.outfit, [slot.id]: value }),
    });
    return {
      label: OUTFIT_LABELS[slot.id] || slot.label,
      hint: current ? names[current] || current : names.none || slot.none,
      submenu: () => [
        option(names.none || slot.none, ''),
        ...slot.options.map((o) => option(names[o.label] || o.label, o.label)),
      ],
    };
  });
  return [...slots, '-', { label: '恢复默认', icon: 'refresh', stay: true, action: () => applyOutfit({ ...DEFAULT_OUTFIT }) }];
}

function pomodoroItems() {
  const status = assistant.pomodoroLabel();
  return status
    ? [{ note: status }, { label: '停止番茄钟', icon: 'stop', action: assistant.togglePomodoro }]
    : [{ note: '专注 25 分钟 + 休息 5 分钟' }, { label: '开始专注', icon: 'play', action: assistant.togglePomodoro }];
}

function wave() {
  pet.react('wave');
  say('嗨～', 2500);
}

async function menuItems() {
  const state = await window.desk.getAppState();
  const { command } = window.desk;
  return [
    { label: '聊天', icon: 'chat', action: () => toggleChat(true) },
    { label: '看看剪贴板', icon: 'clipboard', action: explainClipboard },
    { label: '番茄钟', icon: 'timer', hint: assistant.pomodoroLabel() ? '进行中' : '', submenu: pomodoroItems },
    { label: '换装', icon: 'shirt', submenu: outfitItems },
    { label: '打招呼', icon: 'wave', action: wave },
    '-',
    { label: '设置', icon: 'gear', action: openSettings },
    { label: '清空记忆', icon: 'trash', confirm: '再点一次，确认清空', action: clearHistory },
    { label: '总在最前', icon: 'pin', checked: state.alwaysOnTop, action: () => command('alwaysOnTop', !state.alwaysOnTop) },
    { label: '开机自启', icon: 'power', checked: state.autostart, action: () => command('autostart', !state.autostart) },
    { label: '隐藏到托盘', icon: 'hide', action: () => command('hide') },
    '-',
    { label: '重新加载', icon: 'refresh', action: () => command('reload') },
    { label: '开发者工具', icon: 'code', action: () => command('devtools') },
    { label: '退出', icon: 'exit', action: () => command('quit') },
  ];
}

// 菜单打开时窗口不穿透，点菜单外面就关掉（这一下不再触发别的互动）
window.addEventListener(
  'pointerdown',
  (e) => {
    if (!menu.isOpen || e.target.closest('#menu')) return;
    e.stopPropagation();
    dragged = true;
    if (e.button !== 2) menu.close();
  },
  true,
);
window.addEventListener('blur', () => menu.close());

// ---------- 鼠标：穿透 / 拖动 / 点击 / 桌上道具 ----------

const PROP_ACTIONS = {
  undo: (e) => e.detail === 1 && undoExchange(),
  brush: () => {
    pet.flash('画笔');
    toggleChat(true);
  },
  eraser: () => eraseClick(),
};

let ignoring = true;
let drag = null;
let dragged = false;

function setIgnore(ignore) {
  if (ignore === ignoring) return;
  ignoring = ignore;
  window.desk.setIgnoreMouse(ignore);
}

function isOverUI(target) {
  return !!target.closest?.('.ui:not(.hidden), #bubble:not(.hidden)');
}

window.addEventListener('mousemove', (e) => {
  pet.setPointer(e.clientX, e.clientY);
  if (drag) return;
  if (menu.isOpen) {
    pet.setHover(null);
    canvas.style.cursor = '';
    return setIgnore(false);
  }
  const prop = !isOverUI(e.target) && pet.propAt(e.clientX, e.clientY);
  const props = pet.profile.props;
  pet.setHover(prop && props[prop].look);
  canvas.style.cursor = prop ? 'pointer' : '';
  const overPet = !!prop || pet.hitTest(e.clientX, e.clientY);
  if (overPet) idle.poke();
  setIgnore(!(isOverUI(e.target) || overPet));
});

canvas.addEventListener('pointerdown', async (e) => {
  idle.poke();
  dragged = false;
  if (e.button !== 0 || !pet.hitTest(e.clientX, e.clientY)) return;
  canvas.setPointerCapture(e.pointerId);
  drag = { sx: e.screenX, sy: e.screenY, moved: false, win: null };
  const [x, y] = await window.desk.getWindowPosition();
  if (drag) drag.win = { x, y };
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag?.win) return;
  const dx = e.screenX - drag.sx;
  const dy = e.screenY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  window.desk.moveWindow(drag.win.x + dx, drag.win.y + dy);
});

canvas.addEventListener('pointerup', () => {
  if (!drag) return;
  dragged = drag.moved;
  drag = null;
});

canvas.addEventListener('click', (e) => {
  if (dragged || !pet.hitTest(e.clientX, e.clientY)) return;
  const prop = pet.propAt(e.clientX, e.clientY);
  if (prop) return PROP_ACTIONS[prop](e);
  if (e.detail === 1) {
    const [emotion, line] = CLICK_LINES[Math.floor(Math.random() * CLICK_LINES.length)];
    pet.react(emotion);
    if (!abortCtrl) say(line, 3000);
  }
});

canvas.addEventListener('dblclick', (e) => {
  if (pet.hitTest(e.clientX, e.clientY) && !pet.propAt(e.clientX, e.clientY)) toggleChat();
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  idle.poke();
  if (e.target.closest('#menu')) return;
  if (menu.isOpen || pet.hitTest(e.clientX, e.clientY)) menu.open(e.clientX, e.clientY, menuItems);
});

window.addEventListener('keydown', (e) => {
  idle.poke();
  if (e.key === 'Escape') {
    if (menu.isOpen) return menu.close();
    toggleChat(false);
    closeSettings();
  }
});

window.desk.onMenuAction((action) => {
  idle.poke();
  if (action === 'settings') openSettings();
});

pet.react('wave');
const configured = settings.mode === 'apikey' ? settings.api.key : settings.token;
say(
  !configured
    ? '你好呀！右键我打开「设置」填写令牌或 API Key，双击我聊天～'
    : history.length
      ? '欢迎回来～我还记得我们上次聊的哦'
      : '你好呀，双击我就可以聊天～',
  6000,
);
