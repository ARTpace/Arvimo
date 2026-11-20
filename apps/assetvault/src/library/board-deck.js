import {boardPositions,animateBoardPositions} from './removal-motion.js';
// 画板卡片区：主网格上方的一排「画板卡」——大封面 + 一排小图 + 名称计数，
// 让画板 / 智能画板成为资产库里看得见、点得进的实体，而不是藏在侧栏列表里的一行字。
//
// 与 board-hub 的分工：hub 管装配（store / 规则对话框 / 选择器），这里只管「卡片怎么画、
// 点一下发生什么」。动作全部以回调传入，所以本模块不认识 advanced-query，也不认识路由。
import {BOARD_EVENTS} from './board-store.js';
import {thumbSrc} from './image-src.js';
import {createContextMenu} from './card-context-menu.js';

/** 进入 / 退出画板时由查询层广播；detail 为 {id,name,smart} 或 null。 */
export const BOARD_ACTIVE_EVENT = 'assetvault:board-active';

export function createBoardDeck({
  doc = globalThis.document, win = globalThis.window,
  esc = String, icon = () => '', toast, store, api,
  onOpen, onCanvas, onAll, onNew, onSmart, onRule, onRename, onDelete, onCollect,
} = {}) {
  const section = doc.querySelector('#board-deck');
  const host = doc.querySelector('#board-deck-grid');
  const countEl = doc.querySelector('#board-deck-count');
  const crumb = doc.querySelector('#board-crumb');
  if (!section || !host || !store || !api) {
    return {render() {}, setActive() {}, get active() { return null; }};
  }

  let previews = {};
  let previewKey = '';
  let inflight = false;
  let queued = null;
  let active = null;

  const thumbUrl = item => thumbSrc(item?.thumbnail,{card:true});
  // 底栏副行和资产卡的作者行等价：手动板报「N 个资产」，智能板说明内容是算出来的，
  // 否则一个「自动」孤零零挂在角上，读不出这块板到底装了多少东西。
  const metaText = row => {
    const total = previews[row.id]?.total;
    if (row.smart) return total === undefined ? '按规则自动更新' : `${total} 个资产 · 按规则自动更新`;
    return `${total ?? row.assetCount ?? 0} 个资产`;
  };

  function previewHtml(row) {
    const data = previews[row.id];
    const items = data?.items || [];
    const cover = items[0] ? thumbUrl(items[0]) : '';
    // 独立画板区使用三张大预览，跳过封面；固定槽位避免少量成员改变卡片高度。
    const strip = items.slice(1, 4);
    const cells = strip.length
      ? strip.map(item => `<span class="bd-card-thumb">${thumbUrl(item) ? `<img src="${esc(thumbUrl(item))}" alt="" loading="lazy" decoding="async">` : icon('cube')}</span>`).join('')
      : '<span class="bd-card-thumb is-empty"></span>'.repeat(3);
    return {
      cover: cover
        ? `<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">`
        : `<span class="bd-card-void">${icon('layers')}</span>`,
      strip: cells+(strip.length?'<span class="bd-card-thumb is-empty"></span>'.repeat(Math.max(0,3-strip.length)):''),
    };
  }

  function cardHtml(row) {
    const {cover, strip} = previewHtml(row);
    const name = esc(row.name);
    // 名称/数量压在大封面底部（横向渐变遮罩上），不再单独占一行 —— 省下一条 38px 的横条，
    // 卡片只剩「封面（含标题）+ 小图条」两段。小图条仍在最底下。
    return `<article class="bd-card${row.smart ? ' is-smart' : ''}" data-bd-open="${esc(row.id)}" tabindex="0" role="button" aria-label="打开画板 ${name}">
      <div class="bd-card-cover">${cover}<div class="bd-card-foot">
          <strong title="${esc([...row.path].join(' / '))}">${name}</strong>
          <span class="bd-card-meta">${esc(metaText(row))}</span>
        </div>${row.smart ? `<span class="bd-card-badge">${icon('zap')}智能</span>` : ''}</div>
      <div class="bd-card-strip">${strip}</div>
      ${!row.smart ? `<button type="button" class="bd-card-tool bd-card-canvas" data-bd-canvas="${esc(row.id)}" title="打开对应画布" aria-label="打开 ${name} 的画布">${icon('layers')}</button>` : ''}
      <span class="bd-card-tools">
        ${row.smart ? `<button type="button" class="bd-card-tool" data-bd-rule="${esc(row.id)}" title="编辑筛选规则" aria-label="编辑 ${name} 的筛选规则">${icon('sliders')}</button>` : ''}
        <button type="button" class="bd-card-tool" data-bd-rename="${esc(row.id)}" title="重命名 / 改封面" aria-label="重命名画板 ${name}">${icon('edit')}</button>
        <button type="button" class="bd-card-tool" data-bd-del="${esc(row.id)}" title="删除画板（卡片保留）" aria-label="删除画板 ${name}">${icon('trash')}</button>
      </span>
    </article>`;
  }

  let paintedHtml='';
  function paint() {
    const html=store.flat().map(cardHtml).join('');
    if(html===paintedHtml&&host.children.length)return;
    paintedHtml=html;
    const before=boardPositions(host);
    host.innerHTML = html;
    animateBoardPositions(host,before);
  }

  /** 预览只拉一次：签名（id + 成员数 + 智能位）没变就不重复请求。 */
  async function loadPreviews(boards) {
    const key = boards.map(row => `${row.id}:${row.assetCount}:${row.updatedAt||0}:${row.coverAssetId||''}:${row.smart ? 1 : 0}`).join('|');
    if (key === previewKey) return;
    // 拉取途中又变了（连续往几个画板里加资产），排一次重拉，别把最新一次变更丢掉。
    if (inflight) { queued = boards; return; }
    inflight = true;
    try {
      const data = await api.boardPreviews(boards.map(row => row.id), 6);
      previews = data?.previews && typeof data.previews === 'object' ? data.previews : {};
      previewKey = key;
      paint();
      renderCrumb();
    } catch {
      // 纯文件模式 / 老进程没有这条路由：卡片退化成封面占位，不打断列表。
      previewKey = '';
    } finally {
      inflight = false;
      const again = queued;
      queued = null;
      if (again) loadPreviews(again);
    }
  }

  function renderCrumb() {
    const route = doc.body?.dataset?.route || '';
    if (!crumb) return;
    crumb.hidden = !active || route !== 'library';
    if (crumb.hidden) return;
    const nameEl = crumb.querySelector('.bd-crumb-name');
    const metaEl = crumb.querySelector('.bd-crumb-meta');
    if (nameEl) nameEl.textContent = active.name || '画板';
    if (metaEl) {
      const total = previews[active.id]?.total;
      metaEl.textContent = active.smart ? '智能画板 · 按规则自动更新' : (total === undefined ? '' : `${total} 项`);
    }
    crumb.classList.toggle('is-smart', !!active.smart);
  }

  function render() {
    const route = doc.body?.dataset?.route || '';
    const boards = store.flat();
    // 只在「我的资产库」露脸：发现页 / 下载页的画板入口没有意义，进入画板后由面包屑接管。
    section.hidden = route !== 'library' || !!active || !boards.length;
    if (countEl) countEl.textContent = String(boards.length);
    host.hidden = !boards.length;
    if (!section.hidden) paint();
    renderCrumb();
    if (!section.hidden && boards.length) loadPreviews(boards);
  }

  function setActive(board) {
    active = board && board.id ? board : null;
    render();
  }

  host.addEventListener('click', event => {
    const canvas = event.target.closest?.('[data-bd-canvas]');
    if (canvas) return onCanvas?.(canvas.dataset.bdCanvas);
    const rule = event.target.closest?.('[data-bd-rule]');
    if (rule) return onRule?.(rule.dataset.bdRule);
    const rename = event.target.closest?.('[data-bd-rename]');
    if (rename) return onRename?.(rename.dataset.bdRename);
    const del = event.target.closest?.('[data-bd-del]');
    if (del) return onDelete?.(del.dataset.bdDel);
    const card = event.target.closest?.('[data-bd-open]');
    if (card) onOpen?.(card.dataset.bdOpen);
  });

  host.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest?.('[data-bd-open]');
    if (!card || event.target !== card) return;
    event.preventDefault();
    onOpen?.(card.dataset.bdOpen);
  });

  // 「新建 / 智能」「两颗按钮已经收进命令条上下拉菜单（#bd-quick），节点不在 section 里，
  // 所以按 id 从文档取，而不是从这个画板区里找。
  doc?.getElementById?.('board-deck-new')?.addEventListener('click', () => { closeQuick(); onNew?.(); });
  doc?.getElementById?.('board-deck-smart')?.addEventListener('click', () => { closeQuick(); onSmart?.(); });
  // 收集规则：原来命令条上那颗 ⚡ 键，按 2026-11-18 反馈收进这份菜单，命令条只剩一颗「画板」。
  doc?.getElementById?.('board-deck-collect')?.addEventListener('click', () => { closeQuick(); onCollect?.(); });
  // 命令条上的画板按钮：点开是一份两项的小菜单，点任意一项或点外面就收起。
  const quickBtn = doc?.getElementById?.('bd-quick-btn');
  const quickMenu = doc?.getElementById?.('bd-quick-menu');
  function closeQuick() {
    if (!quickMenu || quickMenu.hidden) return;
    quickMenu.hidden = true;
    quickBtn?.setAttribute('aria-expanded', 'false');
  }
  quickBtn?.addEventListener('click', event => {
    event.stopPropagation();
    if (!quickMenu) return;
    quickMenu.hidden = !quickMenu.hidden;
    quickBtn.setAttribute('aria-expanded', String(!quickMenu.hidden));
  });
  doc?.addEventListener?.('click', event => {
    if (!quickMenu || quickMenu.hidden) return;
    if (event.target.closest?.('#bd-quick')) return;
    closeQuick();
  });
  doc?.addEventListener?.('keydown', event => { if (event.key === 'Escape') closeQuick(); });
  crumb?.querySelector('[data-bd-back]')?.addEventListener('click', () => onAll?.());

  // 画板卡的右键菜单：与资产卡共用同一套菜单骨架（createContextMenu 的定位 / 关闭 / 方向键），
  // 条目直接调本模块已有的回调 —— 不另造一套动作，也不和卡片悬停上那几颗小按钮重复实现。
  createContextMenu({
    icon,
    notify: message => toast?.(message),
    targetOf: target => target.closest?.('[data-bd-open]'),
    buildItems: card => {
      const id = card.dataset.bdOpen;
      const row = store.flat().find(item => item.id === id);
      if (!row) return null;
      const total = previews[row.id]?.total;
      const items = [
        {label: '打开画板', icon: 'layers', run: () => onOpen?.(id)},
        {separator: true},
        {label: '重命名 / 改封面', icon: 'edit', run: () => onRename?.(id)},
      ];
      if (row.smart) items.push({label: '编辑筛选规则', icon: 'sliders', run: () => onRule?.(id)});
      items.push(
        {separator: true},
        {label: '新建画板', icon: 'plus', run: () => onNew?.()},
        {label: '新建智能画板', icon: 'zap', run: () => onSmart?.()},
        {separator: true},
        // 删除动作自己带 window.confirm，这里不再叠第二道确认。
        {label: '删除画板（卡片保留）', icon: 'trash', danger: true, run: () => onDelete?.(id)},
      );
      return {
        title: row.name,
        subtitle: `${total ?? row.assetCount ?? 0} 个资产${row.smart ? ' · 智能画板' : ''}`,
        items,
      };
    },
  });

  win?.addEventListener?.(BOARD_ACTIVE_EVENT, event => setActive(event.detail));  // 画板集合变了（新建 / 改名 / 采集跑完 / 从别处加入）就重画：单一事实源在 store。
  // 成员变了要先让预览失效 —— store 里的 assetCount 往往是旧值，签名不变就不会重拉，
  // 卡片会一直停在「加入之前」的样子，只有整页刷新才更新。
  win?.addEventListener?.(BOARD_EVENTS.changed, event => {
    if (event?.detail?.reason === 'items') previewKey = '';
    render();
  });
  win?.addEventListener?.(BOARD_EVENTS.collect, () => render());

  render();

  return {render, setActive, refresh: render, get active() { return active; }};
}
