import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDragStage, expandDragFiles} from '../server/drag-stage.mjs';

async function scratch(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-drag-asset-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return dir;
}

/** 造一个图片包的落盘结构：<bundle>/images/01-a.png + info.json（与真实交付一致）。 */
async function bundle(root, count = 3) {
  const dir = path.join(root, '落日-images');
  await fs.mkdir(path.join(dir, 'images'), {recursive: true});
  for (let i = 1; i <= count; i += 1) {
    await fs.writeFile(path.join(dir, 'images', `${String(i).padStart(2, '0')}-p${i}.png`), 'PNG');
  }
  await fs.writeFile(path.join(dir, 'info.json'), '{"uid":"u"}');
  await fs.writeFile(path.join(dir, '.info-live-x.tmp'), 'half-written');
  return dir;
}

test('导入资产无下载任务时拖出原文件，保留扩展名并拒绝缺失/越界', async t => {
  const {createAssetResolver} = await import('../server/drag-asset.mjs');
  const root = await scratch(t);
  const file = path.join(root, '素材.psd'); await fs.writeFile(file, 'original');
  const resolve = createAssetResolver({
    findAsset: async uid => uid === 'imported' ? {filePath: file} : null,
    resolveImported: async model => model.filePath,
  });
  assert.deepEqual(await resolve({uid:'imported'}), [file]);
  await fs.unlink(file);
  await assert.rejects(resolve({uid:'imported'}), /原文件不存在/);
  const denied = createAssetResolver({findAsset:async()=>({filePath:file}),resolveImported:async()=>{throw Error('未登记');}});
  await assert.rejects(denied({uid:'x'}), /未登记/);
});

const stageFor = (dir, overrides = {}) => createDragStage({
  dir,
  fetchRemote: async () => { throw Error('这组用例不走远端'); },
  resolveLocal: async ({rel}) => `H:/library/${rel}`,
  resolveAsset: async ({uid}) => uid === 'nope' ? [] : [`H:/library/${uid}/a.png`],
  isAllowedHost: () => true,
  ...overrides,
});

test('图片包目录摊成里面的每一张图，跳过清单与临时文件', async t => {
  const root = await scratch(t);
  const dir = await bundle(root, 5);
  const files = await expandDragFiles(dir);
  assert.equal(files.length, 5, 'info.json 和 .tmp 都不该被当成图片拖出去');
  assert.deepEqual(files.map(f => path.basename(f)), ['01-p1.png', '02-p2.png', '03-p3.png', '04-p4.png', '05-p5.png']);
  for (const file of files) assert.ok(file.startsWith(dir), '必须是绝对路径，CF_HDROP 只认磁盘路径');
});

test('单个模型文件原样返回，不拆包；不存在的路径给空数组', async t => {
  const root = await scratch(t);
  const zip = path.join(root, 'robot.zip');
  await fs.writeFile(zip, 'ZIP');
  assert.deepEqual(await expandDragFiles(zip), [zip]);
  assert.deepEqual(await expandDragFiles(path.join(root, 'missing.zip')), []);
  assert.deepEqual(await expandDragFiles(''), []);
});

test('图片数量按上限截断，不会把几百张一次塞给系统', async t => {
  const root = await scratch(t);
  const dir = await bundle(root, 6);
  assert.equal((await expandDragFiles(dir, {maxItems: 2})).length, 2);
});

test('asset 条目由服务端展开成多个路径，全部进入拖放清单', async t => {
  const dir = await scratch(t);
  const stage = stageFor(dir, {resolveAsset: async ({uid}) => [`H:/library/${uid}/1.png`, `H:/library/${uid}/2.png`]});
  const result = await stage.resolve([{type: 'asset', uid: 'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu'}]);
  assert.deepEqual(result.files, ['H:/library/uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu/1.png', 'H:/library/uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu/2.png']);
});

