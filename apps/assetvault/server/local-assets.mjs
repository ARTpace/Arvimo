import {inspectAssetFormat} from './image-sniff.mjs';
import {classifyAsset,isPanoramicEnvironment,hasEnvironmentHint} from '../src/library/asset-classification.js';
import {readAiImageMeta} from './ai-image-meta.mjs';
// 资产包索引：把一个「下载落盘的资产」识别成一个条目，而不是一堆零散文件。
//
// 背景：下载器落盘时会在每个资产目录里写 info.json（uid / kind / title / author / license …），
// 但资产库的本地扫描原本是逐文件列卡片的，所以一个包里 30 张贴图 + 1 个 fbx 就变成 31 张卡，
// 和下载任务卡完全重复。这里改成以包为单位扫描：
//   1. 目录里有 info.json → 就是一个包，整棵子树归它，不再下钻；
//   2. 目录里没有 info.json，但有个根级带 info.json 的 .zip → 也是一个包（只读中央目录，不解压）；
//   3. 剩下的才当「用户自己放进去的素材」，逐文件返回。
// 判定完全依赖磁盘上的 info.json，与下载任务记录无关：清理记录不会让包重新散成一堆文件。
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createInflateRaw} from 'node:zlib';
import {fileKind} from './local-browse.mjs';
import {FORMATS} from '../src/library/format-registry.js';
import {mapLimit} from './bounded-map.mjs';
import {GROUP_NAMES} from './asset-folders.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information', '__pycache__', '.cache', '.assetvault']);
const MAX_DEPTH = 8;
// 上限不写死：默认 20000（8k 资产库不会在 2000 处静默截断），SFX_SCAN_MAX_PACKAGES / SFX_SCAN_FILE_LIMIT 可覆盖。
// 触顶时仍返回 truncated:true —— 这是「结果不完整」的标记，不是丢数据的借口。
const MAX_PACKAGES = Math.max(1, Number(process.env.SFX_SCAN_MAX_PACKAGES) || 20000);
const DEFAULT_FILE_LIMIT = Math.max(1, Number(process.env.SFX_SCAN_FILE_LIMIT) || 20000);
const MAX_ZIP_BYTES = 2 * 1024 ** 3;
const MAX_INFO_BYTES = 1024 * 1024;
const MAX_LISTED_ENTRIES = 200;

// 扫描时的 stat 并发度：可用 SFX_SCAN_CONCURRENCY 覆盖，0/非法值回落到默认 24。
const STAT_CONCURRENCY = Math.max(1, Number(process.env.SFX_SCAN_CONCURRENCY) || 24);

// 哪些后缀算「模型文件」由格式注册表决定（kind:'model'），此处不再维护第二份清单。
const MODEL_EXT = new Set(Object.values(FORMATS).filter(item => item.kind === 'model').map(item => item.ext));
const MODEL_PRIORITY = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', '3mf', 'usd', 'usda', 'usdc', 'usdz'];
// ponytail: 图片格式复用注册表，TIF/PSD 等统一走缩略图转码，避免封面白名单漏格式。
const COVER_EXT = new RegExp(`\\.(${Object.values(FORMATS).filter(item=>item.kind==='image').map(item=>item.ext).join('|')})$`,'i');
/** 包里一张图都没有时，还能「现算」出封面的文件：3D 模型（前端离屏渲染 / Blender）、
 *  环境贴图（ffmpeg tonemap）、视频（ffmpeg 抓帧）。以前这类包只能挂个类型图标。 */
const RENDERABLE_COVER_EXT = /\.(glb|gltf|fbx|obj|stl|ply|3mf|blend|usd|usda|usdc|usdz|hdr|exr|mp4|mov|m4v|mkv|avi|webm|flv|wmv|mpg|mpeg|ogv)$/i;
/** 压缩包里的封面只能是浏览器直接能显示的图：包内文件没法再过 /api/local/thumb 转码。 */
const ZIP_COVER_EXT = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
/** 贴图命名：底色类优先当封面，法线 / 粗糙度这类通道图尽量别选（常是紫一片、灰一片）。 */
const DIFFUSE_HINT = /(base[_-]?color|basecolor|albedo|diffuse|_color|color|tonemapped|sky)/i;
const CHANNEL_HINT = /(normal|roughness|metallic|metalness|ambient[_-]?occlusion|_ao|height|displacement|cavity|specular|opacity|mask)/i;

