// 右键菜单里和窗口 / 应用相关的项：总在最前、开机自启、隐藏、重新加载、开发者工具、退出
import { MENU_ORDER, type Feature } from '../core/context';

export const windowMenuFeature: Feature = ({ menu }) => {
  const { command } = window.desk;

  menu.register(MENU_ORDER.window, async () => {
    const state = await window.desk.getAppState();
    return [
      {
        label: '总在最前',
        icon: 'pin',
        checked: state.alwaysOnTop,
        action: () => command('alwaysOnTop', !state.alwaysOnTop),
      },
      {
        label: '开机自启',
        icon: 'power',
        checked: state.autostart,
        action: () => command('autostart', !state.autostart),
      },
      { label: '隐藏到托盘', icon: 'hide', action: () => command('hide') },
    ];
  });

  menu.register(MENU_ORDER.app, () => [
    { label: '重新加载', icon: 'refresh', action: () => command('reload') },
    { label: '开发者工具', icon: 'code', action: () => command('devtools') },
    { label: '退出', icon: 'exit', action: () => command('quit') },
  ]);
};
