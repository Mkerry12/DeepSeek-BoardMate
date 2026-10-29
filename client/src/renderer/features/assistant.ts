// 小助手：喝水 / 久坐提醒、番茄钟（25 分钟专注 / 5 分钟休息）、看看剪贴板
import type { CharacterConfig } from '../character/config';
import { MENU_ORDER, type Feature } from '../core/context';
import { clip, pickOne } from '../core/util';
import type { ChimeKind } from '../services/voice';
import type { Reminders } from '../../shared/types';

const FOCUS_MIN = 25;
const BREAK_MIN = 5;
const BUSY_RETRY = 3000;
const HOLD = 8000;
const CLIPBOARD_MAX = 900;

type ReminderKind = keyof Reminders;

export interface AssistantDeps {
  pet: { react(emotion: string): void; flash(look: string): void };
  say: (text: string, holdMs?: number) => void;
  notify: (title: string, body: string) => void;
  isBusy: () => boolean;
  wake: () => void;
  chime: (kind: ChimeKind) => void;
  reminders: CharacterConfig['reminders'];
  /** 角色名（deskmate.json 的 name），用在提醒标题和台词里 */
  name: string;
  /** 开始番茄钟时闪一下的表情（桌上的画笔） */
  focusLook?: string;
}

export function createAssistant({ pet, say, notify, isBusy, wake, chime, reminders, name, focusLook }: AssistantDeps) {
  const timers: Partial<Record<ReminderKind, ReturnType<typeof setInterval>>> = {};
  let pomodoro: { phase: 'focus' | 'break'; endAt: number; timer: ReturnType<typeof setTimeout> } | null = null;

  // 正在聊天时先不打扰，等回复结束再说
  function announce(fn: () => void) {
    if (isBusy()) return void setTimeout(() => announce(fn), BUSY_RETRY);
    wake();
    fn();
  }

  function remind(kind: ReminderKind) {
    const { emotion, lines = [] } = reminders[kind];
    const line = pickOne(lines);
    announce(() => {
      if (emotion) pet.react(emotion);
      chime('waiting');
      say(line, HOLD);
      notify(`${name}提醒`, line);
    });
  }

  function configure(conf: Reminders) {
    for (const kind of Object.keys(reminders) as ReminderKind[]) {
      clearInterval(timers[kind]);
      const c = conf?.[kind];
      if (c?.on && c.minutes > 0) timers[kind] = setInterval(() => remind(kind), c.minutes * 60000);
    }
  }

  function startPhase(phase: 'focus' | 'break', minutes: number) {
    clearTimeout(pomodoro?.timer);
    pomodoro = {
      phase,
      endAt: Date.now() + minutes * 60000,
      timer: setTimeout(() => finishPhase(phase), minutes * 60000),
    };
  }

  function finishPhase(phase: 'focus' | 'break') {
    if (phase === 'focus') {
      startPhase('break', BREAK_MIN);
      announce(() => {
        pet.react('happy');
        chime('done');
        say(`叮！专注 ${FOCUS_MIN} 分钟完成～休息 ${BREAK_MIN} 分钟吧！`, HOLD);
        notify('番茄钟', `专注完成，休息 ${BREAK_MIN} 分钟吧！`);
      });
    } else {
      pomodoro = null;
      announce(() => {
        pet.react('surprised');
        chime('asking');
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
    if (focusLook) pet.flash(focusLook);
    say(`番茄钟开始！专注 ${FOCUS_MIN} 分钟，${name}帮你看着时间～`, 5000);
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

export const assistantFeature: Feature = ({ bus, store, pet, bubble, voice, status, menu, character }) => {
  const assistant = createAssistant({
    pet,
    say: bubble.say,
    notify: window.desk.notify,
    isBusy: () => status.get('replying'),
    wake: () => bus.emit('user:active'),
    chime: (kind) => voice.chime(kind),
    reminders: character.reminders,
    name: character.name,
    focusLook: character.live2d.props.brush?.look,
  });
  assistant.configure(store.settings.reminders);
  status.provide('focusing', () => assistant.focusing);
  bus.on('settings:saved', ({ settings }) => assistant.configure(settings.reminders));

  async function explainClipboard() {
    const text = (await window.desk.readClipboard()).trim();
    if (!text) {
      pet.react('surprised');
      return bubble.say('剪贴板里没有文字哦，先复制一段再叫我～', 3500);
    }
    bus.emit('chat:send', { text: `帮我看看剪贴板里的这段内容，简单解释或总结一下：\n${clip(text, CLIPBOARD_MAX)}` });
  }

  function pomodoroItems() {
    const label = assistant.pomodoroLabel();
    return label
      ? [{ note: label }, { label: '停止番茄钟', icon: 'stop' as const, action: assistant.togglePomodoro }]
      : [
          { note: '专注 25 分钟 + 休息 5 分钟' },
          { label: '开始专注', icon: 'play' as const, action: assistant.togglePomodoro },
        ];
  }

  menu.register(MENU_ORDER.clipboard, () => [{ label: '看看剪贴板', icon: 'clipboard', action: explainClipboard }]);
  menu.register(MENU_ORDER.pomodoro, () => [
    { label: '番茄钟', icon: 'timer', hint: assistant.pomodoroLabel() ? '进行中' : '', submenu: pomodoroItems },
  ]);
};
