import { describe, expect, it, vi } from 'vitest';
import { channelsOf, createDeskApi, DESK_API, registerIpc, type IpcRendererLike } from '../src/shared/ipc';

// main/ipc.ts 依赖 electron，这里只给出它在导入时用到的部分
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getPath: () => '/tmp', quit: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: vi.fn(),
  screen: {},
  clipboard: { readText: () => 'clip' },
  Notification: { isSupported: () => false },
}));

const { createHandlers } = await import('../src/main/ipc');

const fakeStores = () => {
  const settings = { alwaysOnTop: true };
  return {
    settings: {
      get: () => settings,
      view: () => ({ ...settings, officialServerUrl: 'x' }),
      patch: vi.fn(),
      save: vi.fn(),
    },
    history: { get: vi.fn(() => []), set: vi.fn() },
    memory: { get: vi.fn(() => null), set: vi.fn() },
    updater: {
      status: vi.fn(() => ({ state: 'latest', kind: 'installer', current: '0.2.0' })),
      check: vi.fn(async () => ({ state: 'latest', kind: 'installer', current: '0.2.0' })),
      install: vi.fn(),
      openPage: vi.fn(),
    },
  } as unknown as Parameters<typeof createHandlers>[0];
};

describe('IPC contract', () => {
  it('uses each channel once and only valid kinds', () => {
    const entries = Object.values(DESK_API);
    const channels = entries.map((e) => e.channel);
    expect(new Set(channels).size).toBe(channels.length);
    for (const e of entries) expect(['invoke', 'send', 'event']).toContain(e.kind);
  });

  it('main registers a handler for every invoke and send channel, and nothing else', () => {
    const { invoke, send } = createHandlers(fakeStores());
    expect(Object.keys(invoke).sort()).toEqual(channelsOf('invoke').sort());
    expect(Object.keys(send).sort()).toEqual(channelsOf('send').sort());
  });

  it('registerIpc wires handle/on and strips the event argument', async () => {
    const handle = vi.fn();
    const on = vi.fn();
    const invoke = Object.fromEntries(channelsOf('invoke').map((c) => [c, vi.fn((...a: unknown[]) => [c, ...a])]));
    const send = Object.fromEntries(channelsOf('send').map((c) => [c, vi.fn()]));
    registerIpc({ handle, on }, invoke as never, send as never);
    expect(handle.mock.calls.map((c) => c[0]).sort()).toEqual(channelsOf('invoke').sort());
    expect(on.mock.calls.map((c) => c[0]).sort()).toEqual(channelsOf('send').sort());

    const [, ttsListener] = handle.mock.calls.find((c) => c[0] === 'tts')!;
    expect(await ttsListener({ sender: 1 }, 'hi', 'voice')).toEqual(['tts', 'hi', 'voice']);
    const [, notifyListener] = on.mock.calls.find((c) => c[0] === 'notify')!;
    notifyListener({ sender: 1 }, 'title', 'body');
    expect(send.notify).toHaveBeenCalledWith('title', 'body');
  });

  it('preload exposes one method per DESK_API entry mapped to the right channel', async () => {
    const ipc = {
      invoke: vi.fn(async (...a: unknown[]) => a),
      send: vi.fn(),
      on: vi.fn(),
    } satisfies IpcRendererLike;
    const api = createDeskApi(ipc);
    expect(Object.keys(api).sort()).toEqual(Object.keys(DESK_API).sort());

    expect(await api.setSettings({ token: 't' })).toEqual(['settings:set', { token: 't' }]);
    await api.tts('hi', 'zh-CN-XiaoyiNeural');
    expect(ipc.invoke).toHaveBeenLastCalledWith('tts', 'hi', 'zh-CN-XiaoyiNeural');

    api.command('alwaysOnTop', false);
    expect(ipc.send).toHaveBeenLastCalledWith('app:command', 'alwaysOnTop', false);
    api.dragStart();
    expect(ipc.send).toHaveBeenLastCalledWith('drag:start');

    const cb = vi.fn();
    api.onMenuAction(cb);
    const [channel, listener] = ipc.on.mock.calls[0];
    expect(channel).toBe('menu:action');
    listener({ sender: 1 }, 'settings');
    expect(cb).toHaveBeenCalledWith('settings');
  });

  it('update channels delegate to the updater', async () => {
    const stores = fakeStores();
    const { invoke, send } = createHandlers(stores);
    expect(await invoke['update:check']()).toMatchObject({ state: 'latest' });
    expect(invoke['update:status']()).toMatchObject({ current: '0.2.0' });
    send['update:install']();
    send['update:open-page']();
    expect(stores.updater.install).toHaveBeenCalledOnce();
    expect(stores.updater.openPage).toHaveBeenCalledOnce();
  });

  it('settings:set re-applies always-on-top only when the patch touches it', () => {
    const stores = fakeStores();
    vi.mocked(stores.settings.patch).mockReturnValue({ alwaysOnTop: false } as never);
    const { invoke } = createHandlers(stores);
    expect(invoke['settings:set']({ persona: 'x' })).toEqual({ alwaysOnTop: false });
    expect(stores.settings.patch).toHaveBeenCalledWith({ persona: 'x' });
  });
});
