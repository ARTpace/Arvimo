// S3-a：集合语义写入的正确性验收。
//
// 这组用例守的是三件事：
//   1. **集合语义**：打标签是「加一个」不是「整组替换」，重复提交幂等。
//   2. **定点写**：只动受影响的资产，派生表不重建，别人的改动不被抹掉。
//   3. **blob 与派生表一致**：同一批 op 作用在两边，结果必须对得上。
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {normalizeTagOps, applyOpsToState, TagWriteRejected} from '../server/library-tags-write.mjs';

const U = n => `${String(n).padStart(32, 'a')}`;
const uidA = U(1), uidB = U(2);

const state = {
  version: 2,
  models: [
    {uid: uidA, name: '国风石灯', author: 'Alice', platform: 'sketchfab', assetType: 'model', ext: 'fbx',
      tags: ['stone'], addedAt: 1000},
    {uid: uidB, name: '橡木椅', author: 'Bob', platform: 'artstation', assetType: 'model', ext: 'glb',
      tags: ['oak'], addedAt: 2000},
  ],
  aiTags: {[uidA]: ['石材']},
  userTags: {[uidB]: ['常用']},
  userMeta: {[uidA]: {rating: 3, note: '主力石材'}},
  favorites: [],
  trashed: [],
};

const makeDb = () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  db.writeValues({'sfx-library-v2': JSON.stringify(state)}, {replace: true});
  return db;
};

test('校验：非法 op 一律拒绝，且拒绝原因可区分', () => {
  assert.throws(() => normalizeTagOps({}), TagWriteRejected);
  assert.throws(() => normalizeTagOps({ops: [{op: 'tag.add', uid: 'x', value: '木'}]}), /uid 无效/);
  assert.throws(() => normalizeTagOps({ops: [{op: 'tag.add', uid: uidA, value: ''}]}), /标签值无效/);
  assert.throws(() => normalizeTagOps({ops: [{op: 'tag.add', uid: uidA, value: '木', source: 'x'}]}), /来源无效/);
  assert.throws(() => normalizeTagOps({ops: [{op: 'asset.set', uid: uidA, field: 'payload'}]}), /不支持修改的字段/);
  assert.throws(() => normalizeTagOps({ops: [{op: 'asset.set', uid: uidA, field: 'rating', value: 9}]}), /0~5/);
  // 平台标签由采集器维护，用户删了它下次采集又回来 —— 直接拒绝比「删了又冒出来」好。
  assert.throws(() => normalizeTagOps({ops: [{op: 'tag.remove', uid: uidA, value: 'stone', source: 'platform'}]}), /平台标签不可删除/);
  assert.throws(() => normalizeTagOps({ops: new Array(900).fill({op: 'tag.add', uid: uidA, value: '木'})}), /超限/);
});

test('打标签是集合语义：只加不减，重复提交幂等', () => {
  const db = makeDb();
  try {
    const before = db.raw('SELECT count(*) AS n FROM asset_tags')[0].n;
    const ops = normalizeTagOps({ops: [{op: 'tag.add', uid: uidB, value: '木材', source: 'user'}]});
    const first = db.applyTagOps(ops, {actor: 'alice'});
    assert.equal(first.applied, 1);
    assert.deepEqual(first.conflicts, []);

    const rows = db.raw(`SELECT source, count(*) AS n FROM asset_tags WHERE uid = '${uidB}' GROUP BY source`);
    assert.ok(rows.some(row => row.source === 'user'), '新标签应写入 user 来源');

    // 幂等：重复提交不产生重复行，也不报错。
    const again = db.applyTagOps(ops, {actor: 'alice'});
    assert.equal(again.applied, 1);
    const userCount = db.raw(`SELECT count(*) AS n FROM asset_tags WHERE uid = '${uidB}' AND source = 'user'`)[0].n;
    assert.equal(userCount, 2, '重复提交不应产生重复行');
    assert.ok(db.raw(`SELECT count(*) AS n FROM asset_tags`)[0].n > before);
  } finally { db.close(); }
});

