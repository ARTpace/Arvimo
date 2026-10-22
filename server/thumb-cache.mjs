// 缩略图缓存：所有「显示尺寸 ≠ 原始尺寸」的预览图都从这里出。
//
// 之前只有一个 PSD 转码器，PNG/JPG 素材包在缩略图墙上拉的是原图——一个 70 张 2048 贴图的
// 包，光是看一眼缩略图条就是几十 MB。这里把三件事收进同一层：
//   1. 解码能力按格式分工：PSD 走自己的解码器，PNG 走内置解码器（zlib + 反滤波），
//      其余光栅格式（jpg/webp/avif/gif/bmp/tif/tga）交给 ffmpeg，都没有就明确回退原图；
//   2. 结果统一落在系统临时目录，key 里带「路径 + 大小 + 修改时间 + 目标宽度 + 算法版本」，
//      源文件一变 key 就变，不存在看到旧预览的情况；
//   3. 缓存有上限并做 LRU 淘汰：读取时 touch 修改时间，超过阈值就按最久未用删到 80%。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {psdToPng, encodePng, downscale} from './psd-preview.mjs';

const run = promisify(execFile);

// 测试要用独立目录，否则跑一次测试就把用户的预览缓存删了。
const CACHE_DIR = process.env.ASSETVAULT_THUMB_DIR || path.join(os.tmpdir(), 'assetvault-thumbs');
/** 换解码算法时 +1：老缓存凭 key 里的版本号自然失效，不用手动删目录。 */
const CACHE_VERSION = '1';
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const TRIM_RATIO = 0.8;
const TRIM_EVERY_MS = 60_000;

const PSD_EXT = /\.psd$/i;
const PNG_EXT = /\.png$/i;
/** 内置解码器不认、但 ffmpeg 基本都能读的格式。 */
const FFMPEG_EXT = /\.(jpe?g|jfif|webp|avif|gif|bmp|tiff?|tga|exr|hdr)$/i;

export function canThumb(name) {
  return PSD_EXT.test(name) || PNG_EXT.test(name) || FFMPEG_EXT.test(name);
}

// ---------------------------------------------------------------- PNG 解码

/** PNG 的逐行反滤波。bpp 是「一个像素占几个字节」，用于取左邻像素。 */
function unfilter(raw, height, stride, bpp) {
  const out = Buffer.allocUnsafe(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line = raw.subarray(src, src + stride);
    src += stride;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      const v = line[x];
      let value;
      if (filter === 0) value = v;
      else if (filter === 1) value = v + a;
      else if (filter === 2) value = v + b;
      else if (filter === 3) value = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw Error(`PNG 有未知的滤色方式（${filter}）`);
      out[row + x] = value & 0xff;
    }
  }
  return out;
}