test('asset 条目解析不出文件时如实报错，而不是静默成功', async t => {
  const dir = await scratch(t);
  const throwing = stageFor(dir, {resolveAsset: async () => { throw Error('这个资产还没导出到本地'); }});
  await assert.rejects(throwing.resolve([{type: 'asset', uid: 'x'}]), /还没导出到本地/);
  // 展开成空数组也一样：不能让系统拖出一份空清单
  await assert.rejects(stageFor(dir).resolve([{type: 'asset', uid: 'nope'}]), /没有可拖出的文件/);
});

test('一次拖 64 张图集图片仍然放行（对齐图片包 60 张上限）', async t => {
  const dir = await scratch(t);
  const stage = stageFor(dir, {resolveAsset: async () => Array.from({length: 64}, (_, i) => `H:/p/${i}.png`)});
  const result = await stage.resolve([{type: 'asset', uid: 'big'}]);
  assert.equal(result.files.length, 64);
});

test('资产解析器：已保存的图集摊成整组图片，3D 包原样给', async t => {
  const {createAssetResolver} = await import('../server/drag-asset.mjs');
  const root = await scratch(t);
  const dir = await bundle(root, 3);
  const zip = path.join(root, 'robot.zip');
  await fs.writeFile(zip, 'ZIP');
  const jobs = [
    {uid: 'a'.repeat(32), kind: 'images', state: 'saved', filePath: dir},
    {uid: 'b'.repeat(32), kind: 'sketchfab', state: 'saved', filePath: zip},
  ];
  const resolve = createAssetResolver({jobs: () => jobs});
  const images = await resolve({uid: 'a'.repeat(32)});
  assert.equal(images.length, 3, '图片包要给出全部图片，不是那层目录');
  assert.deepEqual(await resolve({uid: 'b'.repeat(32)}), [zip]);
});

test('资产解析器：失败 / 未保存的任务不算可拖，只认最新一条', async t => {
  const {createAssetResolver} = await import('../server/drag-asset.mjs');
  const uid = 'c'.repeat(32);
  const jobs = [
    {uid, kind: 'images', state: 'saved', filePath: 'H:/old', fileExists: false},
    {uid, kind: 'images', state: 'saved', filePath: 'H:/new', fileExists: true},
    {uid, kind: 'images', state: 'failed', filePath: 'H:/bad'},
  ];
  const calls = [];
  const resolve = createAssetResolver({jobs: () => jobs, expand: async target => { calls.push(target); return [`${target}/1.png`]; }});
  assert.deepEqual(await resolve({uid}), ['H:/new/1.png'], 'fileExists=false 的旧记录不能被选中');
  assert.deepEqual(calls, ['H:/new']);
});

test('资产解析器：没有下载任务时回到磁盘扫描结果里按 uid 找目录', async t => {
  const {createAssetResolver} = await import('../server/drag-asset.mjs');
  const uid = 'd'.repeat(32);
  const calls = [];
  const resolve = createAssetResolver({
    jobs: () => [],
    roots: () => ['H:/library'],
    scanPackages: async roots => {
      calls.push(roots);
      return [{uid, root: 'H:/library', rel: 'packs/foo'}];
    },
    expand: async (target, options) => { calls.push([target, options.maxItems]); return ['H:/library/packs/foo/a.png']; },
  });
  assert.deepEqual(await resolve({uid}), ['H:/library/packs/foo/a.png']);
  assert.deepEqual(calls[0], ['H:/library']);
  assert.deepEqual(calls[1], [path.join('H:/library', 'packs', 'foo'), 64]);
});

test('资产解析器：查不到就给出可读原因，别静默返回空', async t => {
  const {createAssetResolver} = await import('../server/drag-asset.mjs');
  const resolve = createAssetResolver({jobs: () => [], roots: () => [], scanPackages: async () => []});
  await assert.rejects(resolve({uid: 'e'.repeat(32)}), /还没导出到本地/);
  await assert.rejects(resolve({}), /缺少资产 ID/);
});
