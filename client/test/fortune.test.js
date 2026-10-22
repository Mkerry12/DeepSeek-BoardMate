import { describe, expect, it } from 'vitest';
import { todayFortune } from '../src/renderer/fortune.js';

describe('todayFortune', () => {
  it('is deterministic within the same day', () => {
    const morning = todayFortune(new Date(2026, 9, 22, 8, 0));
    const night = todayFortune(new Date(2026, 9, 22, 23, 59));
    expect(night).toEqual(morning);
  });

  it('returns a well-formed fortune', () => {
    const f = todayFortune(new Date(2026, 0, 1));
    expect(['大吉', '中吉', '小吉', '吉', '末吉']).toContain(f.level);
    expect(typeof f.emotion).toBe('string');
    const lines = f.text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`今日运势：${f.level}`);
    expect(lines[1]).toMatch(/^幸运色：.+ · 幸运物：.+$/);
    expect(lines[2]).toMatch(/^宜：.+\u3000忌：.+$/);
  });

  it('varies across days', () => {
    const texts = new Set(Array.from({ length: 30 }, (_, i) => todayFortune(new Date(2026, 0, 1 + i)).text));
    expect(texts.size).toBeGreaterThan(1);
  });
});
