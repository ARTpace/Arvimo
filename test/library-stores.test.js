// ADR-12：多资源库注册表 + dataDir 跟随的契约验收。
//
// 守四件事：
//   1) 注册表不存在时一切照旧（默认库 = %APPDATA%/AssetVault/data）；
//   2) 改选之后 resolveUserPaths() 真的指向新库目录 —— 否则重启也没用；
//   3) 目录不存在 / 目录重复 / 删默认库 / 删正在用的库，都必须被拒绝；
//   4) 注册表文件坏了不能拖垮启动：留档 .invalid，按默认库继续。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveUserPaths} from '../server/data-dir.mjs';
import {
  readStoreRegistry, listStores, createStore, selectStore, renameStore, removeStore,
  StoreRejected, DEFAULT_STORE_ID, REGISTRY_FILE,
} from '../server/store-registry.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assetvault-stores-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

/** base = <tmp>/AssetVault；env 显式给 APPDATA，避免碰到真机目录。 */
const envOf = base => ({APPDATA: path.dirname(base)});
const pathsOf = base => resolveUserPaths(envOf(base), os.homedir());

test('注册表不存在时只有默认库，dataDir 仍是 base/data', t => {
  const root = temp(t);
  const base = path.join(root, 'AssetVault');
  const registry = readStoreRegistry(base);
  assert.equal(registry.activeId, DEFAULT_STORE_ID);
  assert.deepEqual(registry.stores.map(store => store.id), [DEFAULT_STORE_ID]);

  const paths = pathsOf(base);
  assert.equal(paths.base, base);
  assert.equal(paths.dataDir, path.join(base, 'data'));
  assert.equal(paths.downloadDir, path.join(base, 'downloads'));
});

test('新建 / 改选 / 改名 / 移除的完整链路，改选后 resolveUserPaths 跟随', t => {
  const root = temp(t);
  const base = path.join(root, 'AssetVault');
  fs.mkdirSync(path.join(base, 'data'), {recursive: true});

  const store = createStore(base, {name: '工作库'});
  assert.ok(fs.existsSync(store.dataDir), '新库目录要真的建出来');
  assert.match(store.dataDir, /AssetVault[\\/]stores/);

  // 改选前后：active 标记跟着走，但 dataDir 在重启前不变。
  const before = listStores(base, {dataDir: path.join(base, 'data')});
  assert.equal(before.stores.length, 2);
  assert.equal(before.stores.find(item => item.active).id, DEFAULT_STORE_ID);

  const {restartRequired} = selectStore(base, store.id, {dataDir: path.join(base, 'data')});
  assert.equal(restartRequired, true, '换目录必须要求重启');
  const after = listStores(base, {dataDir: path.join(base, 'data')});
  assert.equal(after.activeId, store.id);
  assert.equal(after.stores.find(item => item.selected).id, store.id);
  assert.equal(after.stores.find(item => item.active).id, DEFAULT_STORE_ID, '进程还连着旧库');

  // 重启后才生效：新的 resolveUserPaths 指向新库。
  const paths = pathsOf(base);
  assert.equal(paths.dataDir, store.dataDir);
  assert.equal(paths.activeStoreId, store.id);

  assert.equal(renameStore(base, store.id, '主库').name, '主库');

  // 先切回默认库，才能移除工作库。
  selectStore(base, DEFAULT_STORE_ID, {dataDir: store.dataDir});
  const removed = removeStore(base, store.id, {dataDir: path.join(base, 'data')});
  assert.equal(removed.removed, store.id);
  assert.ok(fs.existsSync(store.dataDir), '移除只摘清单，不删磁盘');
  assert.ok(!readStoreRegistry(base).stores.some(item => item.id === store.id));
});

test('非法操作一律拒绝：重复目录 / 目录不存在 / 删默认库 / 删正在用的库', t => {
  const root = temp(t);
  const base = path.join(root, 'AssetVault');
  fs.mkdirSync(path.join(base, 'data'), {recursive: true});
  const store = createStore(base, {name: '素材库'});

  assert.throws(() => createStore(base, {name: '重复', dir: store.dataDir}), StoreRejected);
  assert.throws(() => selectStore(base, 'store-nope', {dataDir: base}), StoreRejected);

  // 目录被删（U 盘拔了）：改选必须拒绝，而不是起一个指向空气的服务。
  fs.rmSync(store.dataDir, {recursive: true, force: true});
  assert.throws(() => selectStore(base, store.id, {dataDir: path.join(base, 'data')}), StoreRejected);

  assert.throws(() => removeStore(base, DEFAULT_STORE_ID, {dataDir: path.join(base, 'data')}), StoreRejected);
  // 目录没了 → activeStore 退回默认库，此时工作库不再是「正在使用」，但目录不存在也该能移。
  const back = createStore(base, {name: '另一个'});
  selectStore(base, back.id, {dataDir: path.join(base, 'data')});
  assert.throws(() => removeStore(base, back.id, {dataDir: back.dataDir}), StoreRejected);
});

test('注册表文件损坏：留档 .invalid 并退回默认库，不打断启动', t => {
  const root = temp(t);
  const base = path.join(root, 'AssetVault');
  fs.mkdirSync(base, {recursive: true});
  fs.writeFileSync(path.join(base, REGISTRY_FILE), '{ this is not json');

  const registry = readStoreRegistry(base);
  assert.equal(registry.activeId, DEFAULT_STORE_ID);
  assert.equal(registry.stores.length, 1);
  assert.ok(fs.readdirSync(base).some(name => name.startsWith(`${REGISTRY_FILE}.invalid-`)));
  assert.equal(pathsOf(base).dataDir, path.join(base, 'data'));
});

test('选中的库目录消失时回退默认目录（不让服务指向空气）', t => {
  const root = temp(t);
  const base = path.join(root, 'AssetVault');
  fs.mkdirSync(path.join(base, 'data'), {recursive: true});
  const store = createStore(base, {name: '移动硬盘'});
  selectStore(base, store.id, {dataDir: path.join(base, 'data')});
  assert.equal(pathsOf(base).dataDir, store.dataDir);

  fs.rmSync(store.dataDir, {recursive: true, force: true});
  const paths = pathsOf(base);
  assert.equal(paths.dataDir, path.join(base, 'data'));
  assert.equal(paths.activeStoreId, null);
});
