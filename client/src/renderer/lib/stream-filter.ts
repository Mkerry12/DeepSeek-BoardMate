// server/stream_filter.py 的 TS 版：去掉 <think>…</think>，解析回复开头的 [emotion] 标签
import { EMOTION_TAGS } from '../../shared/emotions';
import type { ChatEvent } from '../../shared/types';

const EMOTIONS = new Set(EMOTION_TAGS);
const OPEN = '<think>';
const CLOSE = '</think>';

// 非流式结果：去掉 <think> 段（没闭合就去到结尾；只有 </think> 就取它后面）
export function stripThink(text: string): string {
  return (text.split(CLOSE).at(-1) ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}
const EMOTION_RE = /^\[\s*([a-zA-Z_]+)\s*\]/;
const MAX_TAG_LEN = 24;

function partialSuffix(text: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k--) {
    if (tag.startsWith(text.slice(-k))) return k;
  }
  return 0;
}

export class StreamFilter {
  buf = '';
  inThink = false;
  head = '';
  headDone = false;

  feed(text: string): ChatEvent[] {
    const events: ChatEvent[] = [];
    this.buf += text;
    while (true) {
      if (this.inThink) {
        const idx = this.buf.indexOf(CLOSE);
        if (idx === -1) {
          const keep = partialSuffix(this.buf, CLOSE);
          this.buf = keep ? this.buf.slice(-keep) : '';
          break;
        }
        this.buf = this.buf.slice(idx + CLOSE.length);
        this.inThink = false;
        continue;
      }
      const idx = this.buf.indexOf(OPEN);
      if (idx !== -1) {
        events.push(...this.visible(this.buf.slice(0, idx)));
        this.buf = this.buf.slice(idx + OPEN.length);
        this.inThink = true;
        events.push({ type: 'thinking' });
        continue;
      }
      const cut = this.buf.length - partialSuffix(this.buf, OPEN);
      events.push(...this.visible(this.buf.slice(0, cut)));
      this.buf = this.buf.slice(cut);
      break;
    }
    return events;
  }

  flush(): ChatEvent[] {
    const events: ChatEvent[] = [];
    if (!this.inThink && this.buf) events.push(...this.visible(this.buf));
    this.buf = '';
    if (!this.headDone) {
      this.headDone = true;
      const rest = this.head.trim();
      if (rest) events.push({ type: 'delta', text: rest });
    }
    return events;
  }

  private visible(text: string): ChatEvent[] {
    if (!text) return [];
    if (this.headDone) return [{ type: 'delta', text }];
    this.head += text;
    const head = this.head.trimStart();
    if (!head) return [];
    if (head[0] !== '[') return this.finishHead(head);
    const m = EMOTION_RE.exec(head);
    if (m) {
      const emotion = m[1].toLowerCase();
      const events: ChatEvent[] = EMOTIONS.has(emotion) ? [{ type: 'emotion', value: emotion }] : [];
      return [...events, ...this.finishHead(head.slice(m[0].length).trimStart())];
    }
    if (head.includes(']') || head.length > MAX_TAG_LEN) return this.finishHead(head);
    return [];
  }

  private finishHead(rest: string): ChatEvent[] {
    this.headDone = true;
    this.head = '';
    return rest ? [{ type: 'delta', text: rest }] : [];
  }
}
