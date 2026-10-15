// 触摸互动：摸头（按住在头上来回蹭）、戳脸、点鲸鱼、连戳会晕然后生气、拿着窗口猛晃会晕
const POKE_WINDOW = 3000;
const POKE_LIMIT = 5;
const ANGRY_DELAY = 1600;
const STROKE_PATH = 70;
const PAT_LINE_GAP = 2500;
const SHAKE_WINDOW = 1200;
const SHAKE_TURNS = 4;
const SHAKE_MIN = 25;
const COOLDOWN = 4000;
const HOLD = 2600;

const LINES = {
  pat: ['嘿嘿，好舒服～', '再摸一下嘛', '唔…头发要乱了', '摸摸头，烦恼都飞走啦～'],
  face: ['呀！不许戳脸！', '脸、脸会被戳红的啦…', '唔…干嘛突然戳我', '软软的吧？嘿嘿'],
  whale: ['小鲸鱼：噗——！', '喷你一脸水！', '不许欺负小鲸鱼～'],
  dizzy: ['呜…别戳了别戳了，头好晕…', '眼、眼睛在转圈圈…'],
  angry: ['再戳就要锤你啦！', '哼！吃我一锤！'],
  shake: ['呜哇——别晃啦，头好晕～', '晕、晕了…世界在转圈圈…'],
};

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

export function createTouch({ pet, say, quiet }) {
  let pokes = [];
  let calmUntil = 0;
  let lastPatLine = 0;
  let stroke = null;
  let shake = null;

  const talk = (kind) => !quiet() && say(pickOne(LINES[kind]), HOLD);

  // 连戳：3 秒内戳满 5 下 → 晕晕，再过一会儿生气抡锤子
  function poke() {
    const now = performance.now();
    if (now < calmUntil) return true;
    pokes = [...pokes.filter((t) => now - t < POKE_WINDOW), now];
    if (pokes.length < POKE_LIMIT) return false;
    pokes = [];
    calmUntil = now + ANGRY_DELAY + COOLDOWN;
    pet.react('dizzy');
    talk('dizzy');
    setTimeout(() => {
      pet.react('angry');
      talk('angry');
    }, ANGRY_DELAY);
    return true;
  }

  // 单击：返回 false 表示交给默认的随机反应
  function tap(zone) {
    if (poke()) return true;
    if (zone === 'head') {
      pat(true);
      return true;
    }
    if (zone === 'face') {
      pet.react('blush');
      talk('face');
      return true;
    }
    if (zone === 'whale') {
      pet.react('relaxed');
      pet.motion('SprayWater', 2.5);
      talk('whale');
      return true;
    }
    return false;
  }

  function pat(line) {
    pet.react('pat');
    const now = performance.now();
    if (line || now - lastPatLine > PAT_LINE_GAP) {
      lastPatLine = now;
      talk('pat');
    }
  }

  // 按在头上：鼠标来回蹭的路程够长就算摸了一下；strokeEnd 返回 true 表示这次按下算摸头（松开后不再触发单击）
  function strokeStart(x, y) {
    stroke = { x, y, path: 0, patted: false };
  }

  function strokeMove(x, y) {
    if (!stroke) return;
    stroke.path += Math.hypot(x - stroke.x, y - stroke.y);
    stroke.x = x;
    stroke.y = y;
    if (stroke.path < STROKE_PATH) return;
    stroke.path = 0;
    stroke.patted = true;
    pat(false);
  }

  function strokeEnd() {
    const patted = !!stroke?.patted;
    stroke = null;
    return patted;
  }

  // 拖窗口：短时间里左右来回反向好几次 → 晕
  function dragMove(dx) {
    if (!dx) return;
    const now = performance.now();
    const dir = Math.sign(dx);
    if (!shake || now - shake.start > SHAKE_WINDOW) shake = { start: now, dir, run: 0, turns: 0 };
    if (dir === shake.dir) shake.run += Math.abs(dx);
    else {
      if (shake.run >= SHAKE_MIN) shake.turns++;
      shake.dir = dir;
      shake.run = Math.abs(dx);
    }
    if (shake.turns < SHAKE_TURNS || now < calmUntil) return;
    shake = null;
    calmUntil = now + COOLDOWN;
    pet.react('dizzy');
    talk('shake');
  }

  return { tap, strokeStart, strokeMove, strokeEnd, dragMove };
}
