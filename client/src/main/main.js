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
// 贴边：角色（不是透明窗口）离工作区边缘多近算碰到，滑动动画时长，鼠标离开多久缩回去
const EDGE_SNAP = 32;
const PEEK_ANIM_MS = 240;
const PEEK_CLOSE_DELAY = 1500;
const PEEK_POLL_MS = 150;
// 鼠标离角色这么近还算「在她身上」
const PEEK_NEAR = 16;
const DRAG_TICK_MS = 16;
const PEEK_SIDES = ['left', 'right', 'top', 'bottom'];
// 渲染进程量出来之前用的角色可见范围（窗口内坐标）
const DEFAULT_PET_BOX = { left: 38, top: 164, right: 280, bottom: 386, face: { cx: 139, w: 82, top: 258, bottom: 304 } };

const defaultSettings = {
  mode: 'official',
  serverUrl: '',
  token: '',
  model: '',
  persona: '',
  api: { preset: 'deepseek', key: '', baseUrl: '', model: 'deepseek-chat' },
  reminders: { water: { on: true, minutes: 45 }, rest: { on: true, minutes: 60 } },
  outfit: { whale: '头顶鲸' },
  voice: { on: false, name: 'zh-CN-XiaoyiNeural', sfx: true, volume: 80 },
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
  if (typeof s.peek === 'number') s.peek = s.peek < 0 ? 'left' : 'right';
  if (!PEEK_SIDES.includes(s.peek)) s.peek = null;
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
    if (!anim && !drag) savePosition();
  });
  win.webContents.on('did-finish-load', () => {
    peekRestored = false;
  });
}

function savePosition() {
  const [x, y] = win.getPosition();
  settings.position = { x, y };
  saveSettings();
}

// ---------- 拖动 / 贴边探头 ----------

let anim = null;
let drag = null;
let dragTimer = null;
let peekOpen = false;
let peekTimer = null;
let peekAway = 0;
let peekArmed = true;
let peekHold = false;
let peekRestored = false;
let peekWa = null;
let petBox = DEFAULT_PET_BOX;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
const inside = (p, r, pad = 0) =>
  p.x >= r.x - pad && p.x < r.x + r.width + pad && p.y >= r.y - pad && p.y < r.y + r.height + pad;

// 角色本身在屏幕上的范围（窗口四周有大片透明区域，不能拿窗口算）
function petRect(x, y) {
  const { left, top, right, bottom } = petBox;
  return { x: x + left, y: y + top, width: right - left, height: bottom - top };
}

function moveWindow(x, y) {
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_W, height: WIN_H });
}

// 贴边时窗口里还在工作区内的部分（窗口坐标）；渲染进程把伸出去的部分裁掉，免得压在任务栏上
function sendPeek() {
  const [x, y] = win.getPosition();
  const wa = peekWa;
  const clip = settings.peek && {
    left: Math.max(0, wa.x - x),
    top: Math.max(0, wa.y - y),
    right: Math.min(WIN_W, wa.x + wa.width - x),
    bottom: Math.min(WIN_H, wa.y + wa.height - y),
  };
  win.webContents.send('peek', { side: settings.peek || '', open: peekOpen, clip: clip || null });
}

function animateTo(x, y, instant = false) {
  clearInterval(anim?.timer);
  anim = null;
  const [x0, y0] = win.getPosition();
  const done = () => {
    moveWindow(x, y);
    sendPeek();
    savePosition();
  };
  if (instant || (x0 === Math.round(x) && y0 === Math.round(y))) return done();
  const start = Date.now();
  anim = {
    timer: setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / PEEK_ANIM_MS);
      const e = 1 - (1 - t) ** 3;
      if (t < 1) {
        moveWindow(x0 + (x - x0) * e, y0 + (y - y0) * e);
        return sendPeek();
      }
      clearInterval(anim.timer);
      anim = null;
      done();
    }, 16),
  };
}

// 角色碰到的工作区边缘（外面还接着别的显示器就不算边）。下边缘得是从上面拖下来、或者按进任务栏才算，
// 免得本来就坐在任务栏上、横着挪一下就沉下去
function edgeAt(bounds, from) {
  const r = petRect(bounds.x, bounds.y);
  const display = screen.getDisplayMatching(r);
  const wa = display.workArea;
  const gaps = (q) => ({
    left: q.x - wa.x,
    right: wa.x + wa.width - (q.x + q.width),
    top: q.y - wa.y,
    bottom: wa.y + wa.height - (q.y + q.height),
  });
  const now = gaps(r);
  const before = gaps(from);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const beyond = {
    left: { x: wa.x - 1, y: cy },
    right: { x: wa.x + wa.width, y: cy },
    top: { x: cx, y: wa.y - 1 },
    bottom: { x: cx, y: wa.y + wa.height },
  };
  const otherDisplay = (p) => screen.getAllDisplays().some((d) => d.id !== display.id && inside(p, d.bounds));
  const sides = PEEK_SIDES.filter(
    (s) =>
      now[s] <= EDGE_SNAP &&
      !otherDisplay(beyond[s]) &&
      (s !== 'bottom' || before.bottom > EDGE_SNAP || now.bottom < -EDGE_SNAP),
  );
  return sides.sort((a, b) => now[a] - now[b])[0] || null;
}

