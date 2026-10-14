const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  screen,
  Tray,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// 「官方服务器」：主人电脑上的 server（转发到 Ollama）。发给朋友前改成花生壳域名再打包
const OFFICIAL_SERVER_URL = 'http://5f8c344a.r15.cpolar.top';

const WIN_W = 280;
const WIN_H = 430;
const ASSETS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '..', '..', 'assets');
const MODEL_DIR = path.join(ASSETS_DIR, 'live2d', 'ds-whale-girl');
const ICON = path.join(ASSETS_DIR, 'icon.png');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const historyFile = path.join(app.getPath('userData'), 'history.json');
const MAX_STORED_MESSAGES = 200;

const defaultSettings = {
  mode: 'official',
  serverUrl: '',
  token: '',
  model: '',
  persona: '',
  api: { preset: 'deepseek', key: '', baseUrl: '', model: 'deepseek-chat' },
  reminders: { water: { on: true, minutes: 45 }, rest: { on: true, minutes: 60 } },
  outfit: { whale: '头顶鲸' },
  alwaysOnTop: true,
  position: null,
};

let settings = null;
let win = null;
let tray = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function normalize(s) {
  if (s.serverUrl.replace(/\/+$/, '') === OFFICIAL_SERVER_URL) s.serverUrl = '';
  return s;
}

function loadSettings() {
  const saved = readJson(settingsFile, {});
  const s = { ...defaultSettings, ...saved };
  for (const key of ['api', 'reminders', 'outfit']) s[key] = { ...defaultSettings[key], ...saved[key] };
  if (s.api.keyEnc) {
    try {
      s.api.key = safeStorage.decryptString(Buffer.from(s.api.keyEnc, 'base64'));
    } catch {
      s.api.key = '';
    }
    delete s.api.keyEnc;
  }
  return normalize(s);
}

// API Key 用系统 DPAPI 加密后再落盘
function saveSettings() {
  const { key, ...api } = settings.api;
  if (key && safeStorage.isEncryptionAvailable()) api.keyEnc = safeStorage.encryptString(key).toString('base64');
  else if (key) api.key = key;
  writeJson(settingsFile, { ...settings, api });
}

function modelUrl() {
  const file = fs.readdirSync(MODEL_DIR).find((f) => f.endsWith('.model3.json'));
  return pathToFileURL(path.join(MODEL_DIR, file)).href;
}

function send(action) {
  win?.webContents.send('menu:action', action);
}

function showWindow() {
  win.showInactive();
  win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
}

function toggleWindow() {
  if (win.isVisible()) win.hide();
  else showWindow();
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const pos = settings.position || {
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
    alwaysOnTop: settings.alwaysOnTop,
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    settings.position = { x, y };
    saveSettings();
  });
}

// ---------- 开机自启 ----------

function loginItemOptions() {
  if (app.isPackaged) return { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath };
  return { path: process.execPath, args: [path.resolve(__dirname, '..', '..')] };
}

function autostartEnabled() {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function setAutostart(on) {
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: on });
}

// ---------- 托盘 ----------

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
  tray.setToolTip('DeepSeek DeskMate · 小鲸');
  tray.on('click', toggleWindow);
  tray.on('right-click', () =>
    tray.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: win.isVisible() ? '隐藏小鲸' : '显示小鲸', click: toggleWindow },
        {
          label: '设置',
          click: () => {
            showWindow();
            send('settings');
          },
        },
        { label: '开机自启', type: 'checkbox', checked: autostartEnabled(), click: (item) => setAutostart(item.checked) },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    ),
  );
}

function setAlwaysOnTop(on) {
  settings.alwaysOnTop = on;
  win.setAlwaysOnTop(on, 'screen-saver');
  saveSettings();
}

// ---------- IPC ----------

ipcMain.handle('settings:get', () => ({ ...settings, officialServerUrl: OFFICIAL_SERVER_URL }));
ipcMain.handle('settings:set', (_e, patch) => {
  delete patch.officialServerUrl;
  settings = normalize({ ...settings, ...patch });
  saveSettings();
  if ('alwaysOnTop' in patch) win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  return { ...settings, officialServerUrl: OFFICIAL_SERVER_URL };
});

ipcMain.handle('history:get', () => readJson(historyFile, []));
ipcMain.handle('history:set', (_e, messages) => writeJson(historyFile, messages.slice(-MAX_STORED_MESSAGES)));

ipcMain.handle('clipboard:read', () => clipboard.readText());

ipcMain.on('notify', (_e, title, body) => {
  if (win.isVisible() || !Notification.isSupported()) return;
  new Notification({ title, body, icon: ICON }).show();
});

ipcMain.handle('model:url', () => modelUrl());

ipcMain.on('mouse:ignore', (_e, ignore) => {
  win?.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.handle('window:getPosition', () => win.getPosition());
ipcMain.on('window:move', (_e, x, y) => {
  win?.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_W, height: WIN_H });
});

// 渲染进程里的 HTML 右键菜单需要的状态与操作
ipcMain.handle('app:state', () => ({ alwaysOnTop: settings.alwaysOnTop, autostart: autostartEnabled() }));

const commands = {
  alwaysOnTop: (on) => setAlwaysOnTop(!!on),
  autostart: (on) => setAutostart(!!on),
  hide: () => win.hide(),
  reload: () => win.reload(),
  devtools: () => win.webContents.openDevTools({ mode: 'detach' }),
  quit: () => app.quit(),
};
ipcMain.on('app:command', (_e, name, arg) => commands[name]?.(arg));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => win && showWindow());
  app.whenReady().then(() => {
    app.setAppUserModelId('com.deepseek.deskmate');
    nativeTheme.themeSource = 'light';
    settings = loadSettings();
    createWindow();
    createTray();
  });
  app.on('window-all-closed', () => app.quit());
}