/** 包的类型：模型 / 材质 / 天空盒 / 图片素材 / 资源包 / UI 元素。
 *  info.json 的 kind / assetType 优先，路径分类与启发式兜底。
 *  启发式只认「信息不足（显式 kind 都没给）」的包，绝不覆盖已经写明的 category。 */
export function assetCategory(info = {}, rel = '', entries = []) {
  const classification=classifyAsset({...info,entries,rel});
  return ({models:'model',textures:'material',hdris:'skybox',packs:'pack'})[classification.kind]||classification.kind;
}

/** 自然序：Ornament2 排在 Ornament10 前面，否则素材包封面会挑到 10 号以后的图。 */
function natural(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function pickCover(entries, usable = COVER_EXT) {
  const usableEntries = entries.filter(entry => usable.test(entry.name)).sort((a, b) => natural(a.rel, b.rel));
  if (!usableEntries.length) return null;
  const byName = (...patterns) => usableEntries.find(entry => patterns.some(pattern => pattern.test(entry.name)));
  return byName(/^images\/[^/]+$/i, /^preview\b/i, /^thumbnail\b/i, /^cover\b/i, /^pack\.(png|jpe?g)$/i)
    // 一堆贴图里先挑「底色」：法线 / 粗糙度 / 金属度 / AO 常是紫一片、灰一片，当封面像是图坏了。
    || usableEntries.find(entry => DIFFUSE_HINT.test(entry.name) && !CHANNEL_HINT.test(entry.name))
    || usableEntries.filter(entry => entry.rel.split('/').length === 1)[0]
    || usableEntries.find(entry => /\/color|_c[_\-.]|_basecolor|_albedo/i.test(entry.name) && /textures\//i.test(entry.rel))
    || usableEntries.find(entry => /textures\//i.test(entry.rel))
    || usableEntries[0];
}

function pickEntry(entries) {
  for (const ext of MODEL_PRIORITY) {
    const hit = entries.filter(entry => entry.ext === ext).sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))[0];
    if (hit) return hit;
  }
  return null;
}

/**
 * 包里没有任何现成图片时的兜底封面：挑一个后端能「当场算出一张图」的文件。
 * 顺序按「哪张更像封面」：3D 模型 → 环境贴图 → 视频；同一档取层级最浅的 ——
 * 贴图目录深处的 .exr 常是金属度/法线通道，拿来当封面只会是一片灰。
 * （2026-11-16：资产库里 50 个包有 13 个没有封面，全是这种情况。）
 */
function pickRenderableCover(entries) {
  const depthOf = entry => entry.rel.split('/').length;
  const shallowest = pattern => entries
    .filter(entry => RENDERABLE_COVER_EXT.test(entry.name) && pattern(entry))
    .sort((a, b) => depthOf(a) - depthOf(b) || natural(a.rel, b.rel))[0];
  const model = pickEntry(entries);
  if (model) return { rel: model.rel, source: 'thumb', container: '' };
  const env = shallowest(entry => /\.(hdr|exr)$/i.test(entry.name));
  if (env) return { rel: env.rel, source: 'thumb', container: '' };
  const video = shallowest(entry => /\.(mp4|mov|m4v|mkv|avi|webm|flv|wmv|mpg|mpeg|ogv)$/i.test(entry.name));
  if (video) return { rel: video.rel, source: 'thumb', container: '' };
  return null;
}

/** 只读 ZIP 的中央目录：文件名、大小，以及解 info.json 需要的偏移。不碰文件内容。 */
async function readZipDirectory(file) {
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    if (size < 22 || size > MAX_ZIP_BYTES) return null;
    const tailLength = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0) return null;
    const count = tail.readUInt16LE(end + 10), cdSize = tail.readUInt32LE(end + 12), cdOffset = tail.readUInt32LE(end + 16);
    if (!count || count > 20000 || cdSize > 8 * 1024 ** 2) return null;
    const directory = Buffer.alloc(cdSize);
    await handle.read(directory, 0, cdSize, cdOffset);
    const entries = [];
    let infoMeta = null, p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) return null;
      const method = directory.readUInt16LE(p + 10);
      const packed = directory.readUInt32LE(p + 20), length = directory.readUInt32LE(p + 24);
      const nameLength = directory.readUInt16LE(p + 28), extraLength = directory.readUInt16LE(p + 30), commentLength = directory.readUInt16LE(p + 32);
      const offset = directory.readUInt32LE(p + 42);
      const name = directory.subarray(p + 46, p + 46 + nameLength).toString('utf8');
      p += 46 + nameLength + extraLength + commentLength;
      if (!name || name.startsWith('/') || name.split('/').some(part => part === '..')) return null;
      entries.push({ name, ext: path.extname(name).slice(1).toLowerCase(), bytes: length, rel: name });
      if (name === 'info.json') infoMeta = { method, packed, length, offset };
    }
    const mtime = Math.round((await handle.stat()).mtimeMs);
    return { entries, infoMeta, bytes: size, mtime };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** 没有 title 的包（FreeStylized 只写 assetId）用目录名兜底，并剥掉 `-pack-<hash>` 这类落盘后缀。 */
