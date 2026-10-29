// 对话：输入框、发送 / 流式显示 / 停止、聊天记录（撤回、橡皮擦、清空）
import { MENU_ORDER, type Feature } from '../core/context';
import { clip } from '../core/util';
import { streamChat, type ChatError } from '../lib/chat-api';

const MAX_CONTEXT = 20;
const ERASE_CONFIRM_MS = 4000;

export const chatFeature: Feature = (ctx) => {
  const { bus, store, pet, bubble, voice, memory, status, menu, character } = ctx;
  const { chatForm, chatInput, chatSend } = ctx.dom;
  const say = bubble.say;
  const { longReply } = character;
  const { props } = character.live2d;

  let abortCtrl: AbortController | null = null;
  let eraseArmedAt = 0;
  let whaleTimer: ReturnType<typeof setTimeout> | undefined;

  status.provide('replying', () => !!abortCtrl);
  status.provide('typing', () => !!chatInput.value);

  /** 闪一下桌上道具对应的表情（撤回 / 画笔 / 橡皮） */
  const flashProp = (id: string) => {
    const look = props[id]?.look;
    if (look) pet.flash(look);
  };

  // 只把最近几轮发给模型，且以用户消息开头（部分接口要求 user/assistant 交替）
  function context() {
    const recent = store.history.slice(-MAX_CONTEXT);
    while (recent.length && recent[0].role !== 'user') recent.shift();
    return recent;
  }

  function undoExchange() {
    if (abortCtrl) return stopReply();
    const history = store.history;
    let i = history.length - 1;
    if (history[i]?.role === 'assistant') i--;
    flashProp('undo');
    if (history[i]?.role !== 'user') return say('没有可以撤回的对话哦', 2500);
    const [{ content }] = history.splice(i);
    store.saveHistory();
    say(`撤回了上一轮：「${clip(content, 14)}」`, 3500);
  }

  function clearHistory() {
    abortCtrl?.abort();
    voice.stop();
    store.history = [];
    store.saveHistory();
    pet.react('relaxed');
    say('擦干净啦，我们重新开始吧～', 3500);
  }

  function eraseClick() {
    flashProp('eraser');
    if (!store.history.length) return say('现在没有对话要擦哦', 2500);
    if (performance.now() - eraseArmedAt < ERASE_CONFIRM_MS) {
      eraseArmedAt = 0;
      return clearHistory();
    }
    eraseArmedAt = performance.now();
    say('再点一下橡皮，就把聊天记录全部擦掉哦', ERASE_CONFIRM_MS);
  }

  // 长回复时小鲸鱼从头顶挪到桌上（只在戴着头顶鲸时）
  function whaleToDesk(on: boolean) {
    clearTimeout(whaleTimer);
    if (on && pet.isLit(longReply.whenLit)) pet.setLayer('task', longReply.looks);
    else if (!on) whaleTimer = setTimeout(() => pet.setLayer('task', null), longReply.backMs);
  }

  async function send(text: string) {
    bus.emit('user:active');
    abortCtrl?.abort();
    const ctrl = (abortCtrl = new AbortController());
    bus.emit('chat:start', { text });
    const log = store.history;
    chatForm.classList.add('busy');
    chatSend.title = '停止';

    log.push({ role: 'user', content: text });
    pet.setBase('thinking');
    pet.setNotes(true);
    clearTimeout(whaleTimer);
    pet.setLayer('task', null);
    bubble.sayTyping();

    let reply = '';
    try {
      for await (const ev of streamChat(store.settings, context(), ctrl.signal, memory.text)) {
        if (ev.type === 'thinking') {
          bubble.sayTyping(`${character.name}思考中`);
        } else if (ev.type === 'queued') {
          bubble.sayTyping('有人在和我聊天，排队中');
        } else if (ev.type === 'emotion') {
          pet.react(ev.value);
        } else if (ev.type === 'delta') {
          let piece = ev.text;
          if (!reply) {
            piece = piece.trimStart();
            if (!piece) continue;
            pet.setTalking(true);
          }
          if (reply.length <= longReply.chars && reply.length + piece.length > longReply.chars) whaleToDesk(true);
          reply += piece;
          bus.emit('chat:delta', { text: piece, reply });
          say(reply);
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      }
      if (reply) {
        log.push({ role: 'assistant', content: reply });
      } else {
        log.pop();
        pet.react('soulout');
      }
      bus.emit('chat:end', { reply });
      flashProp('eraser');
      say(reply || `（${character.name}没想好说什么…）`, Math.max(6000, reply.length * 180));
    } catch (err) {
      if (ctrl.signal.aborted) {
        if (abortCtrl !== ctrl) return;
        if (reply) log.push({ role: 'assistant', content: reply });
        else log.pop();
        bus.emit('chat:aborted', { reply });
        say(reply || '好吧，那我先不说啦～', reply ? Math.max(4000, reply.length * 120) : 3000);
        return;
      }
      const error = err as ChatError;
      log.pop();
      pet.react('soulout');
      bus.emit('chat:error', { error });
      if (error.status === 401) reportAuthError(error);
      else say(`连接失败：${error.message}`, 8000);
    } finally {
      if (log === store.history) store.saveHistory();
      if (abortCtrl === ctrl) {
        abortCtrl = null;
        chatForm.classList.remove('busy');
        chatSend.title = '发送';
        pet.setNotes(false);
        whaleToDesk(false);
        setTimeout(() => pet.setTalking(false), 400);
      }
    }
  }

  function reportAuthError(err: ChatError) {
    const { settings } = store;
    const apiMode = settings.mode === 'apikey';
    if (apiMode) say(`${err.message}，请在设置里检查 API Key`, 8000);
    else say(settings.token ? '令牌不对哦，请在设置里重新填写' : '还没填访问令牌哦，请在设置里填写', 8000);
    bus.emit('settings:open', { focus: apiMode ? 'apiKey' : 'token' });
  }

  function stopReply() {
    abortCtrl?.abort();
    voice.stop();
    flashProp('undo');
  }

  function toggleChat(show = chatForm.classList.contains('hidden')) {
    chatForm.classList.toggle('hidden', !show);
    if (show) chatInput.focus();
  }

  chatSend.addEventListener('click', (e) => {
    if (!abortCtrl) return;
    e.preventDefault();
    stopReply();
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    send(text);
  });

  bus.on('chat:send', ({ text }) => send(text));
  bus.on('chat:stop', stopReply);
  bus.on('chat:toggle', ({ show }) => toggleChat(show));
  bus.on('ui:escape', () => toggleChat(false));
  // 桌上纸张里的三个图标：撤回上一轮 / 画笔打开输入框 / 橡皮擦掉记录
  bus.on('pet:prop', ({ prop, detail }) => {
    if (prop === 'undo' && detail === 1) undoExchange();
    else if (prop === 'brush') {
      flashProp('brush');
      toggleChat(true);
    } else if (prop === 'eraser') eraseClick();
  });

  menu.register(MENU_ORDER.chat, () => [{ label: '聊天', icon: 'chat', action: () => toggleChat(true) }]);
  menu.register(MENU_ORDER.clearHistory, () => [
    { label: '清空记忆', icon: 'trash', confirm: '再点一次，确认清空', action: clearHistory },
  ]);
};
