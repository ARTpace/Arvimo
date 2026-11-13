// 光栅缩略图必须走 sharp 原生插件，**不派生任何 ffmpeg 子进程**——
// 这是「打开图集不再弹命令行窗口」的彻底解法（不是只藏窗口，而是压根不起进程）。
//
// 为什么这样测而不是去 spy execFile：thumb-cache 顶层 `promisify(execFile)` 捕获的是
// ESM 命名空间里的原始函数，运行时无法替换，所以改测「路由 + 行为 + 静态结构」三重保证：
//   1. 路由：jpg/webp/avif/gif/bmp/tiff 属于 SHARP_EXT、不属于 ffmpeg 专属分支；
//   2. 行为：走 sharp 能产出合法的、被缩到目标宽度以内的 PNG；
//   3. 结构：SHARP_EXT 分支调用 sharpThumb，且只有 SHARP_UNAVAILABLE 时才回落 ffmpeg——
//      谁把 jpg 重新指回 ffmpeg 分支，这条静态守卫会直接挂。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-sharp-test-'));
process.env.ASSETVAULT_THUMB_DIR = cacheDir;

const sharp = (await import('sharp')).default;
const { thumbFor, SHARP_EXT, FFMPEG_EXT } = await import('../server/thumb-cache.mjs');

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('路由分工：jpg/webp/avif/gif/bmp/tiff 走 sharp，tga/exr/hdr 仍归 ffmpeg 兜底', () => {
  for (const ext of ['jpg', 'jpeg', 'jfif', 'webp', 'avif', 'gif', 'bmp', 'tif', 'tiff']) {
    assert.ok(SHARP_EXT.test(`a.${ext}`), `${ext} 应走 sharp`);
  }
  for (const ext of ['tga', 'exr', 'hdr']) {
    assert.ok(!SHARP_EXT.test(`a.${ext}`), `${ext} 不应走 sharp`);
    assert.ok(FFMPEG_EXT.test(`a.${ext}`), `${ext} 仍应可被解码通道处理`);
  }
});

test('jpg 缩略图由 sharp 生成，输出是合法且被缩小的 PNG', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'thumb-jpg-'));
  const src = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 40, g: 90, b: 160 } } }).jpeg().toBuffer();
  const file = path.join(dir, 'photo.jpg');
  await fsp.writeFile(file, src);

  const out = await thumbFor(file, { width: 257 });
  const { width, height } = pngSize(out.buffer);
  assert.ok(width <= 257 && height <= 257, `尺寸应 ≤257，实际 ${width}x${height}`);
  assert.equal(out.cached, false);
});

test('webp / tiff 同样走 sharp 产出缩略图', async () => {
  for (const [ext, make] of [
    ['webp', () => sharp({ create: { width: 900, height: 600, channels: 4, background: { r: 10, g: 200, b: 120 } } }).webp().toBuffer()],
    ['tiff', () => sharp({ create: { width: 700, height: 500, channels: 3, background: { r: 200, g: 30, b: 30 } } }).tiff().toBuffer()],
  ]) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `thumb-${ext}-`));
    const file = path.join(dir, `img.${ext}`);
    await fsp.writeFile(file, await make());
    const out = await thumbFor(file, { width: 200 });
    const { width, height } = pngSize(out.buffer);
    assert.ok(width <= 200 && height <= 200, `${ext} 尺寸应 ≤200，实际 ${width}x${height}`);
  }
});

test('SHARP_EXT 分支只调 sharpThumb，sharp 不可用才回落 ffmpeg（防止 jpg 被指回 ffmpeg）', () => {
  const src = fs.readFileSync(new URL('../server/thumb-cache.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('} else if (SHARP_EXT.test(name))');
  assert.ok(start >= 0, '应存在 SHARP_EXT 分支');
  // 取 SHARP_EXT 起点到「最终兜底 else」之间的整段：含 sharp 主路径与 sharp 不可用时的回落。
  const tail = src.slice(start);
  const fallback = tail.indexOf('} else {');
  const sharpBlock = tail.slice(0, fallback >= 0 ? fallback : tail.length);

  const tryBlock = sharpBlock.slice(0, sharpBlock.indexOf('catch'));
  assert.match(tryBlock, /sharpThumb\(/, 'SHARP_EXT 主路径必须调用 sharpThumb');
  assert.doesNotMatch(tryBlock, /ffmpegThumb\(/, 'SHARP_EXT 主路径不能调 ffmpegThumb');

  const catchBlock = sharpBlock.slice(sharpBlock.indexOf('catch'));
  assert.match(catchBlock, /SHARP_UNAVAILABLE/, 'sharp 不可用时才回落 ffmpeg');
  assert.match(catchBlock, /ffmpegThumb\(/, 'sharp 不可用时回落 ffmpeg');
});

test('sharp 缩略图用可调压缩档（非最慢档 c9），参数集中成常量', () => {
  const src = fs.readFileSync(new URL('../server/thumb-cache.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /compressionLevel:\s*9/, '不应再用最慢的 c9（单张慢约 6 倍）');
  assert.match(src, /PNG_COMPRESSION_LEVEL/, '压缩档位应抽成可调常量');
  assert.match(src, /PNG_ADAPTIVE_FILTERING/, '自适应滤波开关也应抽成常量');
});