function prettyName(rel) {
  const base = path.basename(rel).replace(/\.zip$/i, '');
  return base
    .replace(/-(?:pack|textures|material|images|hdri)-[a-f0-9]{8,12}(?:\s*\(\d+\))?$/i, '')
    .replace(/-[a-f0-9]{8,12}(?:\s*\(\d+\))?$/i, '')
    .replace(/\s*\(\d+\)$/, '');
}

/** 素材包常见 `.../日式纹饰/PNG/*.png` 这种结构：叶子目录叫 PNG，拿它当卡名毫无信息量，退回上一级。 */
const GENERIC_DIR = /^(png|jpe?g|jpg|tga|tiff?|psd|svg|webp|bmp|exr|hdr|images?|textures?|maps?|alphas?|贴图|图片|素材|图集|导出|export)$/i;
function assetName(rel) {
  const own = prettyName(rel);
  if (!GENERIC_DIR.test(own)) return own;
  const parent = prettyName(path.dirname(rel));
  return parent && parent !== '.' ? parent : own;
}

/**
 * 素材包的封面：包内现成的图 → 能现算一张图的文件 → 压缩包里的图。
 * 旧的 `cover` 只认第一档，于是纯 3D 包 / HDRI 包 / 只落到一个 pack.zip 的包全都只剩一个类型图标，
 * 在资产库里就表现成「怎么刷新都有几张卡没有缩略图」。
 * @returns {{rel:string, source:'thumb'|'archive', container:string}|null}
 */
async function derivedCoverOf({ entries, root, rel, type }) {
  // zip 包本身：包里的字节寻址不到，只能挑一张浏览器直接能显示的图（container 留空）。
  if (type === 'zip') {
    const inside = pickCover(entries, ZIP_COVER_EXT);
    return inside ? { rel: inside.rel, source: 'archive', container: '' } : null;
  }
  const renderable = pickRenderableCover(entries);
  if (renderable) return renderable;
  // 文件夹包只落了一个压缩包（下载器先存 zip 再解包，解包失败时就是这个样子）：
  // 读一次中央目录，包里的图片仍能当封面，交给前端的 /api/local/archive/entry 取图。
  const zip = entries
    .filter(entry => /\.zip$/i.test(entry.name))
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || natural(a.rel, b.rel))[0];
  if (!zip) return null;
  const directory = await readZipDirectory(path.join(root, rel, zip.rel));
  const inside = directory ? pickCover(directory.entries, ZIP_COVER_EXT) : null;
  return inside ? { rel: inside.rel, source: 'archive', container: zip.rel } : null;
}

