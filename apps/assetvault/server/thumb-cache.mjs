// 缩略图缓存：所有「显示尺寸 ≠ 原始尺寸」的预览图都从这里出。
//
// 之前只有一个 PSD 转码器，PNG/JPG 素材包在缩略图墙上拉的是原图——一个 70 张 2048 贴图的
// 包，光是看一眼缩略图条就是几十 MB。这里把三件事收进同一层：
//   1. 解码能力按格式分工，且**优先用原生插件、不 spawn 进程**：
//        · PSD 走自己的解码器；
//        · PNG 走内置解码器（zlib + 反滤波）；
//        · jpg/webp/avif/gif/bmp/tiff 这批最常见的光栅格式走 **sharp**（libvips 原生插件，
//          不派生任何子进程，彻底杜绝 Windows 上「打开图集弹出一堆命令行窗口」）；
//        · 其余光栅 / RAW / HEIC / DDS / AI 才走 ffmpeg 兜底（已统一带 windowsHide）。
//      所有外部命令都经过 externalProcessOptions() 包装，新增调用也不会漏掉隐藏窗口标志。
//   2. 结果沿用现有缓存目录，key 优先使用「文件系统身份 + 源版本 + 规格 + 编码版本」，
//      源文件一变 key 就变，不存在看到旧预览的情况；
//   3. 默认 5 GB 预算，访问批量记账，超过阈值按最久未用收敛到 90%。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {sniffImageExtension} from './image-sniff.mjs';
import {resolveUserPaths} from './data-dir.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {psdToPng, encodePng, downscale} from './psd-preview.mjs';
import {FORMATS, extensionOf} from '../src/library/format-registry.js';
import {thumbSourceStat} from './model-dependencies.mjs';

const execFileAsync = promisify(execFile);

/**
 * 后台服务由静默启动器以 detached + windowsHide 拉起，自己没有控制台。
 * Windows 上再派生 ffmpeg.exe 这种控制台程序时，不加 windowsHide 系统会为每个子进程
 * 新建一个可见命令行窗口——打开一个 222 张 jpg 的图集，缩略图墙就会闪上百个黑框。
 * 所有外部命令统一经过这个包装，新增调用也不会漏掉这个标志。
 */
export function externalProcessOptions(options = {}) {
  return { windowsHide: true, ...options };
}

const run = (bin, args, options = {}) => execFileAsync(bin, args, externalProcessOptions(options));

// 测试要用独立目录，否则跑一次测试就把用户的预览缓存删了。
//
// 缓存根必须跟着资产库走：缩略图是「这个库的派生数据」，放在库根下的
// .assetvault-cache/thumbs —— 换盘、换库都跟着资产走，不用整座重建，也不占系统盘。
// 目录名以点开头是硬要求：本来就有「扫描跳过点目录」的规则，缩略图不会被当成资产导入。
//
// 早先落在 %TEMP%（或 <数据目录>/thumb-cache）都不合适：Windows 的存储感知随时清空临时目录，
// 一被清掉，下次打开素材库就得把上千张封面重新生成；更糟的是 /api/local/thumb 生成失败时
// 会回退成原始文件（一张 2048 的 PNG 解码后十几 MB），整片卡片同时回退足以让界面进程内存翻倍。
// 测试仍用 ASSETVAULT_THUMB_DIR 覆盖。
function assetThumbDir(){
 try{return path.join(resolveUserPaths().archiveRoot,'.assetvault-cache','thumbs');}catch{return '';}
}
const CACHE_DIR = process.env.ASSETVAULT_THUMB_DIR
 || assetThumbDir()
 || path.join(os.tmpdir(),'assetvault-thumbs');
/** 换解码算法时 +1：老缓存凭 key 里的版本号自然失效，不用手动删目录。
 *  v2：jpg/webp/avif/gif/bmp/tiff 从 ffmpeg 切换到 sharp（原生无进程）。
 *  v5：HDR / EXR 改成先 tonemap 再缩放（旧缓存是过曝的线性图，必须重出）。 */
const CACHE_VERSION = '5';
const MAX_CACHE_BYTES = 5 * 1024 * 1024 * 1024;
let cacheBudget=MAX_CACHE_BYTES,budgetReady;
const TRIM_RATIO = 0.9;
const TRIM_EVERY_MS = 60_000;

