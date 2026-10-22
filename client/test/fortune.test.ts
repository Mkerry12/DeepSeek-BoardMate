import { describe, expect, it } from 'vitest';
import { todayFortune } from '../src/renderer/features/fortune';
import { character } from './helpers';

const fortune = (date: Date) => todayFortune(character.fortune, date);

describe('todayFortune', () => {
  it('is deterministic within the same day', () => {
    const morning = fortune(new Date(2026, 9, 22, 8, 0));
    const night = fortune(new Date(2026, 9, 22, 23, 59));
    expect(night).toEqual(morning);
  });

  it('returns a well-formed fortune', () => {
    const f = fortune(new Date(2026, 0, 1));
    expect(['大吉', '中吉', '小吉', '吉', '末吉']).toContain(f.level);
    expect(typeof f.emotion).toBe('string');
    const lines = f.text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`今日运势：${f.level}`);
    expect(lines[1]).toMatch(/^幸运色：.+ · 幸运物：.+$/);
    expect(lines[2]).toMatch(/^宜：.+\u3000忌：.+$/);
  });

  it('varies across days', () => {
    const texts = new Set(Array.from({ length: 30 }, (_, i) => fortune(new Date(2026, 0, 1 + i)).text));
    expect(texts.size).toBeGreaterThan(1);
  });

  // 数据搬到 deskmate.json 后，同一天抽到的签必须和搬家前一模一样
  it('matches the pre-refactor draw for a known day', () => {
    expect(fortune(new Date(2026, 9, 22)).text).toBe(
      '今日运势：中吉\n幸运色：樱花粉 · 幸运物：蓝色的笔\n宜：给朋友发个消息\u3000忌：久坐不动\n好运在向你游过来啦，抓住它～',
    );
  });
});
