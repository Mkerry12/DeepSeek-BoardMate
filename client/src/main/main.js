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
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// 「官方服务器」：主人电脑上的 server（转发到 Ollama）。发给朋友前改成花生壳域名再打包
const OFFICIAL_SERVER_URL = 'http://5f8c344a.r15.cpolar.top';

const WIN_W = 280;
const WIN_H = 430;
const ASSETS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '..', '..', 'assets');
const MODEL_DIR = path.join(ASSETS_DIR, 'live2d', 'ds-whale-girl');
const ICON = path.join(ASSETS_DIR, 'icon.png');
// Windows 托盘/窗口用多尺寸 ico，系统按 DPI 选最合适的一档
const WIN_ICON = path.join(ASSETS_DIR, 'icon.ico');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
const historyFile = path.join(app.getPath('userData'), 'history.json');
const memoryFile = path.join(app.getPath('userData'), 'memory.json');
const MAX_STORED_MESSAGES = 200;
const TTS_MAX_CHARS = 300;
const TTS_TIMEOUT = 15000;
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$/;
// 贴边：离工作区边缘多近算碰到，探头时藏起窗口的比例，滑动动画时长
const EDGE_SNAP = 12;
const PEEK_HIDE = 0.5;
const PEEK_ANIM_MS = 220;
const PEEK_CLOSE_DELAY = 1500;

const defaultSettings = {
  mode: 'official',
  serverUrl: '',
  token: '',
  model: '',
  persona: '',
  api: { preset: 'deepseek', key: '', baseUrl: '', model: 'deepseek-chat' },
  reminders: { water: { on: true, minutes: 45 }, rest: { on: true, minutes: 60 } },
  outfit: { whale: '头顶鲸' },
  voice: { on: false, name: 'zh-CN-XiaoyiNeural', sfx: true },
  greeted: {},
  peek: null,
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
  for (const key of ['api', 'reminders', 'outfit', 'voice', 'greeted']) s[key] = { ...defaultSettings[key], ...saved[key] };
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
    icon: process.platform === 'win32' ? WIN_ICON : ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('moved', () => {
    if (!anim) savePosition();
  });
  win.webContents.on('did-finish-load', () => {
    if (settings.peek) setPeek(settings.peek, false, true);
  });
}

function savePosition() {
  const [x, y] = win.getPosition();
  settings.position = { x, y };
  saveSettings();
}

// ---------- 贴边探头 ----------

let anim = null;
let peekOpen = false;
let peekTimer = null;
let peekAway = 0;

function animateTo(x, instant = false) {
  clearInterval(anim?.timer);
  const [x0, y] = win.getPosition();
  const place = (px) => win.setBounds({ x: Math.round(px), y, width: WIN_W, height: WIN_H });
  if (instant || x0 === x) {
    anim = null;
    place(x);
    return savePosition();
  }
  const start = Date.now();
  anim = {
    timer: setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / PEEK_ANIM_MS);
      place(x0 + (x - x0) * (1 - (1 - t) ** 3));
      if (t < 1) return;
      clearInterval(anim.timer);
      anim = null;
      savePosition();
    }, 16),
  };
}

// 碰到的工作区左右边缘（另一侧还接着别的显示器就不算边）
function edgeOf(bounds) {
  const display = screen.getDisplayMatching(bounds);
  const wa = display.workArea;
  const cy = bounds.y + bounds.height / 2;
  const open = (x) => screen.getDisplayNearestPoint({ x, y: cy }).id === display.id;
  if (bounds.x <= wa.x + EDGE_SNAP && open(wa.x - 1)) return -1;
  if (bounds.x + bounds.width >= wa.x + wa.width - EDGE_SNAP && open(wa.x + wa.width)) return 1;
  return 0;
}

function peekX(side, open) {
  const { workArea: wa } = screen.getDisplayMatching(win.getBounds());
  const hidden = open ? 0 : WIN_W * PEEK_HIDE;
  return side < 0 ? wa.x - hidden : wa.x + wa.width - WIN_W + hidden;
}

function setPeek(side, open, instant = false) {
  clearInterval(peekTimer);
  peekOpen = open;
  peekAway = 0;
  if (settings.peek !== side) {
    settings.peek = side;
    saveSettings();
  }
  if (side) animateTo(peekX(side, open), instant);
  if (side && open) peekTimer = setInterval(watchPeek, 300);
  win.webContents.send('peek', { side: side || 0, open });
}

// 滑出来以后：鼠标离开窗口、窗口也不在前台一会儿，就再缩回去
function watchPeek() {
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  peekAway = inside || win.isFocused() ? 0 : peekAway + 300;
  if (peekAway >= PEEK_CLOSE_DELAY) setPeek(settings.peek, false);
}

// ---------- 朗读（API Key 模式 / 服务器不支持时，主进程直连微软 Edge 语音） ----------

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function edgeTts(text, voice) {
  if (!VOICE_RE.test(voice)) throw new Error('不支持的音色');
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text.slice(0, TTS_MAX_CHARS)));
    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('语音合成超时')), TTS_TIMEOUT);
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', () => (clearTimeout(timer), resolve()));
      audioStream.on('error', (e) => (clearTimeout(timer), reject(e)));
    });
    if (!chunks.length) throw new Error('语音合成失败');
    return Buffer.concat(chunks);
  } finally {
    tts.close();
  }
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
  tray = new Tray(
    process.platform === 'win32'
      ? WIN_ICON
      : nativeImage.createFromPath(ICON).resize({ width: 32, height: 32, quality: 'best' }),
  );
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
ipcMain.handle('memory:get', () => readJson(memoryFile, null));
ipcMain.handle('memory:set', (_e, memory) => writeJson(memoryFile, memory));

ipcMain.handle('tts', (_e, text, voice) => edgeTts(String(text), String(voice)));

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
ipcMain.on('drag:start', () => {
  clearInterval(anim?.timer);
  anim = null;
  if (settings.peek) setPeek(null, false);
});
ipcMain.on('drag:end', () => {
  const side = edgeOf(win.getBounds());
  if (side) setPeek(side, false);
  else savePosition();
});
ipcMain.on('peek:open', () => {
  if (settings.peek && !peekOpen) setPeek(settings.peek, true);
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
    createTray();  });
  app.on('window-all-closed', () => app.quit());
}
