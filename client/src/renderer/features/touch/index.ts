// 鼠标：穿透 / 拖动 / 点击 / 摸头 / 桌上道具 / 右键菜单
import type { Feature } from '../../core/context';
import { pickOne } from '../../core/util';
import { createTouch, PAT_ZONE } from './reactions';

// 按在头上时，离按下点这么远才开始拖窗口（小范围来回蹭是摸头）
const HEAD_DRAG_START = 36;
const DRAG_START = 4;
/** 头顶小鲸鱼的触摸区 id：指着它时不算点桌上的道具 */
const WHALE_ZONE = 'whale';

export const touchFeature: Feature = (ctx) => {
  const { bus, pet, bubble, status, menu, character, dom } = ctx;
  const { canvas } = dom;
  const touch = createTouch({
    pet,
    say: bubble.say,
    quiet: () => status.get('replying'),
    config: character.touch,
  });

  let drag: { sx: number; sy: number; lx: number; moved: boolean; head: boolean } | null = null;
  let dragged = false;
  status.provide('dragging', () => !!drag);

  const isOverUI = (target: EventTarget | null) =>
    !!(target as Element | null)?.closest?.('.ui:not(.hidden), #bubble:not(.hidden)');

  // 菜单打开时窗口不穿透，点菜单外面就关掉（这一下不再触发别的互动）
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!menu.isOpen || (e.target as Element).closest('#menu')) return;
      e.stopPropagation();
      dragged = true;
      if (e.button !== 2) menu.close();
    },
    true,
  );
  window.addEventListener('blur', () => menu.close());

  window.addEventListener('mousemove', (e) => {
    pet.setPointer(e.clientX, e.clientY);
    if (drag) return;
    if (menu.isOpen) {
      pet.setHover(null);
      canvas.style.cursor = '';
      return ctx.setIgnoreMouse(false);
    }
    const over = !isOverUI(e.target);
    const zone = over && pet.zoneAt(e.clientX, e.clientY);
    const prop = over && zone !== WHALE_ZONE && pet.propAt(e.clientX, e.clientY);
    pet.setHover(prop ? character.live2d.props[prop]?.look : null);
    canvas.style.cursor = prop || zone === WHALE_ZONE ? 'pointer' : zone === PAT_ZONE ? 'grab' : '';
    const overPet = !!prop || pet.hitTest(e.clientX, e.clientY);
    if (overPet) bus.emit('user:active');
    ctx.setIgnoreMouse(!(isOverUI(e.target) || overPet));
  });

  // 按住头部小范围来回蹭 = 摸头；拖出 HEAD_DRAG_START 以外才开始拖窗口。其他部位照旧，动 4px 就拖
  // 拖动阈值之前用窗口内坐标判断（窗口还没动）；开始拖以后窗口由主进程跟着光标挪
  canvas.addEventListener('pointerdown', (e) => {
    bus.emit('user:active');
    dragged = false;
    if (e.button !== 0 || !pet.hitTest(e.clientX, e.clientY)) return;
    canvas.setPointerCapture(e.pointerId);
    const head = pet.zoneAt(e.clientX, e.clientY) === PAT_ZONE;
    drag = { sx: e.clientX, sy: e.clientY, lx: e.screenX, moved: false, head };
    if (head) touch.strokeStart(e.screenX, e.screenY);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (drag.head) touch.strokeMove(e.screenX, e.screenY);
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < (drag.head ? HEAD_DRAG_START : DRAG_START)) return;
      drag.moved = true;
      window.desk.dragStart();
    }
    touch.dragMove(e.screenX - drag.lx);
    drag.lx = e.screenX;
  });

  function endDrag() {
    if (!drag) return;
    const patted = drag.head && touch.strokeEnd();
    dragged = drag.moved || patted;
    if (drag.moved) window.desk.dragEnd();
    drag = null;
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  canvas.addEventListener('click', (e) => {
    if (dragged || !pet.hitTest(e.clientX, e.clientY)) return;
    const zone = pet.zoneAt(e.clientX, e.clientY);
    const prop = zone !== WHALE_ZONE && pet.propAt(e.clientX, e.clientY);
    if (prop) return bus.emit('pet:prop', { prop, detail: e.detail });
    if (e.detail !== 1) return;
    bus.emit('pet:touched', { zone });
    if (!touch.tap(zone)) {
      const { emotion, line } = pickOne(character.clickLines);
      pet.react(emotion);
      if (!status.get('replying')) bubble.say(line, 3000);
    }
  });

  canvas.addEventListener('dblclick', (e) => {
    if (pet.hitTest(e.clientX, e.clientY) && !pet.propAt(e.clientX, e.clientY)) bus.emit('chat:toggle', {});
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    bus.emit('user:active');
    if ((e.target as Element).closest('#menu')) return;
    if (menu.isOpen || pet.hitTest(e.clientX, e.clientY)) menu.open(e.clientX, e.clientY);
  });
};
