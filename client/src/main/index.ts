// 主进程入口：单实例、加载设置、注册 IPC、建窗口和托盘
import { app, nativeTheme, safeStorage } from 'electron';
import { isDragging } from './drag';
import { createHistoryStore, createMemoryStore } from './history';
import { registerHandlers } from './ipc';
import { userFile } from './paths';
import { createSettingsStore, type KeyCipher } from './settings';
import { createTray } from './tray';
import { createWindow, showWindow } from './window';

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
    registerHandlers({
      settings,
      history: createHistoryStore(userFile('history.json')),
      memory: createMemoryStore(userFile('memory.json')),
    });
    createWindow(settings, isDragging);
    createTray();
  });
  app.on('window-all-closed', () => app.quit());
}
