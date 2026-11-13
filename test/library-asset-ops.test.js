// 阶段 5.1 / ADR-05：asset:* 定点写的契约验收。
//
// 守三件事：
//   1) op 校验在解析阶段就拒绝非法请求，不会写进队列再炸；
//   2) 定点写只动目标资产 + 派生表，整块 blob 一个字节都不改（5.2/5.3 的前提）；
//   3) rev 乐观锁、position/state 保持、用户域不被旧 blob 覆盖、删除清干净派生行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {normalizeAssetOps, AssetOpRejected, MAX_ASSET_OPS} from '../server/library-asset-ops.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32), d = 'd'.repeat(32);
const main = {
  version: 2,
  models: [
    {uid: a, name: '国风石灯', author: 'Artist', platform: 'sketchfab', tags: ['stone'], ext: 'fbx', addedAt: 111},
    {uid: b, name: 'Robot', platform: 'artstation', tags: ['mech'], ext: 'glb', addedAt: 222},
  ],
  aiTags: {}, userTags: {}, userMeta: {[a]: {rating: 4, note: '项目A'}},
  favorites: [b], trashed: [], history: [], tasks: [], options: {},
};

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assetvault-assetops-'));
  const blob = JSON.stringify(main);
  const db = createLibraryDb({Database, file: path.join(dir, 'library.db')});
  db.writeValues({[MAIN_STATE_KEY]: blob}, {stamp: 1000});
  return {db, dir, blob, cleanup: () => { db.close(); fs.rmSync(dir, {recursive: true, force: true}); }};
}

// ------------------------------------------------------------------ 校验层
test('三种 op 都接受，单条简写也能用，uid 以 op 为准', () => {
  const ops = normalizeAssetOps({ops: [
    {op: 'asset:add', uid: c, model: {uid: 'wrong', name: 'Phoenix'}},
    {op: 'asset:patch', uid: a, patch: {name: '石灯改'}, rev: 2},
    {op: 'asset:remove', uid: b},
  ]});
  assert.deepEqual(ops.map(item => item.op), ['asset:add', 'asset:patch', 'asset:remove']);
  assert.equal(ops[0].model.uid, c, 'model 里写错的 uid 必须被 op.uid 覆盖');
  assert.equal(ops[1].rev, 2);
  assert.equal(normalizeAssetOps({op: 'asset:remove', uid: b})[0].uid, b);
});

test('非法 op / uid / rev / patch 字段一律拒绝', () => {
  const bad = [
    {}, {ops: []}, {ops: [{op: 'tag.add', uid: a}]},
    {ops: [{op: 'asset:add', uid: ''}]}, {ops: [{op: 'asset:add', uid: 'x\u0001y'}]},
    {ops: [{op: 'asset:add', uid: c, model: null}]},
    {ops: [{op: 'asset:patch', uid: a, patch: {}}]},
    {ops: [{op: 'asset:patch', uid: a, patch: {state: 'trashed'}}]},
    {ops: [{op: 'asset:patch', uid: a, patch: {trashedAt: 1}}]},
    {ops: [{op: 'asset:patch', uid: a, patch: {__proto__: {polluted: true}}}]},
    {ops: [{op: 'asset:patch', uid: a, patch: {name: {nested: 1}}}]},
    {ops: [{op: 'asset:remove', uid: a, rev: -1}]},
    {ops: Array.from({length: MAX_ASSET_OPS + 1}, () => ({op: 'asset:remove', uid: a}))},
  ];
  for (const input of bad) assert.throws(() => normalizeAssetOps(input), AssetOpRejected);
});

