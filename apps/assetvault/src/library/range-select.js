// 网格框选 / Shift 连选。
//
// 纪律：拖动期间只在 DOM 上加高亮 class，绝不调 renderGrid() —— 网格是增量绘制的，
// 一重绘节点就换了，框选几何会跟着乱。pointerup 才把命中集合提交给 state.selected。
// 选择真值始终只有 state.selected 这一份，和「全选 / 批量整理 / 加入画板」共用。
const INTERACTIVE = 'button,a,input,label,select,textarea,[data-action],[contenteditable],.card-facts,.card-select';
const THRESHOLD = 5;

export function createRangeSelect({grid, state, renderGrid = () => {}}) {
  if (!grid || !state?.selected) return {setup() {}, onCheckboxChange() {}};
  let anchor = '';
  let pendingShift = false;
  let start = null;
  let box = null;
  let dragging = false;
  let suppressClick = false;

  const cards = () => [...grid.querySelectorAll(':scope > .model-card[data-uid]')];
  const uids = () => cards().map(card => card.dataset.uid).filter(Boolean);
  const point = event => {
    const rect = grid.getBoundingClientRect();
    return {x: event.clientX - rect.left + grid.scrollLeft, y: event.clientY - rect.top + grid.scrollTop};
  };
  const cleanup = () => {
    box?.remove();
    box = null;
    document.body.classList.remove('rs-dragging');
    for (const card of cards()) card.classList.remove('rs-hit');
    start = null;
    dragging = false;
  };

  /** 接管 #grid 的 change：普通点击原语义，Shift 点第二张卡时把 anchor→当前整段选中。 */
  function onCheckboxChange(event) {
    const target = event.target;
    const uid = target?.dataset?.select;
    if (!uid) return;
    const shift = pendingShift;
    pendingShift = false;
    if (shift && anchor && anchor !== uid) {
      const list = uids();
      const from = list.indexOf(anchor), to = list.indexOf(uid);
      if (from >= 0 && to >= 0) {
        for (const value of list.slice(Math.min(from, to), Math.max(from, to) + 1)) state.selected.add(value);
        renderGrid();
        return;
      }
    }
    anchor = uid;
    if (target.checked) state.selected.add(uid); else state.selected.delete(uid);
    renderGrid();
  }

  function setup() {
    // 捕获阶段同时干两件事：记录 Shift（change 事件本身不带 shiftKey）、吞掉框选结束那一下 click。
    grid.addEventListener('click', event => {
      if (suppressClick) {
        suppressClick = false;
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      const checkbox = event.target.closest?.('[data-select]');
      pendingShift = !!checkbox && event.shiftKey;
    }, true);

    grid.addEventListener('pointerdown', event => {
      suppressClick = false;
      if (event.button !== 0 || event.target.closest?.(INTERACTIVE)) return;
      start = {origin: point(event), additive: event.ctrlKey || event.metaKey || event.shiftKey};
    });

    window.addEventListener('pointermove', event => {
      if (!start) return;
      const current = point(event);
      if (!dragging && Math.hypot(current.x - start.origin.x, current.y - start.origin.y) < THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        document.body.classList.add('rs-dragging');
        box = document.createElement('div');
        box.className = 'rs-box';
        grid.appendChild(box);
      }
      const left = Math.min(start.origin.x, current.x);
      const top = Math.min(start.origin.y, current.y);
      const right = Math.max(start.origin.x, current.x);
      const bottom = Math.max(start.origin.y, current.y);
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${right - left}px`;
      box.style.height = `${bottom - top}px`;
      const g = grid.getBoundingClientRect();
      for (const card of cards()) {
        const rect = card.getBoundingClientRect();
        const x = rect.left - g.left + grid.scrollLeft;
        const y = rect.top - g.top + grid.scrollTop;
        card.classList.toggle('rs-hit', x < right && x + rect.width > left && y < bottom && y + rect.height > top);
      }
    });

    window.addEventListener('pointerup', () => {
      if (!start) return;
      if (!dragging) { cleanup(); return; }
      const hit = [...grid.querySelectorAll(':scope > .model-card.rs-hit')];
      if (!start.additive) state.selected.clear();
      for (const card of hit) if (card.dataset.uid) state.selected.add(card.dataset.uid);
      suppressClick = true;
      // 拖到网格外松手时不会派发 click，别让抑制标记留到下一次点击。
      setTimeout(() => { suppressClick = false; }, 0);
      cleanup();
      renderGrid();
    });

    window.addEventListener('pointercancel', () => { if (start) cleanup(); });
  }

  return {setup, onCheckboxChange};
}
