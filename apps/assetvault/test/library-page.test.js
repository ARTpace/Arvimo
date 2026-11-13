// 阶段 3 纯函数层：FTS 加速的启用边界、完整资产行、合集顺序、按需分页。
import test from 'node:test';
import assert from 'node:assert/strict';
import {rowsFromState, queryAssets, sortRows, SORTS, normalizeRows, fieldText} from '../server/library-query.mjs';
import {parseMainState, deriveAssetRows, deriveTagRows} from '../server/library-blob.mjs';
import {simpleFtsTerm, toFullModel, queryAssetPage, FTS_CANDIDATE_LIMIT} from '../server/library-page.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
const data = parseMainState(JSON.stringify({
  version: 2,
  models: [
    {uid: a, name: '国风石灯', author: 'Artist', platform: 'sketchfab', tags: ['stone', 'lantern'], likes: 12, addedAt: 40},
    {uid: b, name: 'Robot Arm', author: 'Bob', platform: 'artstation', tags: ['robot'], likes: 99, addedAt: 30},
    {uid: c, name: '石桥石灯笼', author: 'Artist', platform: 'sketchfab', tags: ['stone'], likes: 3, addedAt: 20},
    {uid: d, name: '国风石桥小径', author: 'Cara', platform: 'sketchfab', tags: ['bridge'], likes: 7, addedAt: 10},
  ],
  favorites: [a], aiTags: {[a]: ['石头']}, userTags: {[b]: ['常用']},
  userMeta: {[a]: {rating: 5, note: '项目A'}}, trashed: [], history: [], tasks: [], options: {},
}));
const rows = () => normalizeRows(deriveAssetRows(data, 1000), deriveTagRows(data));
const uids = result => result.uids;

test('simpleFtsTerm：只对 ≥3 字的单个正向纯文本词启用加速', () => {
  assert.equal(simpleFtsTerm('国风石灯'), '国风石灯');
  assert.equal(simpleFtsTerm('stone'), 'stone');
  assert.equal(simpleFtsTerm('STONE'), 'stone', '大小写归一化，与 fieldText 的 lower 一致');
  assert.equal(simpleFtsTerm('石灯笼'), '石灯笼');
  // 2 字中文词 trigram 不成立：走 LIKE 会漏掉 tags，必须退回全量求值。
  assert.equal(simpleFtsTerm('国风'), null);
  assert.equal(simpleFtsTerm('石头'), null);
  assert.equal(simpleFtsTerm('ab'), null);
  assert.equal(simpleFtsTerm(''), null);
  assert.equal(simpleFtsTerm('  '), null);
  // 复杂语法 / 字段 / 排除 / OR / 短语 / 特殊字符一律不加速。
  for (const q of ['tag:stone', 'rating:>=4', '-桥', 'robot | 石桥', '"stone lantern"', 'stone -lantern', 'a:b:c', 'foo/bar', 'foo_bar']) {
    assert.equal(simpleFtsTerm(q), null, q);
  }
  assert.ok(FTS_CANDIDATE_LIMIT > 1000);
});

test('toFullModel：保留 payload 原始字段，同时补齐规范化表里的用户判断', () => {
  const row = rows().find(item => item.uid === a);
  const model = toFullModel(row);
  assert.equal(model.uid, a);
  assert.equal(model.name, '国风石灯');
  assert.equal(model.likes, 12, 'payload 里的平台字段不能丢');
  assert.deepEqual(model.tags, row.model.tags, '平台标签保持原样，不提前合并三层标签');
  assert.equal(model.rating, 5);
  assert.equal(model.note, '项目A');
  assert.equal(model.favorite, true);
  assert.equal(model.state, 'active');
  assert.deepEqual(model.tagKinds.ai, ['石头']);
  assert.ok(model.categories.length > 0);
  assert.ok(model.kind);
});

test('queryAssetPage：按需取页返回完整 model，total / uids 仍是全部命中', () => {
  const page = queryAssetPage({rows: rows(), q: 'stone', limit: 1, offset: 1});
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].uid, c, 'offset=1 取第二页：a(addedAt 40) 之后是 c(20)');
  assert.ok('likes' in page.items[0], 'items 是完整 model 而不是 toCard 的精简卡片');
  assert.equal(page.uids.length, 2);

  const cards = queryAssets({rows: rows(), q: 'stone'});
  assert.deepEqual(uids(page), uids(cards), '同一套查询语义，只是 items 的形状不同');
  assert.equal(cards.items[0].tagKinds, undefined, '精简卡片不含三层标签明细，完整 model 才有');
});

test('候选集只是预筛：带 / 不带 candidateUids 的查询结果完全一致', () => {
  const all = rows();
  for (const q of ['国风石灯', 'stone', 'lantern']) {
    const full = queryAssets({rows: all, q});
    // 模拟 FTS 命中集合（真实环境由 assets_fts 提供）。
    const candidate = new Set(all.filter(row => fieldText(row, null).toLocaleLowerCase().includes(q)).map(row => row.uid));
    const accelerated = queryAssets({rows: all, q, candidateUids: candidate});
    assert.deepEqual(uids(accelerated), uids(full), q);
    assert.equal(accelerated.total, full.total, q);
  }
  assert.equal(queryAssets({rows: all, q: '不存在的东西', candidateUids: new Set()}).total, 0);
});

test("sort:'collection' 按 collection_assets.position 排，未列出的资产排后面", () => {
  assert.ok(SORTS.includes('collection'));
  const positions = new Map([[d, 0], [a, 1], [c, 2]]);
  const ordered = sortRows(rows(), 'collection', '', positions).map(row => row.uid);
  assert.deepEqual(ordered, [d, a, c, b]);
  const noPositions = sortRows(rows(), 'collection').map(row => row.uid);
  assert.deepEqual(noPositions, [a, b, c, d], '没有位置表时退回最近添加，不能崩');
});

test('rowsFromState 与 DB 派生行同形，分页降级路径结果一致', () => {
  const fromBlob = rowsFromState({[MAIN_STATE_KEY]: JSON.stringify(data)}, 1000);
  const indexed = rows();
  assert.deepEqual(uids(queryAssetPage({rows: fromBlob, q: 'stone'})), uids(queryAssetPage({rows: indexed, q: 'stone'})));
  assert.deepEqual(uids(queryAssetPage({rows: fromBlob, filters: {rating: [5, 5]}})), uids(queryAssetPage({rows: indexed, filters: {rating: [5, 5]}})));
});
