// 网格框选 / Shift 连选。
//
// 起点规则（2026-11-13 用户确认）：**卡片上按住 = 拖动卡片**（桌面版直接把文件拖到
// Blender / 资源管理器），**空白处按住拖动 = 框选**。所以「哪里算空白」不能只看
// 起点是否落在 #grid 的盒子里 —— 那样卡片间隙稍窄、留白稍宽、最后一排下面那片空白
// 全都起不了框选，用起来就是「被限制」。现在判据改成：起点在资产区里、
// 不在卡片上、不在真控件上，就算空白。
//
// 纪律：拖动期间只在 DOM 上加高亮 class，绝不调 renderGrid() —— 网格是增量绘制的，
// 一重绘节点就换了，框选几何会跟着乱。pointerup 才把命中集合提交给 state.selected。
// 选择真值始终只有 state.selected 这一份，和「全选 / 批量整理 / 加入画板」共用。
const THRESHOLD = 5;
/** 拖到滚动容器上下边缘多少像素内开始自动滚动，以及每帧最多滚多少。 */
const EDGE = 64;
const MAX_SPEED = 26;
/** 卡片：按住是拖动卡片本身，不是框选起点。 */
const CARD = '.model-card,.local-file-card,.bd-card,.local-gallery-photo,.local-gallery-thumb,.cv-img';
/** 真控件：按下去要留给它自己（点按钮 / 拖滑块 / 选文本）。 */
const CONTROL = 'button,a,input,select,textarea,label,[contenteditable="true"],[contenteditable=""],[role="button"],[role="slider"],[data-action]';
/** 资产区里不属于「资产展示」的区块：检索面板、命令条、画板区、面包屑、页脚、空状态、筛选抽屉。 */
const BLOCKED = '.search-panel,#local-toolbar,.library-heading,.discovery-controls,.bd-deck,.bd-crumb,.gallery-footer,#empty,#selection-bar,.filter-drawer,.filter-rows,#sidebar,.sidebar,dialog,#downloads-view,#canvas-view';

/** 从 grid 往上找真正在滚的那个容器；找不到就退回文档滚动元素。 */
function scrollParent(node) {
  const doc = node?.ownerDocument || document;
  for (let el = node?.parentElement; el && el !== doc.body; el = el.parentElement) {
    if (!el.isConnected) continue;
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2) return el;
  }
  return doc.scrollingElement || doc.documentElement;
}

