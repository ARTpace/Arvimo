// 「来源 / 分类」维度：纯函数层的针对性回归，覆盖新增字段的整条状态链。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceRows, SOURCE_GROUPS, dimensionActive, FILTER_DIMENSIONS,
} from '../src/library/filter-dimensions.js';
import {
  normalizeFilterState, filtersToPayload, clearedDimension, activeFilterChips, hasActiveFilters,
} from '../src/library/filter-state.js';

test('sourceRows 同时吃字符串与数组字段，按频次倒序', () => {
  const models = [
    {platform: 'sketchfab', categories: ['architecture', 'stone']},
    {platform: 'sketchfab', categories: ['stone']},
    {platform: 'polyhaven', categories: 'nature'},
    {platform: '', categories: []},
  ];
  assert.deepEqual(sourceRows(models, 'platform'), [
    {key: 'sketchfab', count: 2}, {key: 'polyhaven', count: 1},
  ]);
  assert.deepEqual(sourceRows(models, 'categories'), [
    {key: 'stone', count: 2}, {key: 'architecture', count: 1}, {key: 'nature', count: 1},
  ]);
});

test('新字段进 extraFilters、激活态与 chips，且能整维清除', () => {
  const state = normalizeFilterState({platforms: ['sketchfab'], categories: ['architecture', 'architecture']});
  assert.deepEqual(state.platforms, ['sketchfab']);
  assert.deepEqual(state.categories, ['architecture']);
  const payload = filtersToPayload(state);
  assert.deepEqual(payload.platforms, ['sketchfab']);
  assert.deepEqual(payload.categories, ['architecture']);
  assert.equal(hasActiveFilters(state), true);
  assert.equal(dimensionActive('source', state), true);
  assert.deepEqual(activeFilterChips(state).filter(chip => chip.id === 'source').map(chip => chip.label),
    ['来源', '分类']);
  const cleared = clearedDimension('source', state);
  assert.deepEqual(cleared.platforms, []);
  assert.deepEqual(cleared.categories, []);
  assert.equal(dimensionActive('source', cleared), false);
});

test('坏存档与候选上限不撑爆面板', () => {
  assert.deepEqual(normalizeFilterState({platforms: 'not-an-array'}).platforms, []);
  assert.equal(FILTER_DIMENSIONS.some(item => item.id === 'source'), true);
  assert.equal(SOURCE_GROUPS.length, 2);
  const many = Array.from({length: 40}, (_, i) => ({platform: `p${i}`}));
  assert.equal(sourceRows(many, 'platform').length, 24);
});
