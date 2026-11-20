// 阶段 5.4 / ADR-08：回收站定点 op 的契约验收。
//
// 守四件事：
//   1) 新 op 校验：model 可选、uid 以 op 为准，patch 仍然禁止改 state / trashedAt；
//   2) 翻译层只认「纯移动」：trash / restore / purge 各自拆开，混合改动一律整块；
//   3) 持久化层把 adds + trash + restore 合成一批发，通道挂了整块重放；
//   4) 服务端 state / trashed_at / payload / rev / position 与 blob 双写一致，幂等且不误删用户域。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {normalizeAssetOps, AssetOpRejected} from '../server/library-asset-ops.mjs';
import {createLibraryDb} from '../server/library-db.mjs';
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';
import {translateStateChange} from '../src/library/tag-ops.js';
import {createPersistentStorage} from '../src/library/persistent-storage.js';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
const A = {uid: a, name: '石灯', tags: ['stone'], addedAt: 1};
const B = {uid: b, name: '椅子', tags: ['wood'], addedAt: 2};
const trashedA = {...A, trashedAt: 12345, userMeta: {rating: 4, note: '项目A'}, userTags: ['石']};
const state = (models, trashed = []) => ({
  version: 2, models, trashed, aiTags: {}, userTags: {}, userMeta: {}, favorites: [],
  assetProbe: {}, history: [], tasks: [], options: {},
});
const blob = (models, trashed = []) => JSON.stringify(state(models, trashed));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const local = {getItem: () => null, setItem() {}};

// ------------------------------------------------------------------ 校验层
test('trash / restore 的 model 可选，uid 以 op 为准；patch 仍禁止改 state', () => {
  const ops = normalizeAssetOps({ops: [
    {op: 'asset:trash', uid: a},
    {op: 'asset:restore', uid: b, model: {uid: 'wrong', name: 'Phoenix'}},
  ]});
  assert.equal(ops[0].model, undefined);
  assert.equal(ops[1].model.uid, b, 'model 里写错的 uid 必须被覆盖');
  assert.throws(() => normalizeAssetOps({op: 'asset:patch', uid: a, patch: {state: 'trashed'}}), AssetOpRejected);
  assert.throws(() => normalizeAssetOps({op: 'asset:trash', uid: a, model: 'bad'}), AssetOpRejected);
  assert.throws(() => normalizeAssetOps({op: 'asset:unknown', uid: a}), AssetOpRejected);
});

// ------------------------------------------------------------------ 单卡删除路径守卫
test('单卡删除能访问共享服务端函数，真实执行定点回收站写入',async()=>{
 const src=fs.readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
 const start=src.indexOf('async function trashOnServer(uids){'),setup=src.indexOf('async function setup(){');
 assert.ok(start>=0&&start<setup,'共享删除函数必须在模块作用域，不能藏在 setup 内');
 const end=src.indexOf('async function deleteLibraryAsset(',start),calls=[];
 const context=vm.createContext({state:{},withRemovalMotion:async(cards,run)=>run(),removalCards:()=>[],trashModels(){},persist(){},renderGrid(){},counts(){},toast(){},fetch:async(url,opt)=>calls.push({url,body:JSON.parse(opt.body)})});
 vm.runInContext(src.slice(start,end)+'this.remove=removeAssetCard;',context);
 await context.remove(a);
 assert.deepEqual(calls,[{url:'/api/library/assets/mutate',body:{ops:[{op:'asset:trash',uid:a}]}}]);
});

test('单卡右键「移入回收站」必须同步到服务端，否则刷新后服务端目录会把记录合并回来', () => {
  const src = fs.readFileSync(new URL('../src/library/app.js', import.meta.url), 'utf8');
  const fn = src.match(/async function removeAssetCard\(uid\)\{([\s\S]*?)\n\}/);
  assert.ok(fn, '能定位到 removeAssetCard 单卡删除函数');
  assert.match(fn[1], /trashOnServer\(\[uid\]\)/, '单卡路径必须像批量路径一样写 asset:trash 到 DB');
});

// ------------------------------------------------------------------ 翻译层
test('作废 / 恢复是纯移动 → 拆成定点 op，不回传整块目录', () => {
  const trash = translateStateChange(state([A, B]), state([B], [trashedA]));
  assert.equal(trash.catalog, null);
  assert.deepEqual(trash.adds, []);
  assert.deepEqual(trash.removes, []);
  assert.equal(trash.trash.length, 1);
  assert.equal(trash.trash[0].op, 'asset:trash');
  assert.equal(trash.trash[0].uid, a);
  assert.equal(trash.trash[0].model.trashedAt, 12345);

  const restore = translateStateChange(state([B], [trashedA]), state([B, A]));
  assert.equal(restore.catalog, null);
  assert.deepEqual(restore.removes, [], '恢复不能被误判成彻底删除');
  assert.equal(restore.restore.length, 1);
  assert.equal(restore.restore[0].op, 'asset:restore');
  assert.equal(restore.restore[0].model.uid, a);
  assert.equal(restore.restore[0].model.trashedAt, undefined);
});