const PSD_EXT = /\.psd$/i;
const PNG_EXT = /\.png$/i;
/** 走 ffmpeg 兜底的格式只含「sharp 不接、注册表没收」的光栅：tga / exr / hdr。
 *  jpg/webp/avif/gif/bmp/tiff 已交给 sharp（见 SHARP_EXT），不再重复列在这里——
 *  改 SHARP_EXT 时这里不会失同步（canThumb 会同时查 SHARP_EXT）。
 *  注册表里 preview:'thumb' 的格式（相机 RAW / AI / HEIC / DDS）也走 ffmpeg，由 DERIVED_THUMB_EXTS 派生。 */
export const FFMPEG_EXT = /\.(tga|exr|hdr|ico)$/i;
/** 视频封面：ffmpeg 抓一帧当卡片图。资产库里的视频、带参考视频的素材包以前一张封面都没有，
 *  卡片只能挂个播放图标（用户 2026-11-16 反馈的「有些资产没法生成缩略图」）。 */
export const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|webm|flv|wmv|mpg|mpeg|ogv)$/i;
/** HDR / EXR 是线性浮点图：直接缩到 8 位会把天空整片糊成白色，先 tonemap 再缩才看得清内容。 */
const TONEMAP_EXT = /\.(hdr|exr)$/i;
const TONEMAP_FILTER = 'format=gbrpf32le,tonemap=hable:desat=0,format=rgb24';
/** sharp 原生能解、且比 ffmpeg 更轻的光栅格式：jpg/webp/avif/gif/bmp/tiff。
 *  走 sharp（纯原生插件，不 spawn 任何进程），打开图集就不再有命令行窗口；
 *  sharp 没装或解不了时回落 ffmpeg（带 windowsHide），预览不会断。 */
export const SHARP_EXT = /\.(jpe?g|jfif|webp|avif|gif|bmp|tiff?|svg|heic|heif)$/i;
/** 注册表里标 preview:'thumb' 的格式（相机 RAW / AI / HEIC / DDS）也走 ffmpeg 通道；
 *  解不了时 /api/local/thumb 会回退原文件，不会让整个预览挂掉。 */
const DERIVED_THUMB_EXTS = new Set(Object.values(FORMATS).filter(item => item.preview === 'thumb').map(item => item.ext));

/** 3D 封面的两条生成路径，产物写进同一个缓存目录（key 与光栅缩略图同源）：
 *   · glb/gltf/fbx/obj/stl/ply/3mf —— 前端 model-thumb.js 用 three.js 离屏渲一帧；
 *   · blend/usd/usda/usdc/usdz —— 浏览器解析不了，服务端出图（.blend 先读内嵌预览，
 *     读不到再上 Blender；USD 只能 Blender）。见 server/model-cover.mjs。 */
export const MODEL_EXT = /\.(glb|gltf|fbx|obj|stl|ply|3mf|blend|usd|usda|usdc|usdz)$/i;
export const isModelName = name => MODEL_EXT.test(String(name || ''));

export function canThumb(name) {
  return PSD_EXT.test(name) || PNG_EXT.test(name) || SHARP_EXT.test(name)
    || FFMPEG_EXT.test(name) || VIDEO_EXT.test(name) || DERIVED_THUMB_EXTS.has(extensionOf(name));
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
  const scale = width ? `scale='min(iw,${width})':'min(ih,${width})':force_original_aspect_ratio=decrease` : '';
  /** 跑一次 ffmpeg，返回 PNG 字节；失败 / 空输出都算「这条路不通」，交给下一条。 */
  const grab = async (before, filters) => {
    const args = ['-v', 'error', ...before, '-i', file, ...(filters ? ['-vf', filters] : []),
      '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'];
    const { stdout } = await run(bin, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).catch(() => ({}));
    return stdout?.length ? stdout : null;
  };
  // 视频：-ss 写在 -i 前面是快速定位，只解到目标帧就停，几百 MB 的片子不会为一张封面从头读；
  // 1 秒以内的短片定位会落在片尾之后（空帧），所以再去掉 -ss 抓第 0 帧。
  const seek = VIDEO_EXT.test(file) ? ['-ss', '1'] : [];
  return withFfmpegSlot(async () => {
    const attempts = TONEMAP_EXT.test(file)
      ? [[[], [TONEMAP_FILTER, scale].filter(Boolean).join(',')], [[], scale]] // 先 tonemap，不行再线性直缩
      : [[seek, scale], [[], scale]];                                          // 先定位到 1s，不行再从头抓
    for (const [before, filters] of attempts) {
      const png = await grab(before, filters);
      if (png) return png;
    }
    throw Error('ffmpeg 没有输出图像');
  });
}

