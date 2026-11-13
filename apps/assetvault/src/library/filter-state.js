// 图标条的统一筛选状态（单一事实源）。
//
// 之前 tags/kinds 在 dock、q/rating/sort 在高级检索 DOM、formats 在共享实例里三处分散，
// 新增颜色 / 数值 / 精确评分会变成第四第五份状态。这里收成一个可持久化快照：
//   - 面板只读写 store，不再直接摸控件；
//   - dock 把 store.toFilters() 塞进 advanced-query 的通用 extraFilters 缝；
//   - 排序调整同时同步 #avq-sort 下拉，让 dialog 与图标条显示同一份值。
//
// 不持久化 q（检索式由高级检索输入框持有），避免两份真值；其余筛选刷新页面后原样恢复。
import {colorFilterSummary, DEFAULT_COLOR_SIMILARITY} from './color-filter.js';
import {rangeDetail} from './numeric-filter.js';
import {sortLabel, kindLabel, localStatusLabel, localScopeLabel} from './filter-dimensions.js';

export const FILTER_SNAPSHOT_KEY = 'sfx-filter-snapshot-v1';

export const EMPTY_FILTERS = Object.freeze({
  tags: [], excludeTags: [], kinds: [], folders: [], categories: [], platforms: [],
  colors: [], colorSimilarity: DEFAULT_COLOR_SIMILARITY, colorSwatches: {}, excludeColors: false,
  ratings: [], excludeRating: false, favoriteMode: 'any',
  ranges: [], excludeRanges: false,
  sort: 'recent', sortOrder: 'asc', seed: '',
});

const ARRAY_FIELDS = ['tags', 'excludeTags', 'kinds', 'folders', 'categories', 'platforms', 'colors', 'ratings', 'ranges'];
const BOOLEAN_FIELDS = ['excludeColors', 'excludeRating', 'excludeRanges'];
const SORT_VALUES = ['recent', 'oldest', 'name', 'rating', 'popular', 'position', 'collection', 'random', 'color', 'resolution', 'size'];

const unique = values => [...new Set((Array.isArray(values) ? values : [])
  .map(item => String(item ?? '').trim()).filter(Boolean))].slice(0, 100);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** 坏存档 / 老版本存档一律按字段裁剪：未知字段直接丢掉，绝不让面板初始化失败。 */
