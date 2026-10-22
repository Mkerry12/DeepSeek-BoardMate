// 头顶的对话气泡：say 显示一句话（可定时收起），sayTyping 显示「…」打字动画
import type { Dom } from '../core/dom';

const BUBBLE_GAP = 12;

export interface Bubble {
  say(text: string, holdMs?: number): void;
  sayTyping(label?: string): void;
  hide(): void;
  readonly hidden: boolean;
}

export function createBubble(dom: Pick<Dom, 'bubble' | 'bubbleText'>, topY: () => number): Bubble {
  const { bubble, bubbleText } = dom;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(nodes: (Node | string)[], holdMs?: number) {
    clearTimeout(timer);
    bubbleText.replaceChildren(...nodes);
    bubble.classList.remove('hidden', 'leaving');
    place();
    bubbleText.scrollTop = bubbleText.scrollHeight;
    if (holdMs) timer = setTimeout(hide, holdMs);
  }

  function place() {
    bubble.style.top = `${Math.max(8, (topY() ?? 0) - bubble.offsetHeight - BUBBLE_GAP)}px`;
  }

  function hide() {
    bubble.classList.add('leaving');
    timer = setTimeout(() => bubble.classList.add('hidden'), 180);
  }

  return {
    say: (text, holdMs) => show([text], holdMs),
    sayTyping(label = '') {
      const dots = document.createElement('span');
      dots.className = 'dots';
      dots.append(...[0, 1, 2].map(() => document.createElement('i')));
      const parts: Node[] = [dots];
      if (label) {
        const span = document.createElement('span');
        span.className = 'typing-label';
        span.textContent = label;
        parts.unshift(span);
      }
      show(parts);
    },
    hide,
    get hidden() {
      return bubble.classList.contains('hidden');
    },
  };
}
