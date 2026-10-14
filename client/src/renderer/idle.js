// 闲置时的小动作：一段时间没人理她就自拍、吹泡泡、吃东西，久了会打瞌睡；任何互动都会打断 / 叫醒
const FIRST_DELAY = [40, 90];
const NEXT_DELAY = [70, 160];
const BUSY_RETRY = [20, 40];
const DOZE_AFTER = 300;
const LINE_CHANCE = 0.35;
const LINE_HOLD = 3500;

const ACTIVITIES = [
  { motion: 'Selfie', secs: 7, weight: 2, lines: ['咔嚓～自拍一张！', '今天的小鲸也很可爱吧？'] },
  { motion: 'SelfieQuick', secs: 4, weight: 1, lines: ['咔嚓！'] },
  { motion: 'BubbleGum', secs: 10, weight: 2, lines: ['吹个泡泡～', '噗——泡泡破啦'] },
  { motion: 'Ketchup', looks: ['蛋包饭', '挤番茄酱'], secs: 10, weight: 1, lines: ['给蛋包饭画个爱心～', '番茄酱要挤满满的！'] },
  { looks: ['开心兴奋', '脸红'], secs: 6, weight: 2, needs: 'parfait', lines: ['偷偷吃一口巴菲…', '巴菲好甜～'] },
  { looks: ['调皮', '吐舌'], secs: 5, weight: 1, lines: ['嘿嘿～', '摸鱼中，勿扰～'] },
  { looks: ['星星眼', '情绪花花'], secs: 5, weight: 1, lines: ['今天也是元气满满的一天！'] },
];

const rand = ([a, b]) => (a + Math.random() * (b - a)) * 1000;
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

export function createIdle({ pet, say, isBusy, isQuiet, canSpeak, has }) {
  let timer = null;
  let dozeTimer = null;
  let stopTimer = null;
  let current = null;
  let dozingSince = 0;

  function schedule(range) {
    clearTimeout(timer);
    timer = setTimeout(run, rand(range));
  }

  function run() {
    if (dozingSince) return;
    if (isBusy()) return schedule(BUSY_RETRY);
    play();
    schedule(NEXT_DELAY);
  }

  function pick() {
    const pool = ACTIVITIES.filter((a) => !a.needs || has(a.needs));
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
  }

  function stop() {
    clearTimeout(stopTimer);
    if (!current) return;
    if (current.motion) pet.stopMotion();
    pet.setLayer('activity', null);
    current = null;
  }

  function doze() {
    if (isBusy()) {
      dozeTimer = setTimeout(doze, 60000);
      return;
    }
    stop();
    clearTimeout(timer);
    dozingSince = performance.now();
    pet.setLayer('activity', ['闭眼口水']);
    if (canSpeak()) say('呼…Zzz…', LINE_HOLD);
  }

  // 有互动：打断当前小动作、叫醒，并重新计时
  function poke() {
    stop();
    if (dozingSince) {
      const slept = performance.now() - dozingSince;
      dozingSince = 0;
      pet.setLayer('activity', null);
      if (slept > 20000) {
        pet.react('surprised');
        if (canSpeak()) say('唔…我才没有睡着！', 2500);
      }
    }
    schedule(FIRST_DELAY);
    clearTimeout(dozeTimer);
    dozeTimer = setTimeout(doze, DOZE_AFTER * 1000);
  }

  poke();
  return { poke, play: (i) => play(ACTIVITIES[i]), doze, get dozing() { return !!dozingSince; } };
}