async function describe({ info, entries, root, rel, type, mtime, bytes, fileCount, hasMeta = false }) {
  const diskStat = await fsp.stat(path.join(root, rel)).catch(()=>null);
  const addedAt = Number(info.addedAt) || Math.round(Math.max(diskStat?.birthtimeMs||0,diskStat?.ctimeMs||0)) || mtime;
  const entry = type === 'folder' ? pickEntry(entries) : null;
  // cover 只放「包内现成的图片文件」：拖拽 / 大图预览都按它是可寻址文件来用，
  // zip 内的路径、3D 主文件都不能塞进来，它们走 derivedCover。
  const cover = type === 'folder' ? pickCover(entries) : null;
  const derivedCover = cover ? null : await derivedCoverOf({ entries, root, rel, type });
  const format = String(info.format || entry?.ext || '').toUpperCase();
  // 有些包（ambientCG）把官方缩略图地址写在 info.json 里，比包内任意一张贴图更能代表这个资产。
  const thumb = /^https?:\/\//i.test(String(info.thumbnail || '')) ? String(info.thumbnail) : null;
  // 清单里不列 info.json：它是资产自身的元信息，不是用户要看的包内文件。
  // 按自然序排：readdir 的返回顺序在 Windows 上不稳定，缩略图墙会忽前忽后。
  const listed = entries
    .filter(item => item.name !== 'info.json' && item.name !== '__info.json')
    .sort((a, b) => natural(a.rel || a.name, b.rel || b.name));
  const listedLimit=assetCategory(info,rel,entries)==='images'?DEFAULT_FILE_LIMIT:MAX_LISTED_ENTRIES;
  return {
    root,
    rel,
    type,
    classification: classifyAsset({...info,entries,rel}),
    uid: typeof info.uid === 'string' ? info.uid : '',
    title: String(info.title || info.assetId || assetName(rel) || rel || path.basename(root)),
    author: String(info.author || ''),
    platform: String(info.platform || ''),
    // 平台资产标识（ambientCG 的 Fabric085、PolyHaven 的 aerial_beach_02、Sketchfab 的 32 位 uid）。
    // 3D 预览全靠它去平台取数据；原来扫描结果不带这个字段，登记时就被写丢了。
    assetId: String(info.assetId || ''),
    license: String(info.license || ''),
    resolution: String(info.resolution || ''),
    format,
    category: assetCategory(info, rel, entries),
    fileCount: type === 'zip' ? listed.length : fileCount,
    bytes,
    mtime, addedAt,
    cover: cover?.rel || null,
    // 没有现成图片时的兜底封面。前端按 source 取图：thumb → /api/local/thumb 现算；
    // archive → /api/local/archive/entry 从 container（zip 相对包的路径，zip 包自身时为空）里取。
    derivedCover,
    thumb,
    entry: entry?.rel || null,
    entries: listed.slice(0, listedLimit).map(item => ({ name: item.name, rel: item.rel, bytes: item.bytes })),
    truncatedEntries: listed.length > listedLimit,
    // 目录里有没有能解析的 info.json：前端据此决定要不要给「登记」按钮。
    hasMeta: hasMeta === true,
    // 图片包边下边写时清单带 status / imageCount：前端据此显示「下载中 N 张」，
    // 不把半成品画板伪装成已完成的资产。
    status: String(info.status || ''),
    // 「只入库」写出的远程收藏卡（status:'remote'）：目录里只有 info.json，没有一张图。
    // 卡片据此显示「远程收藏 · N 张」并给「下载原图」入口，而不是当成空包或零文件素材。
    remote: String(info.status || '') === 'remote',
    // 出处页：远程卡靠它回填「下载原图」任务，用户不必再回去粘一次链接。
    sourceUrl: String(info.url || info.source_url || ''),
    imageCount: Number.isSafeInteger(info.imageCount) ? info.imageCount : 0,
    // 「不下载翻图集」：远程卡存的每张图地址，前端据此直接走 /api/image 代理逐张看。
    // 只在 remote 卡上带，避免普通图片包扫描结果意外膨胀。
    ...(String(info.status || '') === 'remote' && Array.isArray(info.remoteImages)
      ? {remoteImages: info.remoteImages} : {}),
  };
}

