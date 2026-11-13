// 阶段 4 端到端：/api/library/mutations 增量写入、索引同步、并发安全、降级与拒绝路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryServer} from '../server/library.mjs';
import Database from 'better-sqlite3';

const a = 'a'.repeat(32), b = 'b'.repeat(32);
const blob = (over = {}) => JSON.stringify({
  version: 2,
  models: [
    {uid: a, name: '国风石灯', tags: ['stone'], addedAt: 2},
    {uid: b, name: 'Robot Arm', tags: ['robot'], addedAt: 1},
  ],
  aiTags: {}, userMeta: {}, userTags: {}, favorites: [], history: [], tasks: [], trashed: [], options: {}, ...over,
});
const STATE = {'sfx-library-v2': blob()};
const LOCAL = {'X-SFX-Local': '1', 'Content-Type': 'application/json'};
const NO_DB = {libraryDbImporter: async () => { throw Error('native module missing'); }};

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assetvault-mutations-'));
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
  return {base: `http://127.0.0.1:${server.address().port}`, dir};
}

const call = async (base, pathname, {method = 'GET', body, headers = LOCAL} = {}) => {
  const response = await fetch(base + pathname, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json().catch(() => ({}))};
};

async function seeded(t, options) {
  const {base, dir} = await fixture(t, options);
  assert.equal((await call(base, '/api/library-state', {method: 'POST', body: STATE})).status, 200);
  return {base, dir};
}

const main = async base => JSON.parse((await call(base, '/api/library-state')).data.values['sfx-library-v2']);

// 评分 / 备注 / 收藏 / 用户标签在前端走的是 S3 定点通道（persistent-storage.js
// → /api/library/tags/mutate），不是遗留的 /api/library/mutations 整块差量端点。
// 这条端到端必须测真实路径：ADR-02 之后用户域权威在 DB，定点写不碰 blob，
// 但 setRating/setNote/setFav 会同步刷新 assets 派生列，所以 rating:5 应立刻可检索。
test('评分走定点通道：blob 主体不动，rating 派生列即时同步且可检索', async t => {
  const {base} = await seeded(t);
  const ops = [
    {op: 'asset.set', uid: a, field: 'rating', value: 5},
    {op: 'asset.set', uid: a, field: 'note', value: '项目A'},
    {op: 'asset.set', uid: a, field: 'favorite', value: true},
    {op: 'tag.add', uid: a, source: 'user', value: '常用'},
  ];
  const response = await call(base, '/api/library/tags/mutate', {method: 'POST', body: {ops}});
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.fallback, false, '不应退回整块写入');
  assert.ok(response.data.applied > 0, '至少有一条 op 生效');
  assert.ok((response.data.changes || []).some(change => change.uid === a), '变更应落在目标资产上');

  // 定点写不重写权威 blob，目录主体一条不少。
  const state = await main(base);
  assert.equal(state.models.length, 2, '资产主体一动没动');

  // 核心判据：派生列跟着定点写刷新，且只命中被改的那一条。
  const hit = await call(base, '/api/library/assets', {method: 'POST', body: {q: 'rating:5'}});
  assert.equal(hit.status, 200);
  assert.deepEqual(hit.data.uids, [a], 'rating:5 应命中刚评分的资产');
});

test('并发的两次增量写入各自只碰自己的 key，不会互相覆盖', async t => {
  const {base} = await seeded(t);
  const responses = await Promise.all([
    call(base, '/api/library/mutations', {method: 'POST', body: {ops: [{op: 'set', field: 'userMeta', key: a, value: {rating: 5, note: ''}}]}}),
    call(base, '/api/library/mutations', {method: 'POST', body: {ops: [{op: 'set', field: 'userMeta', key: b, value: {rating: 2, note: 'B'}}]}}),
  ]);
  assert.deepEqual(responses.map(item => item.status), [200, 200]);
  const state = await main(base);
  assert.equal(state.userMeta[a].rating, 5);
  assert.equal(state.userMeta[b].rating, 2);
});

