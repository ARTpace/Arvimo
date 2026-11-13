// 查询层：锁死「SQLite 索引」与「blob 内存降级」两条路径产出同样的行、同样的结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {
  normalizeRows, rowsFromState, queryAssets, matchesQuery, matchesFilters,
  normalizeFilters, sortRows, SORTS,
} from '../server/library-query.mjs';
import {parseSearchExpression} from '../server/search-expression.mjs';

const NOW = 1_700_000_000_000;
const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), gone = 'd'.repeat(32);
const state = {
  'sfx-library-v2': JSON.stringify({
    version: 2,
    models: [
      {uid: a, name: '国风石灯', author: 'Artist', platform: 'sketchfab', tags: ['stone', 'lantern'], likes: 12, addedAt: 300},
      {uid: b, name: 'Robot Arm', author: 'Bob', platform: 'artstation', tags: ['robot'], likes: 99, addedAt: 200},
      {uid: c, name: '石桥', author: 'Artist', platform: 'sketchfab', tags: ['stone', 'bridge'], likes: 3, addedAt: 100},
    ],
    aiTags: {[a]: ['石头']}, userTags: {[b]: ['常用']},
    userMeta: {[a]: {rating: 5, note: '项目A'}, [c]: {rating: 2, note: ''}},
    favorites: [a],
    trashed: [{uid: gone, name: '废弃素材', tags: ['old'], trashedAt: NOW}],
    history: [], tasks: [], options: {},
  }),
};
const rows = () => rowsFromState(state, NOW);
const uids = result => result.uids;

test('DB 派生行与内存降级行完全一致（同一份语义，换引擎不改结果）', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  try {
    db.writeValues(state, {replace: true, stamp: NOW});
    const fromDb = normalizeRows(db.all('SELECT * FROM assets', []), db.all('SELECT uid, kind, tag FROM tags', []));
    const fromBlob = rows();
    const key = row => [row.uid, row.name, row.author, row.rating, row.favorite, row.state, row.added_at, [...row.tags].sort().join('|')].join('\u0001');
    assert.deepEqual(fromDb.map(key).sort(), fromBlob.map(key).sort());
    assert.equal(fromDb.length, 4);
  } finally { db.close(); }
});

test('中文、字段限定、排除、OR 组、rating 数值比较', () => {
  assert.deepEqual(uids(queryAssets({rows: rows(), q: '国风'})), [a]);
  assert.deepEqual(uids(queryAssets({rows: rows(), q: 'tag:stone'})).sort(), [a, c].sort());
  assert.deepEqual(uids(queryAssets({rows: rows(), q: 'tag:stone -桥'})), [a]);
  assert.deepEqual(uids(queryAssets({rows: rows(), q: 'author:Artist 石'})).sort(), [a, c].sort());
  assert.deepEqual(uids(queryAssets({rows: rows(), q: 'robot | 石桥'})).sort(), [b, c].sort());
  assert.deepEqual(uids(queryAssets({rows: rows(), q: '"Robot Arm" tag:robot'})), [b]);
  assert.deepEqual(uids(queryAssets({rows: rows(), q: 'rating:>=4'})), [a]);
  assert.deepEqual(uids(queryAssets({rows: rows(), q: 'rating:<3'})).sort(), [b, c].sort());
  assert.deepEqual(uids(queryAssets({rows: rows(), q: 'platform:artstation'})), [b]);
});

test('过滤：跨维 AND、同维 OR、评分/收藏/状态/白名单', () => {
  const run = filters => uids(queryAssets({rows: rows(), filters}));
  assert.deepEqual(run({tags: ['stone'], platforms: ['sketchfab']}).sort(), [a, c].sort());
  assert.deepEqual(run({tags: ['stone', 'robot'], platforms: ['sketchfab']}).sort(), [a, c].sort());
  assert.deepEqual(run({tags: ['stone', 'robot']}).sort(), [a, b, c].sort());
  assert.deepEqual(run({rating: [4, 5], favorite: true}), [a]);
  assert.equal(run({}).includes(gone), false, '默认只看在库资产，回收站不混入');
  assert.deepEqual(run({state: 'trashed'}), [gone]);
  assert.equal(run({state: 'all'}).length, 4);
  assert.deepEqual(run({uids: [b]}), [b]);
  assert.equal(run({collection: 'c1'}).length, 3, '合集 id 只是标记，真正的集合由查询服务注入');
});

test('过滤 + 检索同时生效；集合白名单由调用方注入', () => {
  const result = queryAssets({rows: rows(), q: 'tag:stone', filters: {rating: [3, 5]}});
  assert.deepEqual(result.uids, [a]);
  const scoped = queryAssets({rows: rows(), q: 'tag:stone', collectionUids: new Set([c])});
  assert.deepEqual(scoped.uids, [c]);
});

test('排序、分页、limit 上限与默认参数', () => {
  const run = extra => queryAssets({rows: rows(), ...extra});
  assert.deepEqual(run({sort: 'popular'}).uids, [b, a, c]);
  assert.deepEqual(run({sort: 'rating'}).uids, [a, c, b]);
  assert.deepEqual(run({sort: 'name'}).uids.length, 3);
  assert.deepEqual(run({sort: 'random', seed: 'x'}).uids, run({sort: 'random', seed: 'x'}).uids, '随机排序同种子稳定');
  assert.equal(run({sort: 'no-such-sort'}).uids.length, 3, '未知排序退回默认而不是崩');
  const page = run({limit: 2, offset: 1});
  assert.equal(page.items.length, 2);
  assert.equal(page.total, 3);
  assert.equal(page.uids.length, 3, 'uids 是全部命中，分页只影响 items');
  assert.equal(run({limit: 9999}).limit, 500);
  assert.equal(run({offset: -5}).offset, 0);
  assert.ok(SORTS.includes('recent'));
  assert.equal(run({sort: 'recent'}).items[0].name, '国风石灯');
});

test('低层谓词可单独复用，损坏 payload 不会拖垮整库', () => {
  const row = rows()[0];
  assert.equal(matchesQuery(row, parseSearchExpression('国风 -robot')), true);
  assert.equal(matchesQuery(row, parseSearchExpression('国风 robot')), false);
  assert.equal(matchesFilters(row, normalizeFilters({rating: 4}), null), true);
  assert.equal(matchesFilters(row, normalizeFilters({favorite: false, tags: ['不存在']}), null), false);
  const broken = normalizeRows([{uid: 'x', payload: '{bad json', state: 'active'}], []);
  assert.equal(broken.length, 1);
  assert.deepEqual(sortRows([], 'recent'), []);
  assert.deepEqual(rowsFromState({'sfx-library-v2': 'not json'}), []);
});
