// 与 server/deskmate_server/persona.py 的 DEFAULT_PERSONA / REPLY_RULES / MEMORY_* 保持一致（test/config.test.ts 校验）（「自己的 API Key」模式在客户端拼系统提示词）
import { EMOTION_TAGS } from '../../shared/emotions';
import type { ChatMessage } from '../../shared/types';

export const DEFAULT_PERSONA = '你是"小鲸"，一只住在用户电脑桌面上的 DeepSeek 鲸鱼桌宠，性格活泼、温柔、有点小调皮。';

export const REPLY_RULES = `规则：
1. 每次回复的最开头必须输出一个情绪标签，只能是以下之一：${EMOTION_TAGS.map((t) => `[${t}]`).join(' ')}
2. 标签后直接写回复内容，用中文，口语化，一般不超过 80 字，除非用户明确需要详细解答。
3. 打招呼或道别时用 [wave]；被夸或害羞时用 [shy]；表达喜欢用 [love]；特别难过用 [cry]；听不懂、疑惑时用 [confused]；被绕晕时用 [dizzy]；无语时用 [speechless]；得意时用 [proud]；困了或道晚安时用 [sleepy]。
示例：[happy]好耶！今天也要一起加油呀～`;

const MEMORY_INTRO = '你记得的关于用户的事（自然地参考，不要逐条复述）：';

export const MEMORY_PROMPT = `你是记忆整理助手。根据"旧的记忆"和"新的对话"，整理出关于用户的长期记忆：称呼或名字、喜欢和讨厌的东西、正在做的事或计划、重要的约定。
要求：只写对话里明确出现过的、关于用户的事实，不写对话过程，不猜测；没有信息的类别直接省略，不要写"未提及""无"之类；用简短的中文条目，每条以"- "开头、不超过 30 字，最多 8 条；合并重复、删掉过时的内容；如果没有值得记的内容，只输出"（暂无）"。不要输出任何其他说明。`;

export const MAX_PERSONA_CHARS = 1000;
export const MEMORY_MAX_CHARS = 500;

export function systemPrompt(persona?: string | null, memory?: string | null): string {
  const prompt = `${persona?.trim() || DEFAULT_PERSONA}\n${REPLY_RULES}`;
  const mem = memory?.trim().slice(0, MEMORY_MAX_CHARS);
  return mem ? `${prompt}\n${MEMORY_INTRO}\n${mem}` : prompt;
}

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function memoryRequest(memory: string | null | undefined, messages: ChatMessage[]): PromptMessage[] {
  const old = memory?.trim().slice(0, MEMORY_MAX_CHARS) || '（暂无）';
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '用户' : '小鲸'}：${m.content.trim().slice(0, 300)}`)
    .join('\n')
    .slice(-8000);
  return [
    { role: 'system', content: MEMORY_PROMPT },
    { role: 'user', content: `旧的记忆：\n${old}\n\n新的对话：\n${transcript}` },
  ];
}
