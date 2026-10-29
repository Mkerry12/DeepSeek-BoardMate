// 自动更新
//   安装版（NSIS）：electron-updater 启动后和每 6 小时检查一次，后台下载，「重启并更新」或下次退出时安装
//   便携版：没法替换正在运行的 exe，只查 GitHub 上的最新版本，提示去下载页
//   开发运行：不检查
import { app, net, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import {
  compareVersions,
  installKind,
  RELEASES_PAGE,
  releasePageUrl,
  versionFromReleaseUrl,
  type UpdateStatus,
} from '../shared/update';
import type { Logger } from './log';

const LATEST_API = 'https://api.github.com/repos/Mkerry12/DeepSeek-BoardMate/releases/latest';
const FIRST_CHECK_MS = 15_000;
const INTERVAL_MS = 6 * 3600_000;

export interface UpdaterDeps {
  /** 设置里的「自动更新」；关掉后只在手动「检查更新」时检查 */
  autoEnabled: () => boolean;
  onStatus: (status: UpdateStatus) => void;
  log: Logger;
}

const errorText = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 200);

/** 第一次跳转的目标地址（没有跳转返回空串）。Electron 的 net.fetch 拿不到跳转地址，只能用 net.request */
function redirectTarget(url: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'HEAD', redirect: 'manual' });
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('请求超时'));
    }, timeoutMs);
    const done = (target: string) => {
      clearTimeout(timer);
      resolve(target);
      req.abort();
    };
    req.setHeader('User-Agent', 'DeepSeekDeskMate');
    req.on('redirect', (_status, _method, location) => done(new URL(location, url).href));
    req.on('response', () => done(''));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

export function createUpdater({ autoEnabled, onStatus, log }: UpdaterDeps) {
  const kind = installKind(app.isPackaged, process.env);
  const current = app.getVersion();
  let status: UpdateStatus = { state: kind === 'dev' ? 'disabled' : 'idle', kind, current };
  let pending: Promise<UpdateStatus> | null = null;

  function set(next: Omit<UpdateStatus, 'kind' | 'current'>) {
    status = { ...next, kind, current };
    onStatus(status);
  }

  if (kind === 'installer') {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => set({ state: 'latest' }));
    autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version }));
    autoUpdater.on('download-progress', (p) =>
      set({ state: 'downloading', version: status.version, percent: p.percent }),
    );
    autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
    autoUpdater.on('error', (err) => set({ state: 'error', message: errorText(err) }));
  }

  async function checkInstaller(): Promise<UpdateStatus> {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set({ state: 'error', message: errorText(err) });
    }
    return status;
  }

  async function latestFromApi(): Promise<{ version: string; url: string }> {
    const res = await net.fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DeepSeekDeskMate' },
    });
    if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
    const release = (await res.json()) as { tag_name?: string; html_url?: string };
    return { version: String(release.tag_name ?? '').replace(/^v/i, ''), url: release.html_url || RELEASES_PAGE };
  }

  // 未登录的 GitHub API 每个 IP 每小时 60 次，共用出口 IP 时容易 403；网页的 releases/latest 跳转不受这个限制
  async function latestFromRedirect(): Promise<{ version: string; url: string }> {
    const url = await redirectTarget(RELEASES_PAGE);
    const version = versionFromReleaseUrl(url);
    if (!version) throw new Error(`读不到最新版本（${url || '没有跳转'}）`);
    return { version, url };
  }

  async function checkPortable(): Promise<UpdateStatus> {
    set({ state: 'checking' });
    try {
      const { version: latest, url } = await latestFromApi().catch((err: unknown) => {
        log.warn(`portable: API check failed (${errorText(err)}), trying the releases page`);
        return latestFromRedirect();
      });
      if (latest && compareVersions(latest, current) > 0) {
        log.info(`portable: new version ${latest} available (current ${current})`);
        set({ state: 'available', version: latest, url });
      } else {
        log.info(`portable: up to date (current ${current}, latest ${latest || '?'})`);
        set({ state: 'latest' });
      }
    } catch (err) {
      log.warn('portable: update check failed', err);
      set({ state: 'error', message: errorText(err) });
    }
    return status;
  }

  /** 检查一次；同时只跑一个检查，已在下载 / 已下载好就不重复检查 */
  function check(): Promise<UpdateStatus> {
    if (kind === 'dev' || status.state === 'downloading' || status.state === 'ready') return Promise.resolve(status);
    pending ??= (kind === 'installer' ? checkInstaller() : checkPortable()).finally(() => (pending = null));
    return pending;
  }

  function start(): void {
    if (kind === 'dev') {
      log.info('updater disabled in development');
      return;
    }
    log.info(`updater started (${kind}, current ${current})`);
    const auto = () => {
      if (autoEnabled()) void check();
    };
    setTimeout(auto, FIRST_CHECK_MS);
    setInterval(auto, INTERVAL_MS);
  }

  function install(): void {
    if (status.state !== 'ready') return;
    log.info(`quit and install ${status.version}`);
    // 静默安装后自动重新打开
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  function openPage(): void {
    void shell.openExternal(releasePageUrl(status.url));
  }

  return { status: () => status, check, start, install, openPage };
}

export type Updater = ReturnType<typeof createUpdater>;
