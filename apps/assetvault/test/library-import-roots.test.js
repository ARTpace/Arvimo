import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createImportRoots} from '../server/import-roots.mjs';

test('导入根：添加、幂等、持久化、移除、失效根只跳过不丢配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-import-roots-'));
  const asset = path.join(dir, '素材库');
  fs.mkdirSync(asset);
  try {
    const roots = createImportRoots(dir);
    assert.deepEqual(roots.list(), []);

    const added = roots.add(asset);
    assert.equal(added.added, true);
    assert.equal(added.root, path.resolve(asset));
    assert.equal(added.roots.length, 1);
    assert.equal(roots.add(asset).added, false, '同一个目录重复导入应幂等');

    assert.deepEqual(createImportRoots(dir).list(), [path.resolve(asset)], '重启后导入根仍在');
    assert.throws(() => roots.add('相对路径'), /完整路径/);
    assert.throws(() => roots.add('\\\\server\\share'), /完整路径/);
    assert.throws(() => roots.add(path.join(dir, '不存在')), /不存在/);
    assert.deepEqual(roots.valid(), [path.resolve(asset)]);

    fs.rmSync(asset, {recursive: true, force: true});
    assert.deepEqual(roots.valid(), [], '磁盘断开时扫描应跳过');
    assert.equal(roots.list().length, 1, '但不能把用户配置删掉');

    assert.equal(roots.remove(asset).removed, true);
    assert.equal(roots.remove(asset).removed, false);
    assert.deepEqual(createImportRoots(dir).list(), [], '移除也要持久化');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('断链重连：离线只标状态不删配置，换根后重扫即可恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-import-relink-'));
  const oldRoot = path.join(dir, '旧盘', '素材库');
  const newRoot = path.join(dir, '新盘', '素材库');
  fs.mkdirSync(oldRoot, {recursive: true});
  fs.mkdirSync(newRoot, {recursive: true});
  try {
    const roots = createImportRoots(dir);
    roots.add(oldRoot);
    assert.deepEqual(roots.status().map(item => item.online), [true]);

    // 拔盘：配置留着，状态转离线，原因能说清。
    fs.rmSync(path.join(dir, '旧盘'), {recursive: true, force: true});
    const offline = roots.status();
    assert.equal(offline[0].online, false);
    assert.equal(offline[0].reason, 'missing');
    assert.equal(typeof offline[0].offlineSince, 'number');
    assert.equal(roots.list().length, 1, '离线不等于删除配置');
    assert.deepEqual(roots.valid(), [], '离线根不参与扫描');

    // 重新定位：旧根换新根，配置持久化。
    const relinked = roots.relink(oldRoot, newRoot);
    assert.equal(relinked.relinked, true);
    assert.deepEqual(relinked.roots, [path.resolve(newRoot)]);
    assert.deepEqual(createImportRoots(dir).list(), [path.resolve(newRoot)], '换根要落盘');
    assert.equal(roots.status()[0].online, true);

    assert.throws(() => roots.relink(oldRoot, newRoot), /不在导入列表/);
    assert.throws(() => roots.relink(newRoot, path.join(dir, '无处')), /不存在/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