// ---------------------------------------------------------------- sharp 主路径

/**
 * sharp 是 libvips 的原生 Node 插件，**不派生任何子进程**——这是打开图集不再弹命令行窗口的关键。
 * 懒加载 + 缓存结果：没装 sharp 时把标记置空并抛一个带码的错误，调用方据此回落 ffmpeg，
 * 即使机器上没装 sharp，服务也能正常启动、只是图片缩略图走兜底（已带 windowsHide）。
 */
/**
 * sharp 缩略图的 PNG 编码参数（配置缝：压缩档位集中在此，调优只改这一处）。
 * 压缩级别 0–9：9 是最小文件但最慢；实测 257px 缩略图 jpg→PNG，9 约 193ms/张、6 约 32ms/张
 * （≈6 倍提速），文件只多 26% 且画质无损（PNG 级别只影响压缩率）。c6 是速度/体积的最佳甜点，
 * 再降（3/1/0）收益递减、文件反而明显变大，不划算。adaptiveFiltering 默认会逐行试最优滤波，
 * 关掉几乎不影响观感却省掉一笔 CPU。
 */
const PNG_COMPRESSION_LEVEL = 6;
const PNG_ADAPTIVE_FILTERING = false;

let sharpModule = undefined; // undefined = 还没试过；null = 不可用
async function getSharp() {
  if (sharpModule === null) throw Object.assign(Error('sharp 不可用'), { code: 'SHARP_UNAVAILABLE' });
  if (sharpModule) return sharpModule;
  try { sharpModule = (await import('sharp')).default; }
  catch { sharpModule = null; throw Object.assign(Error('sharp 不可用'), { code: 'SHARP_UNAVAILABLE' }); }
  return sharpModule;
}

/** 用 sharp 把文件缩放成目标宽度以内的 PNG。直接读文件路径（libvips 流式处理，内存占用远低于先把整图读进 Buffer）。 */
async function sharpThumb(file, width, format = 'png') {
  const sharp = await getSharp();
  const image = sharp(file, { limitInputPixels: 268402689 })
    .rotate(); // 按 EXIF Orientation 自动转正（相机 jpg 常见）
  if(width)image.resize(width, width, { fit: 'inside', withoutEnlargement: true });
  return (format==='webp'?image.webp({quality:78,alphaQuality:100}):image.png({ compressionLevel: PNG_COMPRESSION_LEVEL, adaptiveFiltering: PNG_ADAPTIVE_FILTERING })).toBuffer();
}

// ---------------------------------------------------------------- 缓存

/** 前端 3D 封面渲染器改机位/灯光时要 +1：模型文件本身没变，但旧封面是旧算法渲的，
 *  不改 key 就会一直显示旧图。光栅缩略图的 key 保持原样，不受影响。 */
const MODEL_COVER_VERSION = '3';
const sourceIdentity=(file,stat)=>stat.ino&&stat.dev!==undefined?`${stat.dev}:${stat.ino}:${stat.birthtimeNs??stat.birthtimeMs}`:path.resolve(file);
const sourceFamily=(file,stat)=>crypto.createHash('sha1').update(sourceIdentity(file,stat)).digest('hex');
function cacheKey(file, stat, width, format = 'png') {
  const salt = (MODEL_EXT.test(path.basename(file)) ? `|m${MODEL_COVER_VERSION}` : '')+(stat.dependencyVersion?'|d'+stat.dependencyVersion:'');
  const identity=sourceIdentity(file,stat);
  return crypto.createHash('sha1')
    .update(`${identity}|${stat.size}|${stat.mtimeNs??Math.round(stat.mtimeMs)}|${width}|${format}|${CACHE_VERSION}${salt}`)
    .digest('hex');
}