export function normalizeFilterState(input = {}) {
  const data = object(input);
  const next = {...EMPTY_FILTERS};
  for (const field of ARRAY_FIELDS) {
    next[field] = field === 'ranges' ? normalizeRangesState(data[field])
      : field === 'ratings' ? unique(data[field]).map(Number).filter(value => value >= 0 && value <= 5)
        : unique(data[field]);
  }
  for (const field of BOOLEAN_FIELDS) next[field] = data[field] === true;
  const similarity = Number(data.colorSimilarity);
  next.colorSimilarity = Number.isFinite(similarity) ? Math.max(0, Math.min(100, Math.round(similarity))) : DEFAULT_COLOR_SIMILARITY;
  next.colorSwatches = Object.fromEntries(Object.entries(object(data.colorSwatches))
    .filter(([, value]) => /^#[0-9a-f]{6}$/i.test(String(value))).slice(0, 32));
  next.favoriteMode = ['any', 'yes', 'no'].includes(data.favoriteMode) ? data.favoriteMode : 'any';
  next.sort = SORT_VALUES.includes(data.sort) ? data.sort : 'recent';
  next.sortOrder = data.sortOrder === 'desc' ? 'desc' : 'asc';
  next.seed = String(data.seed || '');
  return next;
}

function normalizeRangesState(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 32).map(item => {
    const range = object(item);
    const min = range.min === '' || range.min === null || range.min === undefined ? null : Number(range.min);
    const max = range.max === '' || range.max === null || range.max === undefined ? null : Number(range.max);
    if (!['aspect', 'longEdge', 'width', 'height', 'duration'].includes(range.field)) return null;
    if (min !== null && !Number.isFinite(min)) return null;
    if (max !== null && !Number.isFinite(max)) return null;
    if (min === null && max === null) return null;
    return {id: String(range.id || `${range.field}:${min ?? ''}:${max ?? ''}`), field: range.field, min, max};
  }).filter(Boolean);
}

/** 单击替换 / 再点清空 / Shift 累加或移除 —— 与格式面板、Serpent 的点击语义一致。 */
export function toggleFilterValue(list, value, shiftKey = false) {
  const token = String(value ?? '').trim();
  if (!token) return Array.isArray(list) ? [...list] : [];
  const current = unique(list);
  const exists = current.includes(token);
  if (shiftKey) return exists ? current.filter(item => item !== token) : [...current, token];
  return exists && current.length === 1 ? [] : [token];
}

/** extraFilters 只放「真正生效」的字段：空数组 / false / 默认相似度都不发，避免无筛选也走查询。 */
export function filtersToPayload(data = {}) {
  const state = normalizeFilterState(data);
  const payload = {
    tags: state.tags, excludeTags: state.excludeTags, kinds: state.kinds,
    categories: state.categories, platforms: state.platforms,
    ratings: state.ratings, ranges: state.ranges,
  };
  if (state.favoriteMode !== 'any') payload.favoriteMode = state.favoriteMode;
  if (state.ratings.length && state.excludeRating) payload.excludeRating = true;
  if (state.ranges.length && state.excludeRanges) payload.excludeRanges = true;
  if (state.colors.length) {
    payload.colors = state.colors;
    payload.colorSimilarity = state.colorSimilarity;
    if (Object.keys(state.colorSwatches).length) payload.colorSwatches = state.colorSwatches;
    if (state.excludeColors) payload.excludeColors = true;
  }
  return payload;
}

export function hasActiveFilters(data = {}, extra = {}) {
  const state = normalizeFilterState(data);
  return state.tags.length > 0 || state.excludeTags.length > 0 || state.kinds.length > 0
    || state.folders.length > 0 || state.categories.length > 0 || state.platforms.length > 0
    || state.colors.length > 0 || state.ratings.length > 0 || state.ranges.length > 0
    || state.favoriteMode !== 'any' || state.sort !== 'recent' || state.sortOrder !== 'asc'
    || !!String(extra.q || '').trim() || !!extra.rating || !!extra.favorite
    || !!extra.activeCollection || !!(Array.isArray(extra.formats) && extra.formats.length)
    || !!extra.localKind || !!extra.localStatus
    || (!!extra.localScope && extra.localScope !== 'all');
}

/** 激活筛选 chips：一个维度一个 chip，点 × 单独清除；排序不产生 chip（与 Serpent 一致）。 */
export function activeFilterChips(snapshot = {}) {
  const state = normalizeFilterState(snapshot);
  const chips = [];
  const add = (id, label, detail) => chips.push({id, label, detail});
  if (String(snapshot.q || '').trim()) add('more', '检索式', String(snapshot.q).trim().slice(0, 24));
  if (state.tags.length) add('tags', '标签', state.tags.slice(0, 3).join('、'));
  if (state.excludeTags.length) add('tags', '排除标签', `−${state.excludeTags.slice(0, 3).join('、')}`);
  if (state.kinds.length) add('kinds', '资产类型', state.kinds.length > 1 ? `${state.kinds.length} 类` : state.kinds[0]);
  if (state.platforms.length) add('source', '来源', state.platforms.slice(0, 3).join('、'));
  if (state.categories.length) add('source', '分类', state.categories.slice(0, 3).join('、'));
  // 旧工具栏三个下拉现在只是隐藏状态载体：值有内容时同样出一个 chip，点 × 一并复位。
  // 标签是跨类型维度：选了标签就不再让「类型」参与，chip 也不出现（否则看起来像点了标签顺手开了类型筛）。
  if (snapshot.localKind && !state.tags.length && !state.excludeTags.length) add('kinds', '类型', kindLabel(snapshot.localKind));
  if (state.ratings.length) add('rating', state.excludeRating ? '排除评分' : '评分',
    state.ratings.map(value => value ? `${value}★` : '未评分').join(' ∨ '));
  if (state.favoriteMode !== 'any') add('favorite', '收藏', state.favoriteMode === 'yes' ? '只看收藏' : '只看未收藏');
  if (snapshot.localScope && snapshot.localScope !== 'all') add('favorite', '范围', localScopeLabel(snapshot.localScope));
  if (state.colors.length) add('color', state.excludeColors ? '排除颜色' : '颜色',
    colorFilterSummary(state.colors, state.colorSimilarity));
  if (state.ranges.length) add('kinds', state.excludeRanges ? '排除尺寸' : '尺寸 / 比例',
    `${state.ranges.slice(0, 2).map(rangeDetail).join(' ∨ ')}${state.ranges.length > 2 ? '…' : ''}`);
  if (Array.isArray(snapshot.formats) && snapshot.formats.length) add('format', '格式', snapshot.formats.slice(0, 3).join('、'));
  if (state.folders.length) add('folders', '目录', state.folders.slice(0, 2).join(' / ') + (state.folders.length > 2 ? ` +${state.folders.length - 2}` : ''));
  if (snapshot.localStatus) add('format', '文件', localStatusLabel(snapshot.localStatus));
  if (snapshot.activeCollection) add('more', '合集', '限定在合集内');
  if (state.sort !== 'recent') add('sort', '排序', `${sortLabel(state.sort)}${state.sortOrder === 'desc' ? ' ↓' : ''}`);
  return chips;
}

/** 清一维的字段映射；DOM 控件（q / rating / favorite / 格式）由 dock 额外复位。 */
export function clearedDimension(id, data = {}) {
  const state = normalizeFilterState(data);
  switch (id) {
    case 'color': return {...state, colors: [], excludeColors: false};
    case 'tags': return {...state, tags: [], excludeTags: []};
    case 'kinds': return {...state, kinds: [], ranges: [], excludeRanges: false};
    case 'source': return {...state, categories: [], platforms: []};
    case 'rating': return {...state, ratings: [], excludeRating: false};
    case 'favorite': return {...state, favoriteMode: 'any'};
    case 'folders': return {...state, folders: []};
    case 'more': return {...state};
    case 'sort': return {...state, sort: 'recent', sortOrder: 'asc', seed: ''};
    default: return state;
  }
}

export function createFilterState({storage = null, key = FILTER_SNAPSHOT_KEY, onChange = () => {}, restore = true} = {}) {
  let data = normalizeFilterState({});
  if (restore) {
    try {
      const saved = JSON.parse(storage?.getItem(key) || 'null');
      if (saved && typeof saved === 'object') data = normalizeFilterState(saved.version === 1 ? saved.filters : saved);
    } catch { /* 坏存档用空状态 */ }
  }
  const persist = () => {
    try { storage?.setItem(key, JSON.stringify({version: 1, filters: data})); } catch { /* 内存态照常用 */ }
  };
  const get = () => normalizeFilterState(data);
  const commit = (next, {silent = false, save = true} = {}) => {
    data = normalizeFilterState(next);
    if (save) persist();
    if (!silent) onChange(get(), data);
    return get();
  };
  return {
    get,
    set: (patch, options) => commit({...data, ...object(patch)}, options),
    toggle: (field, value, shiftKey) => commit({...data, [field]: toggleFilterValue(data[field], value, shiftKey)}),
    setRange: (range, shiftKey) => {
      const exists = data.ranges.some(item => item.id === range.id);
      const next = shiftKey ? (exists ? data.ranges.filter(item => item.id !== range.id) : [...data.ranges, range])
        : (exists && data.ranges.length === 1 ? [] : [range]);
      return commit({...data, ranges: next});
    },
    clearDimension: (id, options) => commit(clearedDimension(id, data), options),
    clear: options => commit({...EMPTY_FILTERS}, options),
    toFilters: () => filtersToPayload(data),
    toQueryOptions: () => ({sort: data.sort, sortOrder: data.sortOrder, seed: data.seed}),
    get key() { return key; },
  };
}