// ------------------------------------------------------------------ DB 端到端
test('add / patch / remove 只动目标行，blob 字节不变，FTS 与用户域同步', () => {
  const {db, blob, cleanup} = fresh();
  try {
    const before = db.native().prepare('SELECT position, rev, rating, note FROM assets WHERE uid = ?').get(a);
    const add = db.applyAssetOps([
      {op: 'asset:add', uid: c, model: {uid: c, name: 'Phoenix', platform: 'artstation', tags: ['bird'], ext: 'glb', addedAt: 333}},
    ], {actor: 'test'});
    assert.equal(add.applied, 1);
    assert.equal(add.conflicts.length, 0);
    assert.equal(db.native().prepare('SELECT count(*) n FROM assets').get().n, 3);
    assert.equal(db.native().prepare('SELECT value FROM state_meta WHERE key = ?').get(MAIN_STATE_KEY).value, blob,
      '定点写绝不许改整块 blob');
    const rowC = db.native().prepare('SELECT position, state, rev, rating FROM assets WHERE uid = ?').get(c);
    assert.equal(rowC.state, 'active');
    assert.equal(rowC.rev, 1);
    assert.ok(rowC.position < before.position, '新增资产应稳居最前');
    assert.equal(db.native().prepare("SELECT count(*) n FROM assets_fts WHERE assets_fts MATCH 'Phoenix'").get().n, 1,
      '新资产必须能被全文检索命中');

    const patched = db.applyAssetOps([
      {op: 'asset:patch', uid: a, patch: {name: '国风石灯改'}, rev: before.rev},
    ], {actor: 'test'});
    assert.equal(patched.applied, 1);
    const rowA = db.native().prepare('SELECT position, rev, rating, note, payload FROM assets WHERE uid = ?').get(a);
    assert.equal(JSON.parse(rowA.payload).name, '国风石灯改');
    assert.equal(rowA.position, before.position, 'patch 不许把资产顶到最前');
    assert.equal(rowA.rev, before.rev + 1);
    assert.equal(rowA.rating, 4, '用户域权威在 DB，不能被旧 blob 覆盖');
    assert.equal(rowA.note, '项目A');

    const removed = db.applyAssetOps([{op: 'asset:remove', uid: b}], {actor: 'test'});
    assert.equal(removed.applied, 1);
    assert.equal(db.native().prepare('SELECT count(*) n FROM assets').get().n, 2);
    assert.equal(db.native().prepare('SELECT count(*) n FROM tags WHERE uid = ?').get(b).n, 0);
    assert.equal(db.native().prepare('SELECT count(*) n FROM asset_tags WHERE uid = ?').get(b).n, 0);
    assert.equal(db.native().prepare('SELECT count(*) n FROM asset_formats WHERE uid = ?').get(b).n, 0);
    const actions = db.native().prepare('SELECT action FROM audit_log ORDER BY at, action').all().map(row => row.action);
    assert.ok(actions.includes('asset:add') && actions.includes('asset:patch') && actions.includes('asset.remove'));
  } finally { cleanup(); }
});

test('rev 冲突只跳过那一条，其余照常应用；重复 add 幂等', () => {
  const {db, cleanup} = fresh();
  try {
    const model = {uid: d, name: 'Dup', tags: ['dup'], addedAt: 444};
    db.applyAssetOps([{op: 'asset:add', uid: d, model}]);
    db.applyAssetOps([{op: 'asset:add', uid: d, model}]);
    assert.equal(db.native().prepare('SELECT count(*) n FROM assets WHERE uid = ?').get(d).n, 1);

    const rev = db.native().prepare('SELECT rev FROM assets WHERE uid = ?').get(d).rev;
    const result = db.applyAssetOps([
      {op: 'asset:patch', uid: d, patch: {name: '过期的改名'}, rev: rev - 1},
      {op: 'asset:patch', uid: a, patch: {name: '同时改这个'}},
    ]);
    assert.equal(result.applied, 1);
    assert.deepEqual(result.conflicts.map(item => item.code), ['rev_conflict']);
    assert.notEqual(JSON.parse(db.native().prepare('SELECT payload FROM assets WHERE uid = ?').get(d).payload).name, '过期的改名');
    assert.equal(JSON.parse(db.native().prepare('SELECT payload FROM assets WHERE uid = ?').get(a).payload).name, '同时改这个');
  } finally { cleanup(); }
});

test('删不存在的资产与 patch 不存在的资产只回冲突，不抛异常', () => {
  const {db, cleanup} = fresh();
  try {
    const result = db.applyAssetOps([
      {op: 'asset:remove', uid: d},
      {op: 'asset:patch', uid: d, patch: {name: 'ghost'}},
    ]);
    assert.equal(result.applied, 0);
    assert.deepEqual(result.conflicts.map(item => item.code), ['not_found', 'not_found']);
    assert.equal(db.native().prepare('SELECT count(*) n FROM assets').get().n, 2);
  } finally { cleanup(); }
});
