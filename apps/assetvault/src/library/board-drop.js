// board-drop.js —— 把资产卡拖到画板上，等于「加入这个画板」。
//
// 两条通道，按运行环境自动只有一条真正生效：
//   · 网页版：拖拽是 HTML5 drag，dragstart 时把 uid 写进 dataTransfer。
//   · 桌面版：drag-out.js 会用原生 DoDragDrop 接管拖拽（拖出到 Blender / 资源管理器），
//     一旦系统拖放开始，WebView 就收不到 pointermove 了，落点根本判不出来。所以这一侧
//     窗口内普通拖动交给画板，接近窗口边缘交给原生拖出；Alt 可直接使用原生拖放。
//
// 落点有两处：
//   · 顶部浮出的「拖到画板」条（固定定位，跟着屏幕上沿，滚到哪都够得着）；
//   · 资产库里的画板卡（.bd-card），在可见范围内依然可以直接拖上去。
// 智能画板按规则取内容，不接收手拖进来的成员，因此只作展示、不作落点。
const CARD = '.model-card[data-uid],.local-file-card[data-uid],.model-card[data-package],.local-file-card[data-file],.model-card[data-card-group]';
const BOARD = '.bd-card[data-bd-open]';
const CHIP = '.bd-drop-chip';
const TARGET = `${CHIP},${BOARD}`;
const MIME = 'application/x-av-uid';
const THRESHOLD = 5;
const MAX_CHIPS = 12;