/** 单层读目录，读失败当空目录处理：一个坏目录不该让整次扫描失败。 */
async function readEntries(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
}

/** 不用下钻的子目录：依赖/版本库/回收站，以及下载器解包留下的 `xxx.unpacked` 缓存。 */
function disposableDir(name) {
  return SKIP_DIRS.has(name.toLowerCase()) || /\.unpacked$/i.test(name);
}

/** 把一个包目录摊平：算总大小、最新时间、封面与主文件。`.unpacked` 是解包缓存，跳过。 */
async function walkPackage(abs, root, rel) {
  const entries = [];
  const queue = [{ dir: abs, rel: '' }];
  let bytes = 0, mtime = 0, fileCount = 0;
  while (queue.length) {
    const { dir, rel: prefix } = queue.shift();
    const listing = await readEntries(dir);
    const subdirs = [];
    const files = [];
    for (const item of listing) {
      if (item.name.startsWith('.')) continue;
      if (/^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(item.name)) continue;
      const childRel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name.toLowerCase()) || /\.unpacked$/i.test(item.name)) continue;
        subdirs.push({ dir: path.join(dir, item.name), rel: childRel });
        continue;
      }
      if (!item.isFile()) continue;
      // 包根的 info.json / __info.json 是资产自身的元信息，不算「包内文件」，也不该出现在清单里。
      if (!prefix && (item.name === 'info.json' || item.name === '__info.json')) continue;
      files.push({ item, childRel });
    }
    // 同一层的文件 stat 并发发起；失败等价原来的 catch { continue; }，结果按下标回填，输出顺序与字段不变。
    const stats = await mapLimit(files, STAT_CONCURRENCY, entry => fsp.stat(path.join(dir, entry.item.name)).then(stat => stat, () => null));
    for (let index = 0; index < files.length; index++) {
      const stat = stats[index];
      if (!stat) continue;
      const { item, childRel } = files[index];
      bytes += stat.size; fileCount++;
      if (stat.mtimeMs > mtime) mtime = Math.round(stat.mtimeMs);
      entries.push({ rel: childRel, name: item.name, ext: path.extname(item.name).slice(1).toLowerCase(), bytes: stat.size, mtime: Math.round(stat.mtimeMs) });
    }
    for (const subdir of subdirs) queue.push(subdir);
  }
  return { entries, bytes, fileCount, mtime };
}

/** 读 ZIP 的中央目录 + 只解出 info.json：扫描不该为了一个元信息把几十 MB 全解压。 */
async function readZipManifest(file) {
  let handle = null;
  try {
    const directory = await readZipDirectory(file);
    const info = directory?.infoMeta;
    if (!info || info.length > MAX_INFO_BYTES) return null;
    handle = await fsp.open(file, 'r');
    const local = Buffer.alloc(30);
    await handle.read(local, 0, 30, info.offset);
    if (local.readUInt32LE(0) !== 0x04034b50) return null;
    const start = info.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = Buffer.alloc(info.packed);
    if (info.packed) await handle.read(raw, 0, info.packed, start);
    const data = info.method === 8 ? await inflate(raw) : raw;
    return { info: JSON.parse(data.toString('utf8')), entries: directory.entries, bytes: directory.bytes, mtime: directory.mtime };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }

}

