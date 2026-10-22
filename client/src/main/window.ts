// 透明、无边框、置顶的桌宠窗口
import { BrowserWindow, screen } from 'electron';
import type { EventContract, EventChannel } from '../shared/ipc';
import { ICON, PRELOAD, RENDERER_DEV_URL, RENDERER_HTML, WIN_ICON } from './paths';
import type { SettingsStore } from './settings';

export const WIN_W = 280;
export const WIN_H = 430;

let win: BrowserWindow | null = null;
let store: SettingsStore;
let isDragging: () => boolean = () => false;

export const getWindow = (): BrowserWindow | null => win;

export function createWindow(settings: SettingsStore, dragging: () => boolean): BrowserWindow {
  store = settings;
  isDragging = dragging;
  const s = store.get();
  const { workArea } = screen.getPrimaryDisplay();
  const pos = s.position || {
    x: workArea.x + workArea.width - WIN_W - 40,
    y: workArea.y + workArea.height - WIN_H,
  };

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pos.x,
    y: pos.y,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: s.alwaysOnTop,
    icon: process.platform === 'win32' ? WIN_ICON : ICON,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.setAlwaysOnTop(s.alwaysOnTop, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  if (RENDERER_DEV_URL) win.loadURL(RENDERER_DEV_URL);
  else win.loadFile(RENDERER_HTML);
  win.on('moved', () => {
    if (!isDragging()) savePosition();
  });
  return win;
}

export function savePosition(): void {
  if (!win) return;
  const [x, y] = win.getPosition();
  store.get().position = { x, y };
  store.save();
}

export function showWindow(): void {
  if (!win) return;
  win.showInactive();
  win.setAlwaysOnTop(store.get().alwaysOnTop, 'screen-saver');
}

export function toggleWindow(): void {
  if (win?.isVisible()) win.hide();
  else showWindow();
}

export function setAlwaysOnTop(on: boolean): void {
  store.get().alwaysOnTop = on;
  win?.setAlwaysOnTop(on, 'screen-saver');
  store.save();
}

export function sendToRenderer<C extends EventChannel>(channel: C, ...args: Parameters<EventContract[C]>): void {
  win?.webContents.send(channel, ...args);
}
