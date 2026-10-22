import { describe, expect, it } from 'vitest';
import { StreamFilter, stripThink } from '../src/renderer/stream-filter.js';

function run(chunks) {
  const filter = new StreamFilter();
  const events = chunks.flatMap((c) => filter.feed(c));
  return [...events, ...filter.flush()];
}

const text = (events) =>
  events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('');

describe('StreamFilter emotion tag', () => {
  it('parses a leading emotion tag', () => {
    const events = run(['[happy]好耶！']);
    expect(events[0]).toEqual({ type: 'emotion', value: 'happy' });
    expect(text(events)).toBe('好耶！');
  });

  it('parses a tag split across chunks', () => {
    const events = run(['[ha', 'p', 'py] 今天', '也加油']);
    expect(events.filter((e) => e.type === 'emotion')).toEqual([{ type: 'emotion', value: 'happy' }]);
    expect(text(events)).toBe('今天也加油');
  });

  it('accepts whitespace and upper case inside the tag', () => {
    const events = run(['  [ Shy ]嘿嘿']);
    expect(events[0]).toEqual({ type: 'emotion', value: 'shy' });
    expect(text(events)).toBe('嘿嘿');
  });

  it('drops unknown emotions but keeps the reply', () => {
    const events = run(['[bogus]你好']);
    expect(events.some((e) => e.type === 'emotion')).toBe(false);
    expect(text(events)).toBe('你好');
  });

  it('treats text without a tag as plain reply', () => {
    const events = run(['你好', '呀']);
    expect(events.some((e) => e.type === 'emotion')).toBe(false);
    expect(text(events)).toBe('你好呀');
  });

  it('gives up on an over-long bracket head', () => {
    const events = run(['[这不是一个情绪标签而是一段很长很长很长的文字', '后面还有']);
    expect(events.some((e) => e.type === 'emotion')).toBe(false);
    expect(text(events)).toBe('[这不是一个情绪标签而是一段很长很长很长的文字后面还有');
  });

  it('only parses the tag at the very beginning', () => {
    const events = run(['[happy]好', '[sad]的']);
    expect(events.filter((e) => e.type === 'emotion')).toHaveLength(1);
    expect(text(events)).toBe('好[sad]的');
  });

  it('flushes an unterminated tag head as text', () => {
    expect(text(run(['[hap']))).toBe('[hap');
  });
});

describe('StreamFilter <think>', () => {
  it('strips a think block and emits thinking', () => {
    const events = run(['<think>想一想</think>[happy]答案']);
    expect(events[0]).toEqual({ type: 'thinking' });
    expect(events).toContainEqual({ type: 'emotion', value: 'happy' });
    expect(text(events)).toBe('答案');
  });

  it('handles think tags split across chunks', () => {
    const events = run(['<th', 'ink>推理', '中…</th', 'in', 'k>[sad]', '呜呜']);
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'emotion', value: 'sad' });
    expect(text(events)).toBe('呜呜');
  });

  it('drops content of an unclosed think block on flush', () => {
    expect(text(run(['<think>还没想完']))).toBe('');
  });

  it('keeps a "<" that is not a think tag', () => {
    expect(text(run(['1 <', ' 2']))).toBe('1 < 2');
  });
});

describe('stripThink', () => {
  it('removes closed and unclosed think blocks', () => {
    expect(stripThink('<think>abc</think> 结果 ')).toBe('结果');
    expect(stripThink('前面<think>没闭合')).toBe('前面');
  });

  it('keeps only text after a lone closing tag', () => {
    expect(stripThink('推理过程</think>- 喜欢猫')).toBe('- 喜欢猫');
  });
});
