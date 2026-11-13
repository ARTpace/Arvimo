// ADR-15：语义索引的契约验收。
//
// 守四件事：
//   1) 构建只做增量 —— 文本没变的资产第二次整批跳过；
//   2) 文本变了必须重算（靠 hash，而不是「有没有向量」）；
//   3) 搜索按余弦排序，低分（<0.15）不返回，否则「全库都像」；
//   4) 找相似排除自身，没配向量模型时明确报错而不是静默空结果。
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';
import {createVectorIndex, vectorTextOf, hashTextOf} from '../server/vector-index.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
// tags 刻意不含「石」字：否则三条资产的标签都会把 dim1 填满，相似度就分不出来了。
const model = (uid, name, note = '') => ({uid, name, note, platform: 'sketchfab', tags: ['statue'], addedAt: 1});
const blob = models => JSON.stringify({
  version: 2, models, trashed: [], favorites: [], aiTags: {}, userTags: {}, userMeta: {}, history: [], tasks: [], options: {},
});

/** 确定性假向量：「龙」占第 0 维、「石」占第 1 维。相同措辞 = 相同方向。 */
const fakeAI = embedModel => ({
  settings: async () => ({enabled: true, embedModel}),
  embed: async texts => texts.map(text => Float32Array.from([
    /龙|dragon/i.test(text) ? 1 : 0,
    /石|stone/i.test(text) ? 1 : 0,
    0.1,
  ])),
});

async function seed(t, models = [model(a, '青龙雕像', '一条盘旋的青龙'), model(b, '花岗岩石墩'), model(c, '龙纹石碑', '龙与石')]) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'assetvault-vectors-'));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  const storage = createLibraryStorage(dir, {snapshot: () => ({jobs: []})}, {});
  await storage.save({[MAIN_STATE_KEY]: blob(models)});
  return storage;
}

test('向量文本只取人看得见的字段，日志类不进 embedding', () => {
  const text = vectorTextOf({name: '青龙', note: '备注', logs: ['secret-log'], verification: {x: 1}}, ['石材', '写实']);
  assert.match(text, /青龙/);
  assert.match(text, /石材/);
  assert.doesNotMatch(text, /secret-log/);
  assert.equal(hashTextOf(text), hashTextOf(text));
  assert.notEqual(hashTextOf(text), hashTextOf(`${text} `));
});

test('增量构建：首次全建，二次全跳过，文本变了只重算那一条', async t => {
  const storage = await seed(t);
  const index = createVectorIndex({storage, ai: fakeAI('fake-embed')});

  const first = await index.build({batch: 8, maxBatches: 5});
  assert.equal(first.embedded, 3);
  assert.equal(first.remaining, 0);
  assert.equal(first.skipped, 0);

  const second = await index.build({batch: 8, maxBatches: 5});
  assert.equal(second.embedded, 0);
  assert.equal(second.skipped, 3);

  // 改备注 → hash 变 → 必须重算，且只重算这一条。
  const changed = await storage.mutateTags([{op: 'asset.set', uid: a, field: 'note', value: '备注改了'}]);
  assert.equal(changed.applied, 1);
  assert.equal((await index.status()).pending, 1);
  const third = await index.build({batch: 8, maxBatches: 5});
  assert.equal(third.embedded, 1);
  assert.equal(third.skipped, 2);

  const status = await index.status();
  assert.equal(status.vectors, 3);
  assert.equal(status.pending, 0);
  assert.equal(status.ready, true);
});