test('空操作与整块写入混用不丢数据，幂等重放无副作用', async t => {
  const {base} = await seeded(t);
  const ops = [{op: 'set', field: 'userMeta', key: a, value: {rating: 4, note: ''}}];
  assert.equal((await call(base, '/api/library/mutations', {method: 'POST', body: {ops}})).status, 200);
  assert.equal((await call(base, '/api/library/mutations', {method: 'POST', body: {ops}})).status, 200);
  assert.equal((await call(base, '/api/library/mutations', {method: 'POST', body: {ops: []}})).status, 200);
  assert.equal((await call(base, '/api/library-state', {method: 'POST', body: {'sfx-library-v2': blob({userMeta: {[a]: {rating: 4, note: ''}}, favorites: [b]})}})).status, 200);
  const state = await main(base);
  assert.equal(state.userMeta[a].rating, 4);
  assert.deepEqual(state.favorites, [b]);
  assert.equal(state.models.length, 2);
});

test('非法 op、后门主状态、空库、越权、错误方法都要明确拒绝', async t => {
  const {base} = await seeded(t);
  assert.equal((await call(base, '/api/library/mutations', {method: 'POST', body: {ops: [{op: 'set', field: 'models', value: []}]}})).status, 400);
  assert.equal((await call(base, '/api/library/mutations', {method: 'POST', body: {ops: [], values: {'sfx-library-v2': '{}'}}})).status, 400);
  assert.equal((await call(base, '/api/library/mutations', {method: 'POST', body: {ops: []}, headers: {'Content-Type': 'application/json'}})).status, 403);
  assert.equal((await call(base, '/api/library/mutations', {method: 'GET'})).status, 405);
  assert.equal((await call(base, '/api/library/mutations', {method: 'POST', body: {values: {}}})).status, 400);
  const empty = await fixture(t);
  assert.equal((await call(empty.base, '/api/library/mutations', {method: 'POST', body: {ops: []}})).status, 400, '空库不能用 {} 当底稿把资产写没');
});

test('DB 不可用时增量写入仍可用，engine 如实标为 memory', async t => {
  const {base} = await seeded(t, NO_DB);
  const ops = [{op: 'set', field: 'userMeta', key: a, value: {rating: 3, note: '文件模式'}}];
  const response = await call(base, '/api/library/mutations', {method: 'POST', body: {ops}});
  assert.equal(response.status, 200);
  assert.equal(response.data.engine, 'memory');
  assert.equal((await main(base)).userMeta[a].note, '文件模式');
});

test('只改搜索历史不重建派生表；改评分则要重建', async t => {
  const {base, dir} = await seeded(t);
  // 先用集合语义写入把 rev 顶上去（rev=1 是重建后的默认值，能据此判断有没有重建）
  const tagged = await call(base, '/api/library/tags/mutate', {
    method: 'POST', body: {ops: [{op: 'asset.set', uid: a, field: 'rating', value: 5}]},
  });
  assert.equal(tagged.status, 200);
  const revOf = uid => {
    // 用完立刻关连接：Windows 上不关的话临时目录删不掉（EBUSY）。
    const db = new Database(path.join(dir, 'library.db'), {readonly: true});
    const rev = db.prepare('SELECT rev FROM assets WHERE uid = ?').get(uid).rev;
    db.close();
    return rev;
  };
  assert.ok(revOf(a) > 1, '定点写之后 rev 应当大于 1');

  // 搜索历史变更：与派生表无关，不该重建（重建会把 rev 复位成 1）
  const history = await call(base, '/api/library/mutations', {
    method: 'POST', body: {ops: [{op: 'set', field: 'history', value: [{kind: 'web', url: 'https://example.com'}]}]},
  });
  assert.equal(history.status, 200);
  const state = await main(base);
  assert.equal(state.history.length, 1, '搜索历史要真的写进去');
  assert.ok(revOf(a) > 1, '只改搜索历史不该重建派生表（重建会把 rev 复位成 1）');
  const rating = await call(base, '/api/library/assets', {method: 'POST', body: {q: 'rating:5'}});
  assert.deepEqual(rating.data.uids, [a], '派生索引不能被这次写入弄坏');
});
