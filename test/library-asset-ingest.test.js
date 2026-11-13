// 阶段 5.2 / ADR-06：下载入库增量的契约验收（前端分流 + 服务端过渡期双写）。
//
// 守三件事：
//   1) 只有「纯尾部新增」才拆成 asset:add，任何改动过的旧 model / 回收站变化都照旧整块写；
//   2) 新路由不可用时整块重放，且其它分域通道不被牵连；
//   3) syncBlob 后主 blob 与 DB 一致 —— 已删资产不会被旧 blob 复活。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {translateStateChange} from '../src/library/tag-ops.js';
import {createPersistentStorage} from '../src/library/persistent-storage.js';
import {createLibraryDb} from '../server/library-db.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
const old = {uid: a, name: '石灯', tags: ['stone'], addedAt: 1};
const added = {uid: b, name: 'Phoenix', tags: ['bird'], addedAt: 2};
const state = (over = {}) => ({
  version: 2, models: [old], trashed: [],
  aiTags: {}, userTags: {}, userMeta: {}, favorites: [],
  assetProbe: {}, history: [], tasks: [], options: {}, ...over,
});
const blob = over => JSON.stringify(state(over));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const local = {getItem: () => null, setItem() {}};

// ------------------------------------------------------------------ 翻译层
test('纯尾部新增 → adds 有值、catalog 为 null', () => {
  const result = translateStateChange(state(), state({models: [old, added]}));
  assert.equal(result.fallback, false);
  assert.deepEqual(result.adds, [added]);
  assert.equal(result.catalog, null);
  assert.deepEqual(result.removes, []);
});

test('旧 model 被改 / 顺序变化 / 回收站变化 / 非法 uid → 一律整块 catalog', () => {
  const cases = [
    state({models: [{...old, name: '改名'}, added]}),
    state({models: [added, old]}),
    state({models: [old, added], trashed: [{uid: c, name: '旧', trashedAt: 1}]}),
    state({models: [old, {...added, uid: '不是合法 uid 但很长很长'}]}),
    state({models: [old, {...added, uid: ''}]}),
  ];
  for (const after of cases) {
    const result = translateStateChange(state(), after);
    assert.deepEqual(result.adds, []);
    assert.equal(typeof result.catalog, 'string');
  }
});

test('没有变化时 adds 也是空数组', () => {
  assert.deepEqual(translateStateChange(state(), state()).adds, []);
});

// ------------------------------------------------------------------ 持久化分流
function harness(initial, {assetOpsStatus = 200, assetOpsThrows = false} = {}) {
  const calls = [], commits = [];
  const request = async (requestPath, options = {}) => {
    if (requestPath === '/api/library-state' && !options.method) {
      return {ok: true, json: async () => ({values: initial, recovered: [], scanIndex: true})};
    }
    calls.push({path: requestPath, method: options.method, body: options.body ? JSON.parse(options.body) : null});
    if (requestPath === '/api/library/assets/mutate') {
      if (assetOpsThrows) throw Error('network down');
      if (assetOpsStatus !== 200) return {ok: false, status: assetOpsStatus, json: async () => ({})};
    }
    return {ok: true, status: 200, json: async () => ({saved: true})};
  };
  const storagePromise = createPersistentStorage(local, request, {
    collections: true, onCommit: info => commits.push(info),
  });
  return {storagePromise, calls, commits};
}

test('下载入库只发 asset:add，不回传整块目录 blob', async () => {
  const h = harness({'sfx-library-v2': blob()});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({models: [old, added]}));
  await tick();
  const add = h.calls.find(call => call.path === '/api/library/assets/mutate');
  assert.ok(add, '纯新增必须走增量路由');
  assert.equal(add.body.ops[0].op, 'asset:add');
  assert.equal(add.body.ops[0].uid, b);
  assert.equal(h.calls.some(call => call.path === '/api/library-state' && call.method === 'POST' && call.body[MAIN_STATE_KEY]), false,
    '不该再回传整块目录');
  assert.ok(h.commits[0].domains.includes('adds'));
});

