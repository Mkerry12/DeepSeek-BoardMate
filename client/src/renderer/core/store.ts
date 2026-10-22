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

export function createStore(bus: AppBus, settings: SettingsView, history: ChatMessage[]): Store {
  return {
    get settings() {
      return settings;
    },
    async update(patch) {
      settings = await window.desk.setSettings(patch);
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
