// 自动更新：主进程和渲染进程共用的类型和纯函数

/** dev：开发运行（不检查）；installer：NSIS 安装版（electron-updater 自动下载安装）；portable：便携版（只能提示去下载） */
export type InstallKind = 'dev' | 'installer' | 'portable';

export type UpdateState =
  | 'disabled' // 开发模式
  | 'idle' // 还没检查过
  | 'checking'
  | 'latest' // 已是最新
  | 'downloading' // 安装版：发现新版本，后台下载中
  | 'ready' // 安装版：已下载，重启即更新
  | 'available' // 便携版：有新版本，需要手动下载
  | 'error';

export interface UpdateStatus {
  state: UpdateState;
  kind: InstallKind;
  current: string;
  version?: string;
  percent?: number;
  /** 便携版的下载页 */
  url?: string;
  message?: string;
}

export const RELEASES_PAGE = 'https://github.com/Mkerry12/DeepSeek-BoardMate/releases/latest';

export function installKind(isPackaged: boolean, env: Record<string, string | undefined>): InstallKind {
  if (!isPackaged) return 'dev';
  // electron-builder 的便携版启动器会设置这个环境变量
  return env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installer';
}

/** 比较 x.y.z（忽略前缀 v 和预发布后缀），a > b 返回正数 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** 状态变化时桌宠要说的话；不需要说话返回 null */
export function updateAnnouncement(prev: UpdateStatus | null, next: UpdateStatus): string | null {
  if (prev?.state === next.state && prev?.version === next.version) return null;
  if (next.state === 'ready') return '有新版本啦，重启就能用上～';
  if (next.state === 'available') return `有新版本 v${next.version} 啦！右键「下载新版本」去看看～`;
  return null;
}

/** 手动「检查更新」后的回复 */
export function checkResultMessage(s: UpdateStatus): string {
  switch (s.state) {
    case 'disabled':
      return '开发模式下不检查更新哦';
    case 'latest':
      return `已经是最新版啦（v${s.current}）`;
    case 'downloading':
      return `发现新版本 v${s.version}，正在后台下载～`;
    case 'ready':
      return '新版本已经下载好了，重启就能用上～';
    case 'available':
      return `有新版本 v${s.version}！便携版要手动下载，我帮你打开下载页～`;
    case 'error':
      return `检查更新失败了：${s.message ?? '未知错误'}`;
    default:
      return '正在检查更新…';
  }
}

export type UpdateAction = 'check' | 'install' | 'open-page';

/** 菜单里更新那一项：文字和点了做什么 */
export function updateMenuItem(s: UpdateStatus): { label: string; action: UpdateAction; hint?: string } {
  if (s.state === 'ready') return { label: '重启并更新', action: 'install', hint: `v${s.version}` };
  if (s.state === 'available') return { label: '下载新版本', action: 'open-page', hint: `v${s.version}` };
  if (s.state === 'downloading')
    return { label: '检查更新', action: 'check', hint: s.percent ? `下载中 ${Math.round(s.percent)}%` : '下载中' };
  return { label: '检查更新', action: 'check', hint: `v${s.current}` };
}