export function createRangeSelect({grid, state, renderGrid = () => {}}) {
  if (!grid || !state?.selected) return {setup() {}, onCheckboxChange() {}, syncSelection() {}};
  const doc = grid.ownerDocument || document;
  const win = doc.defaultView || window;
  /**
   * 起点范围 = 承载网格的那个滚动容器（资产区的外框），**不是** #library-view 的盒子。
   * 两者差的就是容器 padding 与滚动条留白那圈「边缘」：之前按 #library-view 判，
   * 右侧一条、底部一条全都是容器自己的区域，落点根本进不来，用户看到的就是
   * 「边缘没法框选」。页面整体滚动时退回 main / body。
   */
  const hostOf = () => {
    const scroller = scrollParent(grid);
    if (scroller && scroller !== doc.documentElement && scroller !== doc.body) return scroller;
    return grid.closest('main') || doc.body;
  };
  /**
   * 画布页（Artflow）是 iframe 装进来的，网格还留在 DOM 里只是 hidden。
   * 只要画布可见就彻底不接管 —— 否则虚线框会画到画布上，看起来像「画布里也能框选资产」。
   */
  const onCanvas = () => {
    const view = doc.getElementById('canvas-view');
    if (!view) return false;
    const hidden = view.hidden || view.hasAttribute('hidden') || view.offsetParent === null;
    return !hidden || doc.body?.dataset?.route === 'canvas';
  };

  let anchor = '';
  let pendingShift = false;
  let session = null;          // {x, y, additive, surface}
  let pointer = {x: 0, y: 0};  // 当前指针（自动滚动时指针不动，要靠它重算）
  let box = null;
  let dragging = false;
  let raf = 0;
  let suppressClick = false;
  // 卡片位置快照：拖动中卡片不会动，只有滚动会整体位移。几百上千张卡每帧都调
  // getBoundingClientRect 会明显掉帧，所以开始时量一次，之后按滚动差量平移。
  let snapshot = null;
  let snapScroll = 0;
  let snapCount = -1;

  const cards = () => [...grid.querySelectorAll('.model-card[data-uid]')];
  const uids = () => cards().map(card => card.dataset.uid).filter(Boolean);

  function cleanup() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    box?.remove();
    box = null;
    doc.body.classList.remove('rs-dragging');
    // 用 data 属性而不是 class：瀑布流的 MutationObserver 只盯 class 变化，
    // 框选时每帧给几十张卡切 class 会把整块网格重排一遍，卡片看起来在闪、还在互相挤位置。
    // 按属性反查而不是遍历 cards()：万一命中的节点在拖动中被替换/移除，残留的高亮也能清掉。
    for (const card of grid.querySelectorAll('[data-rs-hit]')) card.removeAttribute('data-rs-hit');
    snapshot = null;
    snapCount = -1;
    session = null;
    dragging = false;
  }

  /** 量一次卡片客户区坐标；卡片数量变了（续页加载）就重量。 */
  function ensureSnapshot() {
    if (snapshot && snapCount === grid.childElementCount) return;
    snapCount = grid.childElementCount;
    snapScroll = session?.surface?.scrollTop || 0;
    snapshot = [];
    for (const card of cards()) {
      const rect = card.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) snapshot.push({card, l: rect.left, t: rect.top, r: rect.right, b: rect.bottom});
    }
  }

  /** 按当前指针位置重画框、重算命中。框用 fixed 定位：不跟滚动容器/偏移父级纠缠。 */
  function paint() {
    if (!session) return;
    // 拖到一半切到画布：框不能留在画布上。
    if (onCanvas()) { cleanup(); return; }
    const left = Math.min(session.x, pointer.x);
    const top = Math.min(session.y, pointer.y);
    const right = Math.max(session.x, pointer.x);
    const bottom = Math.max(session.y, pointer.y);
    if (!box) {
      box = doc.createElement('div');
      box.className = 'rs-box';
      doc.body.appendChild(box);
      doc.body.classList.add('rs-dragging');
    }
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${right - left}px`;
    box.style.height = `${bottom - top}px`;
    ensureSnapshot();
    const shift = snapScroll - (session.surface?.scrollTop || 0);
    for (const entry of snapshot) {
      const hit = entry.l < right && entry.r > left && entry.t + shift < bottom && entry.b + shift > top;
      if (hit !== entry.card.hasAttribute('data-rs-hit')) entry.card.toggleAttribute('data-rs-hit', hit);
    }
  }

  /** 松手后只改选中态，不重画网格。
   *  renderGrid 会按新的 selected 重新生成卡片 HTML 并 outerHTML 整张替换 —— 图片要重新解码，
   * 瀑布流下一量高度就变，卡片就会「闪一下 / 位移」。框选是纯视觉动作，就地改 class 就够。 */
  function applySelectionUI() {
    const selected = state.selected;
    for (const card of cards()) {
      const on = selected.has(card.dataset.uid);
      if (card.classList.contains('selected') !== on) card.classList.toggle('selected', on);
      const box = card.querySelector('input[data-select]');
      if (box && box.checked !== on) box.checked = on;
    }
    const count = doc.querySelector('#selected-count');
    if (count) count.textContent = selected.size;
    const bar = doc.querySelector('#selection-bar');
    if (bar) bar.hidden = !selected.size || state.route === 'downloads';
  }

  /** 指针停在上下边缘时让资产区自己滚，滚完重算命中（否则长列表框选永远只能框到一屏）。 */
  function autoScroll() {
    raf = 0;
    if (!dragging || !session) return;
    if (onCanvas()) { cleanup(); return; }
    const surface = session.surface;
    const rect = !surface || surface === doc.scrollingElement || surface === doc.documentElement
      ? {top: 0, bottom: win.innerHeight}
      : surface.getBoundingClientRect();
    let speed = 0;
    if (pointer.y < rect.top + EDGE) speed = -MAX_SPEED * Math.min(1, (rect.top + EDGE - pointer.y) / EDGE);
    else if (pointer.y > rect.bottom - EDGE) speed = MAX_SPEED * Math.min(1, (pointer.y - (rect.bottom - EDGE)) / EDGE);
    if (speed && surface) {
      const before = surface.scrollTop;
      surface.scrollTop = before + speed;
      if (surface.scrollTop !== before) paint();
    }
    raf = requestAnimationFrame(autoScroll);
  }

  /** 接管 click：吞掉框选结束那一下点击，同时记录 Shift（change 事件本身不带 shiftKey）。 */
  function onClick(event) {
    if (suppressClick) {
      suppressClick = false;
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    const checkbox = event.target?.closest?.('[data-select]');
    pendingShift = !!checkbox && event.shiftKey;
  }

  /** 普通点击原语义，Shift 点第二张卡时把 anchor→当前整段选中。 */
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
        applySelectionUI();
        return;
      }
    }
    anchor = uid;
    if (target.checked) state.selected.add(uid); else state.selected.delete(uid);
    applySelectionUI();
  }

  /** 松手：提交命中集合。win / doc 两处都会调到，靠 session 判空做到幂等。 */
  function finish() {
    if (!session) return;
    const wasDragging = dragging;
    if (wasDragging) {
      const hit = [...grid.querySelectorAll('[data-rs-hit]')];
      if (!session.additive) state.selected.clear();
      for (const card of hit) if (card.dataset.uid) state.selected.add(card.dataset.uid);
      suppressClick = true;
      // 拖到资产区外松手时不会派发 click，别让抑制标记留到下一次点击。
      setTimeout(() => { suppressClick = false; }, 0);
    }
    cleanup();
    if (wasDragging) applySelectionUI();
  }

  function setup() {
    doc.addEventListener('click', onClick, true);

    doc.addEventListener('pointerdown', event => {
      suppressClick = false;
      if (session || event.button !== 0) return;
      const target = event.target;
      if (!target?.closest) return;
      // 卡片上按住 = 拖卡片（拖出到软件 / 打开画板），不抢。
      if (target.closest(CARD)) return;
      // 真控件、命令条、画板区、页脚、抽屉：都不是框选的地盘。
      if (target.closest(CONTROL) || target.closest(BLOCKED)) return;
      // 画布页（iframe）里一律不接管。
      if (onCanvas()) return;
      // 起点必须落在资产区外框里。容器 padding / 滚动条留白那圈，落点可能直接是
      // body 或别的顶层元素，contains 判不出来，所以再用坐标兜一层。
      const host = hostOf();
      if (host && !host.contains(target)) {
        const rect = host.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) return;
      }
      session = {
        x: event.clientX,
        y: event.clientY,
        additive: event.ctrlKey || event.metaKey || event.shiftKey,
        surface: scrollParent(grid),
      };
      pointer = {x: event.clientX, y: event.clientY};
    }, true);

    win.addEventListener('pointermove', event => {
      if (!session) return;
      pointer = {x: event.clientX, y: event.clientY};
      if (!dragging) {
        if (Math.abs(pointer.x - session.x) < THRESHOLD && Math.abs(pointer.y - session.y) < THRESHOLD) return;
        dragging = true;
        if (!raf) raf = requestAnimationFrame(autoScroll);
      }
      paint();
    });

    win.addEventListener('pointerup', finish);
    // 指针进到 iframe（画布就是这么装的）或移出窗口时，父文档收不到 window 上的
    // pointerup，图标会留在屏幕上 —— 这也会被看成「画布里触发了框选」。这里补两层：
    // 文档级 pointerup 捕获兜住被 stopPropagation 吞掉的情况，pointerout 的
    // relatedTarget 为空说明指针已经离开本文档，直接收掉。
    doc.addEventListener('pointerup', finish, true);
    doc.addEventListener('pointerout', event => { if (session && !event.relatedTarget) cleanup(); }, true);

    win.addEventListener('pointercancel', () => { if (session) cleanup(); });
    // Esc 放弃这次框选，已入库的选择不动。
    win.addEventListener('keydown', event => { if (session && event.key === 'Escape') cleanup(); });
    // 切视图 / 滚出可视区时别把框和会话留在那儿。
    win.addEventListener('blur', () => { if (session) cleanup(); });
    doc.addEventListener('visibilitychange', () => { if (doc.hidden && session) cleanup(); });
    win.addEventListener('pagehide', () => { if (session) cleanup(); });
    // 路由切到画布/下载页：网格虽然还在 DOM 里但已隐藏，框必须立刻消失。
    new MutationObserver(() => { if (session && onCanvas()) cleanup(); })
      .observe(doc.body, {attributes: true, attributeFilter: ['data-route']});
  }

  return {setup, onCheckboxChange, syncSelection: applySelectionUI};
}