export function createBoardDrop({api, toast, selected = () => new Set(), onAdded = () => {},
  boards = () => [], albumKey = () => null, onAlbumDrop, cardDrop, doc = document, win = window} = {}) {
  if (!api || typeof api.boardItems !== 'function') return {setup() {}, cancel() {}};

  let session = null;    // {x, y, x0, y0, uids, active}
  let hovered = null;    // 当前高亮的落点
  let dock = null;
  let ghost = null;
  let dragCard = null;   // HTML5 通道的当前落点
  let hinted = false;    // 「拖到顶部画板条」这句提示只教一次
  let suppressClickUntil = 0;

  const uidsFor = uid => {
    const set = selected();
    return set?.has?.(uid) ? [...set] : [uid];
  };
  const cardUids=card=>{const key=albumKey(card);return key&&onAlbumDrop?['album:'+encodeURIComponent(key)]:card.dataset.uid?uidsFor(card.dataset.uid):[];};
  const hit = (x, y) => {
    const target=doc.elementFromPoint?.(x,y);
    const board=target?.closest?.(TARGET);
    if(board&&session?.uids?.length)return board;
    const card=target?.closest?.(`${CARD},.album-folder-card`);
    return cardDrop?.canDrop(session?.source,card)?card:null;
  };
  const droppable = node => !!node && !node.classList.contains('is-smart') && !node.classList.contains('is-off');
  const idOf = node => node?.dataset?.bdChip || node?.dataset?.bdOpen || '';
  const nameOf = node => {
    if (!node) return '画板';
    if (node.dataset?.bdChip) return node.dataset.bdName || node.textContent.trim() || '画板';
    return node.querySelector('.bd-card-foot strong')?.textContent?.trim() || '画板';
  };

  /* ── 顶部落点条 ─────────────────────────────────────────────────────────── */

  function buildDock() {
    if (dock) return dock;
    dock = doc.createElement('div');
    dock.className = 'bd-drop-dock';
    dock.hidden = true;
    const head = doc.createElement('span');
    head.className = 'bd-drop-head';
    head.textContent = '拖到画板';
    const list = doc.createElement('div');
    list.className = 'bd-drop-list';
    dock.append(head, list);
    doc.body.append(dock);
    return dock;
  }

  function paintDock(rows) {
    const list = buildDock().querySelector('.bd-drop-list');
    list.textContent = '';
    if (!rows.length) {
      const empty = doc.createElement('span');
      empty.className = 'bd-drop-empty';
      empty.textContent = '还没有画板 —— 点上方「画板」新建一块';
      list.append(empty);
      return;
    }
    for (const row of rows.slice(0, MAX_CHIPS)) {
      const chip = doc.createElement('span');
      chip.className = `bd-drop-chip${row.smart ? ' is-off' : ''}`;
      chip.dataset.bdChip = row.id;
      chip.dataset.bdName = row.name || '画板';
      chip.textContent = row.name || '画板';
      chip.title = row.smart
        ? '智能画板按规则自动收集，不接收手拖'
        : `${row.name || '画板'}${row.assetCount != null ? ` · ${row.assetCount} 个资产` : ''}`;
      list.append(chip);
    }
  }

  /** 画板太多时截断：一屏塞不下的落点等于没有落点。 */
  async function openDock() {
    const rows = (boards() || []).filter(row => row?.id);
    paintDock(rows);
    buildDock().hidden = false;
    if (rows.length) return;
    // store 还没加载过（刚启动就拖）：问一次接口，别让落点条是空的。
    try {
      const data = await api.listBoards?.();
      const extra = (data?.collections || []).filter(row => row?.id)
        .map(row => ({id: row.id, name: row.name, smart: !!row.smart, assetCount: row.assetCount}));
      if (extra.length && session) paintDock(extra);
    } catch { /* 接口没起来：保持「还没有画板」提示，用户至少知道原因 */ }
  }

  function closeDock() {
    if (dock) dock.hidden = true;
  }

  /* ── 跟着指针的小标签：让人确信「确实拖起来了」 ─────────────────────────── */

  function moveGhost(x, y, count) {
    if (!ghost) {
      ghost = doc.createElement('div');
      ghost.className = 'bd-drop-ghost';
      ghost.hidden = true;
      doc.body.append(ghost);
    }
    ghost.hidden = false;
    ghost.textContent = hovered&&!idOf(hovered)&&session?.source ? cardDrop.label(session.source,hovered) : count > 1 ? `${count} 个资产` : '拖到卡片合并 / 拖到画板加入';
    ghost.style.transform = `translate(${x + 14}px,${y + 12}px)`;
  }

  function hideGhost() { if (ghost) ghost.hidden = true; }

  /* ── 命中与高亮 ─────────────────────────────────────────────────────────── */

  function mark(node) {
    if (node === hovered) return;
    // 两种落点各用一套高亮类，清旧的时两个都摘掉，省得记错上一次是什么。
    hovered?.classList.remove('is-over', 'bd-card--drop','card-group-drop');
    if (node) node.classList.add(node.dataset?.bdChip ? 'is-over' : idOf(node)?'bd-card--drop':'card-group-drop');
    hovered = node;
  }

  async function addToBoard(node, uids) {
    const id = idOf(node);
    if (!id || !uids?.length) return;
    const name = nameOf(node);
    try {
      if(uids.length===1&&uids[0].startsWith('album:')&&onAlbumDrop){await onAlbumDrop(decodeURIComponent(uids[0].slice(6)),id);onAdded?.(id);return;}
      await api.boardItems(id, uids, 'add');
      toast?.(uids.length > 1 ? `已把 ${uids.length} 个资产加入「${name}」` : `已加入「${name}」`);
      onAdded?.(id);
    } catch (error) {
      toast?.(`加入画板失败：${error?.message || error}`);
    }
  }

  /* ── 会话 ───────────────────────────────────────────────────────────────── */

  function cleanup() {
    session = null;
    mark(null);
    hideGhost();
    closeDock();
    doc.body.classList.remove('bd-drop-active');
  }

  function setup() {
    /** 普通拖动加入画板；Alt 保留给原生拖出。 */
    doc.addEventListener('pointerdown', event => {
      if (session || event.button !== 0 || event.altKey) return;
      const target = event.target;
      const card = target?.closest?.(CARD);
      if (!card) return;
      if (target.closest?.('button:not(.preview-hit),a,input,select,textarea,label')) return;
      const uids = cardUids(card);
      const source=cardDrop?.source(card);
      if (!uids.length&&!source) return;
      doc.body.classList.add('bd-drop-active');
      session = {kind: 'pointer', source, x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, uids, active: false};
    }, true);

    win.addEventListener('pointermove', event => {
      if (!session || session.kind !== 'pointer') return;
      if ((event.buttons & 1) === 0 || event.altKey || event.clientX<=8 || event.clientY<=8 || event.clientX>=win.innerWidth-8 || event.clientY>=win.innerHeight-8) { cleanup(); return; }
      session.x = event.clientX;
      session.y = event.clientY;
      if (!session.active) {
        if (Math.abs(session.x - session.x0) < THRESHOLD && Math.abs(session.y - session.y0) < THRESHOLD) return;
        session.active = true;
        suppressClickUntil=Date.now()+1000;
        void openDock();
      }
      mark(hit(session.x, session.y));
      moveGhost(session.x, session.y, session.uids.length);
      event.preventDefault();
    }, true);

    win.addEventListener('pointerup', event => {
      if (!session || session.kind !== 'pointer') return;
      const node = session.active ? hit(event.clientX, event.clientY) : null;
      const uids = session.uids;
      const source=session.source;
      const moved = session.active;
      if(moved)suppressClickUntil=Date.now()+500;
      cleanup();
      if(node&&!idOf(node)&&cardDrop?.canDrop(source,node)){void cardDrop.drop(source,node);return;}
      if (droppable(node)) { void addToBoard(node, uids); return; }
      if (node) { toast?.('智能画板按规则自动收集，不能手动加成员'); return; }
      // 拖着走了却没落在任何画板上：教一次「往哪儿松手」，别让人以为拖不动。
      if (moved && !hinted) {
        hinted = true;
        toast?.('把卡片拖到屏幕上沿的「拖到画板」条上，松手就加入');
      }
    }, true);

    win.addEventListener('keydown', event => { if (session && event.key === 'Escape') cleanup(); });
    win.addEventListener('blur', () => { if (session) cleanup(); });
    win.addEventListener('pointercancel', () => { if (session) cleanup(); });
    doc.addEventListener('click', event => {
      if (Date.now() > suppressClickUntil) return;
      suppressClickUntil=0;event.preventDefault();event.stopPropagation();
    },true);

    /* 网页版：把 uid 塞进 dragstart 的 dataTransfer（与 board-canvas 用同一个 MIME）。 */
    doc.addEventListener('dragstart', event => {
      const card = event.target?.closest?.(CARD);
      if (!card || !event.dataTransfer) return;
      try {
        const uids = cardUids(card),source=cardDrop?.source(card);if(!uids.length&&!source)return;
        event.dataTransfer.setData(MIME, uids.join(',')||'card-group');
        event.dataTransfer.setData('text/plain', uids.join(','));
        session = {kind: 'html5', source, uids, active: true, x: 0, y: 0, x0: 0, y0: 0};
        void openDock();
      } catch { /* 个别壳不让写 */ }
    }, true);

    doc.addEventListener('dragover', event => {
      const node = hit(event.clientX,event.clientY);
      if (!droppable(node)) return;
      const types = event.dataTransfer?.types;
      if (!types || !Array.from(types).includes(MIME)) return;
      event.preventDefault();
      try { event.dataTransfer.dropEffect = 'copy'; } catch { /* 忽略 */ }
      dragCard = node;
      mark(node);
    }, true);

    doc.addEventListener('dragleave', event => {
      if (dragCard && !dragCard.contains(event.relatedTarget)) { dragCard = null; mark(null); }
    }, true);

    doc.addEventListener('dragend', () => { dragCard = null; cleanup(); }, true);

    doc.addEventListener('drop', event => {
      const node = hit(event.clientX,event.clientY);
      if (!droppable(node)) return;
      const raw = event.dataTransfer?.getData(MIME) || '';
      if (!raw) return;
      event.preventDefault();
      const source=session?.source;
      dragCard = null;
      cleanup();
      if(node&&!idOf(node)&&cardDrop?.canDrop(source,node)){void cardDrop.drop(source,node);return;}
      void addToBoard(node, raw.split(',').filter(Boolean));
    }, true);
  }

  return {setup, cancel: cleanup};
}
