// 拖动按光标的屏幕坐标来算：渲染进程里的 screenX 在窗口移动时会滞后，高 DPI 下拖着拖着会漂
import { screen } from 'electron';
import { getWindow, savePosition, WIN_H, WIN_W } from './window';

const DRAG_TICK_MS = 16;

let drag: { dx: number; dy: number } | null = null;
let dragTimer: ReturnType<typeof setInterval> | undefined;

export const isDragging = (): boolean => !!drag;

function moveWindow(x: number, y: number) {
  getWindow()?.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_W, height: WIN_H });
}

function dragStep() {
  if (!drag) return;
  const p = screen.getCursorScreenPoint();
  moveWindow(p.x - drag.dx, p.y - drag.dy);
}

export function dragStart(): void {
  const win = getWindow();
  if (drag || !win) return;
  const [x, y] = win.getPosition();
  const p = screen.getCursorScreenPoint();
  drag = { dx: p.x - x, dy: p.y - y };
  dragTimer = setInterval(dragStep, DRAG_TICK_MS);
}

export function dragEnd(): void {
  if (!drag) return;
  clearInterval(dragTimer);
  dragStep();
  drag = null;
  savePosition();
}
