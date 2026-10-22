// 按时段打招呼：早上 / 午饭 / 晚饭 / 深夜，每个时段每天只说一次（记在设置里），正在聊天等忙的时候先不打扰
// 另外负责启动时的欢迎语和菜单里的「打招呼」
import type { GreetingPeriod } from '../character/config';
import { MENU_ORDER, type Feature } from '../core/context';
import { pickOne } from '../core/util';
import type { Live2DPet } from '../pet/live2d';

const CHECK_EVERY = 60000;
const HOLD = 8000;
// 凌晨还算前一天的深夜
const DAY_SHIFT_HOURS = 5;

const minutes = ([h, m]: [number, number]) => h * 60 + m;

export function inPeriod(p: Pick<GreetingPeriod, 'from' | 'to'>, now: Date): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const from = minutes(p.from);
  const to = minutes(p.to);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

export function dayKey(now: Date): string {
  const d = new Date(now.getTime() - DAY_SHIFT_HOURS * 3600000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function createGreetings({
  pet,
  say,
  isBusy,
  getGreeted,
  saveGreeted,
  periods,
}: {
  pet: Pick<Live2DPet, 'react' | 'setLayer' | 'motion'>;
  say: (text: string, holdMs?: number) => void;
  isBusy: () => boolean;
  getGreeted: () => Record<string, string>;
  saveGreeted: (greeted: Record<string, string>) => void;
  periods: GreetingPeriod[];
}) {
  // 返回是否打了招呼（启动时用来决定还要不要说默认的欢迎语）
  function check(): boolean {
    const now = new Date();
    const period = periods.find((p) => inPeriod(p, now));
    if (!period || getGreeted()[period.id] === dayKey(now) || isBusy()) return false;
    saveGreeted({ ...getGreeted(), [period.id]: dayKey(now) });
    if (period.emotion) pet.react(period.emotion);
    if (period.looks) pet.setLayer('emotion', period.looks, period.secs);
    if (period.motion) pet.motion(period.motion, period.secs);
    say(pickOne(period.lines), HOLD);
    return true;
  }

  setInterval(check, CHECK_EVERY);
  return { check };
}

export const greetingsFeature: Feature = ({ bus, store, pet, bubble, status, menu, character }) => {
  const say = bubble.say;
  const greetings = createGreetings({
    pet,
    say,
    isBusy: () => status.busy() || status.get('voiceActive') || status.get('focusing'),
    getGreeted: () => store.settings.greeted || {},
    saveGreeted: (greeted) => void store.update({ greeted }),
    periods: character.greetings,
  });

  function wave() {
    pet.react('wave');
    say('嗨～', 2500);
  }

  menu.register(MENU_ORDER.wave, () => [{ label: '打招呼', icon: 'wave', action: wave }]);

  bus.on('app:ready', () => {
    const { settings, history } = store;
    const configured = settings.mode === 'apikey' ? settings.api.key : settings.token;
    if (!configured) {
      pet.react('wave');
      say('你好呀！右键我打开「设置」填写令牌或 API Key，双击我聊天～', 6000);
    } else if (!greetings.check()) {
      pet.react('wave');
      say(history.length ? '欢迎回来～我还记得我们上次聊的哦' : '你好呀，双击我就可以聊天～', 6000);
    }
  });
};
