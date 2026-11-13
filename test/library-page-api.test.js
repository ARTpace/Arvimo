// 阶段 3 端到端：/api/library/assets 按需分页、FTS 加速语义、合集手动顺序、双引擎一致性。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryServer} from '../server/library.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
const models = [
  {uid: a, name: '国风石灯', author: 'Artist', platform: 'sketchfab', tags: ['stone', 'lantern'], likes: 12, addedAt: 40},
  {uid: b, name: 'Robot Arm', author: 'Bob', platform: 'artstation', tags: ['robot'], likes: 99, addedAt: 30},
  {uid: c, name: '石桥石灯笼', author: 'Artist', platform: 'sketchfab', tags: ['stone'], likes: 3, addedAt: 20},
  {uid: d, name: '国风石桥小径', author: 'Cara', platform: 'sketchfab', tags: ['bridge'], likes: 7, addedAt: 10},
];
const state = {'sfx-library-v2': JSON.stringify({
  version: 2, models, favorites: [a], aiTags: {[a]: ['石头']}, userTags: {[b]: ['常用']},
  userMeta: {[a]: {rating: 5, note: '项目A'}}, trashed: [], history: [], tasks: [], options: {},
})};
const LOCAL = {'X-SFX-Local': '1', 'Content-Type': 'application/json'};

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-page-api-'));
  const previous = process.env.SFX_DATA_DIR;
  process.env.SFX_DATA_DIR = dir;
  let server;
  try { server = createLibraryServer(options); }
  finally { if (previous === undefined) delete process.env.SFX_DATA_DIR; else process.env.SFX_DATA_DIR = previous; }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, {recursive: true, force: true});
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const call = async (base, pathname, {method = 'GET', body, headers = LOCAL} = {}) => {
  const response = await fetch(base + pathname, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json().catch(() => ({}))};
};

async function seeded(t, options) {
  const base = await fixture(t, options);
  assert.equal((await call(base, '/api/library-state', {method: 'POST', body: state})).status, 200);
  return base;
}

test('分页接口返回完整 model，POST 与 GET 查询串结果一致', async t => {
  const base = await seeded(t);
  const post = await call(base, '/api/library/assets', {method: 'POST', body: {limit: 2, offset: 1, sort: 'recent'}});
  assert.equal(post.status, 200);
  assert.equal(post.data.mode, 'page');
  assert.equal(post.data.engine, 'sqlite');
  assert.equal(post.data.total, 4);
  assert.equal(post.data.items.length, 2);
  assert.deepEqual(post.data.items.map(item => item.uid), [b, c]);
  assert.equal(post.data.items[1].likes, 3, '完整 model 含平台原始字段');
  assert.equal(post.data.uids.length, 4, 'uids 仍是全部命中而非当前页');

  const get = await call(base, '/api/library/assets?q=stone&limit=1');
  assert.equal(get.status, 200);
  assert.equal(get.data.total, 2);
  assert.equal(get.data.items[0].uid, a, '按 addedAt 的最近添加顺序，a 在 c 前面');
  const getRating = await call(base, '/api/library/assets?rating=5');
  assert.deepEqual(getRating.data.uids, [a]);
  const getCollection = await call(base, '/api/library/assets?favorite=1');
  assert.deepEqual(getCollection.data.uids, [a]);
  assert.equal((await call(base, '/api/library/assets', {method: 'DELETE'})).status, 405);
  assert.equal((await call(base, '/api/library/assets', {headers: {}})).status, 403);
});

test('FTS5 候选集加速只影响性能，不改变任何检索结果', async t => {
  const sqlite = await seeded(t);
  const memory = await seeded(t, {libraryDbImporter: async () => { throw Error('native module missing'); }});
  const cases = [
    {q: '国风石灯'}, {q: 'stone'}, {q: 'lantern'},
    {q: '国风'}, {q: 'tag:stone'}, {q: '-桥'}, {q: 'robot | 石桥'}, {q: 'rating:>=4'},
    {filters: {rating: [5, 5]}}, {sort: 'popular'},
  ];
  for (const input of cases) {
    const fast = await call(sqlite, '/api/library/query', {method: 'POST', body: input});
    const slow = await call(memory, '/api/library/query', {method: 'POST', body: input});
    assert.deepEqual(fast.data.uids, slow.data.uids, `SQLite 加速与内存全量结果必须一致：${JSON.stringify(input)}`);
    assert.equal(fast.data.total, slow.data.total);
    // S2 之后有两条加速路径：能下推的直接走 SQL（pushdown），下推不了的退回全量路径，
    // 全量路径里「单个正向纯文本词」还能用 FTS5 缩候选集（accelerated）。
    // 两条路径都必须与内存全量求值同结果 —— 这才是这个用例真正要守的东西。
    const canPushdown = !input.sort || input.sort !== 'popular';
    assert.equal(fast.data.pushdown, canPushdown, `下推标志：${JSON.stringify(input)}`);
    if (canPushdown) assert.equal(fast.data.accelerated, false, `走下推时不经过 FTS 预筛：${JSON.stringify(input)}`);
    assert.equal(slow.data.accelerated, false, '内存引擎永远不加速');
    assert.equal(slow.data.pushdown, false, '内存引擎永远不下推');
  }
  // 分页接口同样走下推路径，且 items 与 query 的精简卡片顺序一致。
  const page = await call(sqlite, '/api/library/assets', {method: 'POST', body: {q: 'stone'}});
  assert.equal(page.data.pushdown, true);
  assert.deepEqual(page.data.items.map(item => item.uid), page.data.uids);
});

test('合集手动顺序：set / reorder / sort:collection 与前端显示顺序对齐', async t => {
  const base = await seeded(t);
  const created = await call(base, '/api/library/collections', {method: 'POST', body: {name: '手动排序'}});
  const id = created.data.id;
  assert.equal((await call(base, '/api/library/collections/items', {method: 'POST', body: {id, uids: [d, a, c], action: 'set'}})).data.count, 3);
  const ordered = await call(base, '/api/library/query', {method: 'POST', body: {filters: {collection: id}, sort: 'collection'}});
  assert.deepEqual(ordered.data.uids, [d, a, c]);

  await call(base, '/api/library/collections/items', {method: 'POST', body: {id, uids: [c], action: 'reorder'}});
  const reordered = await call(base, '/api/library/query', {method: 'POST', body: {filters: {collection: id}, sort: 'collection'}});
  assert.deepEqual(reordered.data.uids, [c, d, a], '没列出的成员保持相对顺序跟在后面');
  assert.equal(reordered.data.uids.length, 3, 'reorder 不能丢成员');

  const page = await call(base, '/api/library/assets', {method: 'POST', body: {filters: {collection: id}, sort: 'collection', limit: 2}});
  assert.deepEqual(page.data.items.map(item => item.uid), [c, d]);
  const invalid = await call(base, '/api/library/collections/items', {method: 'POST', body: {id, uids: [a], action: 'bogus'}});
  assert.ok(invalid.status >= 400, '不认识的操作必须明确报错，不能静默改数据');
});
