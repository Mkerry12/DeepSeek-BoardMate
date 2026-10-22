// 类型化的事件总线：功能模块之间通过事件协作，而不是互相直接调用
import type { ChatMessage, MenuAction, SettingsView } from '../../shared/types';
import type { ChatError } from '../lib/chat-api';

/** 事件名 → 载荷类型。新增事件先在这里登记 */
export interface AppEvents {
  /** 任何用户互动（鼠标、键盘、菜单…），闲置模块据此打断小动作 / 叫醒 */
  'user:active': void;
  /** 请求发一条消息（剪贴板等功能也走这里） */
  'chat:send': { text: string };
  /** 请求停止当前回复 */
  'chat:stop': void;
  /** 显示 / 隐藏聊天输入框；show 省略表示切换 */
  'chat:toggle': { show?: boolean };
  'chat:start': { text: string };
  'chat:delta': { text: string; reply: string };
  /** 正常说完；reply 为空表示模型什么也没说 */
  'chat:end': { reply: string };
  /** 被用户停止或被新消息打断 */
  'chat:aborted': { reply: string };
  'chat:error': { error: ChatError };
  'history:changed': { history: ChatMessage[] };
  'settings:open': { focus?: 'token' | 'apiKey' } | void;
  /** 设置被修改（任何来源） */
  'settings:changed': { settings: SettingsView };
  /** 用户在设置面板点了保存 */
  'settings:saved': { settings: SettingsView };
  /** 托盘菜单发来的动作 */
  'menu:action': { action: MenuAction };
  /** 单击角色（不是道具）；zone 是命中的触摸区 */
  'pet:touched': { zone: string | null };
  /** 点了桌上的道具（角色配置 live2d.props 的 key）；detail 是连击次数 */
  'pet:prop': { prop: string; detail: number };
  /** 所有功能模块都装好了 */
  'app:ready': void;
  'idle:start': { motion?: string };
  'idle:end': void;
  /** Esc：收起输入框、关闭设置、停止朗读 */
  'ui:escape': void;
}

type Handler<P> = [P] extends [void] ? () => void : (payload: P) => void;
type Args<P> = [P] extends [void] ? [] : undefined extends P ? [payload?: P] : [payload: P];

export interface Bus<E> {
  on<K extends keyof E>(event: K, handler: Handler<E[K]>): () => void;
  emit<K extends keyof E>(event: K, ...args: Args<E[K]>): void;
}

/** 处理函数按注册顺序同步执行；某个处理函数抛错不影响其他处理函数 */
export function createBus<E>(): Bus<E> {
  const handlers = new Map<keyof E, Set<(payload?: unknown) => void>>();
  return {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      handlers.set(event, set);
      const fn = handler as (payload?: unknown) => void;
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(event, ...args) {
      for (const fn of [...(handlers.get(event) ?? [])]) {
        try {
          fn(args[0]);
        } catch (err) {
          console.error(`[bus] ${String(event)} 处理出错：`, err);
        }
      }
    },
  };
}

export type AppBus = Bus<AppEvents>;
