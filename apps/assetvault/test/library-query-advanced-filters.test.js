// 新增筛选语义的查询层回归：颜色 / 数值范围 / 精确评分 / 收藏三态 / 标签排除 / 排序方向 / 检索字段。
import test from 'node:test';
import assert from 'node:assert/strict';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';
import {rowsFromState, queryAssets, sortRows, SORTS, matchesFilters, normalizeFilters} from '../server/library-query.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
const state = {
  version: 2,
  models: [
    {uid: a, name: 'red wide', resolution: '2000x1000', tags: ['stone'], rating: 5},
    {uid: b, name: 'blue tall', resolution: '1000x2000', tags: ['stone', 'demo']},
    {uid: c, name: 'gray square', tags: ['wood']},
    {uid: d, name: 'no cover'},
  ],
  favorites: [a],
  userMeta: {[a]: {rating: 5, note: ''}, [c]: {rating: 3, note: ''}},
  assetProbe: {
    [a]: {v: 1, hex: '#E11D48', h: 348, s: 0.82, l: 0.5, width: 2000, height: 1000, at: 1},
    [b]: {v: 1, hex: '#3B82F6', h: 217, s: 0.83, l: 0.6, width: 1000, height: 2000, at: 1},
    [c]: {v: 1, hex: '#808080', h: 0, s: 0, l: 0.5, width: 900, height: 900, at: 1},
  },
};
const rows = rowsFromState({[MAIN_STATE_KEY]: JSON.stringify(state)});
const uids = (filters = {}, extra = {}) => queryAssets({rows, filters, ...extra}).uids;

test('probe 派生：封面缓存优先，平台 resolution 兜底，缺失为 null', () => {
  assert.equal(rows[0].probe.width, 2000);
  assert.equal(rows[2].probe.hex, '#808080');
  assert.equal(rows[3].probe, null);
  assert.equal(SORTS.length, 11);
  for (const sort of ['color', 'resolution', 'size', 'oldest', 'random']) assert.ok(SORTS.includes(sort));
});

test('颜色：包含 / 排除 / 相似度 / 无采样资产保留', () => {
  assert.deepEqual(uids({colors: ['red'], colorSimilarity: 70}), [a]);
  assert.deepEqual(uids({colors: ['blue'], colorSimilarity: 70}), [b]);
  const excluded = uids({colors: ['red'], colorSimilarity: 70, excludeColors: true});
  assert.ok(!excluded.includes(a));
  assert.ok(excluded.includes(d), '排除模式保留未采样资产');
  assert.deepEqual(uids({colors: ['red', 'blue'], colorSimilarity: 100}).sort(), [a, b].sort(), '多色 OR');
  assert.equal(uids({colors: []}).length, 4, '空筛选不影响结果');
});

test('数值范围：方向 / 宽高比 / 分辨率 / 跨字段 AND / 排除', () => {
  assert.deepEqual(uids({ranges: [{field: 'aspect', min: 1.05}]}), [a]);
  assert.deepEqual(uids({ranges: [{field: 'aspect', max: 0.95}]}), [b]);
  assert.deepEqual(uids({ranges: [{field: 'longEdge', min: 2000}]}).sort(), [a, b].sort());
  assert.deepEqual(uids({ranges: [{field: 'aspect', min: 1.05}, {field: 'longEdge', min: 3000}]}), []);
  assert.ok(uids({ranges: [{field: 'aspect', min: 1.05}], excludeRanges: true}).includes(d));
});

test('评分 / 收藏 / 标签排除与老字段共存', () => {
  assert.deepEqual(uids({ratings: [5]}), [a]);
  assert.deepEqual(uids({ratings: [0]}).sort(), [b, d].sort(), '0 = 未评分');
  assert.deepEqual(uids({ratings: [5], excludeRating: true}).sort(), [b, c, d].sort());
  assert.deepEqual(uids({favoriteMode: 'yes'}), [a]);
  assert.equal(uids({favoriteMode: 'no'}).length, 3);
  assert.deepEqual(uids({excludeTags: ['demo']}).sort(), [a, c, d].sort());
  assert.deepEqual(uids({tags: ['stone'], excludeTags: ['demo']}), [a]);
  assert.deepEqual(uids({favorite: true}), [a], '老前端的 favorite 布尔值仍生效');
});

test('排序全集与方向：desc 反转、色相 / 分辨率排序可复现、随机带种子', () => {
  const asc = queryAssets({rows, sort: 'name'}).uids;
  const desc = queryAssets({rows, sort: 'name', sortOrder: 'desc'}).uids;
  assert.deepEqual(desc, [...asc].reverse());
  assert.equal(queryAssets({rows, sort: 'color'}).uids[0], c, '灰色 hue=0 排最前');
  assert.equal(queryAssets({rows, sort: 'resolution'}).uids.at(-1), d, '无采样数据排后面');
  const first = queryAssets({rows, sort: 'random', seed: 'x'}).uids;
  assert.deepEqual(queryAssets({rows, sort: 'random', seed: 'x'}).uids, first, '同种子可复现');
  const variants = new Set(['x', 'y', 'z', 'w', 'seed-5'].map(seed =>
    queryAssets({rows, sort: 'random', seed}).uids.join(',')));
  assert.ok(variants.size > 1, '不同种子应产生不同顺序');
  assert.deepEqual(sortRows([], 'random'), []);
});

test('检索语法：color:/aspect:/width:/resolution:/duration: 数值比较', () => {
  assert.deepEqual(queryAssets({rows, q: 'color:blue'}).uids, [b]);
  assert.deepEqual(queryAssets({rows, q: 'aspect:>=1.5'}).uids, [a]);
  assert.deepEqual(queryAssets({rows, q: 'width:2000'}).uids, [a]);
  assert.deepEqual(queryAssets({rows, q: 'resolution:>=2000'}).uids.sort(), [a, b].sort());
  assert.deepEqual(queryAssets({rows, q: 'duration:>10'}).uids, []);
  assert.deepEqual(queryAssets({rows, q: 'rating:>=4'}).uids, [a]);
});

test('低层谓词：normalizeFilters 对老请求保持兼容', () => {
  const legacy = normalizeFilters({rating: [3, 5], favorite: true, tags: ['stone']});
  assert.deepEqual(legacy.rating, [3, 5]);
  assert.equal(legacy.favorite, true);
  assert.deepEqual(legacy.colors, []);
  assert.deepEqual(legacy.ranges, []);
  assert.equal(legacy.favoriteMode, 'yes');
  assert.equal(legacy.formats.active, false);
  assert.equal(normalizeFilters({formats: ['png']}).formats.active, true, '格式筛选单独传也一样生效');
  assert.equal(matchesFilters(rows[0], legacy, null), true);
  assert.equal(matchesFilters(rows[1], legacy, null), false);
});
