// 渲染进程入口：读设置 → 加载角色 → 建共享服务 → 按顺序装上各功能模块
import { resolveOutfit } from './character/config';
import { createBus, type AppEvents } from './core/bus';
import { MENU_ORDER, type AppContext, type Feature } from './core/context';
import { queryDom, showHint } from './core/dom';
import { createStatus } from './core/status';
import { createStore } from './core/store';
import { assistantFeature } from './features/assistant';
import { chatFeature } from './features/chat';
import { fortuneFeature } from './features/fortune';
import { greetingsFeature } from './features/greetings';
import { idleFeature } from './features/idle';
import { keyboardFeature } from './features/keyboard';
import { memoryFeature } from './features/memory';
import { outfitFeature } from './features/outfit';
import { settingsPanelFeature } from './features/settings-panel';
import { touchFeature } from './features/touch';
import { updaterFeature } from './features/updater';
import { voiceFeature } from './features/voice';
import { windowMenuFeature } from './features/window-menu';
import { loadPet } from './pet/load';
import { createBubble } from './services/bubble';
import { createMemory } from './services/memory';
import { createMenu } from './services/menu';
import { createVoice } from './services/voice';

// 装载顺序 = 同一事件的处理顺序
const FEATURES: Feature[] = [
  chatFeature,
  voiceFeature,
  memoryFeature,
  touchFeature,
  idleFeature,
  assistantFeature,
  greetingsFeature,
  settingsPanelFeature,
  fortuneFeature,
  outfitFeature,
  windowMenuFeature,
  updaterFeature,
  keyboardFeature,
];

const dom = queryDom();
const bus = createBus<AppEvents>();
const status = createStatus();
const { pet, character } = await loadPet(dom.canvas).catch((err: Error) => {
  console.error(err);
  showHint(dom, `模型加载失败：${err.message}`);
  window.desk.setIgnoreMouse(false);
  throw err;
});
const store = createStore(bus, await window.desk.getSettings(), await window.desk.getHistory(), (s) => ({
  ...s,
  outfit: resolveOutfit(s.outfit, character.outfit.default),
}));
pet.setOutfit(store.settings.outfit);
dom.chatInput.placeholder = `和${character.name}说点什么…`;

const voice = createVoice({ getSettings: () => store.settings, sounds: () => pet.sounds });
const memory = await createMemory({ getSettings: () => store.settings, getHistory: () => store.history });

let ignoring = true;
function setIgnoreMouse(ignore: boolean) {
  if (ignore === ignoring) return;
  ignoring = ignore;
  window.desk.setIgnoreMouse(ignore);
}

const menu = createMenu(dom.menu, {
  onToggle: (open) => {
    if (open) setIgnoreMouse(false);
  },
});
menu.register(MENU_ORDER.separator1, () => ['-']);
menu.register(MENU_ORDER.separator2, () => ['-']);
status.provide('menuOpen', () => menu.isOpen);

const ctx: AppContext = {
  bus,
  status,
  store,
  dom,
  pet,
  character,
  bubble: createBubble(dom, () => pet.topY),
  voice,
  memory,
  menu,
  setIgnoreMouse,
};
for (const install of FEATURES) install(ctx);

window.desk.onMenuAction((action) => {
  bus.emit('user:active');
  bus.emit('menu:action', { action });
});

bus.emit('app:ready');
