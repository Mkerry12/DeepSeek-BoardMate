// 设置：默认值、旧版本迁移、API Key 加密落盘
import type { Settings, SettingsPatch, SettingsView } from '../shared/types';
import { readJson, writeJson } from './json-file';

// 「官方服务器」：主人电脑上的 server（转发到 Ollama）。发给朋友前改成花生壳域名再打包
export const OFFICIAL_SERVER_URL = 'http://5f8c344a.r15.cpolar.top';

export const DEFAULT_SETTINGS: Settings = {
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
  alwaysOnTop: true,
  position: null,
};

const NESTED = ['api', 'reminders', 'outfit', 'voice', 'greeted'] as const;
// 旧版本留下、现在不再使用的字段
const OBSOLETE = ['peek', 'character', 'modelPath'] as const;

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

/** 磁盘上的设置 → 完整的 Settings：补默认值、解密 API Key、清理旧字段 */
export function migrateSettings(saved: unknown, cipher: KeyCipher): Settings {
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
  if (api.keyEnc) {
    try {
      api.key = cipher.decrypt(api.keyEnc);
    } catch {
      api.key = '';
    }
    delete api.keyEnc;
  }
  // 旧版本贴边藏起来时存下的位置在屏幕外，回到默认位置
  if (s.peek) s.position = null;
  for (const key of OBSOLETE) delete s[key];
  return normalize(s);
}

// API Key 用系统 DPAPI 加密后再落盘
export function serializeSettings(s: Settings, cipher: KeyCipher): Stored {
  const { key, ...api } = s.api;
  const out: Record<string, unknown> = { ...api };
  if (key && cipher.available()) out.keyEnc = cipher.encrypt(key);
  else if (key) out.key = key;
  return { ...s, api: out };
}

export function createSettingsStore(file: string, cipher: KeyCipher) {
  let settings = migrateSettings(readJson(file, {}), cipher);

  const save = () => writeJson(file, serializeSettings(settings, cipher));
  const view = (): SettingsView => ({ ...settings, officialServerUrl: OFFICIAL_SERVER_URL });

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