test('真实标注入口：备注覆盖与清空、用户/AI 标签增删只使目标 hash 失效', async t => {
  const storage = await seed(t);
  const sent = [];
  const ai = fakeAI('fake-embed');
  const index = createVectorIndex({storage, ai: {...ai, embed: async texts => {
    sent.push(...texts);
    return ai.embed(texts);
  }}});
  const hashes = () => storage.withDb(db => db.all('SELECT uid, hash FROM asset_vectors ORDER BY uid'));
  await index.build();
  const initial = await hashes();
  const mutate = async ops => {
    const result = await storage.mutateTags(ops);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.applied, 1);
    assert.equal((await index.status()).pending, 1);
    assert.equal((await index.search('龙')).uids.includes(a), false, 'dirty 旧向量不得继续参与搜索');
    await assert.rejects(() => index.similar(a), /还没有语义向量/);
    assert.equal((await index.similar(b)).uids.includes(a), false, 'dirty 旧向量不得作为相似命中');
    sent.length = 0;
    const built = await index.build();
    assert.equal(built.embedded, 1);
    assert.equal(built.skipped, 2);
    assert.equal((await index.status()).pending, 0);
    assert.equal(sent.length, 1);
    const current = await hashes();
    assert.deepEqual(current.filter(row => row.uid !== a), initial.filter(row => row.uid !== a));
    return current.find(row => row.uid === a).hash;
  };
  const changedHash = await mutate([
    {op: 'asset.set', uid: a, field: 'note', value: '全新石材备注'},
    {op: 'tag.add', uid: a, value: 'stone-personal', source: 'user'},
    {op: 'tag.add', uid: a, value: 'stone-ai', source: 'ai'},
  ]);
  assert.match(sent[0], /全新石材备注/);
  assert.match(sent[0], /stone-personal/);
  assert.match(sent[0], /stone-ai/);
  assert.doesNotMatch(sent[0], /一条盘旋的青龙/);
  assert.equal(changedHash, hashTextOf(sent[0]));
  const hit = await index.search('石');
  assert.ok(hit.uids.includes(a));
  assert.equal(hit.items.find(item => item.uid === a).note, '全新石材备注');
  const clearedHash = await mutate([
    {op: 'asset.set', uid: a, field: 'note', value: ''},
    {op: 'tag.remove', uid: a, value: 'stone-personal', source: 'user'},
    {op: 'tag.remove', uid: a, value: 'stone-ai', source: 'ai'},
  ]);
  assert.notEqual(clearedHash, changedHash);
  assert.equal(clearedHash, hashTextOf(sent[0]));
  assert.doesNotMatch(sent[0], /备注：|stone-personal|stone-ai|一条盘旋的青龙/);
  assert.equal((await index.search('石')).uids.includes(a), false);
  const raw = await storage.withDb(db => db.all('SELECT payload, note FROM assets WHERE uid = ?', [a])[0]);
  assert.equal(JSON.parse(raw.payload).note, '一条盘旋的青龙', '保留旧 payload 以证明空用户列没有回退');
  assert.equal(raw.note, '');
  // rating / favorite 不参与文本，不能仅凭 rev 递增误报 pending。
  await storage.mutateTags([{op: 'asset.set', uid: a, field: 'rating', value: 4}]);
  assert.equal((await index.status()).pending, 0);
});

test('语义搜索按相似度排序，低分不返回', async t => {
  const storage = await seed(t);
  const index = createVectorIndex({storage, ai: fakeAI('fake-embed')});
  await index.build({batch: 8, maxBatches: 5});

  const hit = await index.search('龙', {limit: 10});
  assert.deepEqual(hit.uids, [a, c]);            // 纯龙 > 龙+石；只含石的那条被 0.15 门槛挡掉
  assert.ok(hit.scores[0] > hit.scores[1]);

  const none = await index.search('完全不相关的东西');
  assert.deepEqual(none.uids, []);               // 查询向量与所有资产正交 → 空结果而不是全库
});

test('找相似排除自身，缺模型 / 缺向量时给明确原因', async t => {
  const storage = await seed(t);
  const index = createVectorIndex({storage, ai: fakeAI('fake-embed')});
  await assert.rejects(() => index.similar(a), /还没有语义向量/);
  await index.build({batch: 8, maxBatches: 5});

  const near = await index.similar(a, {limit: 5});
  assert.equal(near.uids.includes(a), false);
  assert.equal(near.uids[0], c);                 // 龙纹石碑与青龙最接近，花岗岩垫底或落选

  const off = createVectorIndex({storage, ai: fakeAI('')});
  await assert.rejects(() => off.search('龙'), /向量模型/);
  await assert.rejects(() => off.build(), /向量模型/);
});

