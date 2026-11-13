// ADR-10：整库导出 / 导入的契约验收。
//
// 守四件事：
//   1) 导出是 DB 权威（资产 + 回收站 + 合集），用户域作为「种子」并入每条资产；
//   2) 导入合并到空库：资产、回收站、合集、评分/备注/收藏/我的标签都能落地；
//   3) 导入合并到已有库：已存在 uid 的本地评分/备注不被旧快照覆盖（反证）；
//   4) 形状不对的快照整份拒绝，replace 才清空，且清空后只剩快照内容。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {MAX_MODEL_BYTES, normalizeAssetOps} from '../server/library-asset-ops.mjs';
import {MAIN_STATE_KEY, USER_STATE_KEY, SESSION_STATE_KEY} from '../server/library-schema.mjs';
import {saveCollection, setCollectionItems} from '../server/library-collections.mjs';
import {exportLibrary, importLibrary, normalizeSnapshot, PortableRejected, PORTABLE_FORMAT} from '../server/library-portable.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
const model = (uid, name) => ({uid, name, platform: 'sketchfab', tags: ['stone'], addedAt: 1});
const downloads = {snapshot: () => ({jobs: []})};
const blob = (models, trashed = []) => JSON.stringify({
  version: 2, models, trashed, favorites: [], aiTags: {}, userTags: {}, userMeta: {}, history: [], tasks: [], options: {},
});

async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'assetvault-portable-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

/** 预热一个库：A 带完整用户域，B 在回收站，另有一个合集。 */
async function seed(t) {
  const dir = await temp(t);
  const storage = createLibraryStorage(dir, downloads, {});
  await storage.save({[MAIN_STATE_KEY]: blob([model(a, 'A'), model(b, 'B')], [model(c, 'C')])});
  await storage.withDb(conn => {
    conn.applyAssetOps([{
      op: 'asset:patch', uid: a,
      patch: {rating: 5, note: '项目A', favorite: 1, userTags: ['主角']},
    }], {actor: 'test'});
    const id = saveCollection(conn, {id: 'col-a', name: '场景合集'});
    setCollectionItems(conn, id, [a, b], 'add');
  });
  return {dir, storage};
}

test('导出：DB 权威 + 用户域种子 + 合集 uid', async t => {
  const {storage} = await seed(t);
  const snapshot = await exportLibrary({storage, now: 1700000000000});

  assert.equal(snapshot.format, PORTABLE_FORMAT);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.exportedAt, 1700000000000);
  assert.deepEqual(snapshot.counts, {assets: 2, trashed: 1, collections: 1});

  const first = snapshot.assets.find(item => item.uid === a);
  assert.equal(first.rating, 5, '评分作为种子带出去');
  assert.equal(first.note, '项目A');
  assert.equal(first.favorite, 1);
  assert.deepEqual(first.userTags, ['主角']);

  const collection = snapshot.collections[0];
  assert.equal(collection.id, 'col-a');
  assert.deepEqual(collection.uids.slice().sort(), [a, b].sort());
  assert.equal(collection.assetCount, undefined, '派生的 assetCount 不进快照');
  assert.ok(snapshot.user && typeof snapshot.user === 'object', '完整用户域保留给人工核对');
});

test('导出时间：默认时钟和注入函数均输出可序列化的数值', async t => {
  const {storage} = await seed(t);
  const before = Date.now();
  const snapshot = await exportLibrary({storage});
  assert.equal(typeof snapshot.exportedAt, 'number');
  assert.ok(snapshot.exportedAt >= before && snapshot.exportedAt <= Date.now());
  assert.equal(JSON.parse(JSON.stringify(snapshot)).exportedAt, snapshot.exportedAt);
  assert.equal((await exportLibrary({storage, now: () => 1700000000123})).exportedAt, 1700000000123);
});