const inFlight = new Map();
const publishing=new Map();
const activeKey=key=>inFlight.has(key)||publishing.has(key);
let activeDecodes=0;
const decodeWaiters=[];
async function withDecodeSlot(action) {
  if(activeDecodes>=4)await new Promise(resolve=>decodeWaiters.push(resolve));
  else activeDecodes++;
  try{return await action();}finally{const next=decodeWaiters.shift();if(next)next();else activeDecodes--;}
}
const recentAccess = new Map();
let accessTimer;
function cacheEntry(name){
 const current=/^([a-f0-9]{40})-(\d{2,4})-([a-f0-9]{40})\.(png|webp)$/.exec(name);
 if(current&&Number(current[2])>=32&&Number(current[2])<=2048)return {family:current[1],width:Number(current[2]),key:current[3],format:current[4]};
 const legacy=/^([a-f0-9]{40})\.(png|webp)$/.exec(name);
 return legacy?{key:legacy[1],format:legacy[2]}:null;
}
const cacheName=name=>!!cacheEntry(name);
const cacheFile=(file,stat,width,format)=>`${sourceFamily(file,stat)}-${width}-${cacheKey(file,stat,width,format)}.${format}`;
// ponytail: 热路径只记最近 4096 个源路径，预算清理时再核对；不逐请求扫描目录/写索引。
const knownSources=new Map();
function rememberSource(file,root){
 const full=path.resolve(file);knownSources.delete(full);knownSources.set(full,root);
 if(knownSources.size>4096)knownSources.delete(knownSources.keys().next().value);
}
async function checkedCacheRoot() {
  await fsp.mkdir(CACHE_DIR,{recursive:true});
  const stat=await fsp.lstat(CACHE_DIR);
  const compare=value=>process.platform==='win32'?value.toLowerCase():value;
  if(stat.isSymbolicLink()||compare(path.resolve(await fsp.realpath(CACHE_DIR)))!==compare(path.resolve(CACHE_DIR)))throw Error('缓存根不允许符号链接或 junction');
}
function touchCache(file) {
  recentAccess.set(file,Date.now());
  if(accessTimer)return;
  accessTimer=setTimeout(()=>{
    const entries=[...recentAccess];recentAccess.clear();accessTimer=null;
    Promise.allSettled(entries.map(([file,time])=>fsp.utimes(file,new Date(time),new Date(time))));
  },5000);accessTimer.unref?.();
}
async function loadBudget() {
  if(!budgetReady)budgetReady=(async()=>{
    await checkedCacheRoot();
    try{const value=JSON.parse(await fsp.readFile(path.join(CACHE_DIR,'budget.json'),'utf8')).bytes;
      if(Number.isFinite(value)&&value>=64*1024*1024&&value<=100*1024**3)cacheBudget=value;
    }catch{}
  })();
  return budgetReady;
}
export async function setCacheBudget(bytes) {
  if(!Number.isSafeInteger(bytes)||bytes<64*1024*1024||bytes>100*1024**3)throw Error('缓存预算应在 64 MB–100 GB 之间');
  await loadBudget();await checkedCacheRoot();
  const target=path.join(CACHE_DIR,'budget.json'),tmp=target+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  await fsp.writeFile(tmp,JSON.stringify({bytes}));
  try{await fsp.rename(tmp,target);}finally{await fsp.unlink(tmp).catch(()=>{});}
  cacheBudget=bytes;await trimCache();return cacheStats();
}
let lastTrim = 0;
let trimming = false;

/** LRU 淘汰：按修改时间升序删（每次命中都会 touch，所以最久没被读到的排最前）。 */
export async function trimCache(limit = null) {
  if (trimming) return;
  trimming = true;
  try {
    await loadBudget();limit=limit??cacheBudget;
    const expired=await pruneExpiredCache();
    await checkedCacheRoot();
    const names = await fsp.readdir(CACHE_DIR).catch(() => []);
    const stats = [];
    let total = 0;
    for (const name of names) {
      if (!cacheName(name)||activeKey(cacheEntry(name).key)) continue;
      const target = path.join(CACHE_DIR, name);
      const stat = await fsp.lstat(target).catch(() => null);
      if (!stat?.isFile()||stat.isSymbolicLink()) continue;
      total += stat.size;
      stats.push({ target, size: stat.size, used: recentAccess.get(target)||stat.mtimeMs });
    }
    if (total <= limit) return expired.removed;
    stats.sort((a, b) => a.used - b.used);
    let removed = 0;
    for (const entry of stats) {
      if (total <= limit * TRIM_RATIO) break;
      await fsp.unlink(entry.target).catch(() => {});
      total -= entry.size;
      removed++;
    }
    return removed+expired.removed;
  } finally {
    trimming = false;
  }
}

