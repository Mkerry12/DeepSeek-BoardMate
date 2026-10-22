import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSONA,
  MEMORY_MAX_CHARS,
  MEMORY_PROMPT,
  memoryRequest,
  systemPrompt,
} from '../src/renderer/persona.js';

describe('systemPrompt', () => {
  it('uses the default persona when none is given', () => {
    const prompt = systemPrompt('', '');
    expect(prompt.startsWith(DEFAULT_PERSONA)).toBe(true);
    expect(prompt).toContain('[happy]');
    expect(prompt).not.toContain('你记得的关于用户的事');
  });

  it('replaces only the persona part with a custom persona', () => {
    const prompt = systemPrompt('  你是一只猫  ');
    expect(prompt.startsWith('你是一只猫\n规则：')).toBe(true);
    expect(prompt).not.toContain(DEFAULT_PERSONA);
  });

  it('appends trimmed memory capped at MEMORY_MAX_CHARS', () => {
    const memory = ` ${'记'.repeat(MEMORY_MAX_CHARS + 50)} `;
    const prompt = systemPrompt(null, memory);
    const [, tail] = prompt.split('你记得的关于用户的事（自然地参考，不要逐条复述）：\n');
    expect(tail).toBe('记'.repeat(MEMORY_MAX_CHARS));
  });

  it('ignores whitespace-only memory', () => {
    expect(systemPrompt(undefined, '   ')).toBe(systemPrompt(undefined, ''));
  });
});

describe('memoryRequest', () => {
  it('builds system + user messages with a placeholder for empty memory', () => {
    const [system, user] = memoryRequest('', [
      { role: 'user', content: ' 我叫小明 ' },
      { role: 'assistant', content: '你好小明' },
    ]);
    expect(system).toEqual({ role: 'system', content: MEMORY_PROMPT });
    expect(user.role).toBe('user');
    expect(user.content).toBe('旧的记忆：\n（暂无）\n\n新的对话：\n用户：我叫小明\n小鲸：你好小明');
  });

  it('caps each message at 300 chars and the transcript at 8000', () => {
    const messages = Array.from({ length: 40 }, () => ({ role: 'user', content: 'x'.repeat(500) }));
    const [, user] = memoryRequest('- 喜欢猫', messages);
    const transcript = user.content.split('新的对话：\n')[1];
    expect(user.content.startsWith('旧的记忆：\n- 喜欢猫')).toBe(true);
    expect(transcript.length).toBe(8000);
    expect(transcript).not.toContain('x'.repeat(301));
  });
});
