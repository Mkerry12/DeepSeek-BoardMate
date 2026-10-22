// 开机自启
import { app } from 'electron';

function loginItemOptions(): { path: string; args?: string[] } {
  if (app.isPackaged) return { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath };
  return { path: process.execPath, args: [app.getAppPath()] };
}

export function autostartEnabled(): boolean {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

export function setAutostart(on: boolean): void {
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: on });
}