test('分页扫描限制 payload / tags 读取，批次数耗尽后准确报告 remaining', async t => {
  const models = Array.from({length: 145}, (_, i) => model(i.toString(16).padStart(32, '0'), `资产 ${i}`));
  const storage = await seed(t, models);
  const reads = [];
  const bounded = {...storage, withDb: handler => storage.withDb(db => handler({...db, all(sql, args) {
    if (/\bpayload\b/.test(sql)) assert.match(sql, /LIMIT|WHERE uid =/i, '禁止整库读取 payload');
    if (/FROM tags\b/i.test(sql)) {
      assert.match(sql, /WHERE uid (?:IN|=)/i, '禁止整库读取 tags');
      assert.ok(args.length <= 64, '每次只读取有界 UID 范围的标签');
    }
    const rows = db.all(sql, args);
    if (/\bpayload\b/.test(sql)) reads.push(rows.length);
    return rows;
  }}))};
  const calls = [];
  const ai = fakeAI('fake-embed');
  const index = createVectorIndex({storage: bounded, ai: {...ai, embed: async texts => {
    calls.push(texts.length);
    return ai.embed(texts);
  }}});
  const first = await index.build({batch: 7.9, maxBatches: 2.9});
  assert.equal(first.scanned, 145);
  assert.equal(first.embedded, 14);
  assert.equal(first.remaining, 131);
  assert.deepEqual(calls, [7, 7]);
  assert.equal((await index.status()).pending, 131);
  const next = await index.build({batch: 7, maxBatches: 30});
  assert.equal(next.embedded, 131);
  assert.equal(next.skipped, 14);
  assert.equal(next.remaining, 0);
  assert.ok(reads.every(count => count <= 64));
  assert.equal((await index.status()).pending, 0);
});

test('模型返回无效向量不计成功，等待期间编辑不提交旧文本', async t => {
  const storage = await seed(t);
  const invalid = createVectorIndex({storage, ai: {...fakeAI('fake-embed'), embed: async () => []}});
  const bad = await invalid.build({batch: 2});
  assert.equal(bad.embedded, 0);
  assert.equal(bad.failed, 2);
  assert.equal(bad.remaining, 1);
  assert.equal((await invalid.status()).pending, 3);
  const ai = fakeAI('fake-embed');
  let changed = false;
  const index = createVectorIndex({storage, ai: {...ai, embed: async texts => {
    if (!changed) {
      changed = true;
      await storage.mutateTags([{op: 'asset.set', uid: a, field: 'note', value: '等待期间的新备注'}]);
    }
    return ai.embed(texts);
  }}});
  const built = await index.build({batch: 3});
  assert.equal(built.embedded, 2);
  assert.equal(built.remaining, 1);
  assert.equal((await index.status()).pending, 1);
  assert.equal((await index.build()).embedded, 1);
  await storage.withDb(db => db.run("UPDATE assets SET state = 'trashed' WHERE uid = ?", [a]));
  const status = await index.status();
  assert.equal(status.assets, 2);
  assert.equal(status.vectors, 2);
  assert.equal(status.pending, 0);
});

test('坏 payload 不列入可构建 pending，模型切换不将旧模型结果计入就绪', async t => {
  const storage = await seed(t);
  await storage.withDb(db => db.run('UPDATE assets SET payload = ? WHERE uid = ?', ['{broken', a]));
  let active = 'old-model';
  const ai = fakeAI('old-model');
  const index = createVectorIndex({storage, ai: {
    settings: async () => ({enabled: true, embedModel: active}),
    embed: async texts => { active = 'new-model'; return ai.embed(texts); },
  }});
  assert.equal((await index.status()).pending, 2);
  const built = await index.build();
  assert.equal(built.broken, 1);
  assert.equal(built.embedded, 2);
  assert.equal(built.model, 'old-model');
  const status = await index.status();
  assert.equal(status.model, 'new-model');
  assert.equal(status.vectors, 0);
  assert.equal(status.pending, 2);
});

test('换向量模型后旧向量不参与，状态显示为「未建」', async t => {
  const storage = await seed(t);
  const index = createVectorIndex({storage, ai: fakeAI('fake-embed')});
  await index.build({batch: 8, maxBatches: 5});

  const other = createVectorIndex({storage, ai: fakeAI('another-embed')});
  const status = await other.status();
  assert.equal(status.vectors, 0);
  assert.equal(status.pending, 3);
  // 旧模型的向量还在表里（可再生派生数据，不急着删），但不属于当前模型。
  const rows = await storage.withDb(conn => conn.all('SELECT model, count(*) AS n FROM asset_vectors GROUP BY model'));
  assert.equal(rows.length, 1);
});
