import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createTouch } from '../src/renderer/features/touch/reactions';
import { character } from './helpers';

let now: number;
let pet: { react: Mock<(emotion: string) => void>; motion: Mock<(name: string, secs?: number) => void> };
let say: Mock<(text: string, holdMs?: number) => void>;

beforeEach(() => {
  now = 10000;
  vi.useFakeTimers();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  pet = { react: vi.fn(), motion: vi.fn() };
  say = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const make = (quiet = false) => createTouch({ pet, say, quiet: () => quiet, config: character.touch });

describe('tap zones', () => {
  it('head pats, face blushes, whale sprays, others fall through', () => {
    const touch = make();
    expect(touch.tap('head')).toBe(true);
    expect(pet.react).toHaveBeenLastCalledWith('pat');
    now += 1000;
    expect(touch.tap('face')).toBe(true);
    expect(pet.react).toHaveBeenLastCalledWith('blush');
    now += 1000;
    expect(touch.tap('whale')).toBe(true);
    expect(pet.motion).toHaveBeenCalledWith('SprayWater', 2.5);
    now += 5000;
    expect(touch.tap('body')).toBe(false);
    expect(touch.tap(null)).toBe(false);
  });

  it('stays silent when quiet', () => {
    const touch = make(true);
    touch.tap('face');
    expect(pet.react).toHaveBeenCalledWith('blush');
    expect(say).not.toHaveBeenCalled();
  });
});

describe('rapid pokes', () => {
  it('5 pokes within 3s make her dizzy then angry', () => {
    const touch = make();
    for (let i = 0; i < 4; i++) {
      touch.tap(null);
      now += 100;
    }
    expect(pet.react).not.toHaveBeenCalledWith('dizzy');
    expect(touch.tap(null)).toBe(true);
    expect(pet.react).toHaveBeenLastCalledWith('dizzy');
    vi.advanceTimersByTime(1600);
    expect(pet.react).toHaveBeenLastCalledWith('angry');
    now += 1000;
    expect(touch.tap('face')).toBe(true);
    expect(pet.react).not.toHaveBeenCalledWith('blush');
  });

  it('slow pokes do not trigger', () => {
    const touch = make();
    for (let i = 0; i < 10; i++) {
      touch.tap(null);
      now += 1000;
    }
    expect(pet.react).not.toHaveBeenCalledWith('dizzy');
  });
});

describe('stroke on head', () => {
  it('counts as a pat once the path is long enough', () => {
    const touch = make();
    touch.strokeStart(0, 0);
    touch.strokeMove(30, 0);
    touch.strokeMove(0, 0);
    expect(pet.react).not.toHaveBeenCalled();
    touch.strokeMove(30, 0);
    expect(pet.react).toHaveBeenCalledWith('pat');
    expect(touch.strokeEnd()).toBe(true);
    expect(touch.strokeEnd()).toBe(false);
  });
});

describe('window shake', () => {
  it('several fast direction changes make her dizzy', () => {
    const touch = make();
    for (let i = 0; i < 6; i++) {
      touch.dragMove(i % 2 ? -30 : 30);
      now += 50;
    }
    expect(pet.react).toHaveBeenCalledWith('dizzy');
  });

  it('small jiggles are ignored', () => {
    const touch = make();
    for (let i = 0; i < 10; i++) {
      touch.dragMove(i % 2 ? -5 : 5);
      now += 50;
    }
    expect(pet.react).not.toHaveBeenCalled();
  });
});
