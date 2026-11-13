// PSD 预览生成：素材包里成堆的 .psd 要能在缩略图墙上显示，靠的就是这个转码器。
// 这里用「手工拼一个最小 PSD」来验证解码路径，不依赖真机上的大文件。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { psdToPng } from '../server/psd-preview.mjs';

/** 造一个 8bit、未压缩（RAW）、平面排列的 PSD。 */
function buildPsd({ width, height, channels, depth = 8, colorMode = 3, planes }) {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 'latin1');
  header.writeUInt16BE(1, 4);                  // version 1 = PSD
  header.writeUInt16BE(channels, 12);
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(depth, 22);
  header.writeUInt16BE(colorMode, 24);
  const sections = Buffer.alloc(12);            // 色彩模式 / 图像资源 / 图层，全空
  const compression = Buffer.alloc(2);          // 0 = RAW
  return Buffer.concat([header, sections, compression, ...planes]);
}

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
  assert.equal(buffer.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('RGB PSD 转成 PNG，尺寸按 maxSize 缩放', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'psd-preview-'));
  const width = 4, height = 2;
  const plane = Buffer.alloc(width * height, 120);
  const file = path.join(dir, 'rgb.psd');
  await fsp.writeFile(file, buildPsd({ width, height, channels: 3, planes: [plane, plane, plane] }));

  const out = await psdToPng(file, { maxSize: 2 });
  const size = pngSize(out.buffer);
  assert.deepEqual(size, { width: 2, height: 1 });

  // 这个模块只管转码，缓存由 thumb-cache.mjs 负责：重复调用结果必须一致。
  const again = await psdToPng(file, { maxSize: 2 });
  assert.equal(again.buffer.length, out.buffer.length);
});

test('16 位灰度 PSD（alpha 蒙版的常见形态）也能解', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'psd-preview-'));
  const width = 4, height = 4;
  // 16bit 大端：高字节决定 8bit 结果，所以高字节填 0x80 就是中灰。
  const plane = Buffer.alloc(width * height * 2);
  for (let i = 0; i < plane.length; i += 2) plane[i] = 0x80;
  const file = path.join(dir, 'gray16.psd');
  await fsp.writeFile(file, buildPsd({ width, height, channels: 1, depth: 16, colorMode: 1, planes: [plane] }));

  const out = await psdToPng(file, { maxSize: 64 });
  assert.deepEqual(pngSize(out.buffer), { width, height });
  // colorType 0 = 灰度：灰度素材没必要走 RGB，文件体积差三倍。
  assert.equal(out.buffer[25], 0);
});

test('不是 PSD 的文件明确报错，不会吐出半个 PNG', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'psd-preview-'));
  const file = path.join(dir, 'fake.psd');
  await fsp.writeFile(file, 'not a photoshop file at all');
  await assert.rejects(() => psdToPng(file, { maxSize: 64 }), /PSD/);
  assert.equal(fs.existsSync(file), true);
});
