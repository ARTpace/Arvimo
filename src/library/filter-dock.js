// 常驻筛选图标条（Serpent 式维度入口）：图标 → 浮层面板 → 激活筛选 chips。
//
// 只做「壳 + 状态编排」：维度清单在 filter-dimensions.js、面板在 filter-panels*.js、
// 筛选状态与持久化在 filter-state.js、真正的检索/分页在 advanced-query.js。
// 壳通过 controls 暴露的缝把 store 快照塞进 extraFilters / queryOptions，不反向 import 实现。
import {icon} from './icon-set.js';
import {
  FILTER_DIMENSIONS, SORT_DIMENSION, ALL_DIMENSIONS, FILTER_DOCK_STORAGE_KEY,
  SORT_CHIPS, readDockState, writeDockState, dimensionActive,
} from './filter-dimensions.js';
import {createFilterPanelDrawer} from './filter-panel-drawer.js';
import {createFilterState, activeFilterChips, hasActiveFilters} from './filter-state.js';
import {loadTagRecency, saveTagRecency, withTagUsed, TAG_RECENCY_KEY} from './filter-recency.js';
import {PANEL_VISUALS, PANEL_TIPS, SORT_VISUALS,
  FILTER_SKINS, readSkin, writeSkin} from './filter-visuals.js';


const safeStorage = () => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }
};

