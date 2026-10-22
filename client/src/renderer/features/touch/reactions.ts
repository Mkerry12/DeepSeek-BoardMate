// 触摸互动：摸头（按住在头上来回蹭）、戳脸、点鲸鱼、连戳会晕然后生气、拿着窗口猛晃会晕
// 反应和台词来自角色配置的 touch 段
import type { Reaction, TouchConfig } from '../../character/config';
import { pickOne } from '../../core/util';

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
/** 摸头区的 id（角色配置 live2d.zones 里约定的名字） */
export const PAT_ZONE = 'head';

export interface TouchPet {
  react(emotion: string): void;
  motion(name: string, secs?: number): void;
}

export interface Touch {
  tap(zone: string | null): boolean;
  strokeStart(x: number, y: number): void;
  strokeMove(x: number, y: number): void;
  strokeEnd(): boolean;
  dragMove(dx: number): void;
}

export function createTouch({
  pet,
  say,
  quiet,
  config,
}: {
  pet: TouchPet;
  say: (text: string, holdMs?: number) => void;
  quiet: () => boolean;
  config: TouchConfig;
}): Touch {
  let pokes: number[] = [];
  let calmUntil = 0;
  let lastPatLine = 0;
  let stroke: { x: number; y: number; path: number; patted: boolean } | null = null;
  let shake: { start: number; dir: number; run: number; turns: number } | null = null;

  const talk = (r: Reaction) => !quiet() && r.lines && say(pickOne(r.lines), HOLD);

  // 连戳：3 秒内戳满 5 下 → 晕晕，再过一会儿生气抡锤子
  function poke() {
    const now = performance.now();
    if (now < calmUntil) return true;
    pokes = [...pokes.filter((t) => now - t < POKE_WINDOW), now];
    if (pokes.length < POKE_LIMIT) return false;
    pokes = [];
    calmUntil = now + ANGRY_DELAY + COOLDOWN;
    if (config.dizzy.emotion) pet.react(config.dizzy.emotion);
    talk(config.dizzy);
    setTimeout(() => {
      if (config.angry.emotion) pet.react(config.angry.emotion);
      talk(config.angry);
    }, ANGRY_DELAY);
    return true;
  }

  // 单击：返回 false 表示交给默认的随机反应
  function tap(zone: string | null) {
    if (poke()) return true;
    if (zone === PAT_ZONE) {
      pat(true);
      return true;
    }
    const r = zone ? config.zones[zone] : undefined;
    if (!r) return false;
    if (r.emotion) pet.react(r.emotion);
    if (r.motion) pet.motion(r.motion, r.secs);
    talk(r);
    return true;
  }

  function pat(line: boolean) {
    if (config.pat.emotion) pet.react(config.pat.emotion);
    const now = performance.now();
    if (line || now - lastPatLine > PAT_LINE_GAP) {
      lastPatLine = now;
      talk(config.pat);
    }
  }

  // 按在头上：鼠标来回蹭的路程够长就算摸了一下；strokeEnd 返回 true 表示这次按下算摸头（松开后不再触发单击）
  function strokeStart(x: number, y: number) {
    stroke = { x, y, path: 0, patted: false };
  }

  function strokeMove(x: number, y: number) {
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
  function dragMove(dx: number) {
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
    if (config.shake.emotion) pet.react(config.shake.emotion);
    talk(config.shake);
  }

  return { tap, strokeStart, strokeMove, strokeEnd, dragMove };
}
