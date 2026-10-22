import type { ChatMessage, MemoryState } from '../shared/types';
import { readJson, writeJson } from './json-file';

const MAX_STORED_MESSAGES = 200;

// 聊天记录（history.json）
export function createHistoryStore(file: string) {
  return {
    get: (): ChatMessage[] => readJson<ChatMessage[]>(file, []),
    set: (messages: ChatMessage[]): void => writeJson(file, messages.slice(-MAX_STORED_MESSAGES)),
  };
}

// 长期记忆笔记（memory.json），和聊天记录分开存
export function createMemoryStore(file: string) {
  return {
    get: (): MemoryState | null => readJson<MemoryState | null>(file, null),
    set: (memory: MemoryState): void => writeJson(file, memory),
  };
}
