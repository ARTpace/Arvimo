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

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '$recycle.bin', 'system volume information', '__pycache__', '.cache', '.assetvault']);
const MAX_DEPTH = 8;
const MAX_PACKAGES = 2000;
const MAX_ZIP_BYTES = 2 * 1024 ** 3;
const MAX_INFO_BYTES = 1024 * 1024;
const MAX_LISTED_ENTRIES = 200;

const MODEL_EXT = new Set(['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', '3mf']);
const MODEL_PRIORITY = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', '3mf'];
// PSD 也算可用封面：前端拿它走 /api/local/thumb 转码，卡片封面才不会是一片图标。
const COVER_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg|psd)$/i;

/** 包的类型：模型 / 材质 / 天空盒 / 图片素材。info.json 的 kind / assetType 优先，路径分类兜底。 */
export function assetCategory(info = {}, rel = '') {
  const kind = String(info.kind || '').toLowerCase();
  const type = String(info.assetType || info.sourceType || '').toLowerCase();
  const format = String(info.format || '').toLowerCase();
  if (kind === 'material' || type === 'textures' || Array.isArray(info.maps) || info.textures) return 'material';
  if (kind === 'hdri' || kind === 'skybox' || ['skybox', 'hdris'].includes(type) || ['hdr', 'exr'].includes(format)) return 'skybox';
  if (kind === 'images' || ['images', 'alphas'].includes(type) || (Array.isArray(info.images) && info.images.length)) return 'images';
  // 显式的 kind='model' 直接认，不再往下按目录名猜（本地登记写的就是这个值）。
  if (kind === 'model') return 'model';
  // 早期的包（sketchfab / artstation 模型）压根没有 kind 字段，只能看落盘分类目录。
  if (/[\\/]材质([\\/]|$)/.test(rel)) return 'material';
  if (/[\\/](环境|天空盒)([\\/]|$)/.test(rel)) return 'skybox';
  if (/[\\/]图片([\\/]|$)/.test(rel)) return 'images';
  return 'model';
}

/** 自然序：Ornament2 排在 Ornament10 前面，否则素材包封面会挑到 10 号以后的图。 */
function natural(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function pickCover(entries) {
  const usable = entries.filter(entry => COVER_EXT.test(entry.name)).sort((a, b) => natural(a.rel, b.rel));
  if (!usable.length) return null;
  const byName = (...patterns) => usable.find(entry => patterns.some(pattern => pattern.test(entry.name)));
  return byName(/^images\/[^/]+$/i, /^preview\b/i, /^thumbnail\b/i, /^cover\b/i, /^pack\.(png|jpe?g)$/i)
    || usable.filter(entry => entry.rel.split('/').length === 1)[0]
    || usable.find(entry => /\/color|_c[_\-.]|_basecolor|_albedo/i.test(entry.name) && /textures\//i.test(entry.rel))
    || usable.find(entry => /textures\//i.test(entry.rel))
    || usable[0];
}

function pickEntry(entries) {
  for (const ext of MODEL_PRIORITY) {
    const hit = entries.filter(entry => entry.ext === ext).sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel))[0];
    if (hit) return hit;
  }
  return null;
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

function describe({ info, entries, root, rel, type, mtime, bytes, fileCount, category, hasMeta = false }) {
  const entry = type === 'folder' ? pickEntry(entries) : null;
  const cover = type === 'folder' ? pickCover(entries) : null;
  const format = String(info.format || entry?.ext || '').toUpperCase();
  // 有些包（ambientCG）把官方缩略图地址写在 info.json 里，比包内任意一张贴图更能代表这个资产。
  const thumb = /^https?:\/\//i.test(String(info.thumbnail || '')) ? String(info.thumbnail) : null;
  // 清单里不列 info.json：它是资产自身的元信息，不是用户要看的包内文件。
  // 按自然序排：readdir 的返回顺序在 Windows 上不稳定，缩略图墙会忽前忽后。
  const listed = entries
    .filter(item => item.name !== 'info.json')
    .sort((a, b) => natural(a.rel || a.name, b.rel || b.name));
  return {
    root,
    rel,
    type,
    uid: typeof info.uid === 'string' ? info.uid : '',
    title: String(info.title || info.assetId || assetName(rel) || rel),
    author: String(info.author || ''),
    platform: String(info.platform || ''),
    license: String(info.license || ''),
    resolution: String(info.resolution || ''),
    format,
    category: category || assetCategory(info, rel),
    fileCount: type === 'zip' ? listed.length : fileCount,
    bytes,
    mtime,
    cover: cover?.rel || null,
    thumb,
    entry: entry?.rel || null,
    entries: listed.slice(0, MAX_LISTED_ENTRIES).map(item => ({ name: item.name, rel: item.rel, bytes: item.bytes })),
    truncatedEntries: listed.length > MAX_LISTED_ENTRIES,
    // 目录里有没有能解析的 info.json：前端据此决定要不要给「登记」按钮。
    hasMeta: hasMeta === true,
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
    for (const item of await readEntries(dir)) {
      if (item.name.startsWith('.')) continue;
      const childRel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name.toLowerCase()) || /\.unpacked$/i.test(item.name)) continue;
        queue.push({ dir: path.join(dir, item.name), rel: childRel });
        continue;
      }
      if (!item.isFile()) continue;
      // 包根的 info.json 是资产自身的元信息，不算「包内文件」，也不该出现在清单里。
      if (!prefix && item.name === 'info.json') continue;
      let stat = null;
      try { stat = await fsp.stat(path.join(dir, item.name)); } catch { continue; }
      bytes += stat.size; fileCount++;
      if (stat.mtimeMs > mtime) mtime = Math.round(stat.mtimeMs);
      entries.push({ rel: childRel, name: item.name, ext: path.extname(item.name).slice(1).toLowerCase(), bytes: stat.size, mtime: Math.round(stat.mtimeMs) });
    }
  }
  return { entries, bytes, fileCount, mtime };
}

