import { describe, expect, it } from 'vitest';
import { dayKey, inPeriod } from '../src/renderer/features/greetings';

const at = (h: number, m: number, day = 22) => new Date(2026, 9, day, h, m);

describe('inPeriod', () => {
  const lunch = { from: [11, 45], to: [13, 0] } as { from: [number, number]; to: [number, number] };
  const night = { from: [23, 30], to: [5, 0] } as { from: [number, number]; to: [number, number] };

  it('handles a same-day window (end exclusive)', () => {
    expect(inPeriod(lunch, at(11, 44))).toBe(false);
    expect(inPeriod(lunch, at(11, 45))).toBe(true);
    expect(inPeriod(lunch, at(12, 59))).toBe(true);
    expect(inPeriod(lunch, at(13, 0))).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(inPeriod(night, at(23, 29))).toBe(false);
    expect(inPeriod(night, at(23, 30))).toBe(true);
    expect(inPeriod(night, at(2, 0))).toBe(true);
    expect(inPeriod(night, at(5, 0))).toBe(false);
  });
});

describe('dayKey', () => {
  it('counts early morning as the previous day', () => {
    expect(dayKey(at(4, 59, 23))).toBe('2026-10-22');
    expect(dayKey(at(5, 0, 23))).toBe('2026-10-23');
    expect(dayKey(at(23, 59, 22))).toBe('2026-10-22');
  });
});
