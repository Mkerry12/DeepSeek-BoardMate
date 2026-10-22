// 长期记忆：新聊了够多条就在后台把「关于用户的事」整理成一小段笔记（memory.json），之后每次聊天都带上
// 和聊天记录（history.json）分开：「清空记忆」只擦聊天记录，「忘掉这些」只擦这段笔记
import type { ChatMessage, MemoryState } from '../../shared/types';
import { summarizeMemory, type ConnSettings } from '../lib/chat-api';

const SUMMARIZE_AFTER = 40;
const MIN_WINDOW = 40;
const MAX_WINDOW = 80;

export interface Memory {
  added(count: number): void;
  summarize(): Promise<string>;
  clear(): void;
  readonly text: string;
  readonly busy: boolean;
}

export async function createMemory({
  getSettings,
  getHistory,
}: {
  getSettings: () => ConnSettings;
  getHistory: () => ChatMessage[];
}): Promise<Memory> {
  const saved = await window.desk.getMemory();
  let memory: MemoryState = { text: '', pending: getHistory().length, updatedAt: 0, ...saved };
  let running: Promise<string> | null = null;

  const save = () => window.desk.saveMemory(memory);

  // 新增了几条消息；攒够了就悄悄整理（失败也不打扰聊天，下次再试）
  function added(count: number) {
    memory.pending += count;
    save();
    if (memory.pending >= SUMMARIZE_AFTER)
      summarize().catch((err: Error) => console.warn('[memory] 整理失败：', err.message));
  }

  function summarize(): Promise<string> {
    if (running) return running;
    const take = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, memory.pending));
    const messages = getHistory().slice(-take);
    if (!messages.length) return Promise.resolve(memory.text);
    running = summarizeMemory(getSettings(), memory.text, messages)
      .then((text) => {
        memory = { text: text || memory.text, pending: 0, updatedAt: Date.now() };
        save();
        return memory.text;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  function clear() {
    memory = { text: '', pending: 0, updatedAt: Date.now() };
    save();
  }

  return {
    added,
    summarize,
    clear,
    get text() {
      return memory.text;
    },
    get busy() {
      return !!running;
    },
  };
}
