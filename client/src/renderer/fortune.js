// 今日运势：按日期做种子，同一天怎么抽都是同一签
const LEVELS = [
  { name: '大吉', emotion: 'proud', weight: 2, words: ['今天做什么都会顺顺利利的！小鲸也沾沾你的好运～', '运气爆棚！要不要去买张彩票…开玩笑的啦～'] },
  { name: '中吉', emotion: 'happy', weight: 3, words: ['是不错的一天哦，适合把拖着的事情做完！', '好运在向你游过来啦，抓住它～'] },
  { name: '小吉', emotion: 'relaxed', weight: 3, words: ['平平稳稳就是福，慢慢来不着急～', '小小的幸运藏在细节里，留意一下吧～'] },
  { name: '吉', emotion: 'love', weight: 2, words: ['今天适合对自己好一点点～', '会遇到让你会心一笑的小事哦～'] },
  { name: '末吉', emotion: 'confused', weight: 1, words: ['有点小波折，不过有小鲸陪着你呀！', '运气在热身中…先喝口水再出发吧～'] },
];
const COLORS = ['海蓝色', '薄荷绿', '樱花粉', '奶油黄', '星空紫', '珊瑚橙', '云朵白'];
const ITEMS = ['一杯奶茶', '小鱼干', '蓝色的笔', '耳机', '便利贴', '草莓巴菲', '一颗糖'];
const GOOD = ['摸鱼十分钟', '早点睡觉', '喝够八杯水', '整理桌面', '给朋友发个消息', '学一个新单词', '出门晒太阳'];
const BAD = ['熬夜', '空腹喝咖啡', '和 bug 硬刚', '拖延', '乱发脾气', '久坐不动'];

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h;
}

export function todayFortune(date = new Date()) {
  const rand = seeded(hash(`deskmate-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  let r = rand() * LEVELS.reduce((sum, l) => sum + l.weight, 0);
  const level = LEVELS.find((l) => (r -= l.weight) < 0) || LEVELS[0];
  const text = [
    `今日运势：${level.name}`,
    `幸运色：${pick(COLORS)} · 幸运物：${pick(ITEMS)}`,
    `宜：${pick(GOOD)}　忌：${pick(BAD)}`,
    pick(level.words),
  ].join('\n');
  return { level: level.name, emotion: level.emotion, text };
}