test('合并导入到空库：资产 / 回收站 / 合集 / 用户域种子全部落地', async t => {
  const {storage} = await seed(t);
  const snapshot = await exportLibrary({storage});

  const targetDir = await temp(t);
  const target = createLibraryStorage(targetDir, downloads, {});
  const report = await importLibrary({storage: target, payload: snapshot, mode: 'merge', actor: 'test'});

  assert.equal(report.added, 3, '回收站里的资产也先 add');
  assert.equal(report.trashed, 1);
  assert.equal(report.collections, 1);

  const catalog = await target.withDb(conn => conn.readCatalog());
  assert.deepEqual(catalog.models.map(item => item.uid).sort(), [a, b].sort());
  assert.deepEqual(catalog.trashed.map(item => item.uid), [c]);

  const user = await target.withDb(conn => conn.readUserDomain());
  assert.equal(user.userMeta[a].rating, 5, '新库首次入库采纳种子评分');
  assert.equal(user.userMeta[a].note, '项目A');
  assert.ok(user.favorites.includes(a));
  // 用户标签随首次入库的种子一起进来（deriveTagRows 认 model.userTags）；
  // 已存在的资产不吃种子，保留本机标签 —— 下面那条反证守的就是这个边界。
  assert.deepEqual(user.userTags[a], ['主角']);

  const collections = await target.withDb(conn => conn.all('SELECT collection_id, name FROM collections'));
  assert.deepEqual(collections.map(row => row.collection_id), ['col-a']);
});

test('反证：合并导入不覆盖已有资产的本机评分 / 备注', async t => {
  const source = await seed(t);
  const snapshot = await exportLibrary({storage: source.storage});

  const targetDir = await temp(t);
  const target = createLibraryStorage(targetDir, downloads, {});
  await target.save({[MAIN_STATE_KEY]: blob([model(a, 'A 本地版')])});
  // 本机评分必须走用户域通道写：asset:patch 按协作保护规则不碰 rating / note 这三列，
  // 用它构造「本地值」只会得到 0，反证就成了假绿。
  await target.withDb(conn => conn.applyUserSeeds([{uid: a, rating: 2, note: '本地笔记'}], {now: 1000}));

  await importLibrary({storage: target, payload: snapshot, mode: 'merge', actor: 'test'});
  const user = await target.withDb(conn => conn.readUserDomain());
  assert.equal(user.userMeta[a].rating, 2, '本机评分是权威，不能被旧快照改回 5');
  assert.equal(user.userMeta[a].note, '本地笔记');
});

test('replace：先清空再导入，旧资产不残留', async t => {
  const source = await seed(t);
  const snapshot = await exportLibrary({storage: source.storage});

  const targetDir = await temp(t);
  const target = createLibraryStorage(targetDir, downloads, {});
  await target.save({[MAIN_STATE_KEY]: blob([model(d, '待清理')])});

  const report = await importLibrary({storage: target, payload: snapshot, mode: 'replace', actor: 'test'});
  assert.equal(report.removed, 1);

  const catalog = await target.withDb(conn => conn.readCatalog());
  assert.equal(catalog.models.some(item => item.uid === d), false, '清空后不该有旧资产');
  assert.deepEqual(catalog.models.map(item => item.uid).sort(), [a, b].sort());
});

test('形状不对的快照整份拒绝；父合集缺失时降级为根节点', async () => {
  assert.throws(() => normalizeSnapshot({format: 'other', version: 1}), PortableRejected);
  assert.throws(() => normalizeSnapshot({format: PORTABLE_FORMAT, version: 99}), PortableRejected);
  assert.throws(() => normalizeSnapshot({
    format: PORTABLE_FORMAT, version: 1, assets: [{uid: '不是uid'}], trashed: [],
  }), PortableRejected);

  const snapshot = normalizeSnapshot({
    format: PORTABLE_FORMAT, version: 1,
    assets: [{uid: a, name: 'A'}], trashed: [],
    collections: [{id: 'child', name: '子集', parentId: 'missing', uids: [a]}],
  });
  assert.equal(snapshot.collections[0].parentId, 'missing');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'assetvault-portable-'));
  try {
    const storage = createLibraryStorage(dir, downloads, {});
    const report = await importLibrary({storage, payload: {
      format: PORTABLE_FORMAT, version: 1, assets: [{uid: a, name: 'A'}], trashed: [],
      collections: [{id: 'child', name: '子集', parentId: 'missing', uids: [a]}],
    }, mode: 'merge'});
    assert.equal(report.collections, 1);
    const row = await storage.withDb(conn => conn.all('SELECT parent_id FROM collections WHERE collection_id = ?', ['child']));
    assert.equal(row[0].parent_id, null, '缺失的父合集降级为根节点，而不是整份导入失败');
  } finally {
    await fsp.rm(dir, {recursive: true, force: true});
  }
});

