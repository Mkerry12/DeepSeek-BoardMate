// 右键菜单（HTML 版，替代系统黑色原生菜单）。子菜单在卡片内逐层展开，始终留在窗口里
// 菜单项：'-' 分隔线 | { note } 说明文字 | { label, icon, hint, checked, submenu, action, confirm, stay }
//   submenu：返回子菜单项的函数；confirm：第一次点击先变成确认文案；stay：点完不关闭、原地刷新
const ICONS = {
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  wave: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h4"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4"/>',
  shirt: '<path d="M8 3 3 6l2 4 2-1v12h10V9l2 1 2-4-5-3a3 3 0 0 1-8 0z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pin: '<path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8"/>',
  power: '<path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  hide: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  exit: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
};

const MARGIN = 8;

function icon(name, className) {
  const span = document.createElement('span');
  span.className = className;
  if (name) span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

export function createMenu(el, { onToggle }) {
  let anchor = { x: 0, y: 0 };
  let stack = [];

  function itemEl(item) {
    if (item === '-') {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      return sep;
    }
    if (item.note) {
      const note = document.createElement('div');
      note.className = 'menu-note';
      note.textContent = item.note;
      return note;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu-item${item.armed ? ' danger' : ''}`;
    const label = document.createElement('span');
    label.className = 'menu-label';
    label.textContent = item.armed ? item.confirm : item.label;
    btn.append(icon(item.icon, 'menu-icon'), label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'menu-hint';
      hint.textContent = item.hint;
      btn.append(hint);
    }
    if (item.checked !== undefined) btn.append(icon(item.checked && 'check', 'menu-check'));
    if (item.submenu) btn.append(icon('next', 'menu-arrow'));
    btn.addEventListener('click', () => activate(item));
    return btn;
  }

  async function activate(item) {
    if (item.submenu) {
      stack.push({ title: item.label, build: item.submenu });
      return show();
    }
    if (item.confirm && !item.armed) {
      item.armed = true;
      return show(false);
    }
    if (!item.stay) close();
    await item.action?.();
    if (item.stay) show();
  }

  async function show(rebuild = true) {
    const page = stack.at(-1);
    if (rebuild || !page.items) page.items = await page.build();
    const nodes = [];
    if (stack.length > 1) {
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'menu-head';
      head.append(icon('back', 'menu-icon'), page.title);
      head.addEventListener('click', () => {
        stack.pop();
        show();
      });
      nodes.push(head, itemEl('-'));
    }
    nodes.push(...page.items.map(itemEl));
    el.replaceChildren(...nodes);
    el.classList.remove('hidden');
    place();
  }

  function place() {
    const { offsetWidth: w, offsetHeight: h } = el;
    const left = Math.max(MARGIN, Math.min(anchor.x, innerWidth - w - MARGIN));
    const top = Math.max(MARGIN, Math.min(anchor.y, innerHeight - h - MARGIN));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.transformOrigin = `${anchor.x - left}px ${anchor.y - top}px`;
  }

  async function open(x, y, build) {
    anchor = { x, y };
    stack = [{ build }];
    el.classList.remove('opening');
    await show();
    void el.offsetWidth;
    el.classList.add('opening');
    onToggle(true);
  }

  function close() {
    if (el.classList.contains('hidden')) return;
    el.classList.add('hidden');
    stack = [];
    onToggle(false);
  }

  return {
    open,
    close,
    get isOpen() {
      return !el.classList.contains('hidden');
    },
  };
}
