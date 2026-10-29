// 托盘图标与右键菜单
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { updateMenuItem } from '../shared/update';
import { autostartEnabled, setAutostart } from './autostart';
import { characterName, ICON, WIN_ICON } from './paths';
import type { Updater } from './updater';
import { getWindow, sendToRenderer, showWindow, toggleWindow } from './window';

let tray: Tray | null = null;

function updateItem(updater: Updater): MenuItemConstructorOptions[] {
  const status = updater.status();
  if (status.state === 'disabled') return [];
  const item = updateMenuItem(status);
  const run = { check: () => void updater.check(), install: updater.install, 'open-page': updater.openPage };
  return [{ label: item.hint ? `${item.label}（${item.hint}）` : item.label, click: run[item.action] }];
}

export function createTray(updater: Updater): Tray {
  tray = new Tray(
    process.platform === 'win32'
      ? WIN_ICON
      : nativeImage.createFromPath(ICON).resize({ width: 32, height: 32, quality: 'best' }),
  );
  const name = characterName();
  tray.setToolTip(`DeepSeek DeskMate · ${name}`);
  tray.on('click', toggleWindow);
  tray.on('right-click', () =>
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: getWindow()?.isVisible() ? `隐藏${name}` : `显示${name}`, click: toggleWindow },
        {
          label: '设置',
          click: () => {
            showWindow();
            sendToRenderer('menu:action', 'settings');
          },
        },
        {
          label: '开机自启',
          type: 'checkbox',
          checked: autostartEnabled(),
          click: (item) => setAutostart(item.checked),
        },
        ...updateItem(updater),
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    ),
  );
  return tray;
}
