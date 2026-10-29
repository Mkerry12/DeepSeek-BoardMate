// 设置：默认值、旧版本迁移、API Key / 访问令牌加密落盘
import type { Settings, SettingsPatch, SettingsView } from '../shared/types';
import { readJson, writeJson } from './json-file';

// 「官方服务器」：主人电脑上的 server（转发到 Ollama）。默认值在 client/build-env.ts，
// 打包时可用环境变量 DESKMATE_SERVER_URL 换成别的地址（开发 / 测试 / 正式各用各的）
export const OFFICIAL_SERVER_URL: string = __DESKMATE_SERVER_URL__;

export const DEFAULT_SETTINGS: Settings = {
  mode: 'official',
  serverUrl: '',
  token: '',
  model: '',
  persona: '',
  api: { preset: 'deepseek', key: '', baseUrl: '', model: 'deepseek-chat' },
  reminders: { water: { on: true, minutes: 45 }, rest: { on: true, minutes: 60 } },
  // 只存用户改过的槽位；默认装扮在角色配置 deskmate.json 的 outfit.default 里
  outfit: {},
  // name：服务器 GPT-SoVITS 的音色预设名，空 = 服务器默认音色
  voice: { on: false, name: '', sfx: true, volume: 80 },
  greeted: {},
  alwaysOnTop: true,
  autoUpdate: true,
  position: null,
};

const NESTED = ['api', 'reminders', 'outfit', 'voice', 'greeted'] as const;
// 旧版本留下、现在不再使用的字段
const OBSOLETE = ['peek', 'character', 'modelPath'] as const;
// 旧版本存下的微软 Edge 音色名（如 zh-CN-XiaoyiNeural），语音只剩 GPT-SoVITS 后换回服务器默认音色
const OLD_EDGE_VOICE = /^[a-z]{2,3}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$/;

/** 加解密由调用方提供（主进程里是 safeStorage / DPAPI），方便测试 */
export interface KeyCipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

type Stored = Record<string, unknown> & { api?: Record<string, unknown> };

const clone = <T>(v: T): T => structuredClone(v);

export function normalize(s: Settings, officialUrl = OFFICIAL_SERVER_URL): Settings {
  if (String(s.serverUrl ?? '').replace(/\/+$/, '') === officialUrl) s.serverUrl = '';
  return s;
}

// 解不开（比如 settings.json 拷到了别的电脑 / 别的 Windows 账户）就清空，记一条日志让用户知道要重新填
function decryptOr(encoded: unknown, cipher: KeyCipher, what: string, warn: (msg: string) => void): string {
  try {
    return cipher.decrypt(String(encoded));
  } catch (err) {
    warn(`${what}解密失败，已清空，需要在设置里重新填写：${(err as Error)?.message ?? err}`);
    return '';
  }
}

/** 磁盘上的设置 → 完整的 Settings：补默认值、解密 API Key 和访问令牌、清理旧字段 */
export function migrateSettings(saved: unknown, cipher: KeyCipher, warn: (msg: string) => void = () => {}): Settings {
  const raw: Stored = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...(saved as Stored) } : {};
  const s = { ...clone(DEFAULT_SETTINGS), ...raw } as Settings & Record<string, unknown>;
  for (const key of NESTED) {
    const value = raw[key];
    (s as Record<string, unknown>)[key] = {
      ...clone(DEFAULT_SETTINGS[key]),
      ...(value && typeof value === 'object' ? value : {}),
    };
  }
  const api = s.api as Settings['api'] & { keyEnc?: string };
  if (api.keyEnc) api.key = decryptOr(api.keyEnc, cipher, 'API Key ', warn);
  delete api.keyEnc;
  // 旧版本的令牌是明文 token，下次保存时自动改成加密的 tokenEnc
  if (s.tokenEnc) s.token = decryptOr(s.tokenEnc, cipher, '访问令牌', warn);
  delete s.tokenEnc;
  if (typeof s.token !== 'string') s.token = '';
  if (typeof s.voice.name !== 'string' || OLD_EDGE_VOICE.test(s.voice.name)) s.voice.name = '';
  // 旧版本贴边藏起来时存下的位置在屏幕外，回到默认位置
  if (s.peek) s.position = null;
  for (const key of OBSOLETE) delete s[key];
  return normalize(s);
}

// API Key 和访问令牌用系统 DPAPI 加密后再落盘（没有 DPAPI 时退回明文）
export function serializeSettings(s: Settings, cipher: KeyCipher): Stored {
  const { key, ...api } = s.api;
  const { token, ...rest } = s;
  const out: Record<string, unknown> = { ...api };
  const top: Record<string, unknown> = { ...rest };
  if (cipher.available()) {
    if (key) out.keyEnc = cipher.encrypt(key);
    if (token) top.tokenEnc = cipher.encrypt(token);
  } else {
    if (key) out.key = key;
    if (token) top.token = token;
  }
  return { ...top, api: out };
}

export function createSettingsStore(file: string, cipher: KeyCipher, warn: (msg: string) => void = () => {}) {
  const raw = readJson<Stored>(file, {});
  let settings = migrateSettings(raw, cipher, warn);

  const save = () => writeJson(file, serializeSettings(settings, cipher));
  const view = (): SettingsView => ({ ...settings, officialServerUrl: OFFICIAL_SERVER_URL });
  // 旧版本明文存的令牌 / Key：读进来就加密重写一遍
  if (cipher.available() && (raw?.token || raw?.api?.key)) save();

  return {
    get: () => settings,
    view,
    save,
    patch(patch: SettingsPatch): SettingsView {
      const { officialServerUrl: _ignored, ...rest } = patch;
      settings = normalize({ ...settings, ...rest });
      save();
      return view();
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
