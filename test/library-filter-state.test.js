// 图标条统一筛选状态：快照归一化、单击/Shift 语义、payload 只发有效字段、chips、持久化。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTER_SNAPSHOT_KEY, EMPTY_FILTERS, normalizeFilterState, toggleFilterValue,
  filtersToPayload, hasActiveFilters, activeFilterChips, clearedDimension, createFilterState,
} from '../src/library/filter-state.js';

const memory = () => {
  const map = new Map();
  return {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map};
};

test('空状态与坏存档：未知字段丢弃、类型钳制、相似度范围', () => {
  assert.deepEqual(normalizeFilterState({}), {...EMPTY_FILTERS});
  const cleaned = normalizeFilterState({tags: ['石头', '石头', ''], ratings: [9, 3, 'x'],
    favoriteMode: 'nope', sort: 'nope', sortOrder: 'sideways', colorSimilarity: 999,
    ranges: [{field: 'aspect', min: '1.0', max: ''}, {field: 'bad', min: 1}], unknown: 1});
  assert.deepEqual(cleaned.tags, ['石头']);
  assert.deepEqual(cleaned.ratings, [3]);
  assert.equal(cleaned.favoriteMode, 'any');
  assert.equal(cleaned.sort, 'recent');
  assert.equal(cleaned.sortOrder, 'asc');
  assert.equal(cleaned.colorSimilarity, 100);
  assert.deepEqual(cleaned.ranges, [{id: 'aspect:1:', field: 'aspect', min: 1, max: null}]);
  assert.equal(cleaned.unknown, undefined);
});

test('单击替换 / 再点清空 / Shift 累加，范围按 id 去重', () => {
  assert.deepEqual(toggleFilterValue([], 'blue'), ['blue']);
  assert.deepEqual(toggleFilterValue(['blue'], 'blue'), []);
  assert.deepEqual(toggleFilterValue(['blue'], 'red', true), ['blue', 'red']);
  const store = createFilterState({storage: null, restore: false});
  const range = {id: 'aspect:16:9', field: 'aspect', min: 1.68, max: 1.87};
  store.setRange(range);
  assert.equal(store.get().ranges.length, 1);
  store.setRange(range, true);
  assert.equal(store.get().ranges.length, 0, '再按 Shift 点同一个应移除');
});

test('payload 只发真正生效的字段；空筛选不触发查询', () => {
  assert.deepEqual(filtersToPayload(EMPTY_FILTERS),
    {tags: [], excludeTags: [], kinds: [], categories: [], platforms: [], ratings: [], ranges: []});
  const payload = filtersToPayload({colors: ['red'], colorSimilarity: 40, excludeColors: true,
    favoriteMode: 'no', ratings: [5], excludeRating: true, ranges: [{field: 'aspect', min: 1, max: null}],
    tags: ['石头'], kinds: ['models']});
  assert.equal(payload.colors[0], 'red');
  assert.equal(payload.colorSimilarity, 40);
  assert.equal(payload.excludeColors, true);
  assert.equal(payload.favoriteMode, 'no');
  assert.equal(payload.excludeRating, true);
  assert.equal(payload.excludeRanges, undefined, '没打开排除就不发');
  assert.equal(hasActiveFilters(EMPTY_FILTERS), false);
  assert.equal(hasActiveFilters({colors: ['red']}), true);
  assert.equal(hasActiveFilters(EMPTY_FILTERS, {q: 'stone'}), true);
});

test('激活 chips 与清一维：颜色 / 尺寸 / 排序各自独立', () => {
  const snapshot = {...EMPTY_FILTERS, colors: ['red'], ranges: [{field: 'aspect', min: 1.05, max: null}],
    tags: ['石头'], sort: 'name', q: 'stone', formats: ['png']};
  const ids = activeFilterChips(snapshot).map(item => item.id);
  assert.ok(ids.includes('color') && ids.includes('kinds') && ids.includes('sort')
    && ids.includes('format') && ids.includes('more') && ids.includes('tags'));
  assert.deepEqual(clearedDimension('color', snapshot).colors, []);
  assert.deepEqual(clearedDimension('kinds', snapshot).ranges, []);
  assert.equal(clearedDimension('sort', snapshot).sort, 'recent');
  assert.deepEqual(clearedDimension('tags', snapshot).tags, []);
});

test('持久化：写入 → 重新创建恢复；坏存档与只读存储都不炸', () => {
  const storage = memory();
  let changes = 0;
  const first = createFilterState({storage, onChange: () => { changes++; }});
  first.set({colors: ['blue'], sort: 'resolution', sortOrder: 'desc'});
  assert.equal(changes, 1);
  const saved = JSON.parse(storage.map.get(FILTER_SNAPSHOT_KEY));
  assert.equal(saved.version, 1);
  assert.equal(saved.filters.colors[0], 'blue');
  const second = createFilterState({storage});
  assert.equal(second.get().sort, 'resolution');
  assert.equal(second.toQueryOptions().sortOrder, 'desc');
  second.clear({silent: true});
  assert.equal(second.get().sort, 'recent');
  assert.equal(changes, 1, 'silent 不通知');
  storage.map.set(FILTER_SNAPSHOT_KEY, '{bad');
  assert.equal(createFilterState({storage}).get().colors.length, 0);
  assert.doesNotThrow(() => createFilterState({storage: {setItem() { throw Error('quota'); }}}).set({tags: ['a']}));
});
