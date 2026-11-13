// /api/library/* 端到端：路由守卫、SQLite 引擎、合集 CRUD、智能合集重算、内存降级。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryServer} from '../server/library.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
const blob = models => JSON.stringify({version: 2, models, favorites: [a], aiTags: {}, userTags: {}, userMeta: {
  [a]: {rating: 5, note: '项目A'}, [c]: {rating: 4, note: ''},
}, trashed: [], history: [], tasks: [], options: {}});
const state = {'sfx-library-v2': blob([
  {uid: a, name: '国风石灯', author: 'Artist', platform: 'sketchfab', tags: ['stone', 'lantern'], likes: 12},
  {uid: b, name: 'Robot Arm', author: 'Bob', platform: 'artstation', tags: ['robot'], likes: 99},
  {uid: c, name: '石桥', author: 'Artist', platform: 'sketchfab', tags: ['stone', 'bridge'], likes: 3},
])};
const LOCAL = {'X-SFX-Local': '1', 'Content-Type': 'application/json'};

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-query-api-'));
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

test('本地标识与同源校验：缺标识 / 跨站一律 403', async t => {
  const base = await fixture(t);
  assert.equal((await call(base, '/api/library/query/status', {headers: {}})).status, 403);
  assert.equal((await call(base, '/api/library/query/status', {headers: {...LOCAL, Origin: 'https://evil.test'}})).status, 403);
  assert.equal((await call(base, '/api/library/query', {method: 'POST', body: {q: 'a'}, headers: {}})).status, 403);
  assert.equal((await call(base, '/api/library/query/status', {headers: {...LOCAL, Origin: base}})).status, 200, '同源 Origin 放行');
});

test('写入状态后，布尔 / 字段 / 过滤 / 排序 / 分页全部走 SQLite 索引', async t => {
  const base = await fixture(t);
  assert.equal((await call(base, '/api/library-state', {method: 'POST', body: state})).status, 200);
  const status = await call(base, '/api/library/query/status');
  assert.equal(status.data.engine, 'sqlite');
  assert.equal(status.data.counts.assets, 3);
  assert.ok(status.data.sorts.includes('random'));
  assert.match(status.data.syntax, /空格/);

  const query = body => call(base, '/api/library/query', {method: 'POST', body});
  assert.deepEqual((await query({q: '国风'})).data.uids, [a]);
  assert.deepEqual((await query({q: 'tag:stone -桥'})).data.uids, [a]);
  assert.deepEqual((await query({q: 'robot | 石桥'})).data.uids.sort(), [b, c].sort());
  assert.deepEqual((await query({q: 'rating:>=4'})).data.uids.sort(), [a, c].sort());
  assert.deepEqual((await query({filters: {tags: ['stone'], rating: [5, 5]}})).data.uids, [a]);
  assert.deepEqual((await query({filters: {platforms: ['artstation']}})).data.uids, [b]);
  assert.deepEqual((await query({sort: 'popular'})).data.uids, [b, a, c]);
  const page = (await query({limit: 1, offset: 1})).data;
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 3);
  assert.equal(page.uids.length, 3);
  assert.equal((await query({q: '不存在的东西'})).data.total, 0);
});

test('合集 HTTP CRUD、按合集查询、智能合集按规则自动重算', async t => {
  const base = await fixture(t);
  await call(base, '/api/library-state', {method: 'POST', body: state});
  const created = await call(base, '/api/library/collections', {method: 'POST', body: {name: '项目A'}});
  const id = created.data.id;
  assert.match(id, /^c-/);
  assert.equal((await call(base, '/api/library/collections/items', {method: 'POST', body: {id, uids: [a, c], action: 'set'}})).data.count, 2);
  assert.equal((await call(base, '/api/library/collections')).data.collections[0].assetCount, 2);
  assert.deepEqual((await call(base, '/api/library/query', {method: 'POST', body: {filters: {collection: id}}})).data.uids.sort(), [a, c].sort());

  const smart = await call(base, '/api/library/smart-collections', {method: 'POST', body: {name: '高分', q: 'rating:>=4', sort: 'rating'}});
  assert.equal(smart.data.rule.q, 'rating:>=4');
  const before = await call(base, '/api/library/smart-collections/resolve', {method: 'POST', body: {id: smart.data.id}});
  assert.deepEqual(before.data.uids.sort(), [a, c].sort());

  // 规则重算而非结果快照：新加一个高分资产后，不重新保存规则也能立刻被算进去。
  const extended = {'sfx-library-v2': blob([
    {uid: a, name: '国风石灯', tags: ['stone']}, {uid: b, name: 'Robot Arm', tags: ['robot']},
    {uid: c, name: '石桥', tags: ['stone']}, {uid: 'e'.repeat(32), name: '新高分', tags: []},
  ])};
  const replaced = JSON.parse(extended['sfx-library-v2']);
  replaced.userMeta['e'.repeat(32)] = {rating: 5, note: ''};
  await call(base, '/api/library-state', {method: 'POST', body: {'sfx-library-v2': JSON.stringify(replaced)}});
  const after = await call(base, '/api/library/smart-collections/resolve', {method: 'POST', body: {id: smart.data.id}});
  assert.ok(after.data.uids.includes('e'.repeat(32)), '新增资产自动进入智能合集');

  assert.equal((await call(base, `/api/library/collections?id=${encodeURIComponent(id)}`, {method: 'DELETE'})).data.removed, true);
  assert.equal((await call(base, '/api/library/collections')).data.collections.length, 1, '只剩智能合集');
  assert.equal((await call(base, '/api/library/smart-collections/resolve', {method: 'POST', body: {id: 'nope'}})).status, 404);
});

test('DB 不可用时自动降级内存引擎：检索照常、合集明确 503', async t => {
  const base = await fixture(t, {libraryDbImporter: async () => { throw Error('native module missing'); }});
  await call(base, '/api/library-state', {method: 'POST', body: state});
  const status = await call(base, '/api/library/query/status');
  assert.equal(status.data.engine, 'memory');
  const result = await call(base, '/api/library/query', {method: 'POST', body: {q: 'tag:stone -桥'}});
  assert.equal(result.status, 200);
  assert.equal(result.data.engine, 'memory');
  assert.deepEqual(result.data.uids, [a], '内存引擎与 SQLite 引擎结果一致');
  assert.equal((await call(base, '/api/library/collections')).status, 503);
  assert.equal((await call(base, '/api/library/collections', {method: 'POST', body: {name: 'X'}})).status, 503);
});
