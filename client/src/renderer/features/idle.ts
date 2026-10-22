// 闲置时的小动作：一段时间没人理她就自拍、吹泡泡、吃东西，久了会打瞌睡；任何互动都会打断 / 叫醒
// 小动作列表和台词来自角色配置的 idle 段
import type { CharacterConfig, IdleActivity } from '../character/config';
import type { AppBus } from '../core/bus';
import type { Feature } from '../core/context';
import { pickOne } from '../core/util';
import type { Live2DPet } from '../pet/live2d';

const FIRST_DELAY: [number, number] = [40, 90];
const NEXT_DELAY: [number, number] = [70, 160];
const BUSY_RETRY: [number, number] = [20, 40];
const DOZE_AFTER = 300;
const LINE_CHANCE = 0.35;
const LINE_HOLD = 3500;

const rand = ([a, b]: [number, number]) => (a + Math.random() * (b - a)) * 1000;

export interface IdleDeps {
  pet: Pick<Live2DPet, 'setLayer' | 'motion' | 'stopMotion' | 'isLit' | 'react'>;
  say: (text: string, holdMs?: number) => void;
  isBusy: () => boolean;
  isQuiet: () => boolean;
  canSpeak: () => boolean;
  /** 换装里这个槽位有没有选东西 */
  wearing: (slot: string) => boolean;
  config: CharacterConfig['idle'];
  bus?: AppBus;
}

export function createIdle({ pet, say, isBusy, isQuiet, canSpeak, wearing, config, bus }: IdleDeps) {
  const activities = config.activities;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dozeTimer: ReturnType<typeof setTimeout> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let current: IdleActivity | null = null;
  let dozingSince = 0;

  function schedule(range: [number, number]) {
    clearTimeout(timer);
    timer = setTimeout(run, rand(range));
  }

  function run() {
    if (dozingSince) return;
    if (isBusy()) return schedule(BUSY_RETRY);
    play();
    schedule(NEXT_DELAY);
  }

  function pick(): IdleActivity {
    const pool = activities.filter(
      (a) => (!a.unlessOutfit || !wearing(a.unlessOutfit)) && (!a.avoid || !pet.isLit(a.avoid)),
    );
    let r = Math.random() * pool.reduce((sum, a) => sum + a.weight, 0);
    return pool.find((a) => (r -= a.weight) < 0) || pool[0];
  }

  function play(act = pick()) {
    stop();
    current = act;
    pet.setLayer('activity', act.looks, act.secs);
    if (act.motion) pet.motion(act.motion, act.secs);
    if (!isQuiet() && canSpeak() && Math.random() < LINE_CHANCE) say(pickOne(act.lines), LINE_HOLD);
    stopTimer = setTimeout(stop, act.secs * 1000);
    bus?.emit('idle:start', { motion: act.motion });
  }

  function stop() {
    clearTimeout(stopTimer);
    if (!current) return;
    if (current.motion) pet.stopMotion();
    pet.setLayer('activity', null);
    current = null;
    bus?.emit('idle:end');
  }

  function doze() {
    if (isBusy()) {
      dozeTimer = setTimeout(doze, 60000);
      return;
    }
    stop();
    clearTimeout(timer);
    dozingSince = performance.now();
    pet.setLayer('activity', config.doze.looks);
    if (canSpeak()) say(config.doze.line, LINE_HOLD);
  }

  // 有互动：打断当前小动作、叫醒，并重新计时
  function poke() {
    stop();
    if (dozingSince) {
      const slept = performance.now() - dozingSince;
      dozingSince = 0;
      pet.setLayer('activity', null);
      if (slept > 20000) {
        pet.react(config.wake.emotion);
        if (canSpeak()) say(config.wake.line, 2500);
      }
    }
    schedule(FIRST_DELAY);
    clearTimeout(dozeTimer);
    dozeTimer = setTimeout(doze, DOZE_AFTER * 1000);
  }

  poke();
  return {
    poke,
    play: (i: number) => play(activities[i]),
    doze,
    get dozing() {
      return !!dozingSince;
    },
  };
}

export const idleFeature: Feature = ({ bus, pet, bubble, status, store, character }) => {
  const idle = createIdle({
    pet,
    say: bubble.say,
    isBusy: () => status.busy() || status.get('voiceActive'),
    isQuiet: () => status.get('focusing'),
    canSpeak: () => bubble.hidden,
    wearing: (slot) => !!store.settings.outfit[slot],
    config: character.idle,
    bus,
  });
  bus.on('user:active', () => idle.poke());
};
