// 主进程 ⇄ 渲染进程的唯一 IPC 约定：频道名、参数和返回值都在这里定义
//   主进程按 InvokeContract / SendContract 注册处理函数（src/main/ipc.ts，缺一个就编译不过）
//   preload 按 DESK_API 生成 window.desk（src/preload/index.ts），渲染进程拿到的类型是 DeskApi
import type { AppCommand, AppState, ChatMessage, MemoryState, MenuAction, SettingsPatch, SettingsView } from './types';

/** 渲染进程 → 主进程，有返回值（ipcRenderer.invoke / ipcMain.handle） */
export interface InvokeContract {
  'settings:get': () => SettingsView;
  'settings:set': (patch: SettingsPatch) => SettingsView;
  'history:get': () => ChatMessage[];
  'history:set': (messages: ChatMessage[]) => void;
  'memory:get': () => MemoryState | null;
  'memory:set': (memory: MemoryState) => void;
  tts: (text: string, voice: string) => Uint8Array;
  'clipboard:read': () => string;
  'model:url': () => string;
  'app:state': () => AppState;
}

/** 渲染进程 → 主进程，不等结果（ipcRenderer.send / ipcMain.on） */
export interface SendContract {
  notify: (title: string, body: string) => void;
  'mouse:ignore': (ignore: boolean) => void;
  'drag:start': () => void;
  'drag:end': () => void;
  'app:command': (name: AppCommand, arg?: boolean) => void;
}

/** 主进程 → 渲染进程（webContents.send / ipcRenderer.on） */
export interface EventContract {
  'menu:action': (action: MenuAction) => void;
}

export type InvokeChannel = keyof InvokeContract;
export type SendChannel = keyof SendContract;
export type EventChannel = keyof EventContract;

type ApiEntry =
  | { readonly kind: 'invoke'; readonly channel: InvokeChannel }
  | { readonly kind: 'send'; readonly channel: SendChannel }
  | { readonly kind: 'event'; readonly channel: EventChannel };

/** window.desk 的方法名 → 频道 */
export const DESK_API = {
  getSettings: { kind: 'invoke', channel: 'settings:get' },
  setSettings: { kind: 'invoke', channel: 'settings:set' },
  getHistory: { kind: 'invoke', channel: 'history:get' },
  saveHistory: { kind: 'invoke', channel: 'history:set' },
  getMemory: { kind: 'invoke', channel: 'memory:get' },
  saveMemory: { kind: 'invoke', channel: 'memory:set' },
  tts: { kind: 'invoke', channel: 'tts' },
  readClipboard: { kind: 'invoke', channel: 'clipboard:read' },
  getModelUrl: { kind: 'invoke', channel: 'model:url' },
  getAppState: { kind: 'invoke', channel: 'app:state' },
  notify: { kind: 'send', channel: 'notify' },
  setIgnoreMouse: { kind: 'send', channel: 'mouse:ignore' },
  dragStart: { kind: 'send', channel: 'drag:start' },
  dragEnd: { kind: 'send', channel: 'drag:end' },
  command: { kind: 'send', channel: 'app:command' },
  onMenuAction: { kind: 'event', channel: 'menu:action' },
} as const satisfies Record<string, ApiEntry>;

type Api = typeof DESK_API;

type ApiMethod<E> = E extends { kind: 'invoke'; channel: infer C extends InvokeChannel }
  ? (...args: Parameters<InvokeContract[C]>) => Promise<Awaited<ReturnType<InvokeContract[C]>>>
  : E extends { kind: 'send'; channel: infer C extends SendChannel }
    ? (...args: Parameters<SendContract[C]>) => void
    : E extends { kind: 'event'; channel: infer C extends EventChannel }
      ? (listener: EventContract[C]) => void
      : never;

/** 渲染进程里 window.desk 的类型 */
export type DeskApi = { [K in keyof Api]: ApiMethod<Api[K]> };

/** 主进程的处理函数：返回值可以是 Promise */
export type InvokeHandlers = {
  [C in InvokeChannel]: (
    ...args: Parameters<InvokeContract[C]>
  ) => ReturnType<InvokeContract[C]> | Promise<ReturnType<InvokeContract[C]>>;
};
export type SendHandlers = { [C in SendChannel]: SendContract[C] };

export function channelsOf(kind: ApiEntry['kind']): string[] {
  return Object.values(DESK_API as Record<string, ApiEntry>)
    .filter((e) => e.kind === kind)
    .map((e) => e.channel);
}

/** preload 用：只依赖 ipcRenderer 的最小接口，方便测试 */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

export function createDeskApi(ipc: IpcRendererLike): DeskApi {
  const api: Record<string, (...args: unknown[]) => unknown> = {};
  for (const [name, entry] of Object.entries(DESK_API as Record<string, ApiEntry>)) {
    const { kind, channel } = entry;
    if (kind === 'invoke') api[name] = (...args) => ipc.invoke(channel, ...args);
    else if (kind === 'send') api[name] = (...args) => ipc.send(channel, ...args);
    else
      api[name] = (listener) => {
        ipc.on(channel, (_e, ...args) => (listener as (...a: unknown[]) => void)(...args));
      };
  }
  return api as DeskApi;
}

/** 主进程用：只依赖 ipcMain 的最小接口，方便测试 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 与 Electron 的 IpcMain 签名对齐 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function registerIpc(ipc: IpcMainLike, invoke: InvokeHandlers, send: SendHandlers): void {
  for (const channel of Object.keys(invoke) as InvokeChannel[]) {
    const fn = invoke[channel] as (...args: unknown[]) => unknown;
    ipc.handle(channel, (_e, ...args: unknown[]) => fn(...args));
  }
  for (const channel of Object.keys(send) as SendChannel[]) {
    const fn = send[channel] as (...args: unknown[]) => void;
    ipc.on(channel, (_e, ...args: unknown[]) => fn(...args));
  }
}