/** 读 ZIP 的中央目录 + 只解出 info.json：扫描不该为了一个元信息把几十 MB 全解压。 */
async function readZipManifest(file) {
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
    let info = null, p = 0;
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
      if (name === 'info.json') info = { method, packed, length, offset };
    }
    if (!info || info.length > MAX_INFO_BYTES) return null;
    const local = Buffer.alloc(30);
    await handle.read(local, 0, 30, info.offset);
    if (local.readUInt32LE(0) !== 0x04034b50) return null;
    const start = info.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const raw = Buffer.alloc(info.packed);
    if (info.packed) await handle.read(raw, 0, info.packed, start);
    const data = info.method === 8 ? await inflate(raw) : raw;
    return { info: JSON.parse(data.toString('utf8')), entries, bytes: size, mtime: Math.round((await handle.stat()).mtimeMs) };
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
export async function scanLibraryPackages({ roots = [], limit = 2000 } = {}) {
  const packages = [];
  const files = [];
  const byUid = new Map();
  let truncated = false;

  const addPackage = item => {
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
    const entries = await readEntries(dir);
    const names = new Set(entries.map(entry => entry.name));
    if (names.has('info.json')) {
      let info = null;
      try { info = JSON.parse(await fsp.readFile(path.join(dir, 'info.json'), 'utf8')); }
      catch { info = null; }
      if (info && typeof info === 'object') {
        const flat = await walkPackage(dir, root, rel);
        addPackage(describe({ info, entries: flat.entries, root, rel, type: 'folder', mtime: flat.mtime, bytes: flat.bytes, fileCount: flat.fileCount, hasMeta: true }));
        return;
      }
    }
    // 用户自己整理/拷进资产库的素材往往没有 info.json，但同样是「一个文件夹＝一个资产」。
    // 补三条判定，否则一包 70 张 alpha 就是 70 张没有缩略图的行卡：
    //   a) 目录里只有一两个模型文件 + 旁边的贴图子目录 → 整包算一个模型资产
    //      （一个目录里躺着十几个模型的是「模型合集」，那种应该逐个文件出卡，不能吞成一张）；
    //   b) 子目录全是 PNG / SVG / TGA 这类格式名 → 同一套素材的多种格式，合成一个包；
    //   c) 叶子目录里除了图片什么都没有（≥2 张）→ 一个图片素材包。
    const subdirs = entries.filter(item => item.isDirectory() && !disposableDir(item.name));
    const directFiles = entries.filter(item => item.isFile() && !item.name.startsWith('.') && item.name !== 'info.json');
    const directModels = directFiles.filter(item => MODEL_EXT.has(path.extname(item.name).slice(1).toLowerCase())).length;
    if (directModels >= 1 && directModels <= 2 && subdirs.length) {
      const flat = await walkPackage(dir, root, rel);
      addPackage(describe({ info: {}, entries: flat.entries, root, rel, type: 'folder', mtime: flat.mtime, bytes: flat.bytes, fileCount: flat.fileCount }));
      return;
    }
    if (subdirs.length && subdirs.every(item => GENERIC_DIR.test(item.name))) {
      const flat = await walkPackage(dir, root, rel);
      const kinds = new Set(flat.entries.map(item => fileKind(item.name)));
      if (kinds.size === 1 && kinds.has('image')) {
        addPackage(describe({ info: {}, entries: flat.entries, root, rel, type: 'folder', mtime: flat.mtime, bytes: flat.bytes, fileCount: flat.fileCount, category: 'images' }));
        return;
      }
    }
    if (!subdirs.length) {
      const kinds = directFiles.map(item => fileKind(item.name));
      const images = kinds.filter(kind => kind === 'image').length;
      if (images >= 2 && images === kinds.length) {
        const flat = await walkPackage(dir, root, rel);
        addPackage(describe({ info: {}, entries: flat.entries, root, rel, type: 'folder', mtime: flat.mtime, bytes: flat.bytes, fileCount: flat.fileCount, category: 'images' }));
        return;
      }
    }
    for (const item of entries) {
      if (item.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        if (depth >= MAX_DEPTH || disposableDir(item.name)) continue;
        await walk(path.join(dir, item.name), root, childRel, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      const abs = path.join(dir, item.name);
      if (/\.zip$/i.test(item.name)) {
        const manifest = await readZipManifest(abs);
        if (manifest?.info) {
          addPackage(describe({ info: manifest.info, entries: manifest.entries, root, rel: childRel, type: 'zip', mtime: manifest.mtime, bytes: manifest.bytes, fileCount: manifest.entries.length, hasMeta: true }));
          continue;
        }
      }
      let stat = null;
      try { stat = await fsp.stat(abs); } catch { continue; }
      files.push({ rel: childRel, name: item.name, ext: path.extname(item.name).slice(1).toLowerCase(), kind: fileKind(item.name), bytes: stat.size, mtime: Math.round(stat.mtimeMs), root });
      if (files.length >= limit) { truncated = true; return; }
    }
  }

  for (const root of roots) await walk(root, root, '', 0);

  packages.sort((a, b) => b.mtime - a.mtime);
  files.sort((a, b) => b.mtime - a.mtime);
  return { packages, files, truncated };
}