function inflate(bytes) {
  return new Promise((resolve, reject) => {
    const stream = createInflateRaw();
    const parts = [];
    stream.on('data', chunk => parts.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.end(bytes);
  });
}

/**
 * 扫描若干根目录，返回 `{ packages, files }`：
 * - packages：一个资产一条（含元信息、封面、主文件、总大小）；
 * - files：不属于任何包的文件，也就是用户自己拷进资产库目录的素材。
 */
export async function scanLibraryPackages({ roots = [], limit = DEFAULT_FILE_LIMIT, packageCache = null, changedPaths = null } = {}) {
  const fileLimit = Math.max(1, Number(limit) || DEFAULT_FILE_LIMIT);
  const packages = [];
  const files = [];
  const byUid = new Map();
  let truncated = false;
  const previous=packageCache?new Map(packageCache):null;
  packageCache?.clear();

  const addPackage = item => {
    packageCache?.set(path.resolve(item.root,item.rel),{...item});
    // 同一 uid 出现多次＝同一个资产被下载了多份（含历史编码错误写出的重复目录）：
    // 只留最新那份，其余记进 copies，避免同一个资产占两张卡。
    const previous = item.uid ? byUid.get(item.uid) : null;
    if (previous) {
      previous.copies = (previous.copies || 1) + 1;
      if (item.mtime > previous.mtime) Object.assign(previous, item, { copies: previous.copies });
      return;
    }
    item.copies = 1;
    if (item.uid) byUid.set(item.uid, item);
    if (packages.length < MAX_PACKAGES) packages.push(item);
    else truncated = true;
  };

  async function walk(dir, root, rel, depth) {
    const cached=previous?.get(path.resolve(dir));
    if(cached&&!cached.scanDirectOnly&&changedPaths&&!changedPaths.some(changed=>{
      const toItem=path.relative(changed,dir),toChange=path.relative(dir,changed);
      const contains=rel=>rel===''||(!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel));
      return contains(toItem)||contains(toChange);
    })){
      addPackage({...cached});return;
    }
    const entries = (await readEntries(dir)).filter(item=>!/^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(item.name));
    const names = new Set(entries.map(entry => entry.name));
    if (names.has('info.json')) {
      let info = null;
      try { info = JSON.parse(await fsp.readFile(path.join(dir, 'info.json'), 'utf8')); }
      catch { info = null; }
      if (info && typeof info === 'object') {
        const flat = await walkPackage(dir, root, rel);
        addPackage(await describe({ info, entries: flat.entries, root, rel, type: 'folder', mtime: flat.mtime, bytes: flat.bytes, fileCount: flat.fileCount, hasMeta: true }));
        return;
      }
    }
    // 分类目录（<分组>/<子类型>，如 图片/其他图片）本身就是「资产摆放的位置」，不是资产包。
    // 不跳过的话，装着几十张图的分类目录会被下面「叶子目录 ≥2 张图」那条吞成「一个图片素材包」，
    // 零散文件区里就只剩一个叫「其他图片」的怪包，单张卡片反而看不见。
    const categoryDir = Boolean(rel) && rel.split('/').length <= 2 && GROUP_NAMES.has(rel.split('/')[0]);
    // 用户自己整理/拷进资产库的素材往往没有 info.json，但同样是「一个文件夹＝一个资产」。
    // 补三条判定，否则一包 70 张 alpha 就是 70 张没有缩略图的行卡：
    //   a) 目录里只有一两个模型文件 + 旁边的贴图子目录 → 整包算一个模型资产
    //      （一个目录里躺着十几个模型的是「模型合集」，那种应该逐个文件出卡，不能吞成一张）；
    //   b) 子目录全是 PNG / SVG / TGA 这类格式名 → 同一套素材的多种格式，合成一个包；
    //   c) 叶子目录里除了图片什么都没有（≥2 张）→ 一个图片素材包。
    const subdirs = entries.filter(item => item.isDirectory() && !disposableDir(item.name));
    const directFiles = entries.filter(item => item.isFile() && !item.name.startsWith('.') && item.name !== 'info.json' && item.name !== '__info.json' && !item.name.toLowerCase().endsWith('.info.json'));
    const directModels = directFiles.filter(item => MODEL_EXT.has(path.extname(item.name).slice(1).toLowerCase())).length;
    if (!categoryDir && directModels >= 1 && directModels <= 2 && subdirs.length) {
      const flat = await walkPackage(dir, root, rel);
      addPackage(await describe({ info: {}, entries: flat.entries, root, rel, type: 'folder', mtime: flat.mtime, bytes: flat.bytes, fileCount: flat.fileCount }));
      return;
    }
    if (!categoryDir && subdirs.length && subdirs.every(item => GENERIC_DIR.test(item.name))) {
      const flat = await walkPackage(dir, root, rel);
      const kinds = new Set(flat.entries.map(item => fileKind(item.name)));
      const panoramaCollection=flat.entries.some(item=>{const filePath=path.join(dir,item.rel);return hasEnvironmentHint({filePath})&&isPanoramicEnvironment({filePath,formatCheck:inspectAssetFormat(filePath)});});
      if (kinds.size === 1 && kinds.has('image') && !panoramaCollection) {
        addPackage(await describe({ info: {}, entries: flat.entries, root, rel, type: 'folder', mtime: flat.mtime, bytes: flat.bytes, fileCount: flat.fileCount }));
        return;
      }
    }
    let groupedDirectImages = false;
    if (!categoryDir) {
      const kinds = directFiles.map(item => fileKind(item.name));
      const images = kinds.filter(kind => kind === 'image').length;
      const panoramaCollection=hasEnvironmentHint({filePath:dir})&&directFiles.some(item=>isPanoramicEnvironment({filePath:path.join(dir,item.name),formatCheck:inspectAssetFormat(path.join(dir,item.name))}));
      if (images >= 2 && images === kinds.length && !panoramaCollection) {
        const flat = await walkPackage(dir, root, rel);
        const selected = subdirs.length ? flat.entries.filter(item => !item.rel.includes('/')) : flat.entries;
        const pkg = await describe({ info: {}, entries: selected, root, rel, type: 'folder', mtime: Math.max(...selected.map(item=>item.mtime)), bytes: selected.reduce((sum,item)=>sum+item.bytes,0), fileCount: selected.length });
        if(subdirs.length)Object.assign(pkg,{title:'本层图片',albumParent:rel,scanDirectOnly:true});
        addPackage(pkg);
        if(!subdirs.length)return;
        groupedDirectImages = true;
      }
    }
    // 本层文件的 stat 并发发起；zip 仍按原顺序单独读 manifest，结果按下标回填，输出顺序与字段不变。
    const statTargets = [];
    for (const item of entries) {
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) continue;
      if (!item.isFile()) continue;
      if (/\.zip$/i.test(item.name)) continue;
      statTargets.push({ item, abs: path.join(dir, item.name) });
    }
    const statResults = await mapLimit(statTargets, STAT_CONCURRENCY, target => fsp.stat(target.abs).then(stat => stat, () => null));
    const statByItem = new Map(statTargets.map((target, index) => [target.item, statResults[index]]));
    for (const item of entries) {
      if (item.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (depth >= MAX_DEPTH || disposableDir(item.name)) continue;
        await walk(path.join(dir, item.name), root, childRel, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      if (groupedDirectImages && fileKind(item.name) === 'image') continue;
      const abs = path.join(dir, item.name);
      if (/\.zip$/i.test(item.name)) {
        const manifest = await readZipManifest(abs);
        if (manifest?.info) {
          addPackage(await describe({ info: manifest.info, entries: manifest.entries, root, rel: childRel, type: 'zip', mtime: manifest.mtime, bytes: manifest.bytes, fileCount: manifest.entries.length, hasMeta: true }));
          continue;
        }
      }
      let stat;
      if (statByItem.has(item)) {
        stat = statByItem.get(item);
        if (!stat) continue;
      } else {
        try { stat = await fsp.stat(abs); } catch { continue; }
      }
      // 库自己的说明书不是资产：<资产名>.info.json（sidecar）、
      // 目录资产包内的 __info.json、Windows 的 desktop.ini。
      // 不在这里挡掉，它们会以「零散文件」出现在界面上，还可能影响包判定。
      const lowerName = item.name.toLowerCase();
      // 孤儿说明书：主文件已经不在了，只剩 <文件名>.info.json。留着没有意义，
      // 它自己又会被扫成「一张 0 字节的卡」；下次刷新也还在，看起来就像删不掉。
      // 扫描阶段顺手清掉（只删说明书，绝不碰任何数据文件）。
      if (lowerName.endsWith('.info.json')) {
        const owner = abs.slice(0, -'.info.json'.length);
        try { await fsp.access(owner); } catch { await fsp.rm(abs, { force: true }).catch(() => {}); }
        continue;
      }
      if (lowerName === 'desktop.ini' || lowerName === '__info.json') continue;
      const formatCheck=inspectAssetFormat(abs);
      const kind=isPanoramicEnvironment({filePath:abs,formatCheck})?'env':fileKind(`asset.${formatCheck.effective}`);
      files.push({ rel: childRel, name: item.name, ext: formatCheck.effective, kind, formatCheck, bytes: stat.size, mtime: Math.round(stat.mtimeMs), addedAt:Math.round(Math.max(stat.birthtimeMs||0,stat.ctimeMs||0))||Math.round(stat.mtimeMs), root });
      if (files.length >= fileLimit) { truncated = true; return; }
    }
  }

  for (const root of roots) await walk(root, root, '', 0);

  // 文件夹卡片对应祖先目录，不能只拿子图集的旧时间推断其复制时间。
  const folderTimes = new Map();
  await mapLimit(packages, STAT_CONCURRENCY, async pkg => {
    const parts=String(pkg.rel||'').split('/');
    if(pkg.type!=='folder')parts.pop();
    const dates={};
    while(parts.length){
      const rel=parts.join('/'),absolute=path.join(pkg.root,rel);
      if(!folderTimes.has(absolute))folderTimes.set(absolute,fsp.stat(absolute).then(stat=>Math.round(Math.max(stat.birthtimeMs||0,stat.ctimeMs||0)),()=>0));
      dates[rel]=await folderTimes.get(absolute);
      parts.pop();
    }
    pkg.folderAddedAt=dates;
  });

  packages.sort((a, b) => b.mtime - a.mtime);
  files.sort((a, b) => b.mtime - a.mtime);

  // AI 生成图识别：只对 PNG 读文本块里的提示词（只读文件头，跳过像素），并发受限。
  // 结果挂在条目的 aiMeta 上交给前端归类；任何失败静默跳过，不影响扫描主流程。
  // 整次扫描有缓存，这段只在首次/失效时执行；SFX_SCAN_AI_META=0 可关闭。
  if (String(process.env.SFX_SCAN_AI_META || '') !== '0') {
    const pngFiles = files.filter(item => item.kind === 'image' && /^png$/i.test(item.ext || ''));
    if (pngFiles.length) {
      const metas = await mapLimit(pngFiles, STAT_CONCURRENCY, async item => {
        try { return await readAiImageMeta(path.join(item.root, item.rel)); } catch { return null; }
      });
      for (let i = 0; i < pngFiles.length; i++) if (metas[i]) pngFiles[i].aiMeta = metas[i];
    }
  }

  // limits 供前端/调用方感知当前上限（附加字段，不影响既有字段）。
  return { packages, files, truncated, limits: { maxPackages: MAX_PACKAGES, fileLimit } };
}

// Match deleted local paths to catalog records, including children of a deleted folder.
export function catalogUidsForRemovedPaths(rows,removed){
 const normalize=value=>{const full=path.resolve(value);return process.platform==='win32'?full.toLowerCase():full;};
 const paths=removed.map(normalize),uids=[];
 for(const row of rows){
  let model;try{model=typeof row.payload==='string'?JSON.parse(row.payload):row;}catch{continue;}
  const root=model.localRoot||model.sourceRoot||model.root;
  const rel=model.localRel||model.sourceRel||model.rel;
  const file=model.filePath||(root&&rel?path.resolve(root,rel):'');
  if(!file)continue;
  const full=normalize(file);
  if(paths.some(p=>full===p||full.startsWith(p+path.sep)))uids.push(row.uid||model.uid);
 }
 return [...new Set(uids.filter(Boolean))];
}
