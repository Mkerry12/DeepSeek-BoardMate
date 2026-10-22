// 按时段打招呼：早上 / 午饭 / 晚饭 / 深夜，每个时段每天只说一次（记在设置里），正在聊天等忙的时候先不打扰
const CHECK_EVERY = 60000;
const HOLD = 8000;
// 凌晨还算前一天的深夜
const DAY_SHIFT_HOURS = 5;
const EAT = { looks: ['蛋包饭', '挤番茄酱', '开心兴奋'], motion: 'Ketchup', secs: 7 };

const PERIODS = [
  {
    id: 'morning',
    from: [8, 0],
    to: [10, 0],
    emotion: 'wave',
    lines: ['早上好呀！今天也一起加油吧～', '早安！吃早饭了没？小鲸已经醒啦～'],
  },
  {
    id: 'lunch',
    from: [11, 45],
    to: [13, 0],
    ...EAT,
    lines: ['中午啦，记得好好吃午饭哦～', '午饭时间到！小鲸给你的蛋包饭画个爱心～'],
  },
  {
    id: 'dinner',
    from: [17, 45],
    to: [19, 30],
    ...EAT,
    lines: ['该吃晚饭啦，别饿着肚子哦～', '晚饭时间！今天辛苦啦，吃点好的吧～'],
  },
  {
    id: 'night',
    from: [23, 30],
    to: [5, 0],
    looks: ['阴暗', '闭眼口水'],
    secs: 8,
    lines: ['已经好晚啦…早点睡吧，小鲸也困了…呼…', '熬夜会变成熊猫眼的哦…快去睡觉吧～晚安'],
  },
];

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
const minutes = ([h, m]) => h * 60 + m;

export function inPeriod(p, now) {
  const t = now.getHours() * 60 + now.getMinutes();
  const from = minutes(p.from);
  const to = minutes(p.to);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

export function dayKey(now) {
  const d = new Date(now.getTime() - DAY_SHIFT_HOURS * 3600000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function createGreetings({ pet, say, isBusy, getGreeted, saveGreeted }) {
  // 返回是否打了招呼（启动时用来决定还要不要说默认的欢迎语）
  function check() {
    const now = new Date();
    const period = PERIODS.find((p) => inPeriod(p, now));
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
