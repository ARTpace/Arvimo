// .blend 内嵌预览提取（零依赖、零进程）。
//
// Blender 每次「带界面保存」都会把当前视口缩进文件里：块序列是 REND → TEST → GLOB，
// TEST 的载荷是 int32 width + int32 height + RGBA8 像素，**行序自下而上、alpha 已预乘**。
// 所以这里只做三件事：定位 TEST、翻转行序、反预乘，然后编成 PNG。
//
// 参考实现（两套独立验证过同一布局）：
//   · Apache Tika 的 BlenderParser（PR #3539，TEST 块 128 px RGBA）
//   · blendpreview（Go，MIT）—— plain / gzip / zstd 三种容器都能读
// 我们自己加两条保护：不信任文件里的长度字段（全部走上限判断）、解压只看文件头部
// 有界的一段（TEST 紧跟 REND，永远在最前面）。
//
// 读不出来一律返回 null：调用方会退回 Blender 渲染，而不是抛错打断整条缩略图链路。

import fs from 'node:fs';
import zlib from 'node:zlib';

/** 文件头之后的块头：4 字节块名 + 4 字节长度 + 指针 + 4 字节 SDNA + 4 字节数量。 */
const HEADER_BYTES = 12;
/** 解压后最多扫这么多字节：TEST 是第 1~2 个块，真实文件里都在前 100 KB 内。 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** 单张预览的像素上限（blendpreview 的「bounded read, never trust lengths」）。 */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
/** 预览边长上限：Blender 现在存 128，历史上没有超过 512 的。 */
const MAX_SIDE = 1024;

export const isBlendName = name => /\.blend$/i.test(String(name || ''));

function compressionOf(head) {
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  // zstd 帧魔数 28 B5 2F FD
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  return null;
}

/** 只解压文件头部有限的一段就停下：TEST 在前面，没必要把 20 MB 场景全展开。 */
function decompressHead(file, kind) {
  return new Promise(resolve => {
    let source;
    let decoder;
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      try { source?.destroy(); } catch { /* 已关闭 */ }
      try { decoder?.destroy(); } catch { /* 已关闭 */ }
      resolve(value);
    };
    const stop = () => finish(Buffer.concat(chunks, total));
    try {
      source = fs.createReadStream(file, { highWaterMark: 1 << 16 });
      decoder = kind === 'gzip' ? zlib.createGunzip() : zlib.createZstdDecompress();
    } catch {
      return finish(null);
    }
    decoder.on('data', chunk => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= MAX_SCAN_BYTES) stop();
    });
    decoder.on('end', stop);
    // 截断 / 损坏 / 不认识的流：已经解出来的部分仍可尝试解析（TEST 往往已经在了）。
    decoder.on('error', () => (total ? stop() : finish(null)));
    source.on('error', () => finish(null));
    source.pipe(decoder);
  });
}

/** 读文件头那一段（未压缩文件直接定位块，压缩文件先解压头部）。 */
async function readHeadBytes(file, bytes) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** 在（可能已解压的）字节流里找 TEST 块。 */
function parseTestBlock(buffer) {
  if (buffer.length < HEADER_BYTES + 24) return null;
  if (buffer.subarray(0, 7).toString('latin1') !== 'BLENDER') return null;
  // 第 8 字节是「指针宽度」标记：'_' = 4 字节，'-' = 8 字节。
  const pointerSize = buffer[7] === 0x5f ? 4 : buffer[7] === 0x2d ? 8 : 0;
  // 第 9 字节是端序：'v' = 小端，'V' = 大端。
  const little = buffer[8] === 0x76;
  const bigEndian = buffer[8] === 0x56;
  if (!pointerSize || (!little && !bigEndian)) return null;
  const readInt32 = little ? (b, o) => b.readInt32LE(o) : (b, o) => b.readInt32BE(o);
  const blockHead = 16 + pointerSize;

  let offset = HEADER_BYTES;
  // 正常文件 3 个块内就能命中；60 个块还没找到说明这不是我们认识的布局（例如 Blender 5 的新块头）。
  for (let guard = 0; guard < 64; guard++) {
    if (offset + blockHead > buffer.length) return null;
    const code = buffer.subarray(offset, offset + 4).toString('latin1');
    const length = readInt32(buffer, offset + 4);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SCAN_BYTES) return null;
    const data = offset + blockHead;
    if (code === 'TEST') {
      if (length < 8) return null;
      const width = readInt32(buffer, data);
      const height = readInt32(buffer, data + 4);
      if (!(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE)) return null;
      const need = width * height * 4;
      if (need > MAX_PREVIEW_BYTES) return null;
      const end = data + 8 + need;
      if (buffer.length < end) return null; // 头部解压得不够长，交给调用方退回 Blender。
      return { width, height, rgba: buffer.subarray(data + 8, end) };
    }
    if (code === 'ENDB') return null;
    offset = data + length;
  }
  return null;
}

/** 自下而上的行序翻正，并反掉预乘 alpha（Blender 存的是预乘值）。 */
function normalize(index, width, height, rgba) {
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      const alpha = rgba[s + 3];
      if (alpha === 0) {
        // 全透明像素的颜色没有意义，清零免得合成时出现黑边。
        out[d] = 0; out[d + 1] = 0; out[d + 2] = 0; out[d + 3] = 0;
      } else if (alpha === 255) {
        out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = 255;
      } else {
        const k = 255 / alpha;
        out[d] = Math.min(255, Math.round(rgba[s] * k));
        out[d + 1] = Math.min(255, Math.round(rgba[s + 1] * k));
        out[d + 2] = Math.min(255, Math.round(rgba[s + 2] * k));
        out[d + 3] = alpha;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG 编码

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 4, 'latin1');
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8 位 RGBA PNG（无滤波）。预览只有 128 px，deflate 一下就几十 KB，不需要 sharp。 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // 颜色类型：真彩 + alpha
  ihdr[10] = 0;  // 压缩方法
  ihdr[11] = 0;  // 滤波方法
  ihdr[12] = 0;  // 隔行：无
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 对外入口

/**
 * 读 .blend 内嵌预览，成功返回 { png, width, height }，读不到返回 null。
 * 不抛错：调用方拿 null 去走 Blender 渲染兜底。
 */
export async function readBlendPreview(file) {
  try {
    const head = await readHeadBytes(file, 32);
    if (head.length < HEADER_BYTES) return null;
    const compression = compressionOf(head);
    let bytes;
    if (compression) bytes = await decompressHead(file, compression);
    else bytes = await readHeadBytes(file, MAX_SCAN_BYTES);
    if (!bytes?.length) return null;
    const preview = parseTestBlock(bytes);
    if (!preview) return null;
    const rgba = normalize(file, preview.width, preview.height, preview.rgba);
    return { png: encodePng(preview.width, preview.height, rgba), width: preview.width, height: preview.height };
  } catch {
    return null;
  }
}

/** 测试用：只解析已经读进内存的字节（不碰文件系统）。 */
export function parseBlendBuffer(buffer) {
  const preview = parseTestBlock(buffer);
  if (!preview) return null;
  return { width: preview.width, height: preview.height, png: encodePng(preview.width, preview.height, normalize(0, preview.width, preview.height, preview.rgba)) };
}