/** 解 PNG 到平面数组。返回 {width,height,kind}，kind 决定最终编码成灰度 / RGB / RGBA。 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw Error('不是 PNG 文件');
  let width = 0, height = 0, depth = 8, colorType = 2, interlace = 0;
  let palette = null;
  const idat = [];
  let at = 8;
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!width || !height) throw Error('PNG 缺少尺寸信息');
  if (interlace) throw Error('隔行 PNG 走 ffmpeg');
  if (depth !== 8 && depth !== 16) throw Error(`${depth} 位 PNG 走 ffmpeg`);

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bytesPerSample = depth === 8 ? 1 : 2;
  const bpp = Math.max(1, channels * bytesPerSample);
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) throw Error('PNG 数据不完整');
  const pixels = unfilter(raw, height, stride, bpp);

  const size = width * height;
  // 每像素取样：16 位取高字节（视觉等价），8 位原样。
  const sample = (index, channel) => {
    const offset = index * bpp + channel * bytesPerSample;
    return bytesPerSample === 1 ? pixels[offset] : pixels[offset];
  };

  if (colorType === 3) {
    if (!palette) throw Error('调色板 PNG 缺少 PLTE');
    const r = new Uint8Array(size), g = new Uint8Array(size), b = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const p = pixels[i] * 3;
      r[i] = palette[p] || 0; g[i] = palette[p + 1] || 0; b[i] = palette[p + 2] || 0;
    }
    return { width, height, kind: 'rgb', planes: [r, g, b] };
  }
  if (colorType === 0) {
    const gray = new Uint8Array(size);
    for (let i = 0; i < size; i++) gray[i] = sample(i, 0);
    return { width, height, kind: 'gray', planes: [gray] };
  }
  if (colorType === 2) {
    const r = new Uint8Array(size), g = new Uint8Array(size), b = new Uint8Array(size);
    for (let i = 0; i < size; i++) { r[i] = sample(i, 0); g[i] = sample(i, 1); b[i] = sample(i, 2); }
    return { width, height, kind: 'rgb', planes: [r, g, b] };
  }
  if (colorType === 4) {
    // 灰度 + alpha：转成 RGBA 交给统一编码路径，缩略图里半透明才显示得对。
    const size2 = size;
    const r = new Uint8Array(size2), g = new Uint8Array(size2), b = new Uint8Array(size2), a = new Uint8Array(size2);
    for (let i = 0; i < size; i++) { const v = sample(i, 0); r[i] = v; g[i] = v; b[i] = v; a[i] = sample(i, 1); }
    return { width, height, kind: 'rgba', planes: [r, g, b, a] };
  }
  const r = new Uint8Array(size), g = new Uint8Array(size), b = new Uint8Array(size), a = new Uint8Array(size);
  for (let i = 0; i < size; i++) { r[i] = sample(i, 0); g[i] = sample(i, 1); b[i] = sample(i, 2); a[i] = sample(i, 3); }
  return { width, height, kind: 'rgba', planes: [r, g, b, a] };
}

// ---------------------------------------------------------------- ffmpeg 兜底

let ffmpegPath = null;
/** 找 ffmpeg：先看项目自带的 vendor 目录，再看 PATH。找不到返回 null（前端回落到原图）。 */
async function findFfmpeg() {
  if (ffmpegPath !== null) return ffmpegPath || null;
  const local = path.join(process.cwd(), 'vendor', 'ffmpeg', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(local)) { ffmpegPath = local; return local; }
  try { await run(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', ['-version'], { timeout: 5000 }); ffmpegPath = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'; }
  catch { ffmpegPath = ''; }
  return ffmpegPath || null;
}

/** ffmpeg 一次只能吃一个进程，并发太猛会把机器拖住：这里限到 2 路。 */
let ffmpegRunning = 0;
const ffmpegQueue = [];
function withFfmpegSlot(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      ffmpegRunning++;
      task().then(resolve, reject).finally(() => {
        ffmpegRunning--;
        const next = ffmpegQueue.shift();
        if (next) next();
      });
    };
    if (ffmpegRunning < 2) start();
    else ffmpegQueue.push(start);
  });
}

