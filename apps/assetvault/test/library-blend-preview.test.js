// .blend 内嵌预览提取 + 封面格式清单的回归测试。
// 夹具全部是现场拼出来的合成文件：不依赖本机装没装 Blender，也不依赖仓库里有没有 .blend 样本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { readBlendPreview, parseBlendBuffer, encodePng, isBlendName } from '../server/blend-preview.mjs';
import { MODEL_EXT, isModelName } from '../server/thumb-cache.mjs';
import { isServerCoverName } from '../server/model-cover.mjs';

/** 旧式 BHead：4 字节块名 + 4 字节长度 + 8 字节指针 + 4 字节 SDNA + 4 字节数量。 */
function block(code, data) {
  const head = Buffer.alloc(24);
  head.write(code, 0, 4, 'latin1');
  head.writeInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
}

function testBlock(width, height, rows) {
  const data = Buffer.alloc(8 + width * height * 4);
  data.writeInt32LE(width, 0);
  data.writeInt32LE(height, 4);
  let offset = 8;
  // rows[0] 是文件里的第一行，也就是**画面底部**那一行（Blender 自下而上存）。
  for (const row of rows) {
    for (const [r, g, b, a] of row) {
      data[offset++] = r; data[offset++] = g; data[offset++] = b; data[offset++] = a;
    }
  }
  return block('TEST', data);
}

function blendFile({ preview = true, endian = 'v', pointer = '-', extra = true } = {}) {
  const header = Buffer.concat([Buffer.from('BLENDER', 'latin1'), Buffer.from(pointer + endian + '405', 'latin1')]);
  const parts = [header, block('REND', Buffer.alloc(72))];
  if (preview) {
    parts.push(testBlock(2, 2, [
      [[255, 0, 0, 255], [255, 0, 0, 255]],   // 文件首行 = 画面底部（红）
      [[0, 255, 0, 255], [0, 255, 0, 255]],   // 文件末行 = 画面顶部（绿）
    ]));
  }
  if (extra) parts.push(block('GLOB', Buffer.alloc(64)));
  return Buffer.concat(parts);
}

/** 从我们自己编的 PNG 里取像素：单 IDAT、每行一个 0 滤波字节。 */
function pngPixels(png) {
  assert.equal(png.readUInt32BE(0), 0x89504e47, '应该是 PNG');
  let offset = 8;
  let width = 0, height = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('latin1');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    assert.equal(raw[start], 0, '我们只写 filter=None');
    rows.push([...raw.subarray(start + 1, start + 1 + stride)]);
  }
  return { width, height, rows };
}

test('.blend 内嵌预览：解析出 128 那种 RGBA 块并翻正行序', () => {
  const parsed = parseBlendBuffer(blendFile());
  assert.ok(parsed);
  assert.equal(parsed.width, 2);
  assert.equal(parsed.height, 2);
  const { rows } = pngPixels(parsed.png);
  // 文件首行是画面底部（红），翻正后第一行应该是文件末行（绿）。
  assert.deepEqual(rows[0].slice(0, 3), [0, 255, 0]);
  assert.deepEqual(rows[1].slice(0, 3), [255, 0, 0]);
});

test('.blend 内嵌预览：半透明像素反预乘', () => {
  const header = Buffer.concat([Buffer.from('BLENDER', 'latin1'), Buffer.from('-v405', 'latin1')]);
  // alpha=128 的预乘红：存储值 128,0,0 / 反预乘后应接近 255,0,0。
  const parsed = parseBlendBuffer(Buffer.concat([header, testBlock(1, 1, [[[128, 0, 0, 128]]])]));
  assert.ok(parsed);
  const { rows } = pngPixels(parsed.png);
  assert.equal(rows[0][0], 255, '128 * (255/128) 还原到 255');
  assert.equal(rows[0][3], 128, 'alpha 本身不动');
});

test('.blend 内嵌预览：没有 TEST 块时返回 null（交给 Blender 兜底）', () => {
  assert.equal(parseBlendBuffer(blendFile({ preview: false })), null);
});

test('.blend 内嵌预览：不是 blend / 数据截断 / 垃圾字节都返回 null', () => {
  assert.equal(parseBlendBuffer(Buffer.from('not a blend file at all')), null);
  const full = blendFile();
  // 12 字节头 + REND(24+72) + TEST 头(24) = 132，像素还得再要 24 字节：切到 140 就是半张预览。
  assert.equal(parseBlendBuffer(full.subarray(0, 140)), null);
  const garbage = Buffer.concat([Buffer.from('BLENDER-v405', 'latin1'), Buffer.alloc(400, 0x7f)]);
  assert.equal(parseBlendBuffer(garbage), null);
});

test('.blend 内嵌预览：gzip / zstd 压缩的文件也能读出来', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-blend-test-'));
  try {
    const plain = blendFile();
    const gzipPath = path.join(dir, 'a.blend');
    await fs.writeFile(gzipPath, zlib.gzipSync(plain));
    const gzipResult = await readBlendPreview(gzipPath);
    assert.ok(gzipResult, 'gzip 应该能读出预览');
    assert.equal(gzipResult.width, 2);

    const zstdPath = path.join(dir, 'b.blend');
    await fs.writeFile(zstdPath, zlib.zstdCompressSync(plain));
    const zstdResult = await readBlendPreview(zstdPath);
    assert.ok(zstdResult, 'zstd 应该能读出预览');
    assert.equal(zstdResult.width, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('.blend 内嵌预览：文件不存在也不抛错', async () => {
  assert.equal(await readBlendPreview(path.join(os.tmpdir(), 'definitely-missing-av.blend')), null);
});

test('encodePng：输出合法签名与尺寸', () => {
  const png = encodePng(1, 1, Buffer.from([1, 2, 3, 4]));
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
});

test('格式清单：blend / usd 系列纳入 3D 封面，且走服务端渲染', () => {
  for (const name of ['a.blend', 'a.usd', 'a.usda', 'a.usdc', 'a.usdz']) {
    assert.ok(MODEL_EXT.test(name), `${name} 应算模型`);
    assert.ok(isModelName(name));
    assert.ok(isServerCoverName(name), `${name} 应由服务端出封面`);
  }
  for (const name of ['a.glb', 'a.fbx', 'a.ply', 'a.3mf']) {
    assert.ok(isModelName(name));
    assert.ok(!isServerCoverName(name), `${name} 仍由前端渲染`);
  }
  assert.ok(isBlendName('x.blend'));
  assert.ok(!isBlendName('x.blend1'), '.blend1 是备份文件，不按 .blend 处理');
});
