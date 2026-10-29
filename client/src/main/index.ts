// 主进程入口：单实例、加载设置、注册 IPC、建窗口和托盘、自动更新
import { app, nativeTheme, safeStorage } from 'electron';
import { isDragging } from './drag';
import { createHistoryStore, createMemoryStore } from './history';
import { registerHandlers } from './ipc';
import { createFileLogger, logFile } from './log';
import { userFile } from './paths';
import { createSettingsStore, type KeyCipher } from './settings';
import { createTray } from './tray';
import { createUpdater } from './updater';
import { createWindow, sendToRenderer, showWindow } from './window';

const dpapi: KeyCipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    app.setAppUserModelId('com.deepseek.deskmate');
    nativeTheme.themeSource = 'light';
    const settings = createSettingsStore(userFile('settings.json'), dpapi);
    const updater = createUpdater({
      autoEnabled: () => settings.get().autoUpdate,
      onStatus: (status) => sendToRenderer('update:changed', status),
      log: createFileLogger(logFile(), 'updater'),
    });
    registerHandlers({
      settings,
      history: createHistoryStore(userFile('history.json')),
      memory: createMemoryStore(userFile('memory.json')),
      updater,
    });
    createWindow(settings, isDragging);
    createTray(updater);
    updater.start();
  });
  app.on('window-all-closed', () => app.quit());
}
