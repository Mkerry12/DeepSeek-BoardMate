// 小助手：喝水 / 久坐提醒 + 番茄钟（25 分钟专注 / 5 分钟休息）
const FOCUS_MIN = 25;
const BREAK_MIN = 5;
const BUSY_RETRY = 3000;
const HOLD = 8000;

const REMINDERS = {
  water: {
    emotion: 'surprised',
    lines: ['该喝水啦！小鲸陪你一起咕噜咕噜～', '叮～喝口水休息一下吧！', '记得补充水分哦，鲸鱼都离不开水呢～'],
  },
  rest: {
    emotion: 'wave',
    lines: ['坐太久啦，站起来伸个懒腰吧～', '眼睛累了吧？看看远处放松一下～', '起来活动活动，小鲸等你回来！'],
  },
};

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

export function createAssistant({ pet, say, notify, isBusy, wake }) {
  const timers = {};
  let pomodoro = null;

  // 正在聊天时先不打扰，等回复结束再说
  function announce(fn) {
    if (isBusy()) return setTimeout(() => announce(fn), BUSY_RETRY);
    wake();
    fn();
  }

  function remind(kind) {
    const { emotion, lines } = REMINDERS[kind];
    const line = pickOne(lines);
    announce(() => {
      pet.react(emotion);
      say(line, HOLD);
      notify('小鲸提醒', line);
    });
  }

  function configure(reminders) {
    for (const kind of Object.keys(REMINDERS)) {
      clearInterval(timers[kind]);
      const conf = reminders?.[kind];
      if (conf?.on && conf.minutes > 0) timers[kind] = setInterval(() => remind(kind), conf.minutes * 60000);
    }
  }

  function startPhase(phase, minutes) {
    clearTimeout(pomodoro?.timer);
    pomodoro = { phase, endAt: Date.now() + minutes * 60000, timer: setTimeout(() => finishPhase(phase), minutes * 60000) };
  }

  function finishPhase(phase) {
    if (phase === 'focus') {
      startPhase('break', BREAK_MIN);
      announce(() => {
        pet.react('happy');
        say(`叮！专注 ${FOCUS_MIN} 分钟完成～休息 ${BREAK_MIN} 分钟吧！`, HOLD);
        notify('番茄钟', `专注完成，休息 ${BREAK_MIN} 分钟吧！`);
      });
    } else {
      pomodoro = null;
      announce(() => {
        pet.react('surprised');
        say('休息结束啦！还要再来一个番茄钟吗？右键我就能开始～', HOLD);
        notify('番茄钟', '休息结束啦！');
      });
    }
  }

  function togglePomodoro() {
    if (pomodoro) {
      clearTimeout(pomodoro.timer);
      pomodoro = null;
      pet.react('relaxed');
      say('番茄钟停下啦，辛苦了～', 3000);
      return;
    }
    startPhase('focus', FOCUS_MIN);
    pet.react('wave');
    pet.flash('画笔');
    say(`番茄钟开始！专注 ${FOCUS_MIN} 分钟，小鲸帮你看着时间～`, 5000);
  }

  function pomodoroLabel() {
    if (!pomodoro) return '';
    const left = Math.max(1, Math.ceil((pomodoro.endAt - Date.now()) / 60000));
    return `${pomodoro.phase === 'focus' ? '专注' : '休息'}中，还剩 ${left} 分钟`;
  }

  return {
    configure,
    remind,
    togglePomodoro,
    pomodoroLabel,
    get focusing() {
      return pomodoro?.phase === 'focus';
    },
  };
}
