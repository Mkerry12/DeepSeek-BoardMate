// 按 src/shared/ipc.ts 的约定注册全部 IPC 处理函数
import { app, ipcMain } from 'electron';
import { registerIpc, type InvokeHandlers, type SendHandlers } from '../shared/ipc';
import type { AppCommand } from '../shared/types';
import { autostartEnabled, setAutostart } from './autostart';
import { dragEnd, dragStart } from './drag';
import type { createHistoryStore, createMemoryStore } from './history';
import { modelUrl } from './paths';
import type { SettingsStore } from './settings';
import { notify, readClipboard } from './system';
import { edgeTts } from './tts';
import { getWindow, setAlwaysOnTop } from './window';

interface Stores {
  settings: SettingsStore;
  history: ReturnType<typeof createHistoryStore>;
  memory: ReturnType<typeof createMemoryStore>;
}

// 渲染进程里的 HTML 右键菜单需要的操作
const commands: Record<AppCommand, (arg?: boolean) => void> = {
  alwaysOnTop: (on) => setAlwaysOnTop(!!on),
  autostart: (on) => setAutostart(!!on),
  hide: () => getWindow()?.hide(),
  reload: () => getWindow()?.reload(),
  devtools: () => getWindow()?.webContents.openDevTools({ mode: 'detach' }),
  quit: () => app.quit(),
};

export function createHandlers({ settings, history, memory }: Stores): {
  invoke: InvokeHandlers;
  send: SendHandlers;
} {
  return {
    invoke: {
      'settings:get': () => settings.view(),
      'settings:set': (patch) => {
        const view = settings.patch(patch);
        if ('alwaysOnTop' in patch) getWindow()?.setAlwaysOnTop(view.alwaysOnTop, 'screen-saver');
        return view;
      },
      'history:get': () => history.get(),
      'history:set': (messages) => history.set(messages),
      'memory:get': () => memory.get(),
      'memory:set': (m) => memory.set(m),
      tts: (text, voice) => edgeTts(String(text), String(voice)),
      'clipboard:read': () => readClipboard(),
      'model:url': () => modelUrl(),
      'app:state': () => ({ alwaysOnTop: settings.get().alwaysOnTop, autostart: autostartEnabled() }),
    },
    send: {
      notify: (title, body) => notify(title, body),
      'mouse:ignore': (ignore) => getWindow()?.setIgnoreMouseEvents(ignore, { forward: true }),
      'drag:start': () => dragStart(),
      'drag:end': () => dragEnd(),
      'app:command': (name, arg) => commands[name]?.(arg),
    },
  };
}

export function registerHandlers(stores: Stores): void {
  const { invoke, send } = createHandlers(stores);
  registerIpc(ipcMain, invoke, send);
}
