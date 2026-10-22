// 各功能模块登记自己的状态（只读取值函数），其他模块按名字查询，避免互相引用
export interface StatusFlags {
  /** 正在等 / 正在流式输出回复 */
  replying: boolean;
  /** 按住角色拖动中（包括摸头判定阶段） */
  dragging: boolean;
  menuOpen: boolean;
  settingsOpen: boolean;
  /** 输入框里有没发出去的字 */
  typing: boolean;
  /** 正在朗读或排队合成 */
  voiceActive: boolean;
  /** 番茄钟专注阶段 */
  focusing: boolean;
}

export type StatusKey = keyof StatusFlags;

export interface Status {
  provide<K extends StatusKey>(key: K, getter: () => StatusFlags[K]): void;
  get<K extends StatusKey>(key: K): StatusFlags[K];
  /** 正在和用户互动，别插嘴：回复中 / 拖动中 / 菜单或设置开着 / 正在打字 */
  busy(): boolean;
}

export function createStatus(): Status {
  const getters = new Map<StatusKey, () => boolean>();
  const get = <K extends StatusKey>(key: K) => (getters.get(key)?.() ?? false) as StatusFlags[K];
  return {
    provide: (key, getter) => void getters.set(key, getter),
    get,
    busy: () => get('replying') || get('dragging') || get('menuOpen') || get('settingsOpen') || get('typing'),
  };
}