test('清空回收站只发 removes；混合改动 / 脏 uid 一律整块 catalog', () => {
  const t1 = {...A, trashedAt: 1}, t2 = {...B, trashedAt: 2};
  const purge = translateStateChange(state([], [t1, t2]), state([], [t1]));
  assert.equal(purge.catalog, null);
  assert.deepEqual(purge.removes, [b]);

  const mixed = [
    state([{...B, name: '改名'}], [trashedA]),                 // 移动同时改了留下的 model
    state([B], []),                                             // uid 凭空消失，既没进回收站也没 purge
    state([B], [{...trashedA, uid: '不是合法 uid'}]),            // 脏 uid
  ];
  for (const after of mixed) {
    const result = translateStateChange(state([A, B]), after);
    assert.equal(typeof result.catalog, 'string');
    assert.deepEqual(result.trash, []);
  }
});

// ------------------------------------------------------------------ 持久化分流
function harness(initial, {assetOpsStatus = 200} = {}) {
  const calls = [];
  const request = async (requestPath, options = {}) => {
    if (requestPath === '/api/library-state' && !options.method) {
      return {ok: true, json: async () => ({values: initial, recovered: [], scanIndex: true})};
    }
    calls.push({path: requestPath, method: options.method, body: options.body ? JSON.parse(options.body) : null});
    if (requestPath === '/api/library/assets/mutate' && assetOpsStatus !== 200) {
      return {ok: false, status: assetOpsStatus, json: async () => ({})};
    }
    return {ok: true, status: 200, json: async () => ({saved: true})};
  };
  return {calls, storagePromise: createPersistentStorage(local, request, {collections: true})};
}

test('作废走 mutate 且不回传整块目录；通道 404 时整块重放', async () => {
  const h = harness({'sfx-library-v2': blob([A, B])});
  const storage = await h.storagePromise;
  storage.setItem('sfx-library-v2', blob([B], [trashedA]));
  await tick();
  const mutate = h.calls.find(call => call.path === '/api/library/assets/mutate');
  assert.ok(mutate);
  assert.equal(mutate.body.ops[0].op, 'asset:trash');
  assert.equal(h.calls.some(call => call.path === '/api/library-state' && call.method === 'POST' && call.body[MAIN_STATE_KEY]), false);

  const broken = harness({'sfx-library-v2': blob([A, B])}, {assetOpsStatus: 404});
  const brokenStorage = await broken.storagePromise;
  brokenStorage.setItem('sfx-library-v2', blob([B], [trashedA]));
  await tick();
  const replay = broken.calls.find(call => call.path === '/api/library-state' && call.method === 'POST');
  assert.ok(replay, '通道挂掉必须把 catalog 改回完整主状态');
  assert.equal(JSON.parse(replay.body[MAIN_STATE_KEY]).trashed.length, 1);
});

// ------------------------------------------------------------------ 服务端
test('trash / restore 改 state + trashed_at、保留 position/rev、syncBlob 同步两个数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assetvault-trash-'));
  const db = createLibraryDb({Database, file: path.join(dir, 'library.db')});
  try {
    db.writeValues({[MAIN_STATE_KEY]: JSON.stringify(state([A, B], []))}, {stamp: 1000});
    const native = db.native();
    const row = uid => native.prepare('SELECT state, trashed_at, rev, position, payload FROM assets WHERE uid = ?').get(uid);
    const readBlob = () => JSON.parse(native.prepare('SELECT value FROM state_meta WHERE key = ?').get(MAIN_STATE_KEY).value);
    const beforePosition = row(a).position;

    const first = db.applyAssetOps([{op: 'asset:trash', uid: a, model: trashedA}], {syncBlob: true});
    assert.equal(first.applied, 1);
    assert.equal(row(a).state, 'trashed');
    assert.ok(row(a).trashed_at, 'trashed_at 必须一起写，不能留下半截状态');
    assert.equal(row(a).position, beforePosition, '移动不该改变排序位置');
    assert.equal(row(a).rev, 2);
    assert.equal(JSON.parse(row(a).payload).trashedAt, 12345);
    assert.equal(readBlob().models.some(item => item.uid === a), false);
    assert.equal(readBlob().trashed.length, 1);
    assert.equal(readBlob().trashed[0].userMeta.rating, 4, '评分快照要随 model 进回收站');

    // 不带 model：服务端从 payload 还原，按页前端也能只发 uid。
    const second = db.applyAssetOps([{op: 'asset:restore', uid: a}], {syncBlob: true});
    assert.equal(second.applied, 1);
    assert.equal(row(a).state, 'active');
    assert.equal(row(a).trashed_at, null);
    assert.equal(JSON.parse(row(a).payload).trashedAt, undefined);
    assert.equal(readBlob().models.length, 2);
    assert.equal(readBlob().trashed.length, 0);

    // 幂等：重复的 trash 收敛到同一状态；不存在的 uid 只回冲突不抛异常。
    const again = db.applyAssetOps([{op: 'asset:trash', uid: a}, {op: 'asset:trash', uid: c}], {syncBlob: true});
    assert.equal(row(a).state, 'trashed');
    assert.deepEqual(again.conflicts.map(item => item.code), ['not_found']);
    assert.equal(native.prepare('SELECT count(*) n FROM assets WHERE uid = ?').get(b).n, 1, '别的资产不能被牵连');
  } finally {
    db.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
