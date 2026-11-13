// 阶段 5.3a / ADR-07：读侧目录域以 assets 表为权威的契约验收。
//
// 守四件事：
//   1) readCatalog 按 position 还原顺序、active/trashed 分开、坏 payload 只跳过一行；
//   2) DB 里比 blob 多的合法历史资产必须在读视图里可见（5.1 合并语义，禁止当脏数据）；
//   3) 连续两次 load 返回同一字符串 —— 前端 diff 依赖「save 后 load 逐字节还原」；
//   4) 回退开关 / DB 目录为空时不接管读视图，用户域不被目录合成冲掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createLibraryStorage, stateFileFor} from '../server/library-storage.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
const model = (uid, name) => ({uid, name, platform: 'sketchfab', addedAt: 1});
const downloads = {snapshot: () => ({jobs: []})};
const blob = models => JSON.stringify({
  version: 2, models, trashed: [], favorites: [a], aiTags: {}, userTags: {},
  userMeta: {[a]: {rating: 5, note: '项目A'}}, history: [], tasks: [], options: {},
});

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'assetvault-catalogread-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('readCatalog：position 顺序、state 分组、DB-only 资产、坏 payload 跳过', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assetvault-catalograw-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'library.db');
  const conn = createLibraryDb({Database, file});
  conn.writeValues({[MAIN_STATE_KEY]: JSON.stringify({
    version: 2, models: [model(a, 'A'), model(b, 'B')], trashed: [model(c, 'C')],
  })}, {stamp: 1000});
  // 5.1 的定点新增只写 DB：position = MIN-1，读视图里应该排在最前。
  conn.applyAssetOps([{op: 'asset:add', uid: d, model: model(d, '历史资产')}], {actor: 'test'});
  // 一条脏 payload 不能拖垮整库启动。
  const raw = new Database(file);
  raw.prepare('UPDATE assets SET payload = ? WHERE uid = ?').run('{not-json', b);
  raw.close();

  const catalog = conn.readCatalog();
  assert.deepEqual(catalog.models.map(item => item.uid), [d, a], '坏行跳过，其余按 position 还原');
  assert.deepEqual(catalog.trashed.map(item => item.uid), [c]);
  assert.equal(catalog.models[0].name, '历史资产');
  conn.close();
});

test('load() 把 DB-only 资产并进读视图，顺序按 position，用户域不丢且字节稳定', async t => {
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, downloads, {});
  await storage.save({[MAIN_STATE_KEY]: blob([model(a, 'A'), model(b, 'B')])});
  await storage.withDb(conn => conn.applyAssetOps(
    [{op: 'asset:add', uid: d, model: model(d, '历史资产')}], {actor: 'test'}));

  const first = (await storage.load()).values[MAIN_STATE_KEY];
  const second = (await storage.load()).values[MAIN_STATE_KEY];
  assert.equal(first, second, '连续两次读取必须逐字节一致，否则前端 diff 会无限回写');
  const view = JSON.parse(first);
  assert.deepEqual(view.models.map(item => item.uid), [d, a, b]);
  assert.equal(view.userMeta[a].rating, 5, '目录合成不能把用户域冲掉');
  assert.deepEqual(view.favorites, [a]);
  assert.equal(storage.dbStatus().catalog, 'db');
});

test('回退开关关掉后读视图用回 blob，DB-only 资产不出现', async t => {
  const dir = await temp(t);
  const file = stateFileFor(dir, MAIN_STATE_KEY);
  await fsp.mkdir(path.dirname(file), {recursive: true});
  await fsp.writeFile(file, JSON.stringify(blob([model(a, 'A')])));

  const storage = createLibraryStorage(dir, downloads, {});
  const before = (await storage.load()).values[MAIN_STATE_KEY];
  // 真实写一条只在 DB 里的资产，反证「开关关掉」确实没有发生合成。
  await storage.withDb(conn => conn.applyAssetOps(
    [{op: 'asset:add', uid: d, model: model(d, '历史资产')}], {actor: 'test'}));
  assert.deepEqual(JSON.parse((await storage.load()).values[MAIN_STATE_KEY]).models.map(item => item.uid), [d, a]);

  const legacy = createLibraryStorage(dir, downloads, {catalogDbAuthoritative: false});
  const view = JSON.parse((await legacy.load()).values[MAIN_STATE_KEY]);
  assert.equal(view.models.length, 1, '开关关掉后一行 DB 合成都不能发生');
  assert.equal(view.models[0].uid, a);
  assert.equal(legacy.dbStatus().catalog, 'blob');
  assert.equal(before, (await legacy.load()).values[MAIN_STATE_KEY], '回退后的读视图与原始快照一致');
});