test('快照里带 _remoteOnly 的运行时标记不会进库', async () => {
  const snapshot = normalizeSnapshot({
    format: PORTABLE_FORMAT, version: 1,
    assets: [{uid: a, name: 'A', _remoteOnly: true}], trashed: [],
  });
  assert.equal(Object.hasOwn(snapshot.assets[0], '_remoteOnly'), false);
});

const emptySnapshot = () => ({format: PORTABLE_FORMAT, version: 1, assets: [], trashed: [], collections: []});
const dump = conn => Object.fromEntries(conn.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .map(({name}) => [name, conn.all(`SELECT * FROM "${name}"`).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));

test('replace 完整清理旧回收站/合集/规则/派生，保留原件与主机配置，空库重启不复活', async t => {
  const {dir, storage} = await seed(t);
  const original = path.join(dir, 'original.bin');
  await fsp.writeFile(original, 'keep original');
  await storage.save({[SESSION_STATE_KEY]: JSON.stringify({options: {host: 'keep'}, history: ['keep']})});
  await storage.withDb(conn => saveCollection(conn, {id: 'smart-old', name: '智能', smart: {q: 'old'}}));
  const report = await importLibrary({storage, payload: emptySnapshot(), mode: 'replace'});
  assert.equal(report.removed, 3, 'active 和 trash 都计入替换');
  for (const target of [storage, createLibraryStorage(dir, downloads, {})]) {
    const snapshot = await exportLibrary({storage: target});
    assert.deepEqual(snapshot.counts, {assets: 0, trashed: 0, collections: 0});
    const view = JSON.parse((await target.load()).values[MAIN_STATE_KEY]);
    assert.deepEqual(view.models, []);
    assert.deepEqual(view.trashed, []);
    assert.deepEqual(view.userMeta, {});
    assert.equal(view.options.host, 'keep');
    await target.save({[SESSION_STATE_KEY]: JSON.stringify({options: {host: 'keep'}, history: ['next']})});
    assert.deepEqual((await exportLibrary({storage: target})).counts, {assets: 0, trashed: 0, collections: 0});
  }
  await storage.withDb(conn => {
    for (const table of ['assets', 'tags', 'asset_tags', 'asset_formats', 'asset_vectors', 'assets_fts',
      'collections', 'collection_assets', 'smart_collections', 'tag_counts', 'content_tags']) {
      assert.equal(conn.all(`SELECT count(*) AS n FROM ${table}`)[0].n, 0, table);
    }
  });
  assert.equal(await fsp.readFile(original, 'utf8'), 'keep original');
});

test('replace 同 uid 不继承旧用户域，逆序父子合集正常恢复', async t => {
  const {storage} = await seed(t);
  await storage.save({[USER_STATE_KEY]: JSON.stringify({userMeta: {[a]: {note: 'old', rating: 5}}, userTags: {[a]: ['old']}, favorites: [a], aiTags: {}})});
  await importLibrary({storage, mode: 'replace', payload: {...emptySnapshot(), assets: [model(a, 'fresh')], collections: [
    {id: 'child', parentId: 'parent', name: 'child', uids: [a]},
    {id: 'parent', name: 'parent', uids: []},
  ]}});
  const user = await storage.withDb(conn => conn.readUserDomain());
  assert.equal(user.userMeta[a]?.note || '', '');
  assert.deepEqual(user.userTags[a] || [], []);
  assert.deepEqual(user.favorites, []);
  assert.equal((await storage.withDb(conn => conn.all("SELECT parent_id FROM collections WHERE collection_id = 'child'")))[0].parent_id, 'parent');
});

for (const mode of ['replace', 'merge']) test(`${mode} 中途失败：资产/合集/用户域/版本戳/审计整库回滚`, async t => {
  const {storage} = await seed(t);
  const before = await storage.withDb(dump);
  const failing = Object.create(storage);
  failing.withDbWrite = handler => storage.withDbWrite(conn => {
    const original = conn.applyUserSeeds;
    conn.applyUserSeeds = (...args) => {
      original(...args);
      throw Error('injected midway failure');
    };
    return handler(conn);
  });
  await assert.rejects(importLibrary({storage: failing, mode, payload: {
    ...emptySnapshot(), assets: [{...model(d, 'new'), note: 'new seed'}],
  }}), /injected midway failure/);
  assert.deepEqual(await storage.withDb(dump), before);
});

test('合集写入失败也回滚已完成资产批次与合集变更', async t => {
  const {storage} = await seed(t);
  const before = await storage.withDb(dump);
  const failing = Object.create(storage);
  failing.withDbWrite = handler => storage.withDbWrite(conn => {
    const run = conn.run.bind(conn);
    conn.run = (sql, ...args) => {
      const result = run(sql, ...args);
      if (/INSERT INTO collections/.test(sql)) throw Error('injected collection failure');
      return result;
    };
    return handler(conn);
  });
  await assert.rejects(importLibrary({storage: failing, mode: 'replace', payload: {
    ...emptySnapshot(), assets: [model(d, 'new')], collections: [{id: 'new-col', name: 'new', uids: [d]}],
  }}), /injected collection failure/);
  assert.deepEqual(await storage.withDb(dump), before);
});

test('无效快照在任何排队/写入前拒绝，数据库零变更', async t => {
  const {storage} = await seed(t);
  const before = await storage.withDb(dump);
  for (const patch of [{assets: undefined}, {trashed: {}}, {collections: [null]},
    {assets: [model(d, 'd'), model(d, 'duplicate')]}, {collections: [{id: 'x', name: ''}]}]) {
    await assert.rejects(importLibrary({storage, mode: 'replace', payload: {...emptySnapshot(), ...patch}}), PortableRejected);
  }
  assert.deepEqual(await storage.withDb(dump), before);
});

test('资产 UTF-8 字节精确边界与真实 asset-ops 一致，ASCII / Unicode 合法', () => {
  const overhead = Buffer.byteLength(JSON.stringify({uid: d, name: ''}), 'utf8');
  for (const unit of ['x', '中']) {
    const budget = MAX_MODEL_BYTES - overhead;
    const width = Buffer.byteLength(unit, 'utf8');
    const name = unit.repeat(Math.floor(budget / width)) + 'x'.repeat(budget % width);
    const item = {uid: d, name};
    assert.equal(Buffer.byteLength(JSON.stringify(item), 'utf8'), MAX_MODEL_BYTES);
    const normalized = normalizeSnapshot({...emptySnapshot(), assets: [item]}).assets[0];
    assert.deepEqual(normalized, item);
    assert.deepEqual(normalizeAssetOps({ops: [{op: 'asset:add', uid: d, model: normalized}]})[0].model, item);
    assert.throws(() => normalizeSnapshot({...emptySnapshot(), assets: [{...item, name: name + 'x'}]}), PortableRejected);
  }
});

test('非 ASCII 字符数未超限但 UTF-8 字节超限，replace / merge 均零排队零写入', async t => {
  const {storage} = await seed(t);
  const before = await storage.withDb(dump);
  const item = {uid: d, name: '中'.repeat(Math.floor(MAX_MODEL_BYTES / 3))};
  assert.ok(JSON.stringify(item).length < MAX_MODEL_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(item), 'utf8') > MAX_MODEL_BYTES);
  assert.throws(() => normalizeAssetOps({ops: [{op: 'asset:add', uid: d, model: item}]}), /超过/);
  let queued = 0;
  const guarded = Object.create(storage);
  guarded.withDbWrite = () => { queued += 1; throw Error('unexpected write queue'); };
  for (const mode of ['replace', 'merge']) {
    await assert.rejects(importLibrary({storage: guarded, mode, payload: {...emptySnapshot(), assets: [item]}}), PortableRejected);
  }
  assert.equal(queued, 0);
  assert.deepEqual(await storage.withDb(dump), before);
});

test('整库事务与其他 storage 写共享队列，嵌套 op 使用 savepoint 不自锁', async t => {
  const {storage} = await seed(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const transaction = storage.withDbWrite(async conn => {
    conn.applyAssetOps([{op: 'asset:add', uid: d, model: model(d, 'queued')}]);
    enter();
    await gate;
  });
  await entered;
  let exclusiveRan = false;
  const exclusive = storage.exclusive(() => { exclusiveRan = true; });
  const replace = importLibrary({storage, mode: 'replace', payload: emptySnapshot()});
  await Promise.resolve();
  assert.equal(exclusiveRan, false);
  release();
  await Promise.all([transaction, exclusive, replace]);
  assert.equal(exclusiveRan, true);
  assert.equal((await exportLibrary({storage})).counts.assets, 0);
});
