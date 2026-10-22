// 今日运势：按日期做种子，同一天怎么抽都是同一签；掏出手机翻开看一眼，再念给你听
import type { FortuneConfig } from '../character/config';
import { MENU_ORDER, type Feature } from '../core/context';

const FORTUNE_REVEAL_MS = 2600;

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h;
}

export interface Fortune {
  level: string;
  emotion: string;
  text: string;
}

export function todayFortune(config: FortuneConfig, date = new Date()): Fortune {
  const rand = seeded(hash(`deskmate-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`));
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const { levels } = config;
  let r = rand() * levels.reduce((sum, l) => sum + l.weight, 0);
  const level = levels.find((l) => (r -= l.weight) < 0) || levels[0];
  const text = [
    `今日运势：${level.name}`,
    `幸运色：${pick(config.colors)} · 幸运物：${pick(config.items)}`,
    `宜：${pick(config.good)}　忌：${pick(config.bad)}`,
    pick(level.words),
  ].join('\n');
  return { level: level.name, emotion: level.emotion, text };
}

export const fortuneFeature: Feature = ({ bus, pet, bubble, voice, status, menu, character }) => {
  function showFortune() {
    if (status.get('replying')) return bubble.say('等我说完这句再看运势嘛～', 2500);
    bus.emit('user:active');
    const { emotion, text } = todayFortune(character.fortune);
    pet.motion(character.fortune.motion, FORTUNE_REVEAL_MS / 1000 + 1.5);
    bubble.sayTyping('小鲸在看今日运势');
    setTimeout(() => {
      pet.react(emotion);
      voice.chime('done');
      bubble.say(text, 12000);
      voice.speak(text);
    }, FORTUNE_REVEAL_MS);
  }

  menu.register(MENU_ORDER.fortune, () => [{ label: '今日运势', icon: 'gift', action: showFortune }]);
};
