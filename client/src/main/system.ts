// 剪贴板与系统通知
import { clipboard, Notification } from 'electron';
import { ICON } from './paths';
import { getWindow } from './window';

export const readClipboard = () => clipboard.readText();

// 窗口看得见时气泡就够了，藏到托盘时才弹系统通知
export function notify(title: string, body: string): void {
  if (getWindow()?.isVisible() || !Notification.isSupported()) return;
  new Notification({ title, body, icon: ICON }).show();
}
