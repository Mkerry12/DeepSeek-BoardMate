// 键盘：任何按键都算互动；Esc 先关菜单，没有菜单就收起输入框、关设置、停止朗读
import type { Feature } from '../core/context';

export const keyboardFeature: Feature = ({ bus, menu }) => {
  window.addEventListener('keydown', (e) => {
    bus.emit('user:active');
    if (e.key !== 'Escape') return;
    if (menu.isOpen) return menu.close();
    bus.emit('ui:escape');
  });
};