export function createFilterDock({
  $, state, controls, esc = value => String(value), toast = () => {},
  storage = safeStorage(), key = FILTER_DOCK_STORAGE_KEY, probe = null, packages = null,
} = {}) {
  const toolbar = $('#local-toolbar');
  if (!toolbar || !controls) return {refresh() {}, close() {}, open() {}, store: null};

  const dock = document.createElement('div');
  dock.id = 'filter-dock';
  dock.className = 'fd-dock';
  dock.dataset.skin = readSkin(storage);
  dock.setAttribute('role', 'group');
  dock.setAttribute('aria-label', '筛选维度');
  // 命令条上只留一颗「筛选」键；九个维度不占主界面，进抽屉后沿左侧竖排。
  // 抽屉 = 维度轨道 + 当前维度面板 + 已选条件条，切换维度不用退出再进（2026-11-12 反馈「要点很多次」）。
  // 轨道按键不带各自的主题色：默认一律灰，只有「这一栏有筛选在生效」才亮成主题绿 + 光晕。
  dock.innerHTML = `
    <button type="button" class="tb-btn fd-expand" id="fd-expand" aria-expanded="false"
      aria-controls="fd-pop" aria-label="筛选" title="筛选：颜色 / 标签 / 类型 / 评分 / 收藏 / 格式 / 目录 / 来源 / 更多">
      ${icon('filter')}<span class="tb-label">筛选</span><b class="fd-expand-count" hidden></b></button>
    <div class="fd-sort" data-id="${esc(SORT_DIMENSION.id)}">
      <button type="button" class="fd-sort-trigger" aria-haspopup="listbox" aria-expanded="false"
        title="${esc(PANEL_TIPS.sort)}" aria-label="排序">
        ${icon(SORT_DIMENSION.icon)}<span class="fd-sort-label"></span></button>
      <div class="fd-sort-menu" role="listbox" hidden></div>
    </div>
    <div class="fd-pop" id="fd-pop" hidden></div>`;
  toolbar.prepend(dock);

  const pop = dock.querySelector('#fd-pop');
  const sortLabelNode = dock.querySelector('.fd-sort-label');
  const sortWrap = dock.querySelector('.fd-sort');
  const sortTrigger = dock.querySelector('.fd-sort-trigger');
  const sortMenu = dock.querySelector('.fd-sort-menu');
  // 排序从 dock 里搬到命令条顶层：dock 只留「筛选键 + 激活 chip」这一簇，
  // 排序与右侧的画板 / 视图调节自成另一簇，中间由 CSS 的 auto 外边距留白。
  sortWrap.remove();
  dock.querySelectorAll('.fd-sep').forEach(sep => sep.remove());
  dock.insertAdjacentElement('afterend', sortWrap);
  let sortMenuOpen = false;
  let openId = '', panel = null;

  // 抽屉的触发键。记住上次停在哪个维度：再点开还是那一栏，不用每次从第一栏点起。
  const expandBtn = dock.querySelector('#fd-expand');
  const expandBadge = dock.querySelector('.fd-expand-count');
  let lastDim = readDockState(storage, key).openId || 'color';
  function setDrawerOpen(open) {
    expandBtn.setAttribute('aria-expanded', String(Boolean(open)));
  }

  /** 排序下拉菜单：从 SORT_CHIPS 取全集，按 primary / secondary 分组，当前项打勾。
   *  底部一行「升序 / 降序」切换保留排序方向能力，但不占用主图标条空间。 */
  function buildSortMenu() {
    const current = controls.sort.value;
    const groups = {};
    for (const item of SORT_CHIPS) (groups[item.group] ||= []).push(item);
    const column = key => (groups[key] || []).map(item =>
      `<button type="button" class="fd-sort-item" role="option" data-value="${esc(item.value)}"
        aria-selected="${String(current === item.value)}" title="${esc(item.label)}">
        <span class="fd-sort-check">${current === item.value ? icon('check') : ''}</span>
        <span class="fd-sort-item-label">${esc(item.label)}</span></button>`).join('');
    const sep = '<span class="fd-sort-sep" role="separator" aria-hidden="true"></span>';
    const dir = store.get().sortOrder === 'desc' ? '降序' : '升序';
    sortMenu.innerHTML = column('primary') + sep + column('secondary') + sep
      + `<button type="button" class="fd-sort-dir" data-dir="toggle" title="切换升 / 降序">
          ${icon('chevron-up')}<span>${esc(dir)}</span></button>`;
  }

  function setSortMenu(force) {
    const next = force === undefined ? !sortMenuOpen : force;
    if (next === sortMenuOpen) return;
    sortMenuOpen = next;
    sortTrigger.setAttribute('aria-expanded', String(next));
    sortMenu.hidden = !next;
    if (next) { close(); buildSortMenu(); }
  }
  let recent = loadTagRecency(storage, TAG_RECENCY_KEY);
  const recency = {
    list: () => [...recent],
    used: name => { recent = withTagUsed(recent, name); saveTagRecency(storage, recent, TAG_RECENCY_KEY); },
  };

  const snapshot = () => ({
    ...store.get(),
    q: controls.q.value, rating: controls.rating.value, favorite: controls.favorite.checked,
    formats: controls.formatFilter.tokens(), sort: controls.sort.value,
    activeCollection: controls.getActiveCollection?.() || '',
    // 旧工具栏三个下拉：整合后视觉隐藏，只作状态载体；这里集中读一次，图标与 chip 都从这走。
    ...localSnapshot(),
  });

  /** 旧下拉的当前值（类型 / 文件状态 / 范围）。缺元素时给空值，别让工具栏初始化失败。 */
  function localSnapshot() {
    const read = id => document.querySelector(id);
    return {
      localKind: read('#local-kind')?.value || '',
      localStatus: read('#local-status')?.value || '',
      localScope: read('#local-feature')?.value || 'all',
    };
  }

  /** 写旧下拉并派发 change：app.js 里那套本地过滤逻辑保持原样，只是入口换成图标。 */
  function setLocal(selector, value) {
    const select = document.querySelector(selector);
    if (!select) return;
    const next = value === undefined ? '' : value;
    if (select.value === next) return;
    select.value = next;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }

  /** 标签筛选是否在起作用。标签是「跨类型」的维度：一旦选了标签，顶部模式带来的
   *  本地类型就不再参与过滤（用户 2026-11-11 反馈「标签筛选不该顺手把类型筛也带上」）。 */
  const tagsActive = () => {
    const data = store.get();
    return data.tags.length > 0 || data.excludeTags.length > 0;
  };

  /** store 变化 → 同步到高级检索的通用扩展缝 + 排序下拉，再触发一次查询。 */
  function sync() {
    const data = store.get();
    // 类型 chip 的真值仍是旧 #local-kind（单选，前端过滤），但它同时要进查询 payload：
    // 否则服务端规则（智能画板）看不到「类型」这个维度，存下来的规则会少一条。
    const extras = store.toFilters();
    const legacyKind = tagsActive() ? '' : localSnapshot().localKind;
    if (legacyKind) extras.kinds = [...new Set([...(extras.kinds || []), legacyKind])];
    controls.setExtraFilters?.(extras);
    controls.setQueryOptions?.(store.toQueryOptions());
    // 目录只对磁盘上扫出来的本地资产有意义（在线平台没有这层），不进查询 payload，
    // 直接摊到共享 state 上给 app.js 的 extraCards() 读。
    if (state) state.folders = data.folders.slice(0, 100);
    if (controls.sort.value !== data.sort) controls.sort.value = data.sort;
    // 工具栏那个全局 #sort 下拉仍要跟着显示，值域不重叠（如 collection）时跳过。
    const global = document.querySelector('#sort');
    if (global && [...global.options].some(option => option.value === data.sort)) global.value = data.sort;
    refresh();
  }

  const store = createFilterState({storage, onChange: () => { sync(); controls.scheduleApply(); }});

  function refresh() {
    const snap = snapshot();
    for (const button of pop.querySelectorAll('.fd-rail-btn')) {
      const id = button.dataset.id;
      button.classList.toggle('is-current', id === openId);
      // 该维度有筛选在生效：轨道上点一颗小圆点，扫一眼就知道哪几栏动过。
      button.classList.toggle('is-set', dimensionActive(id, snap));
      button.setAttribute('aria-selected', String(id === openId));
    }
    sortLabelNode.textContent = `${SORT_VISUALS[controls.sort.value]?.label || SORT_VISUALS.recent.label}`;
    sortTrigger.classList.toggle('is-active', dimensionActive('sort', snap));
    sortTrigger.setAttribute('aria-label', `排序：${SORT_VISUALS[controls.sort.value]?.label || '最近添加'}`);
    if (sortMenuOpen) buildSortMenu();
    // 已选条件只在抽屉里出现：命令条上不再摊一排小胶囊，避免筛完一屏标识。
    const chips = activeFilterChips(snap);
    const chipHost = pop.querySelector('.fd-active');
    if (chipHost) {
      chipHost.hidden = !chips.length;
      chipHost.innerHTML = chips.length
        ? chips.map(item => `<button type="button" class="fd-active-chip" data-dim="${esc(item.id)}"
            style="--fv-tone:${esc(PANEL_VISUALS[item.id]?.tone || '#C9F581')}"
            title="${esc(`${item.label}：${item.detail || ''} · 点击移除`)}">
            ${icon(PANEL_VISUALS[item.id]?.icon || 'filter')}<span>${esc(item.label)}</span><i>×</i></button>`).join('')
          + `<button type="button" class="fd-clear-all" title="清除全部">${icon('trash')}</button>`
        : '';
    }
    const badge = pop.querySelector('.fd-pop-badge');
    if (badge) badge.hidden = !openId || !dimensionActive(openId, snap);
    // 收起后看不出哪些维度在用，用触发键右上角的数字补上这个信息。
    const activeDims = FILTER_DIMENSIONS.filter(dim => dimensionActive(dim.id, snap)).length;
    expandBadge.hidden = !activeDims;
    expandBadge.textContent = String(activeDims);
    expandBtn.classList.toggle('is-active', activeDims > 0);
    // 抽屉关着时只剩一个数字，悬停给一句人话，省得点进去逐栏找哪个条件还挂着。
    expandBtn.title = activeDims
      ? `筛选（${activeDims} 项生效）：${chips.map(item => item.label).join(' / ')}`
      : '筛选：颜色 / 标签 / 类型 / 评分 / 收藏 / 格式 / 目录 / 来源 / 更多';
    panel?.refresh();
  }

  /** chip 单独清除：store 字段与几份仍留在 DOM 控件里的旧状态一起复位。 */
  function clearDimension(id) {
    store.clearDimension(id, {silent: true});
    switch (id) {
      case 'rating': controls.rating.value = ''; break;
      case 'favorite': controls.favorite.checked = false; setLocal('#local-feature', 'all'); break;
      case 'format': controls.formatFilter.clear(false); controls.onFormatChange?.(); setLocal('#local-status', ''); break;
      case 'kinds': setLocal('#local-kind', ''); break;
      case 'more': controls.q.value = ''; controls.clearCollection?.(); break;
      case 'sort': controls.sort.value = 'recent'; break;
      default: break;
    }
    sync();
    controls.scheduleApply();
  }

  function close() {
    if (!openId) return;
    openId = '';
    panel = null;
    setDrawerOpen(false);
    // 浮层销毁后别让 advanced-query 的同步链还握着已脱离文档的旧格式面板。
    controls.setDockFormatUI?.(null);
    pop.hidden = true;
    pop.innerHTML = '';
    delete pop.dataset.id;
    writeDockState(storage, '', key);
    refresh();
  }

  const ctx = {
    controls, state, esc, toast, store, storage, probe, recency,
    // 旧下拉的读写缝：面板只调这些，不直接摸 DOM id，换控件形态不用改面板。
    localKind: () => localSnapshot().localKind,
    tagsActive: () => tagsActive(),
    localStatus: () => localSnapshot().localStatus,
    localScope: () => localSnapshot().localScope,
    setLocalKind: value => {
      const current = localSnapshot().localKind;
      setLocal('#local-kind', current === value ? '' : value);
      refresh();
    },
    setLocalStatus: value => {
      const select = document.querySelector('#local-status');
      if (select?.disabled) { toast?.('下载服务未连接，文件状态暂不可用'); return; }
      const current = localSnapshot().localStatus;
      setLocal('#local-status', current === value ? '' : value);
      refresh();
    },
    setLocalScope: value => {
      setLocal('#local-feature', value || 'all');
      refresh();
    },
    scanProbe: async () => {
      if (!probe) return toast?.('封面探测未启用，请刷新页面后重试');
      await probe.scanAll();
      controls.scheduleApply();
      refresh();
    },
    stopProbe: () => probe?.stop(),
    // 目录维度的候选来自扫描结果（含零散文件），面板只做聚合，不认识业务。
    packages: () => (typeof packages === 'function' ? packages() : []),
    onFormatChange: () => controls.onFormatChange?.(),
    onSortChange: () => refresh(),
    // 智能画板：面板只管发一条“要新建了”的事件，规则对话框归画板模块，避免两处各写一套。
    onSmartBoardNew: () => { close(); window.dispatchEvent(new CustomEvent('assetvault:smart-board-new')); },
    onCollectionPick: () => close(),
  };

  const drawer = createFilterPanelDrawer({host: pop, ctx});

  /** 一键清全部：图标条的 store 与旧工具栏那套（类型 / 文件状态 / 范围 / 搜索词）一起复位。 */
  function clearEverything() {
    controls.clear?.();
    document.querySelector('#reset-local-filters')?.click();
    refresh();
  }

  function open(id) {
    const dim = ALL_DIMENSIONS.find(item => item.id === id);
    if (!dim) return;
    if (openId === id) return;
    openId = id;
    lastDim = id;
    setDrawerOpen(true);
    pop.dataset.id = id;
    pop.hidden = false;
    // 抽屉：左边一列维度，右边当前维度的面板，下面是「已选条件」条。
    // 换成抽屉是为了把「开筛选 → 找维度 → 再开面板」压成一次点击，筛选后的条件也不再摊在命令条上。
    panel = drawer.open(id);
    writeDockState(storage, id, key);
    refresh();
  }

  dock.addEventListener('click', event => {
    if (event.target.closest?.('.fd-pop-close')) return close();
    if (event.target.closest?.('.fd-pop-reset')) return clearDimension(openId);
    const chip = event.target.closest?.('.fd-active-chip');
    if (chip) return clearDimension(chip.dataset.dim);
    if (event.target.closest?.('.fd-clear-all')) return clearEverything();
    if (event.target.closest?.('.fd-expand')) { setSortMenu(false); return openId ? close() : open(lastDim); }
    const rail = event.target.closest?.('.fd-rail-btn');
    if (rail) return open(rail.dataset.id);
  });
  // 排序块上面被搬到了 dock 外面（命令条顶层），点击不会再冒泡到 dock —— 必须自己挂一份，
  // 否则触发键按下去毫无反应（2026-11-12 反馈「排序点不了了」）。
  sortWrap.addEventListener('click', event => {
    if (event.target.closest?.('.fd-sort-trigger')) return setSortMenu();
    const dirBtn = event.target.closest?.('.fd-sort-dir');
    if (dirBtn) { store.set({sortOrder: store.get().sortOrder === 'desc' ? 'asc' : 'desc'}); return; }
    const sortItem = event.target.closest?.('.fd-sort-item');
    if (sortItem) {
      store.set({sort: sortItem.dataset.value,
        ...(sortItem.dataset.value === 'random' ? {seed: String(Date.now())} : {})});
      setSortMenu(false);
    }
  });
  document.addEventListener('pointerdown', event => {
    if (openId && !dock.contains(event.target)) close();
    if (sortMenuOpen && !sortWrap.contains(event.target)) setSortMenu(false);
  });
  document.addEventListener('keydown', event => {
    // dialog 自己处理 ESC（关闭模态框），这里只收浮层，别抢。
    if (event.key === 'Escape') {
      if (sortMenuOpen) { setSortMenu(false); return; }
      if (openId && !controls.dialog?.open) close();
    }
  });
  // 旧下拉被别处改动（侧栏筛选树、路由切收藏、清除筛选）时，图标与 chip 要跟着变。
  for (const selector of ['#local-kind', '#local-status', '#local-feature', '#sort']) {
    document.querySelector(selector)?.addEventListener('change', () => {
      refresh();
      // 类型现在也进查询 payload（智能画板要能把它存成规则），改完得补一次查询。
      if (selector === '#local-kind') { sync(); controls.scheduleApply?.(); }
    });
  }

  // 卡片封面是同源代理图：加载完成就顺手采一次主色 / 尺寸，零额外请求、零新依赖。
  // 只写缓存不重绘，所以不会和 renderGrid 形成循环；写盘由 asset-probe.js 节流合并。
  if (probe) {
    const byUid = () => new Map((state.models || []).map(model => [model.uid, model]));
    document.addEventListener('load', event => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.matches?.('.thumbnail')) return;
      const card = img.closest?.('.model-card[data-uid]');
      const model = card && byUid().get(card.dataset.uid);
      if (model && !probe.has(model.uid)) probe.probeOne(model, img).catch(() => {});
    }, true);
    window.addEventListener('assetvault:probe-progress', refresh);
  }

  sync();
  controls.registerClearHook?.(() => { store.clear({silent: true}); refresh(); });
  controls.setOnFormatSync?.(refresh);
  const saved = readDockState(storage, key);
  // 排序不再走浮层面板（已改为下拉菜单），恢复时跳过该 id，避免旧存档弹出空面板。
  if (saved.openId && saved.openId !== 'sort') open(saved.openId);
  // 刷新页面后恢复的筛选必须真的生效一次，不能只把 chip 画出来。
  if (hasActiveFilters(store.get(), {q: controls.q.value, rating: controls.rating.value,
    favorite: controls.favorite.checked, formats: controls.formatFilter.tokens(),
    activeCollection: controls.getActiveCollection?.() || '', ...localSnapshot()})) controls.scheduleApply();

  /** 皮肤热切换缝：入口不在工具栏里占位置，设置面板 / 插件可直接调用并持久化。 */
  const setSkin = skin => {
    if (!FILTER_SKINS.includes(skin)) return dock.dataset.skin;
    dock.dataset.skin = skin;
    writeSkin(storage, skin);
    return skin;
  };

  return {refresh, close, open, store, setSkin, tagsActive, get skin() { return dock.dataset.skin; },
    get openId() { return openId; }};
}
