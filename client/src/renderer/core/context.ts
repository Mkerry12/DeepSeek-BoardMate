// 传给每个功能模块的共享服务。功能模块之间不互相 import，只通过 bus 事件和 status 协作
import type { CharacterConfig } from '../character/config';
import type { Live2DPet } from '../pet/live2d';
import type { Bubble } from '../services/bubble';
import type { Memory } from '../services/memory';
import type { Menu } from '../services/menu';
import type { Voice } from '../services/voice';
import type { AppBus } from './bus';
import type { Dom } from './dom';
import type { Status } from './status';
import type { Store } from './store';

export interface AppContext {
  bus: AppBus;
  status: Status;
  store: Store;
  dom: Dom;
  pet: Live2DPet;
  character: CharacterConfig;
  bubble: Bubble;
  voice: Voice;
  memory: Memory;
  menu: Menu;
  /** 窗口是否让鼠标穿透到桌面（没指着角色 / 界面时穿透） */
  setIgnoreMouse(ignore: boolean): void;
}

/** 功能模块：install 时订阅事件、登记菜单项和状态 */
export type Feature = (ctx: AppContext) => void;

/** 右键菜单里各组的位置（小的在上面） */
export const MENU_ORDER = {
  chat: 10,
  clipboard: 20,
  pomodoro: 30,
  fortune: 40,
  outfit: 50,
  wave: 60,
  separator1: 100,
  settings: 110,
  voice: 120,
  memory: 130,
  clearHistory: 140,
  window: 150,
  separator2: 200,
  update: 205,
  app: 210,
} as const;
