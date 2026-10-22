// 角色配置 deskmate.json：表情映射、触摸区、闲置小动作、台词、换装、运势……
// 换角色 = 在 assets/live2d/ 下放一个新文件夹（模型 + pet.json + deskmate.json）
import { EMOTION_TAGS, STATE_TAGS } from '../../shared/emotions';
import { arr, ConfigError, num, obj, record, str, tuple, type Check } from './schema';

export const CONFIG_FILE = 'deskmate.json';

/** 一次角色反应：情绪（emotions 里的 key）/ 直接点亮的表情 / 动作 + 时长 / 随机一句台词 */
const reaction = obj({
  'emotion?': str,
  'looks?': arr(str),
  'motion?': str,
  'secs?': num,
  'lines?': arr(str, { min: 1 }),
});

const ellipse = { x: num, y: num, rx: num, ry: num };

const live2d = obj({
  /** 基础姿势（thinking / queued…）点亮的表情 */
  states: record(arr(str)),
  /** 情绪 → 表情（looks）与可选动作 */
  emotions: record(obj({ looks: arr(str, { min: 1 }), 'motion?': str, 'secs?': num })),
  /** 桌上可点的道具：中心按模型包围盒的比例给出 */
  props: record(obj({ look: str, x: num, y: num })),
  propRadius: obj({ x: num, y: num }),
  /** 这些表情亮着时道具被挡住，不可点 */
  propBlockers: arr(str),
  /** 触摸区（椭圆），按顺序命中；when：对应表情亮着才算。约定 id：head 摸头、face 戳脸、whale 头顶的小鲸鱼 */
  zones: arr(obj({ id: str, ...ellipse, 'when?': str })),
  /** 写本本：pet.json 里的选项 label，以及写的时候要让位的槽位 */
  'notes?': obj({ option: str, 'clears?': str }),
  mouthParam: str,
});

const config = obj({
  configVersion: num,
  name: str,
  live2d,
  /** 回复很长时把这些表情点亮（只在 whenLit 亮着时），说完 backMs 后放回 */
  longReply: obj({ chars: num, whenLit: str, looks: arr(str, { min: 1 }), backMs: num }),
  clickLines: arr(obj({ emotion: str, line: str }), { min: 1 }),
  touch: obj({ pat: reaction, zones: record(reaction), dizzy: reaction, angry: reaction, shake: reaction }),
  idle: obj({
    activities: arr(
      obj({
        'motion?': str,
        'looks?': arr(str),
        secs: num,
        weight: num,
        /** 这个表情亮着时不选（比如吐魂时不吹泡泡） */
        'avoid?': str,
        /** 换装里这个槽位有选择时不选（比如巴菲收起来了就不偷吃） */
        'unlessOutfit?': str,
        lines: arr(str, { min: 1 }),
      }),
      { min: 1 },
    ),
    doze: obj({ looks: arr(str, { min: 1 }), line: str }),
    wake: obj({ emotion: str, line: str }),
  }),
  outfit: obj({
    /** 出现在「换装」里的 pet.json 槽位（其余槽位是随对话变化的表情） */
    slots: arr(str),
    slotLabels: record(str),
    optionLabels: record(record(str)),
    default: record(str),
  }),
  fortune: obj({
    motion: str,
    levels: arr(obj({ name: str, emotion: str, weight: num, words: arr(str, { min: 1 }) }), { min: 1 }),
    colors: arr(str, { min: 1 }),
    items: arr(str, { min: 1 }),
    good: arr(str, { min: 1 }),
    bad: arr(str, { min: 1 }),
  }),
  greetings: arr(
    obj({
      id: str,
      from: tuple(num, num),
      to: tuple(num, num),
      'emotion?': str,
      'looks?': arr(str),
      'motion?': str,
      'secs?': num,
      lines: arr(str, { min: 1 }),
    }),
  ),
  reminders: obj({ water: reaction, rest: reaction }),
});

type Out<C> = C extends Check<infer T> ? T : never;
export type CharacterConfig = Out<typeof config>;
export type Live2DProfile = CharacterConfig['live2d'];
export type Reaction = Out<typeof reaction>;
export type IdleActivity = CharacterConfig['idle']['activities'][number];
export type GreetingPeriod = CharacterConfig['greetings'][number];
export type FortuneConfig = CharacterConfig['fortune'];
export type TouchConfig = CharacterConfig['touch'];

/** 代码里直接用到的情绪（除了模型回复里的标签之外） */
export const INTERNAL_EMOTIONS = ['soulout', 'pat', 'blush'];

export function validateConfig(raw: unknown): CharacterConfig {
  const c = config(raw, '');
  if (c.configVersion !== 1) throw new ConfigError(`不支持的 configVersion：${c.configVersion}`);
  const emotions = c.live2d.emotions;
  const missing = [...EMOTION_TAGS.filter((t) => !STATE_TAGS.includes(t)), ...INTERNAL_EMOTIONS].filter(
    (t) => !emotions[t],
  );
  if (missing.length) throw new ConfigError(`live2d.emotions 缺少情绪：${missing.join(', ')}`);
  const used = [
    ...c.clickLines.map((l) => l.emotion),
    ...c.fortune.levels.map((l) => l.emotion),
    c.idle.wake.emotion,
    ...[c.touch.pat, c.touch.dizzy, c.touch.angry, c.touch.shake, ...Object.values(c.touch.zones)].map(
      (r) => r.emotion,
    ),
    ...c.greetings.map((g) => g.emotion),
    c.reminders.water.emotion,
    c.reminders.rest.emotion,
  ].filter((e): e is string => !!e);
  const unknown = [...new Set(used.filter((e) => !emotions[e]))];
  if (unknown.length) throw new ConfigError(`用到了 live2d.emotions 里没有的情绪：${unknown.join(', ')}`);
  return c;
}

export async function loadConfig(modelUrl: string): Promise<CharacterConfig> {
  const url = new URL(CONFIG_FILE, modelUrl);
  let raw: unknown;
  try {
    raw = await fetch(url).then((r) => r.json());
  } catch (err) {
    throw new Error(`读不到角色配置 ${CONFIG_FILE}：${(err as Error).message}`, { cause: err });
  }
  try {
    return validateConfig(raw);
  } catch (err) {
    throw new Error(`角色配置 ${CONFIG_FILE} 有误：${(err as Error).message}`, { cause: err });
  }
}