async function ffmpegThumb(file, width) {
  const bin = await findFfmpeg();
  if (!bin) throw Error('没有可用的 ffmpeg，无法生成这个格式的缩略图');
  return withFfmpegSlot(async () => {
    const filter = `scale='min(iw,${width})':'min(ih,${width})':force_original_aspect_ratio=decrease`;
    const { stdout } = await run(bin, ['-v', 'error', '-i', file, '-vf', filter, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    if (!stdout?.length) throw Error('ffmpeg 没有输出图像');
    return stdout;
  });
}

// ---------------------------------------------------------------- 缓存

function cacheKey(file, stat, width) {
  return crypto.createHash('sha1')
    .update(`${path.resolve(file)}|${stat.size}|${Math.round(stat.mtimeMs)}|${width}|${CACHE_VERSION}`)
    .digest('hex');
}

const inFlight = new Map();
let lastTrim = 0;
let trimming = false;

/** LRU 淘汰：按修改时间升序删（每次命中都会 touch，所以最久没被读到的排最前）。 */
export async function trimCache(limit = MAX_CACHE_BYTES) {
  if (trimming) return;
  trimming = true;
  try {
    const names = await fsp.readdir(CACHE_DIR).catch(() => []);
    const stats = [];
    let total = 0;
    for (const name of names) {
      if (!name.endsWith('.png')) continue;
      const target = path.join(CACHE_DIR, name);
      const stat = await fsp.stat(target).catch(() => null);
      if (!stat) continue;
      total += stat.size;
      stats.push({ target, size: stat.size, used: stat.mtimeMs });
    }
    if (total <= limit) return 0;
    stats.sort((a, b) => a.used - b.used);
    let removed = 0;
    for (const entry of stats) {
      if (total <= limit * TRIM_RATIO) break;
      await fsp.unlink(entry.target).catch(() => {});
      total -= entry.size;
      removed++;
    }
    return removed;
  } finally {
    trimming = false;
  }
}

function scheduleTrim() {
  const now = Date.now();
  if (now - lastTrim < TRIM_EVERY_MS) return;
  lastTrim = now;
  trimCache().catch(() => {});
}

/**
 * 拿一张缩略图。返回 {buffer} 直接发，或者抛错让调用方回落到原文件。
 * 同一个 key 并发请求只会算一次（缩略图墙一次会发几十个请求）。
 */
export async function thumbFor(file, { width = 512 } = {}) {
  const name = path.basename(file);
  if (!canThumb(name)) throw Error('这个格式不生成缩略图');
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) throw Error('文件不存在');
  const size = Math.min(2048, Math.max(32, Math.round(width) || 512));

  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const key = cacheKey(file, stat, size);
  const cached = path.join(CACHE_DIR, `${key}.png`);

  try {
    const buffer = await fsp.readFile(cached);
    // 命中就 touch：LRU 淘汰靠这个修改时间排序，否则「常用的」和「很久没用的」分不出来。
    const now = new Date();
    fsp.utimes(cached, now, now).catch(() => {});
    return { buffer, cached: true };
  } catch { /* 没缓存，现算 */ }

  if (inFlight.has(key)) return inFlight.get(key);
  const task = (async () => {
    let buffer;
    if (PSD_EXT.test(name)) buffer = (await psdToPng(file, { maxSize: size })).buffer;
    else if (PNG_EXT.test(name)) {
      const decoded = decodePng(await fsp.readFile(file));
      const scale = Math.min(1, size / Math.max(decoded.width, decoded.height));
      const outW = Math.max(1, Math.round(decoded.width * scale));
      const outH = Math.max(1, Math.round(decoded.height * scale));
      const planes = decoded.planes.map(plane => downscale(plane, decoded.width, decoded.height, outW, outH));
      const colorType = decoded.kind === 'gray' ? 0 : decoded.kind === 'rgb' ? 2 : 6;
      buffer = encodePng(outW, outH, colorType, planes);
    } else {
      buffer = await ffmpegThumb(file, size);
    }
    // 先写临时文件再 rename：半截 PNG 被写进缓存，以后每次都读到一个坏图。
    const tmp = `${cached}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, cached).catch(async () => { await fsp.unlink(tmp).catch(() => {}); });
    scheduleTrim();
    return { buffer, cached: false };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

/** 设置页/测试用：缓存现状。 */
export async function cacheStats() {
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  let bytes = 0, count = 0;
  for (const name of names) {
    const stat = await fsp.stat(path.join(CACHE_DIR, name)).catch(() => null);
    if (!stat) continue;
    bytes += stat.size; count++;
  }
  return { count, bytes, limit: MAX_CACHE_BYTES, dir: CACHE_DIR };
}

/** 手动清空（改算法、排查坏图时用）。 */
export async function clearCache() {
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  for (const name of names) await fsp.unlink(path.join(CACHE_DIR, name)).catch(() => {});
  return names.length;
}
