// 缩略图缓存：所有预览图都从这里出，所以三件事必须有回归——
// 能不能把 PNG 正确缩小、同一个文件第二次是不是走缓存、缓存满了会不会按最久未用淘汰。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// 独立缓存目录：必须在 import 之前设好，模块里是顶层常量。
const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-cache-test-'));
process.env.ASSETVAULT_THUMB_DIR = cacheDir;
const { thumbFor, decodePng, trimCache, canThumb, cacheStats } = await import('../server/thumb-cache.mjs');
const { encodePng } = await import('../server/psd-preview.mjs');

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] };
}

/** 造一张纯色图（每个平面填同一个值），尺寸与通道可选。 */
function makeImage(width, height, planes, fill = 128) {
  return planes.map(() => {
    const plane = new Uint8Array(width * height);
    plane.fill(fill);
    return plane;
  });
}

test('PNG 缩略图按目标宽度缩小，第二次命中缓存', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'rgb.png');
  await fsp.writeFile(file, encodePng(64, 32, 2, makeImage(64, 32, [0, 0, 0])));

  const first = await thumbFor(file, { width: 32 });
  assert.deepEqual(pngSize(first.buffer), { width: 32, height: 16, colorType: 2 });
  assert.equal(first.cached, false);

  const second = await thumbFor(file, { width: 32 });
  assert.equal(second.cached, true, '源文件没变就该直接读缓存');
  assert.equal(second.buffer.length, first.buffer.length);
});

test('不同宽度各自缓存一份，粒度不互相顶掉', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'rgb.png');
  await fsp.writeFile(file, encodePng(64, 64, 2, makeImage(64, 64, [0, 0, 0])));

  const small = await thumbFor(file, { width: 32 });
  const large = await thumbFor(file, { width: 64 });
  assert.deepEqual(pngSize(small.buffer), { width: 32, height: 32, colorType: 2 });
  assert.deepEqual(pngSize(large.buffer), { width: 64, height: 64, colorType: 2 });
});

test('源文件改了（mtime 变化）就不再吃老缓存', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'vary.png');
  await fsp.writeFile(file, encodePng(64, 64, 2, makeImage(64, 64, [0, 0, 0])));
  await thumbFor(file, { width: 32 });

  await fsp.writeFile(file, encodePng(64, 64, 2, makeImage(64, 64, [0, 0, 0], 200)));
  await fsp.utimes(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const again = await thumbFor(file, { width: 32 });
  assert.equal(again.cached, false);
});

test('灰度 PNG 仍编码成灰度（体积是 RGB 的三分之一）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'gray.png');
  await fsp.writeFile(file, encodePng(32, 32, 0, makeImage(32, 32, [0])));
  const out = await thumbFor(file, { width: 32 });
  assert.equal(pngSize(out.buffer).colorType, 0);
});

test('带透明通道的 PNG 保留 alpha', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const file = path.join(dir, 'rgba.png');
  await fsp.writeFile(file, encodePng(32, 32, 6, makeImage(32, 32, [0, 0, 0, 0], 90)));
  const decoded = decodePng(await fsp.readFile(file));
  assert.equal(decoded.kind, 'rgba');
  const out = await thumbFor(file, { width: 32 });
  assert.equal(pngSize(out.buffer).colorType, 6);
});

test('不认识的格式直接拒绝，让端点回落到原文件', async () => {
  assert.equal(canThumb('a.png'), true);
  assert.equal(canThumb('a.PSD'), true);
  assert.equal(canThumb('a.jpg'), true);
  assert.equal(canThumb('a.svg'), false);
  await assert.rejects(() => thumbFor('whatever.txt', { width: 32 }), /不生成缩略图/);
});

test('缓存超过上限时按最久未用淘汰', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-src-'));
  const files = [];
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, `p${i}.png`);
    // 每张用不同尺寸，保证 size 足够大、并且各自一份缓存。
    await fsp.writeFile(file, encodePng(64, 64, 2, makeImage(64, 64, [0, 0, 0], i * 20)));
    files.push(file);
    await thumbFor(file, { width: 64 });
  }
  const names = (await fsp.readdir(cacheDir)).filter(name => name.endsWith('.png'));
  assert.ok(names.length >= 4, `缓存里应该有多份结果，实际 ${names.length}`);

  // 把最早那份的时间戳压到最早，模拟「很久没被读过」。
  const oldest = path.join(cacheDir, names[0]);
  await fsp.utimes(oldest, new Date(2000, 1, 1), new Date(2000, 1, 1));
  const stats = await cacheStats();
  // 上限设成「现有总量的一半」，必然触发淘汰。
  const removed = await trimCache(Math.floor(stats.bytes / 2));
  assert.ok(removed > 0, '超过上限应该删掉一些');
  assert.equal(fs.existsSync(oldest), false, '最久未用的那份应该被删掉');
  assert.ok((await cacheStats()).bytes <= stats.bytes / 2 * 0.9 + 1);
});