test('删除标签：按原始值与归一化值都能删干净，界面上不会留下残影', () => {
  const db = makeDb();
  try {
    // 库里存的是 'oak'，词表标准名是 '橡木'。两种写法都要能删。
    db.applyTagOps(normalizeTagOps({ops: [{op: 'tag.add', uid: uidB, value: '橡木', source: 'user'}]}), {actor: 'bob'});
    assert.ok(db.raw(`SELECT count(*) AS n FROM tags WHERE uid = '${uidB}' AND kind = 'user' AND tag = '橡木'`)[0].n > 0);

    db.applyTagOps(normalizeTagOps({ops: [{op: 'tag.remove', uid: uidB, value: '橡木', source: 'user'}]}), {actor: 'bob'});
    assert.equal(db.raw(`SELECT count(*) AS n FROM tags WHERE uid = '${uidB}' AND kind = 'user' AND tag = '橡木'`)[0].n, 0);
    assert.equal(db.raw(`SELECT count(*) AS n FROM asset_tags WHERE uid = '${uidB}' AND source = 'user' AND term_id =
      (SELECT term_id FROM tag_terms WHERE norm = '橡木')`)[0].n, 0);
  } finally { db.close(); }
});

test('检索文本随标签更新，且包含词表标准名与别名', () => {
  const db = makeDb();
  try {
    db.applyTagOps(normalizeTagOps({ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]}), {actor: 'alice'});
    const text = db.raw(`SELECT tags_text FROM assets WHERE uid = '${uidA}'`)[0].tags_text;
    // 原始标签 stone + 词表标准名「石材」+ 别名，检索文本必须都收进去。
    assert.match(text, /stone/);
    assert.match(text, /石材/);
    // 码点序排序（与 SQLite BINARY collation 对齐）
    const tokens = text.split(' ');
    assert.deepEqual([...tokens].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), tokens);
  } finally { db.close(); }
});

test('定点写：只动受影响的资产，别人的改动不被抹掉', () => {
  const db = makeDb();
  try {
    const revA = db.raw(`SELECT rev FROM assets WHERE uid = '${uidA}'`)[0].rev;
    const revB = db.raw(`SELECT rev FROM assets WHERE uid = '${uidB}'`)[0].rev;
    const textB = db.raw(`SELECT tags_text FROM assets WHERE uid = '${uidB}'`)[0].tags_text;

    db.applyTagOps(normalizeTagOps({ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]}), {actor: 'alice'});

    assert.notEqual(db.raw(`SELECT rev FROM assets WHERE uid = '${uidA}'`)[0].rev, revA, '被改的资产 rev 应递增');
    assert.equal(db.raw(`SELECT rev FROM assets WHERE uid = '${uidB}'`)[0].rev, revB, '没被改的资产 rev 不该动');
    assert.equal(db.raw(`SELECT tags_text FROM assets WHERE uid = '${uidB}'`)[0].tags_text, textB, '没被改的资产检索文本不该动');
  } finally { db.close(); }
});

test('asset.set：单值字段带 rev 冲突检测', () => {
  const db = makeDb();
  try {
    const rev = db.raw(`SELECT rev FROM assets WHERE uid = '${uidA}'`)[0].rev;
    const ok = db.applyTagOps(normalizeTagOps({ops: [{op: 'asset.set', uid: uidA, field: 'rating', value: 5, rev}]}), {actor: 'alice'});
    assert.equal(ok.applied, 1);
    assert.equal(db.raw(`SELECT rating FROM assets WHERE uid = '${uidA}'`)[0].rating, 5);

    // 拿旧 rev 再写 → 冲突，拒绝覆盖
    const stale = db.applyTagOps(normalizeTagOps({ops: [{op: 'asset.set', uid: uidA, field: 'rating', value: 1, rev}]}), {actor: 'bob'});
    assert.equal(stale.applied, 0);
    assert.equal(stale.conflicts[0].code, 'rev_conflict');
    assert.equal(db.raw(`SELECT rating FROM assets WHERE uid = '${uidA}'`)[0].rating, 5, '冲突时不得覆盖');
  } finally { db.close(); }
});

