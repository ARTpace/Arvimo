// 高级检索 / 合集面板（阶段 2 的前端入口）。
//
// 刻意不改 index.html，也不重写 library-view.js 的渲染链：面板自己建 DOM，
// 只把「全部命中 uid」写进 state.queryUids，由 app.js 的 filtered() 过滤现有卡片。
// 于是分页、缩略图、右键菜单、多选、拖拽导出全部沿用原逻辑，零回归风险。
// 阶段 4：检索结果改由服务端按页取数（library-page-fetch.js），大库不再一次拿全部命中 uid；
// 老进程没有 /assets 时自动退回阶段 2 的整量 /query，面板结构不用动。
import {createPagedQuery} from './library-page-fetch.js';
import {createFormatFilterState} from './format-filter.js';
import {sortLabel, kindLabel} from './filter-dimensions.js';
import {rangeDetail} from './numeric-filter.js';
import {askText, askChoice} from './ask-dialog.js';
const API = '/api/library';
const HEADERS = {'X-SFX-Local': '1', 'Content-Type': 'application/json'};

async function request(path, {method = 'GET', body} = {}) {
  const response = await fetch(`${API}${path}`, {
    method, headers: HEADERS, body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function createAdvancedQuery({$, state, renderGrid, toast, esc, icon, resetPaging, formatFilter}) {
  // 工具栏按钮与 dialog 弹窗已移除：检索式 / 合集 / 评分 / 收藏 / 排序 / 格式全部并入
  // 图标条（更多面板 + 各维度图标），不再给同一套能力挂两个入口。
  // 底层引擎保留：q/rating/sort/favorite 用「脱离文档的隐藏元素」承载，图标面板通过
  // controls 读写它们，不依赖任何可见的 dialog。
  const q = document.createElement('input'); q.type = 'search';
  const rating = document.createElement('select');
  const sort = document.createElement('select');
  const favorite = document.createElement('input'); favorite.type = 'checkbox';
  const result = document.createElement('div'); // 原 dialog 状态条，现隐藏承载，避免引用报错
  let timer = null, activeCollection = '', collections = [], lastUids = [];
  // 当前打开的画板（手动或智能）。画板卡片区 / 面包屑都靠它判断「现在在不在板内」，
  // 与 activeCollection 不是一回事：智能画板通过 smartCollectionId 保留服务端作用域，
  // 但仍然是「一块进了就要能退出来的画板」。
  let activeBoard = null;
  // 图标条（filter-dock.js）的四个接入缝：extraFilters 是通用扩展缝 —— 新增维度只往里塞
  // 一个后端 filters 白名单字段，不必回来改 payload()；两份格式 UI 共享同一个 fmt 实例。
  let extraFilters = {}, clearHook = null, dockFormatUI = null, formatSyncHook = null, boardDirtyHook = null;
  // 图标条新增的排序方向 / 随机种子走这条缝，不动 q/rating/favorite 这些既有控件。
  let queryOptions = {sort: 'recent', sortOrder: 'asc', seed: ''};

  const notify = error => toast(error?.message || '高级检索失败');
  const paged = createPagedQuery({request, state, onUpdate: info => applyPage(info), onError: error => legacyQuery(error)});
  // library-paging.js 的「加载更多」按钮通过这个缝转发，不必反向 import 面板。
  state.onRemoteMore = () => paged.more();
  // 协作接入缝：别人改了资产库（服务端广播过来）时重新取当前页。
  // 只重取用户已浏览的范围，避免切回资产库时分页缩回首页；不整库刷新。
  state.onRemoteRefresh = () => paged.refresh(payload());
  // 格式状态由 app.js 装配（面板与本地网格共用同一个实例）；单独测试时可退化成内存态。
  const fmt = formatFilter || createFormatFilterState({storage: null});
  // 格式 UI 由「文件」图标面板渲染（同一份 fmt 实例）；advanced-query 不再维护 dialog 副本。
  const syncFormat = () => { dockFormatUI?.refresh(); formatSyncHook?.(); };
  const onFormatChange = () => { debounce(); syncFormat(); };

  function payload() {
    const min = Number(rating.value) || 0;
    // 排序真值在 queryOptions（图标条的排序下拉），那个脱离文档的 select 只是历史载体：
    // 这里补一次回退，否则服务端排序永远是默认值，存进智能画板的规则也会丢掉排序。
    const sortValue = sort.value || queryOptions.sort || 'recent';
    return {
      ...(activeBoard?.smart ? {smartCollectionId:activeBoard.id} : {}),
      q: q.value.trim(),
      filters: {
        rating: min ? [min, 5] : [0, 5], favorite: favorite.checked, collection: activeCollection || undefined,
        ...fmt.filter(), ...extraFilters,
      },
      sort: sortValue,
      sortOrder: queryOptions.sortOrder,
      seed: queryOptions.seed,
    };
  }

  /** extraFilters 现在既有数组也有布尔 / 数值，别再一律当数组判空。 */
  const hasExtra = () => Object.values(extraFilters).some(value => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return false;
  });
  // 排序本身也是一个筛选维度：只改排序不能被判成「空筛选」，否则服务端排序永远不会跑。
  const isEmpty = () => !activeBoard?.smart && !q.value.trim() && !rating.value && !favorite.checked && !activeCollection
    && fmt.isEmpty() && !hasExtra() && (sort.value || queryOptions.sort || 'recent') === 'recent'
    && queryOptions.sortOrder === 'asc' && !queryOptions.seed;

  // ---- 智能画板规则 -------------------------------------------------------------
  // 规则就是服务端的 filters 协议本身（q / filters / sort），前端不另发明一套格式：
  // 存规则时把当前 payload 原样交给画板服务，重算时服务端用同一个 runQuery 跑，
  // 所以「筛选条上看到的」和「画板里装着的」永远是同一件事。
  const RULE_FIELD_LABELS = {
    kinds: '类型', tags: '标签', excludeTags: '排除标签', colors: '颜色', excludeColors: '排除颜色',
    ratings: '评分', rating: '评分', excludeRating: '排除评分', ranges: '尺寸', excludeRanges: '排除尺寸',
    formats: '格式', favorite: '收藏', localStatus: '文件状态',
  };

  /** 智能画板不该把「当前所在合集」也存进规则，否则一进板就锁死在那个旧合集里。 */
  function ruleFilters() {
    const filters = {...payload().filters};
    delete filters.collection;
    return filters;
  }

  /** rating:[0,5] / favorite:false / 空数组都是「没设置」，不能算成条件。 */
  function ruleMeaningful(field, value) {
    if (value === undefined || value === null || value === '' || value === false) return false;
    if (Array.isArray(value)) {
      if (!value.length) return false;
      if (field === 'rating' && Number(value[0]) === 0) return false;
      return true;
    }
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }

  function ruleRows(filters) {
    return Object.entries(filters || {})
      .filter(([field, value]) => ruleMeaningful(field, value))
      .map(([field, value]) => {
        let shown;
        if (field === 'kinds') shown = value.map(kindLabel).join('、');
        else if (field === 'ratings') shown = value.map(item => item ? `${item}★` : '未评分').join(' ∨ ');
        else if (field === 'rating') shown = `≥ ${value[0]} 星`;
        else if (field === 'ranges') shown = value.slice(0, 3).map(rangeDetail).join(' ∨ ');
        else if (Array.isArray(value)) shown = value.slice(0, 6).map(String).join('、');
        else shown = String(value);
        return {key: RULE_FIELD_LABELS[field] || field, value: shown};
      });
  }

  /** 把任意一条规则翻成人话；画板对话框左右两栏都是它渲染的，不各写一套标签。 */
  function describeRule(rule) {
    const rows = [];
    const qText = String(rule?.q || '').trim();
    if (qText) rows.push({key: '检索式', value: qText});
    rows.push(...ruleRows(rule?.filters));
    rows.push({key: '排序', value: `${sortLabel(rule?.sort || 'recent')}${rule?.sortOrder === 'desc' ? ' ↓' : ''}`});
    return rows;
  }

  /** 给画板规则对话框用的人话摘要：当前筛选条到底约束了什么。 */
  const ruleSummary = () => describeRule(currentRule());

  const ruleHasConditions = () => !!String(q.value || '').trim() || ruleRows(ruleFilters()).length > 0;

  /** 当前筛选 → 可直接 POST 给 /smart-collections 的规则体。 */
  function currentRule() {
    const input = payload();
    return {q: String(input.q || '').trim(), filters: ruleFilters(), sort: input.sort,
      sortOrder: input.sortOrder, seed: input.seed};
  }

  /** 整量模式（智能合集 / 老进程降级）：一次拿到全部命中 uid。 */
  function setUids(uids, label) {
    lastUids = uids;
    state.queryUids = new Set(uids);
    // 服务端返回的 uids 本身就是排好序的（含合集手动顺序），前端按它显示，
    // 不再靠 state.sort 二次排序 —— 阶段 2 留下的「合集排序看不出来」由此解决。
    state.queryOrder = uids;
    state.remotePaging = null;
    resetPaging?.();
    result.textContent = label || `命中 ${uids.length} 个资产 · 已应用到资产库`;
    renderGrid();
  }

  /** 按页模式：queryUids / queryOrder 已由 createPagedQuery 累积好，这里只更新提示并重绘。 */
  function applyPage({uids, total, loaded, hasMore, reset, engine, pushdown, reason}) {
    lastUids = uids;
    if (reset) resetPaging?.();
    const scope = activeCollection ? ' · 限定在合集内' : '';
    const tail = hasMore ? ' · 点「加载更多」继续' : ' · 已取完';
    // 5.6：下推状态必须可见。颜色（HSL 距离）是唯一仍会让整条查询退回全表求值的维度，
    // 用户选了它就该知道「这次是慢路径」，而不是以为资产库变卡了。
    const route = pushdown === false ? ` · 全表回退${reason ? `（${reason}）` : ''}` : ' · 索引下推';
    state.queryPushdown = pushdown !== false;
    result.textContent = `命中 ${total} 个资产 · 已取 ${loaded} 项${tail}${scope} · ${engine === 'sqlite' ? '索引引擎' : '内存引擎'}${route}`;
    renderGrid();
  }

  function clear(resetInputs = true) {
    clearTimeout(timer);
    paged.reset();
    state.queryUids = null;
    state.queryOrder = null;
    resetPaging?.();
    activeCollection = '';
    activeBoard = null;
    broadcastBoard();
    lastUids = [];
    extraFilters = {};
    queryOptions = {sort: 'recent', sortOrder: 'asc', seed: ''};
    clearHook?.();
    if (resetInputs) {
      q.value = ''; rating.value = ''; favorite.checked = false; sort.value = 'recent';
      fmt.clear(false);
      syncFormat();
      result.textContent = '未应用高级筛选';
    }
    renderGrid();
  }

  async function apply() {
    // 新条件必须替代在途旧请求；分页器用 generation 丢弃过期结果。
    // 排序是「即使没有其它筛选也要生效」的维度：提前同步到网格，别被 isEmpty() 短路掉
    // （图标条的排序面板只改排序，原来会被当成空筛选直接 clear）。
    if (['recent', 'name', 'rating', 'popular'].includes(sort.value)) state.sort = sort.value;
    if (isEmpty()) { clear(false); return; }
    const input = payload();
    await paged.first(input);
  }

  /** 只有「老进程确实没有新接口」才降级；真故障照常提示，别把错误吞掉。 */
  async function legacyQuery(error) {
    // 智能 scope 接口失败不能回退全库 /query，否则会越出画板。
    if (activeBoard?.smart || (error?.status !== 404 && error?.status !== 405)) { notify(error); return; }
    paged.reset();
    try {
      const input = payload();
      const data = await request('/query', {method: 'POST', body: input});
      if (['recent', 'name', 'rating', 'popular'].includes(input.sort)) state.sort = input.sort;
      // 服务端对 uid 列表有硬上限（5000 个）。命中更多时只回一部分，
      // 必须如实告诉用户「这不是全集」，否则他会以为库里只有这么多。
      const shown = (data.uids || []).length;
      const truncated = data.uidsComplete === false ? `，仅返回前 ${shown} 个` : '';
      setUids(data.uids || [], `命中 ${data.total} 个资产 · ${data.engine === 'sqlite' ? '索引引擎' : '内存引擎'}（整量模式${truncated}）`);
    } catch (fallbackError) { notify(fallbackError); }
  }

  const debounce = () => { clearTimeout(timer); timer = setTimeout(apply, 280); };

  // 合集列表由「更多」面板渲染（controls.listCollections / applyCollection），
  // 这里不再维护 dialog 内的副本。
  function renderCollections() {}

  async function refreshCollections() {
    try {
      const data = await request('/collections');
      collections = data.collections || [];
    } catch (error) {
      collections = [];
    }
    renderCollections();
  }

  async function openCollection(id, {force = false, refresh = false, board = null} = {}) {
    // 画板 / 合集列表以前只在弹窗打开时才拉；现在画板卡片区直接调它，
    // 没加载过就会「点了没反应」，所以这里先补一次。
    if (board?.id !== id && (refresh || !collections.length)) await refreshCollections();
    const item = board?.id === id ? board : collections.find(entry => entry.id === id);
    if (!item) return;
    // 再点一次当前画板 = 退出回到全部资产，和「选中态可取消」的直觉一致。
    if (!force && activeBoard?.id === item.id) { await clearCollection(); return; }
    if (item.smart) {
      paged.reset();
      activeCollection = '';
      activeBoard = {id:item.id, name:item.name, smart:true, assetCount:item.assetCount};
      const rule = item.smart && typeof item.smart === 'object' ? item.smart : item.rule || {};
      sort.value = rule.sort || 'recent';
      queryOptions = {sort:sort.value, sortOrder:rule.sortOrder || 'asc', seed:rule.seed ?? ''};
      broadcastBoard();
      await apply();
      return;
    }
    activeCollection = !force && activeCollection === id ? '' : id;
    activeBoard = activeCollection ? {id: item.id, name: item.name, smart: false, assetCount: item.assetCount} : null;
    // 打开手动画板时默认按画板里保存的顺序显示；用户仍可在排序下拉里换成别的。
    if (activeCollection && sort.value === 'recent') sort.value = 'collection';
    renderCollections();
    broadcastBoard();
    await apply();
  }

  function clearCollection() {
    paged.reset(); activeCollection = ''; activeBoard = null;
    broadcastBoard(); renderCollections(); return apply();
  }

  /** 画板进出只有这一个广播口：卡片区收起、面包屑出现都靠它，别处不各自猜状态。 */
  function broadcastBoard() {
    try {
      window.dispatchEvent(new CustomEvent('assetvault:board-active', {detail: activeBoard ? {...activeBoard} : null}));
    } catch { /* 非浏览器环境（单测）没有 CustomEvent，忽略即可 */ }
  }

  /** 新建手动画板。智能画板走画板模块的规则对话框（要命名 + 预览规则），不在这里分身。 */
  async function createBoard() {
    const name = await askText({title: '新建画板', message: '建好后把卡片拖进来，或右键「加入画板」', placeholder: '给画板起个名字', maxLength: 80});
    if (!name) return;
    try {
      await request('/collections', {method: 'POST', body: {name: name.trim()}});
      await refreshCollections();
      boardDirtyHook?.();
      toast(`已新建画板「${name.trim()}」，把卡片拖进来或右键「加入画板」`);
    } catch (error) { notify(error); }
  }

  async function addCurrent() {
    let id = activeCollection;
    if (!id) {
      const manual = collections.filter(item => !item.smart);
      if (!manual.length) { toast('请先在「更多」面板新建或选择一个合集'); return; }
      const choice = await askChoice({
        title: '加入哪个画板',
        message: `当前加载的 ${lastUids.length} 条结果加入哪个画板？`,
        choices: manual.map(item => ({label: item.name, value: item.id})),
      });
      if (!choice) return;
      id = choice;
    }
    if (!lastUids.length) { toast('当前没有命中结果可加入'); return; }
    try {
      const data = await request('/collections/items', {method: 'POST', body: {id, uids: lastUids, action: 'add'}});
      await refreshCollections();
      toast(`已把加载的 ${lastUids.length} 项加入合集，现有 ${data.count} 个资产`);
    } catch (error) { notify(error); }
  }

  async function reorderCurrent() {
    const id = activeCollection;
    if (!id) { toast('请先在「更多」面板选择一个手动合集'); return; }
    if (!lastUids.length) { toast('当前没有命中结果可重排'); return; }
    try {
      await request('/collections/items', {method: 'POST', body: {id, uids: lastUids, action: 'reorder'}});
      toast('已按当前显示顺序保存合集顺序');
      await apply();
    } catch (error) { notify(error); }
  }

  // showDialog 已移除：高级检索弹窗不再使用，所有能力在图标条内可达。
  // 原 dialog 内的按钮（关闭 / 应用 / 清除 / 新建 / 智能 / 加入 / 重排）已随弹窗移除，
  // 这些能力现在由图标条「更多」面板的合集行承载。仅保留与真实 DOM 控件相关的绑定。
  q.addEventListener('input', debounce);
  [rating, sort, favorite].forEach(element => element.addEventListener('change', apply));
  // 「重置本地筛选」不该把高级筛选偷偷留着：挂 addEventListener 而不是覆盖 onclick。
  $('#reset-local-filters')?.addEventListener('click', () => clear(true));

  // 图标条通过 controls 读写既有控件，不 import 具体实现；新增维度只需往 extraFilters 里塞字段。
  const controls = {
    q, rating, sort, favorite, formatFilter: fmt,
    apply, scheduleApply: debounce, clear: () => clear(true),
    setExtraFilters: next => { extraFilters = next && typeof next === 'object' ? next : {}; },
    setQueryOptions: next => { queryOptions = {...queryOptions, ...(next && typeof next === 'object' ? next : {})}; },
    getActiveCollection: () => activeCollection,
    getActiveBoard: () => (activeBoard ? {...activeBoard} : null),
    // 「更多」面板直接复用既有的合集能力，不再造第二套筛选预设存储。
    listCollections: () => collections.map(item => ({id: item.id, name: item.name, smart: !!item.smart, assetCount: item.assetCount})),
    refreshCollections,
    applyCollection: (id, options) => openCollection(id, options),
    createBoard: () => createBoard(),
    // 智能画板规则：查询层只负责「当前筛选长什么样」，存规则与重算由画板模块负责。
    currentRule: () => currentRule(),
    ruleSummary: () => ruleSummary(),
    ruleHasConditions: () => ruleHasConditions(),
    describeRule: rule => describeRule(rule),
    // 画板实体在别处新增 / 改名后，侧栏要跟着重拉一次；用钩子而不是在查询层 import 画板。
    setOnBoardDirty: hook => { boardDirtyHook = hook; },
    clearCollection,
    // 原 dialog 专属的两个合集管理动作，平移到「更多」面板的合集行。
    addToCollection: () => addCurrent(),
    reorderCollection: () => reorderCurrent(),
    onFormatChange,
    setDockFormatUI: ui => { dockFormatUI = ui; },
    registerClearHook: hook => { clearHook = hook; },
    setOnFormatSync: hook => { formatSyncHook = hook; },
  };
  return {clear: () => clear(true), more: () => paged.more(), controls};
}