// 探头时露出来的那部分要带着脸：左右藏到脸的中线再往里一点，上边藏到眉毛，下边藏到下巴
// （face 是脸部触摸区，上沿大约在眼睛中间）
function peekPos(side, open) {
  const [x0, y0] = win.getPosition();
  const wa = peekWa;
  const right = wa.x + wa.width;
  const bottom = wa.y + wa.height;
  if (open) return { x: clamp(x0, wa.x, right - WIN_W), y: clamp(y0, wa.y, bottom - WIN_H) };
  const { face } = petBox;
  const x = clamp(x0, wa.x - petBox.left, right - petBox.right);
  const y = clamp(y0, wa.y - petBox.top, bottom - petBox.bottom);
  const lean = face.w * 0.15;
  if (side === 'left') return { x: wa.x - (face.cx - lean), y };
  if (side === 'right') return { x: right - (face.cx + lean), y };
  if (side === 'top') return { x, y: wa.y - (face.top - 0.3 * (face.bottom - face.top)) };
  return { x, y: bottom - face.bottom };
}

function setPeek(side, open, instant = false) {
  clearInterval(peekTimer);
  peekOpen = !!side && open;
  peekAway = 0;
  if (!peekOpen) peekArmed = false;
  if (settings.peek !== side) {
    settings.peek = side;
    saveSettings();
  }
  if (!side) {
    clearInterval(anim?.timer);
    anim = null;
    return sendPeek();
  }
  peekWa = screen.getDisplayMatching(petRect(...win.getPosition())).workArea;
  const { x, y } = peekPos(side, peekOpen);
  animateTo(x, y, instant);
  peekTimer = setInterval(watchPeek, PEEK_POLL_MS);
}

// 藏着时：鼠标得先离开她一次才能再把她勾出来（刚松手时鼠标还压在她身上）
// 滑出来以后：鼠标离开她一会儿、也没有打开的聊天框/菜单/设置，就再缩回去
function watchPeek() {
  const near = inside(screen.getCursorScreenPoint(), petRect(...win.getPosition()), PEEK_NEAR);
  if (!peekOpen) {
    if (!near) peekArmed = true;
    return;
  }
  peekAway = near || peekHold ? 0 : peekAway + PEEK_POLL_MS;
  if (peekAway >= PEEK_CLOSE_DELAY) setPeek(settings.peek, false);
}

function validBox(box) {
  const nums = [box?.left, box?.top, box?.right, box?.bottom, box?.face?.cx, box?.face?.w, box?.face?.top, box?.face?.bottom];
  return nums.every(Number.isFinite) && box.right > box.left && box.bottom > box.top;
}

// 拖动按光标的屏幕坐标来算：渲染进程里的 screenX 在窗口移动时会滞后，高 DPI 下拖着拖着会漂
function dragStep() {
  const p = screen.getCursorScreenPoint();
  moveWindow(p.x - drag.dx, p.y - drag.dy);
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

ipcMain.on('drag:start', () => {
  if (drag) return;
  const [x, y] = win.getPosition();
  const p = screen.getCursorScreenPoint();
  drag = { dx: p.x - x, dy: p.y - y, from: petRect(x, y) };
  if (settings.peek) setPeek(null, false);
  clearInterval(anim?.timer);
  anim = null;
  dragTimer = setInterval(dragStep, DRAG_TICK_MS);
});
ipcMain.on('drag:end', () => {
  if (!drag) return;
  clearInterval(dragTimer);
  dragStep();
  const side = edgeAt(win.getBounds(), drag.from);
  drag = null;
  if (side) setPeek(side, false);
  else savePosition();
});
ipcMain.on('pet:bounds', (_e, box) => {
  if (!validBox(box)) return;
  petBox = box;  if (peekRestored) return;
  peekRestored = true;
  if (settings.peek) setPeek(settings.peek, false, true);
});
ipcMain.on('peek:open', () => {
  if (settings.peek && !peekOpen && peekArmed && !drag) setPeek(settings.peek, true);
});
ipcMain.on('peek:hold', (_e, hold) => {
  peekHold = !!hold;
  if (peekHold && settings.peek && !peekOpen && !drag) setPeek(settings.peek, true);
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
