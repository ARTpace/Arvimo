// 画板状态源：树扁平化、选中态、最近使用与持久化，单一事实源。
// 纯函数与副作用分离：flattenBoards / searchBoards / normalizePrefs 可直接单测，
// createBoardStore 才碰 storage 与 fetch，测试注入假实现即可。
export const BOARD_ACTIVE_KEY = 'sfx-active-board-v1';
export const BOARD_RECENTS_KEY = 'sfx-board-recents-v1';
export const BOARD_EVENTS = Object.freeze({
  changed: 'assetvault:board-changed',
  selected: 'assetvault:board-selected',
  collect: 'assetvault:collect-changed',
});

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const RECENT_LIMIT = 12;

/** 智能画板的规则：服务端只存这一份（q + filters + sort），前端别另造副本。 */
function normalizeRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const filters = input.filters && typeof input.filters === 'object' && !Array.isArray(input.filters)
    ? {...input.filters} : {};
  return {q: text(input.q).slice(0, 500), filters, sort: text(input.sort) || 'recent',
    sortOrder: input.sortOrder === 'desc' ? 'desc' : 'asc', seed: text(input.seed)};
}

export function normalizeBoard(input) {
  const row = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rule = normalizeRule(row.smart);
  return {
    id: text(row.id).trim(),
    parentId: text(row.parentId).trim() || null,
    name: text(row.name).trim() || '未命名画板',
    description: text(row.description),
    coverAssetId: text(row.coverAssetId) || null,
    icon: text(row.icon) || null,
    color: text(row.color) || null,
    position: Number.isFinite(Number(row.position)) ? Number(row.position) : 0,
    assetCount: Math.max(0, Number(row.assetCount) || 0),
    smart: !!row.smart,
    // rule 一直带在画板行上：侧栏点「规则」要立刻能读出当前条件，不必再发一次请求。
    rule,
  };
}

/**
 * 树扁平化：同级按 position / name 稳定排序，返回带 depth 与 path 的一维数组。
 * 坏数据（parentId 指向不存在、互相成环）一律降级为顶层，不让一次脏数据卡死整棵树。
 */
export function flattenBoards(input) {
  const rows = (Array.isArray(input) ? input : []).map(normalizeBoard).filter(row => row.id);
  const byId = new Map(rows.map(row => [row.id, row]));
  const children = new Map();
  for (const row of rows) {
    const parent = row.parentId && byId.has(row.parentId) && row.parentId !== row.id ? row.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  const sort = list => list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'zh'));
  const out = [];
  const walk = (parent, depth, path, seen) => {
    for (const row of sort([...(children.get(parent) || [])])) {
      if (seen.has(row.id)) continue;
      const next = new Set(seen);
      next.add(row.id);
      out.push({...row, depth, path: [...path, row.name]});
      walk(row.id, depth + 1, [...path, row.name], next);
    }
  };
  walk(null, 0, [], new Set());
  // 成环节点不在任何可达分支里：补到底层，保证「列表里看得到」而不是静默消失。
  for (const row of rows) if (!out.some(item => item.id === row.id)) out.push({...row, depth: 0, path: [row.name]});
  return out;
}

export function searchBoards(input, keyword = '') {
  const needle = text(keyword).trim().toLowerCase();
  const rows = Array.isArray(input) ? input : [];
  return needle ? rows.filter(row => `${row.name} ${row.path?.join(' ') || ''}`.toLowerCase().includes(needle)) : rows;
}

export function normalizePrefs(input) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    activeId: text(data.activeId).trim(),
    recents: (Array.isArray(data.recents) ? data.recents : []).map(text).filter(Boolean).slice(0, RECENT_LIMIT),
  };
}

export function readBoardPrefs(storage, keys = {active: BOARD_ACTIVE_KEY, recents: BOARD_RECENTS_KEY}) {
  const read = key => { try { return storage?.getItem(key) || ''; } catch { return ''; } };
  let recents = [];
  try { recents = JSON.parse(read(keys.recents) || '[]'); } catch { recents = []; }
  return normalizePrefs({activeId: read(keys.active), recents});
}

export function writeBoardPrefs(storage, prefs, keys = {active: BOARD_ACTIVE_KEY, recents: BOARD_RECENTS_KEY}) {
  const data = normalizePrefs(prefs);
  try {
    storage?.setItem(keys.active, data.activeId);
    storage?.setItem(keys.recents, JSON.stringify(data.recents));
  } catch { /* 只读存储退化成本次会话有效 */ }
  return data;
}

export function withRecent(recents, id, limit = RECENT_LIMIT) {
  return [text(id).trim(), ...(Array.isArray(recents) ? recents : []).map(text)]
    .filter((value, index, list) => value && list.indexOf(value) === index).slice(0, limit);
}

export function createBoardStore({api, storage, emit = () => {}} = {}) {
  if (!api) throw Error('画板状态源缺少 api');
  let boards = [];
  let prefs = readBoardPrefs(storage);
  let engine = '';

  const changed = reason => emit(BOARD_EVENTS.changed, {reason});
  const persist = () => { prefs = writeBoardPrefs(storage, prefs); };

  return {
    get engine() { return engine; },
    list: () => boards.map(row => ({...row})),
    flat: () => flattenBoards(boards),
    byId: id => boards.find(row => row.id === text(id).trim()) || null,
    get activeId() { return prefs.activeId; },
    active: () => boards.find(row => row.id === prefs.activeId) || null,
    recents: () => [...prefs.recents],

    async refresh() {
      const data = await api.listBoards();
      boards = (Array.isArray(data.collections) ? data.collections : []).map(normalizeBoard);
      engine = text(data.engine);
      if (prefs.activeId && !boards.some(row => row.id === prefs.activeId)) { prefs.activeId = ''; persist(); }
      changed('refresh');
      return boards;
    },
    setActive(id) {
      const key = text(id).trim();
      prefs = {...prefs, activeId: key, recents: key ? withRecent(prefs.recents, key) : prefs.recents};
      persist();
      emit(BOARD_EVENTS.selected, {id: key});
      return key;
    },
    use(id) {
      prefs = {...prefs, recents: withRecent(prefs.recents, id)};
      persist();
    },
    async create(payload) {
      const data = await api.saveBoard(payload);
      await this.refresh();
      return text(data.id);
    },
    /** 新建或更新智能画板规则：带 id 更新、不带新建，返回值统一成 id。 */
    async saveSmart(payload = {}) {
      const data = await api.saveSmartBoard(payload);
      await this.refresh();
      return text(data.id || payload.id);
    },
    async rename(id, patch) {
      const board = this.byId(id);
      if (!board) throw Error('画板不存在');
      await api.saveBoard({...board, ...patch, id: board.id});
      await this.refresh();
    },
    async remove(id) {
      await api.deleteBoard(id);
      if (prefs.activeId === id) prefs = {...prefs, activeId: ''};
      persist();
      await this.refresh();
    },
    async addItems(id, uids) {
      if (!id || !Array.isArray(uids) || !uids.length) return 0;
      await api.boardItems(id, uids, 'add');
      this.use(id);
      changed('items');
      return uids.length;
    },
    async removeItems(id, uids) {
      if (!id || !Array.isArray(uids) || !uids.length) return 0;
      await api.boardItems(id, uids, 'remove');
      changed('items');
      return uids.length;
    },
  };
}
