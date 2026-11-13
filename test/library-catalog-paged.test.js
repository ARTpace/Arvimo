// 阶段 5.5 / ADR-09：DB 单一写入权威 + 启动按页 + 整块通道收口的契约验收。
//
// 守五件事：
//   1) readCatalogPage 是 SQL 分页（顺序 / total / nextOffset），uid 集合只回 active；
//   2) catalog=paged 读视图不带 models，但回收站与非目录域完整；
//   3) 主 blob 落盘时目录字段恒为空，非目录字段不被「纯目录 blob」抹掉；
//   4) 停双写后整块重放过期 blob 不会把已作废 / 已删除的资产复活（反证）；
//   5) 前端补页时 cache / lastParsed 与 state.models 同步 —— 不会被误判成删除。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createLibraryStorage, stateFileFor} from '../server/library-storage.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';
import {createPersistentStorage} from '../src/library/persistent-storage.js';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
const model = (uid, name) => ({uid, name, platform: 'sketchfab', addedAt: 1});
const downloads = {snapshot: () => ({jobs: []})};
const blob = (models, trashed = []) => JSON.stringify({
  version: 2, models, trashed, favorites: [a], aiTags: {}, userTags: {},
  userMeta: {[a]: {rating: 5, note: '项目A'}}, history: [], tasks: [], options: {},
});

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'assetvault-paged-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

test('readCatalogPage 走 SQL 分页；readCatalogUids 只回 active', async t => {
  const dir = await temp(t);
  const conn = createLibraryDb({Database, file: path.join(dir, 'library.db')});
  conn.writeValues({[MAIN_STATE_KEY]: blob([model(a, 'A'), model(b, 'B')], [model(c, 'C')])}, {stamp: 1000});
  conn.applyAssetOps([{op: 'asset:add', uid: d, model: model(d, 'D')}], {actor: 'test'});

  const first = conn.readCatalogPage(0, 2);
  assert.equal(first.total, 3, 'total 只数 active');
  assert.deepEqual(first.items.map(item => item.uid), [d, a], 'position 顺序，新增资产排最前');
  assert.equal(first.nextOffset, 2);
  const second = conn.readCatalogPage(first.nextOffset, 2);
  assert.deepEqual(second.items.map(item => item.uid), [b]);
  assert.equal(second.nextOffset, 3);
  assert.deepEqual(conn.readCatalogPage(99, 2).items, [], '越界返回空页而不是报错');
  assert.deepEqual(conn.readCatalogUids('active').uids, [d, a, b]);
  assert.deepEqual(conn.readCatalogUids('trashed').uids, [c]);
  conn.close();
});

test('catalog=paged 读视图：models 空、回收站与非目录域完整、带 total', async t => {
  const dir = await temp(t);
  // 真实库早已由旧双轨语义把目录灌进 DB；测试先补这一步，再切到单一写入权威。
  await createLibraryStorage(dir, downloads, {}).save({[MAIN_STATE_KEY]: blob([model(a, 'A'), model(b, 'B')])});
  const storage = createLibraryStorage(dir, downloads, {catalogSingleWriter: true});
  await storage.withDb(conn => conn.applyAssetOps(
    [{op: 'asset:trash', uid: a}, {op: 'asset:add', uid: d, model: model(d, 'D')}],
    {actor: 'test'}));

  const paged = await storage.load({catalogPaged: true});
  assert.equal(paged.catalogPaged, true);
  assert.equal(paged.catalogTotal, 2, 'B + D 为 active');
  const view = JSON.parse(paged.values[MAIN_STATE_KEY]);
  assert.deepEqual(view.models, [], '整份目录不再随整块 GET 下发');
  assert.deepEqual(view.trashed.map(item => item.uid), [a], '回收站小而完整，随读视图一起给');
  assert.equal(view.userMeta[a].rating, 5, '非目录域不受瘦身影响');
  assert.deepEqual(view.favorites, [a]);

  const full = await storage.load();
  assert.equal(full.catalogPaged, undefined, '不带参数时保持旧全量视图');
  assert.equal(JSON.parse(full.values[MAIN_STATE_KEY]).models.length, 2);
  assert.equal(storage.dbStatus().writer, 'db');
  assert.equal((await storage.catalogPage(0, 100)).items.length, 2);
  assert.deepEqual((await storage.catalogUids()).uids, [d, b]);
});