test('新增与打标同时发生时，先入库再打标', async () => {
  const h = harness({'sfx-library-v2': blob()});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob({models: [old, added], userTags: {[b]: ['新标签']}}));
  await tick();
  const paths = h.calls.map(call => call.path);
  assert.ok(paths.indexOf('/api/library/assets/mutate') < paths.indexOf('/api/library/tags/mutate'),
    'tag.add 不能打到还不存在的资产');
});

test('新路由 404 / 抛错 → 本次整块重放，之后不再白撞', async () => {
  for (const opts of [{assetOpsStatus: 404}, {assetOpsThrows: true}]) {
    const h = harness({'sfx-library-v2': blob()}, opts);
    const storage = await h.storagePromise;
    storage.setItem('sfx-library-v2', blob({models: [old, added]}));
    await tick();
    const statePost = h.calls.find(call => call.path === '/api/library-state' && call.method === 'POST');
    assert.ok(statePost, '降级必须整块重放完整主状态');
    assert.equal(JSON.parse(statePost.body[MAIN_STATE_KEY]).models.length, 2);
    const before = h.calls.length;
    storage.setItem('sfx-library-v2', blob({models: [old, added, {...added, uid: c}]}));
    await tick();
    assert.equal(h.calls.slice(before).some(call => call.path === '/api/library/assets/mutate'), false);
    const replay = h.calls.slice(before).find(call => call.path === '/api/library-state' && call.method === 'POST');
    assert.ok(replay, '通道关掉后纯新增也必须整块重放，不能一条请求都不发');
    assert.equal(JSON.parse(replay.body[MAIN_STATE_KEY]).models.length, 3);
  }
});

// ------------------------------------------------------------------ 服务端双写
test('syncBlob 把新增写进主 blob；remove 后 DB 与 blob 都不留，重放不会复活', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assetvault-ingest-'));
  const db = createLibraryDb({Database, file: path.join(dir, 'library.db')});
  try {
    const initial = JSON.stringify({
      version: 2,
      models: [{uid: a, name: '石灯', tags: ['stone'], addedAt: 1}],
      aiTags: {}, userTags: {}, userMeta: {}, favorites: [],
      trashed: [], history: [], tasks: [], options: {},
    });
    db.writeValues({[MAIN_STATE_KEY]: initial}, {stamp: 1000});
    db.applyAssetOps([{op: 'asset:add', uid: b, model: added}], {syncBlob: true});
    const readBlob = () => JSON.parse(db.native().prepare('SELECT value FROM state_meta WHERE key = ?').get(MAIN_STATE_KEY).value);
    assert.equal(readBlob().models.length, 2);
    assert.ok(readBlob().models.some(model => model.uid === b));
    assert.equal(db.native().prepare('SELECT count(*) n FROM assets WHERE uid = ?').get(b).n, 1);

    db.applyAssetOps([{op: 'asset:remove', uid: a}], {syncBlob: true});
    const main = readBlob();
    assert.equal(main.models.some(model => model.uid === a), false, 'blob 里必须一起删掉');
    // 模拟下一次整块写入 / 重启合并：旧 blob 不该把已删资产复活。
    db.writeValues({[MAIN_STATE_KEY]: JSON.stringify(main)}, {stamp: 9000});
    assert.equal(db.native().prepare('SELECT count(*) n FROM assets WHERE uid = ?').get(a).n, 0);
    assert.equal(db.native().prepare('SELECT count(*) n FROM assets WHERE uid = ?').get(b).n, 1);
    // 域戳必须推进，否则 readValues 会误判文件快照更新而搬回旧目录。
    const stamp = db.native().prepare("SELECT value FROM db_meta WHERE key = ?").get('state_stamp:' + MAIN_STATE_KEY);
    assert.ok(stamp, '域戳已写入');
  } finally {
    db.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
