import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {probeThirdPartyLibrary, importEagleLibrary} from '../server/import-eagle.mjs';

const downloads = {snapshot: () => ({jobs: []})};

async function temp(t, prefix = 'assetvault-eagle-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, {recursive: true, force: true}));
  return dir;
}

/** 造一个 Eagle 库：一条新格式（.info 目录）+ 一条旧格式（.info 文件）。 */
async function makeEagleLibrary(t) {
  const root = path.join(await temp(t, 'eagle-lib-'), 'Demo.billfish');
  await fsp.mkdir(path.join(root, 'images', 'ITEM1.info'), {recursive: true});
  await fsp.writeFile(path.join(root, 'metadata.json'), JSON.stringify({
    folders: [{id: 'f1', name: '角色', children: [{id: 'f2', name: '主角', children: []}]}],
  }));
  await fsp.writeFile(path.join(root, 'images', 'ITEM1.info', 'metadata.json'), JSON.stringify({
    id: 'ITEM1', name: 'knight', ext: 'png', tags: ['盔甲', '写实'], star: 4, annotation: '主角概念图', folders: ['f2'], btime: 1700000000000,
  }));
  await fsp.writeFile(path.join(root, 'images', 'ITEM1.info', 'ITEM1.png'), 'thumb-1');
  await fsp.writeFile(path.join(root, 'images', 'ITEM1.info', 'knight.png'), 'original-1');
  await fsp.writeFile(path.join(root, 'images', 'ITEM2.info'), JSON.stringify({
    id: 'ITEM2', name: 'sword', ext: 'jpg', tags: ['武器'], star: 2, folders: ['f1'], mtime: 1700000001000,
  }));
  await fsp.writeFile(path.join(root, 'images', 'ITEM2.jpg'), 'original-2');
  await fsp.writeFile(path.join(root, 'images', 'ITEM2.png'), 'thumb-2');
  return root;
}

test('探测：识别库根、数条目与文件夹', async t => {
  const root = await makeEagleLibrary(t);
  const probe = await probeThirdPartyLibrary(root);
  assert.equal(probe.items, 2);
  assert.equal(probe.folders, 2);
  assert.equal(probe.name, 'Demo');
  assert.ok(probe.samples.length >= 1);
});

test('探测：选中父目录也能下探到 .billfish 库', async t => {
  const root = await makeEagleLibrary(t);
  const probe = await probeThirdPartyLibrary(path.dirname(root));
  assert.equal(probe.root, root);
  assert.equal(probe.items, 2);
});

test('探测：不像库的目录直接报错', async t => {
  const dir = await temp(t, 'not-a-lib-');
  await assert.rejects(() => probeThirdPartyLibrary(dir), /不像 Eagle/);
});

test('导入：复制原图与缩略图，标签星级备注与文件夹一起入库', async t => {
  const root = await makeEagleLibrary(t);
  const dataDir = await temp(t, 'eagle-data-');
  const storage = createLibraryStorage(dataDir, downloads, {});
  const addedRoots = [];
  const importRoots = {add: folder => { addedRoots.push(folder); return {added: true, root: folder}; }};

  const report = await importEagleLibrary({folder: root, dataDir, importRoots, storage});
  assert.equal(report.added, 2);
  assert.equal(report.collections, 2);
  assert.equal(report.skipped, 0);

  // 文件真的落到 imports 下，按 Eagle 文件夹层级分目录
  const knight = path.join(dataDir, 'imports', 'Demo', '角色', '主角', 'knight.png');
  assert.equal(fs.readFileSync(knight, 'utf8'), 'original-1');
  assert.deepEqual(addedRoots, [path.join(dataDir, 'imports')]);

  const catalog = await storage.withDb(conn => ({
    models: conn.readCatalog().models,
    user: conn.readUserDomain(),
  }));
  assert.equal(catalog.models.length, 2);
  const knightModel = catalog.models.find(model => model.name === 'knight');
  assert.ok(knightModel);
  assert.match(knightModel.uid, /^[a-f0-9]{32}$/);
  assert.equal(knightModel.fileExists, true);
  assert.ok(knightModel.thumbnail.includes('/api/local/thumb?'));
  assert.deepEqual(knightModel.categories.sort(), ['主角', '角色'].sort());

  // 用户域：标签、星级、备注都作为种子写进去了
  assert.deepEqual(catalog.user.userTags[knightModel.uid].slice().sort(), ['写实', '盔甲'].sort());
  assert.equal(catalog.user.userMeta[knightModel.uid].rating, 4);
  assert.equal(catalog.user.userMeta[knightModel.uid].note, '主角概念图');
});

test('导入：跳过已删除条目，不因单个坏条目整批失败', async t => {
  const root = await makeEagleLibrary(t);
  await fsp.writeFile(path.join(root, 'images', 'ITEM3.info'), JSON.stringify({id: 'ITEM3', name: 'gone', ext: 'png', isDeleted: true}));
  await fsp.writeFile(path.join(root, 'images', 'ITEM3.png'), 'x');
  const dataDir = await temp(t, 'eagle-data-');
  const storage = createLibraryStorage(dataDir, downloads, {});
  const report = await importEagleLibrary({folder: root, dataDir, storage, importRoots: {add() {}}});
  assert.equal(report.added, 2);
  assert.equal(report.skipped, 1);
});

test('导入：重复导入同一个库不会产生重复资产', async t => {
  const root = await makeEagleLibrary(t);
  const dataDir = await temp(t, 'eagle-data-');
  const storage = createLibraryStorage(dataDir, downloads, {});
  const first = await importEagleLibrary({folder: root, dataDir, storage, importRoots: {add() {}}});
  const second = await importEagleLibrary({folder: root, dataDir, storage, importRoots: {add() {}}});
  assert.equal(first.added, 2);
  const catalog = await storage.withDb(conn => conn.readCatalog());
  assert.equal(catalog.models.length, 2);
  assert.equal(second.added, 2); // upsert 语义：仍然写两次，但库里的行数不变
});