test('不存在的资产整条拒绝，不留孤儿行', () => {
  const db = makeDb();
  try {
    const before = db.raw('SELECT count(*) AS n FROM asset_tags')[0].n;
    const result = db.applyTagOps(normalizeTagOps({ops: [{op: 'tag.add', uid: U(9), value: '木材', source: 'user'}]}), {actor: 'x'});
    assert.equal(result.applied, 0);
    assert.equal(result.conflicts[0].code, 'asset_not_found');
    assert.equal(db.raw('SELECT count(*) AS n FROM asset_tags')[0].n, before, '不得留下孤儿 asset_tags 行');
  } finally { db.close(); }
});

test('每次写都留审计行', () => {
  const db = makeDb();
  try {
    db.applyTagOps(normalizeTagOps({ops: [{op: 'tag.add', uid: uidA, value: '木材', source: 'user'}]}), {actor: 'alice'});
    const rows = db.raw('SELECT actor, action, uid FROM audit_log ORDER BY id');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {actor: 'alice', action: 'tag.add', uid: uidA});
  } finally { db.close(); }
});

test('blob 与派生表对同一批 op 的结果一致', () => {
  const db = makeDb();
  try {
    const ops = normalizeTagOps({ops: [
      {op: 'tag.add', uid: uidB, value: '木材', source: 'user'},
      {op: 'tag.remove', uid: uidA, value: '石材', source: 'ai'},
      {op: 'asset.set', uid: uidA, field: 'rating', value: 5},
      {op: 'asset.set', uid: uidB, field: 'favorite', value: true},
    ]});
    const next = applyOpsToState(state, ops);
    db.applyTagOps(ops, {actor: 'alice'});

    // blob 侧
    assert.deepEqual(next.userTags[uidB].sort(), ['常用', '木材'].sort());
    // 删掉最后一个标签后，键应当消失（与前端 delete op 语义一致），而不是留一个空数组。
    assert.equal(next.aiTags[uidA], undefined);
    assert.equal(next.userMeta[uidA].rating, 5);
    assert.ok(next.favorites.includes(uidB));

    // 派生表侧
    const tagsB = db.raw(`SELECT kind, tag FROM tags WHERE uid = '${uidB}' ORDER BY kind`).map(r => r.tag);
    assert.ok(tagsB.includes('木材'));
    assert.ok(!db.raw(`SELECT count(*) AS n FROM tags WHERE uid = '${uidA}' AND kind = 'ai'`)[0].n);
    assert.equal(db.raw(`SELECT rating FROM assets WHERE uid = '${uidA}'`)[0].rating, 5);
    assert.equal(db.raw(`SELECT favorite FROM assets WHERE uid = '${uidB}'`)[0].favorite, 1);
  } finally { db.close(); }
});

test('标签计数物化随之更新', () => {
  const db = makeDb();
  try {
    const termId = db.raw(`SELECT term_id FROM tag_terms WHERE norm = '木材'`)[0]?.term_id;
    const before = db.raw(`SELECT asset_count FROM tag_counts WHERE term_id = ${termId}`)[0]?.asset_count ?? 0;
    db.applyTagOps(normalizeTagOps({ops: [{op: 'tag.add', uid: uidB, value: '木材', source: 'user'}]}), {actor: 'bob'});
    const after = db.raw(`SELECT asset_count FROM tag_counts WHERE term_id = ${termId}`)[0]?.asset_count ?? 0;
    assert.equal(after, before + 1, '计数应随打标递增');
  } finally { db.close(); }
});
