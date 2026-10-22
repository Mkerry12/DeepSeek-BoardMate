// 托盘图标与右键菜单
import { app, Menu, nativeImage, Tray } from 'electron';
import { autostartEnabled, setAutostart } from './autostart';
import { ICON, WIN_ICON } from './paths';
import { getWindow, sendToRenderer, showWindow, toggleWindow } from './window';

let tray: Tray | null = null;

export function createTray(): Tray {
  tray = new Tray(
    process.platform === 'win32'
      ? WIN_ICON
      : nativeImage.createFromPath(ICON).resize({ width: 32, height: 32, quality: 'best' }),
  );
  tray.setToolTip('DeepSeek DeskMate · 小鲸');
  tray.on('click', toggleWindow);
  tray.on('right-click', () =>
    tray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: getWindow()?.isVisible() ? '隐藏小鲸' : '显示小鲸', click: toggleWindow },
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
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    ),
  );
  return tray;
}