test('单一写入权威：主 blob 落盘无目录、纯目录 blob 不抹用户域、整块重放不复活资产', async t => {
  const dir = await temp(t);
  await createLibraryStorage(dir, downloads, {}).save({[MAIN_STATE_KEY]: blob([model(a, 'A'), model(b, 'B')])});
  const storage = createLibraryStorage(dir, downloads, {catalogSingleWriter: true});
  await storage.save({[MAIN_STATE_KEY]: blob([model(a, 'A'), model(b, 'B')])});

  // 1) 目录字段恒为空，非目录字段仍在。
  const onDisk = JSON.parse(JSON.parse(await fsp.readFile(stateFileFor(dir, MAIN_STATE_KEY), 'utf8')));
  assert.deepEqual(onDisk.models, []);
  assert.deepEqual(onDisk.trashed, []);
  assert.equal(onDisk.userMeta[a].rating, 5);

  // 2) 降级重放发来的「纯目录 blob」只有三字段，不能把评分抹掉。
  await storage.save({[MAIN_STATE_KEY]: JSON.stringify({version: 2, models: [model(a, 'A')], trashed: []})});
  const afterSlim = JSON.parse(JSON.parse(await fsp.readFile(stateFileFor(dir, MAIN_STATE_KEY), 'utf8')));
  assert.equal(afterSlim.userMeta[a].rating, 5, '缺的字段必须从当前快照补齐');
  assert.deepEqual(afterSlim.models, []);

  // 3) 反证：定点作废后再整块重放含 A 的过期目录，DB 不能把 A 复活成 active。
  await storage.withDb(conn => conn.applyAssetOps([{op: 'asset:trash', uid: a}], {actor: 'test'}));
  await storage.save({[MAIN_STATE_KEY]: blob([model(a, 'A'), model(b, 'B')])});
  const catalog = await storage.withDb(conn => conn.readCatalog());
  assert.deepEqual(catalog.models.map(item => item.uid), [b]);
  assert.deepEqual(catalog.trashed.map(item => item.uid), [a]);
  const view = JSON.parse((await storage.load()).values[MAIN_STATE_KEY]);
  assert.deepEqual(view.models.map(item => item.uid), [b], '读视图同样不能被过期 blob 带偏');
});

test('回退开关 catalogSingleWriter:false 时主 blob 保留目录（真实反证）', async t => {
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, downloads, {catalogSingleWriter: false});
  await storage.save({[MAIN_STATE_KEY]: blob([model(a, 'A')])});
  const onDisk = JSON.parse(JSON.parse(await fsp.readFile(stateFileFor(dir, MAIN_STATE_KEY), 'utf8')));
  assert.equal(onDisk.models.length, 1, '关掉开关后确实回到旧双轨，不是空操作');
  assert.equal(storage.dbStatus().writer, 'legacy');
});

test('前端补页：首屏一页 + 后台补齐，基准同步不会误判删除', async () => {
  const pages = [
    {items: [model(a, 'A'), model(b, 'B')], total: 3, nextOffset: 2},
    {items: [model(c, 'C')], total: 3, nextOffset: 3},
  ];
  const calls = [];
  const request = async (url, opt = {}) => {
    calls.push({url, opt});
    const respond = data => ({ok: true, status: 200, json: async () => data});
    if (url.startsWith('/api/library-state?catalog=paged')) return respond({
      values: {[MAIN_STATE_KEY]: blob([])}, recovered: [], scanIndex: false,
      catalogPaged: true, catalogTotal: 3,
    });
    if (url.startsWith('/api/library/catalog/page')) {
      const offset = Number(new URL(url, 'http://local').searchParams.get('offset')) || 0;
      return respond(pages[offset ? 1 : 0]);
    }
    return respond({saved: true});
  };
  const storage = await createPersistentStorage(null, request, {catalogPaged: true});
  assert.deepEqual(storage.catalogModels.map(item => item.uid), [a, b], '首屏只拿第一页就返回');
  await storage.catalogReady;
  assert.deepEqual(storage.catalogModels.map(item => item.uid), [a, b, c], '后台补齐剩余页');

  let delivered = [];
  storage.setCatalogPageHandler(items => { delivered.push(...items); });
  assert.deepEqual([...new Set(delivered.map(item => item.uid))], [a, b, c], '启动期已到的页必须补发给 state');

  // 完整目录写回 + 一次真实评分改动：基准与已补齐目录一致，绝不能出现「删除」信号，
  // 评分改动仍应走用户域定点通道，而不是被基准同步整条吞掉。
  const changed = JSON.parse(blob([model(a, 'A'), model(b, 'B'), model(c, 'C')]));
  changed.userMeta[a].rating = 4;
  storage.setItem(MAIN_STATE_KEY, JSON.stringify(changed));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls.some(call => call.url === '/api/library/assets/remove'), false,
    '按页补齐不能把尚未加载的资产误判成删除');
  assert.equal(calls.some(call => call.url === '/api/library/tags/mutate' && call.opt.method === 'POST'), true,
    '真实的用户域改动仍要发出去');
});

test('分页接口挂掉时整块重放，不白屏', async () => {
  const calls = [];
  const request = async (url, opt = {}) => {
    calls.push(url);
    const respond = data => ({ok: true, status: 200, json: async () => data});
    if (url.startsWith('/api/library-state?catalog=paged')) return respond({
      values: {[MAIN_STATE_KEY]: blob([])}, recovered: [], scanIndex: false,
      catalogPaged: true, catalogTotal: 2,
    });
    if (url.startsWith('/api/library/catalog/page')) return {ok: false, status: 503, json: async () => ({})};
    if (url === '/api/library-state' && !opt.method) return respond({values: {[MAIN_STATE_KEY]: blob([model(a, 'A'), model(b, 'B')])}});
    return respond({saved: true});
  };
  const storage = await createPersistentStorage(null, request, {catalogPaged: true});
  await storage.catalogReady;
  assert.deepEqual(storage.catalogModels.map(item => item.uid), [a, b]);
  assert.equal(calls.filter(url => url === '/api/library-state').length, 1, '确实重放了整块 GET');
});