/** 只按在线源的当前身份/版本删除可证明过期的分组缓存；不猜测旧 40 位文件名。 */
export async function pruneExpiredCache({files=[...knownSources.keys()],roots=knownSources}={}){
 if(!Array.isArray(files)||files.length>50000||files.some(file=>typeof file!=='string'||!path.isAbsolute(file)))throw Error('过期清理须提供最多 5 万个绝对源路径');
 await checkedCacheRoot();
 const sources=new Map();let skippedSources=0;
 for(const file of new Set(files)){
  try{
   const link=await fsp.lstat(file,{bigint:true});
   if(!link.isFile()||link.isSymbolicLink()){skippedSources++;continue;}
   const stat=await thumbSourceStat(file,{root:roots.get(file)});
   if(!stat.isFile()||stat.isSymbolicLink()){skippedSources++;continue;}
   sources.set(sourceFamily(file,stat),{file,stat,root:roots.get(file)});
  }catch{skippedSources++;}
 }
 let removed=0,bytes=0;
 const names=await fsp.readdir(CACHE_DIR);
 for(const name of names){
  const entry=cacheEntry(name),source=entry?.family&&sources.get(entry.family);
  if(!source||activeKey(entry.key)||cacheKey(source.file,source.stat,entry.width,entry.format)===entry.key)continue;
  const target=path.join(CACHE_DIR,name),stat=await fsp.lstat(target).catch(()=>null);
  if(!stat?.isFile()||stat.isSymbolicLink())continue;
  // 清理过程中源也可能被改写/搬走；此时保守跳过，不用旧 stat 判断新的当前版本。
  const latest=await thumbSourceStat(source.file,{root:source.root}).catch(()=>null);
  if(!latest?.isFile()||latest.isSymbolicLink()||sourceFamily(source.file,latest)!==entry.family
    ||cacheKey(source.file,latest,entry.width,entry.format)!==cacheKey(source.file,source.stat,entry.width,entry.format))continue;
  if(activeKey(entry.key))continue;
  try{await fsp.unlink(target);recentAccess.delete(target);removed++;bytes+=stat.size;}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 return {removed,removedBytes:bytes,checkedSources:sources.size,skippedSources};
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
export async function thumbFor(file, { width = 512, format = 'png',root,original=false } = {}) {
  if(original)format='png'; // 原尺寸预览使用无损编码，与卡片 WebP 缓存分开。
  if(!['png','webp'].includes(format))throw Error('缩略图编码格式无效');
  if(format==='webp')try{await getSharp();}catch(error){if(error.code==='SHARP_UNAVAILABLE')return thumbFor(file,{width,format:'png',root});throw error;}
  const name = path.basename(file);
  // 下载 / 生成出来的图常没有扩展名（"1694..._lora" 这种），只按名字判会把真图挡在门外：
  // 这里读魔数补一次判断，下面按「补出来的名字」走同一条解码链。
  const sniffed = canThumb(name) || MODEL_EXT.test(name) ? '' : sniffImageExtension(file);
  const label = sniffed ? `thumb.${sniffed}` : name;
  // 模型格式没有服务端解码器，但可能已经有前端渲染好的封面 PNG —— 先让它走到缓存查询。
  // 其它非图片格式仍第一时间拒绝，保持原来的错误语义。
  if (!canThumb(label) && !MODEL_EXT.test(name)) throw Error('这个格式不生成缩略图');
  const stat = await thumbSourceStat(file,{root});
  if (!stat?.isFile()) throw Error('文件不存在');
  const size = original?0:Math.min(2048, Math.max(32, Math.round(width) || 512));

  await checkedCacheRoot();
  const key = cacheKey(file, stat, size, format);
  let cached = path.join(CACHE_DIR, cacheFile(file,stat,size,format));

  try {
    let cachedStat=await fsp.lstat(cached).catch(()=>null);
    if(!cachedStat){
      const legacy=path.join(CACHE_DIR,`${key}.${format}`),legacyStat=await fsp.lstat(legacy).catch(()=>null);
      if(legacyStat?.isFile()&&!legacyStat.isSymbolicLink()){
        try{await fsp.rename(legacy,cached);cachedStat=legacyStat;}catch{cached=legacy;cachedStat=legacyStat;}
      }
    }
    if(!cachedStat)throw Error('缓存未命中');
    if(!cachedStat.isFile()||cachedStat.isSymbolicLink())throw Error('无效缓存条目');
    const buffer = await fsp.readFile(cached);
    // 命中就 touch：LRU 淘汰靠这个修改时间排序，否则「常用的」和「很久没用的」分不出来。
    touchCache(cached);
    rememberSource(file,root);
    return { buffer, cached: true, mime:format==='webp'?'image/webp':'image/png' };
  } catch { /* 没缓存，现算 */ }

  // 缓存里没有 3D 封面：明确抛错，/api/local/thumb 回 415，前端据此启动离屏渲染。
  if (!canThumb(label)) throw Error('这个格式不生成缩略图，等待前端渲染 3D 封面');
  if (inFlight.has(key)) return inFlight.get(key);
  const task = withDecodeSlot(async () => {
    let buffer;
    if(format==='webp'&&(sniffed||PNG_EXT.test(name)||SHARP_EXT.test(name))) {
      try { buffer=await sharpThumb(file,size,'webp'); }
      catch { buffer=await ffmpegThumb(file,size); }
    } else if (sniffed) {
      // 扩展名是我们补的，内置 PNG 解码器未必吃得住这类来路不明的文件：直接交给 sharp（自带格式探测）。
      try { buffer = await sharpThumb(file, size); }
      catch (err) {
        buffer = await ffmpegThumb(file, size);
      }
    } else if (PSD_EXT.test(name)) buffer = (await psdToPng(file, { maxSize: size })).buffer;
    else if (PNG_EXT.test(name)) {
      const decoded = decodePng(await fsp.readFile(file));
      const scale = size ? Math.min(1, size / Math.max(decoded.width, decoded.height)) : 1;
      const outW = Math.max(1, Math.round(decoded.width * scale));
      const outH = Math.max(1, Math.round(decoded.height * scale));
      const planes = decoded.planes.map(plane => downscale(plane, decoded.width, decoded.height, outW, outH));
      const colorType = decoded.kind === 'gray' ? 0 : decoded.kind === 'rgb' ? 2 : 6;
      buffer = encodePng(outW, outH, colorType, planes);
    } else if (SHARP_EXT.test(name)) {
      // 常见光栅格式走 sharp：原生插件，零子进程，不再弹命令窗。
      // sharp 没装 / 加载失败 → 回落 ffmpeg 兜底（已带 windowsHide），预览不中断。
      try { buffer = await sharpThumb(file, size); }
      catch (err) {
        buffer = await ffmpegThumb(file, size);
      }
    } else {
      // tga/exr/hdr 与 RAW/HEIC/DDS/AI 等异类：ffmpeg 兜底（带 windowsHide）。
      buffer = await ffmpegThumb(file, size);
    }
    // 先写临时文件再 rename：半截 PNG 被写进缓存，以后每次都读到一个坏图。
    if(format==='webp'&&!(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP')) {
      const sharp=await getSharp();buffer=await sharp(buffer).rotate().resize(size,size,{fit:'inside',withoutEnlargement:true}).webp({quality:78,alphaQuality:100}).toBuffer();
    }
    const latest=await thumbSourceStat(file,{root});
    if(cacheKey(file,latest,size,format)!==key)throw Error('生成缩略图期间源文件已变化，请重试');
    const tmp = `${cached}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, cached).catch(async () => { await fsp.unlink(tmp).catch(() => {}); });
    rememberSource(file,root);
    scheduleTrim();
    return { buffer, cached: false, mime:format==='webp'?'image/webp':'image/png' };
  }).finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}

/** 收下前端渲染好的 3D 封面。key 与 thumbFor 完全一致（路径 + 大小 + mtime + 宽度 + 版本），
 *  所以下一次 GET /api/local/thumb 会直接命中；源文件一改，旧封面自动失效。
 *  只接受 PNG 且有大小上限，避免把任意字节写进缓存目录。 */
export async function saveModelThumb(file, png, { width = 512, format = 'png',root,coverVersion } = {}) {
  if(!['png','webp'].includes(format))throw Error('缩略图编码格式无效');
  if(format==='webp')try{await getSharp();}catch(error){if(error.code==='SHARP_UNAVAILABLE')format='png';else throw error;}
  if (!MODEL_EXT.test(path.basename(file))) throw Error('不是支持生成封面的 3D 格式');
  if (!Buffer.isBuffer(png) || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw Error('封面不是合法 PNG');
  if (png.length > 4 * 1024 * 1024) throw Error('封面 PNG 过大');
  const stat = await thumbSourceStat(file,{root});
  if (!stat?.isFile()) throw Error('文件不存在');
  if(coverVersion!==undefined&&coverVersion!==sourceVersion(file,stat))throw Object.assign(Error('模型或依赖已变化，请重新生成封面'),{status:409});
  const size = Math.min(2048, Math.max(32, Math.round(width) || 512));
  await checkedCacheRoot();
  if(format==='webp'){const sharp=await getSharp();png=await sharp(png).rotate().resize(size,size,{fit:'inside',withoutEnlargement:true}).webp({quality:78,alphaQuality:100}).toBuffer();}
  const key=cacheKey(file,stat,size,format),cached = path.join(CACHE_DIR,cacheFile(file,stat,size,format));
  // 手动回传封面也受清理保护，不只保护图片解码任务。
  publishing.set(key,(publishing.get(key)||0)+1);
  try{
  if(cacheKey(file,await thumbSourceStat(file,{root}),size,format)!==cacheKey(file,stat,size,format))throw Error('生成封面期间源文件已变化，请重试');
  const tmp = `${cached}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, png);
  await fsp.rename(tmp, cached).catch(async () => { await fsp.unlink(tmp).catch(() => {}); });
  rememberSource(file,root);
  scheduleTrim();
  return { cached };
  }finally{const left=publishing.get(key)-1;if(left)publishing.set(key,left);else publishing.delete(key);}
}

/** 删资产时顺手清掉它的派生缩略图缓存。
 *
 *  缓存文件名是 `<family>-<宽>-<hash>.<格式>`，family 由「设备号:inode:创建时间」派生
 *  （非 inode 平台退化成绝对路径）。所以**必须在删文件之前调用** —— 文件一没，stat 拿不到，
 *  这份缓存就永远清不掉了，只能等 60 天过期或被预算淘汰。
 *
 *  target 可以是文件，也可以是资产包目录（递归收 family，一次 readdir 批量删）。
 *  返回删掉的缓存文件数；任何一步失败都静默跳过 —— 清理缓存永远不该拦住删除本身。
 */
export async function dropThumbCache(target) {
  const families = new Set();
  const collect = async file => {
    const stat = await thumbSourceStat(file, {}).catch(() => null);
    if (stat?.isFile()) families.add(sourceFamily(file, stat));
  };
  const walk = async (dir, depth = 0) => {
    if (depth > 5) return;
    const stat = await fsp.stat(dir).catch(() => null);
    if (!stat) return;
    if (!stat.isDirectory()) { await collect(dir); return; }
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const abs = path.join(dir, item.name);
      if (item.isDirectory() || item.isSymbolicLink()) await walk(abs, depth + 1);
      else await collect(abs);
    }
  };
  await walk(target);
  if (!families.size) return 0;
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  let removed = 0;
  for (const name of names) {
    if (!families.has(name.split('-')[0])) continue;
    await fsp.rm(path.join(CACHE_DIR, name), { force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

/** 设置页/测试用：缓存现状。 */
export async function cacheStats() {
  await loadBudget();await checkedCacheRoot();
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  let bytes = 0, count = 0;
  for (const name of names) {
    if(!cacheName(name))continue;
    const stat = await fsp.lstat(path.join(CACHE_DIR, name)).catch(() => null);
    if (!stat?.isFile()||stat.isSymbolicLink()) continue;
    bytes += stat.size; count++;
  }
  return { count, bytes, limit: cacheBudget, dir: CACHE_DIR };
}

/** 手动清空（改算法、排查坏图时用）。 */
export async function clearCache() {
  await checkedCacheRoot();
  const names = await fsp.readdir(CACHE_DIR).catch(() => []);
  let removed=0;
  for (const name of names) {
    if(!cacheName(name)||activeKey(cacheEntry(name).key))continue;
    const target=path.join(CACHE_DIR,name),stat=await fsp.lstat(target).catch(()=>null);
    if(!stat?.isFile()||stat.isSymbolicLink())continue;
    await fsp.unlink(target);recentAccess.delete(target);removed++;
  }
  return removed;
}

export const LIST_THUMB_SIZE=384;
const sourceVersion=(file,stat)=>cacheKey(file,stat,LIST_THUMB_SIZE,'webp');
export async function modelThumbVersion(file,{root}={}){return sourceVersion(file,await thumbSourceStat(file,{root}));}
