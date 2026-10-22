// 主进程与渲染进程共用的数据类型

export type ConnectionMode = 'official' | 'apikey';

export interface ApiSettings {
  preset: string;
  key: string;
  baseUrl: string;
  model: string;
}

export interface ReminderSetting {
  on: boolean;
  minutes: number;
}

export interface Reminders {
  water: ReminderSetting;
  rest: ReminderSetting;
}

export interface VoiceSettings {
  on: boolean;
  name: string;
  sfx: boolean;
  volume: number;
}

/** 换装：{ 槽位 id: 选项 label }，对应角色包 pet.json 里的 expressionSlots */
export type Outfit = Record<string, string>;

export interface WindowPosition {
  x: number;
  y: number;
}

export interface Settings {
  mode: ConnectionMode;
  serverUrl: string;
  token: string;
  model: string;
  persona: string;
  api: ApiSettings;
  reminders: Reminders;
  outfit: Outfit;
  voice: VoiceSettings;
  /** 按时段问候：{ 时段 id: 日期 key } */
  greeted: Record<string, string>;
  alwaysOnTop: boolean;
  position: WindowPosition | null;
}

/** 渲染进程看到的设置：多带一个只读的官方服务器地址 */
export interface SettingsView extends Settings {
  officialServerUrl: string;
}

export type SettingsPatch = Partial<SettingsView>;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MemoryState {
  text: string;
  pending: number;
  updatedAt: number;
}

export interface AppState {
  alwaysOnTop: boolean;
  autostart: boolean;
}

export type AppCommand = 'alwaysOnTop' | 'autostart' | 'hide' | 'reload' | 'devtools' | 'quit';

/** 托盘菜单发给渲染进程的动作 */
export type MenuAction = 'settings';

/** 两种连接方式统一产出的流式事件 */
export type ChatEvent =
  | { type: 'thinking' }
  | { type: 'queued' }
  | { type: 'emotion'; value: string }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };
