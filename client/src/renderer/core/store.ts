// 渲染进程的共享状态：设置 + 聊天记录（读写都经过 window.desk 落盘）
import type { ChatMessage, SettingsPatch, SettingsView } from '../../shared/types';
import type { AppBus } from './bus';

const MAX_STORED = 200;

export interface Store {
  readonly settings: SettingsView;
  update(patch: SettingsPatch): Promise<SettingsView>;
  history: ChatMessage[];
  saveHistory(): void;
}

/** normalize：从主进程拿到设置后补上依赖角色配置的默认值（如默认装扮） */
export function createStore(
  bus: AppBus,
  initial: SettingsView,
  history: ChatMessage[],
  normalize: (s: SettingsView) => SettingsView = (s) => s,
): Store {
  let settings = normalize(initial);
  return {
    get settings() {
      return settings;
    },
    async update(patch) {
      settings = normalize(await window.desk.setSettings(patch));
      bus.emit('settings:changed', { settings });
      return settings;
    },
    get history() {
      return history;
    },
    set history(list) {
      history = list;
    },
    saveHistory() {
      history = history.slice(-MAX_STORED);
      window.desk.saveHistory(history);
      bus.emit('history:changed', { history });
    },
  };
}
