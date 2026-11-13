// Eagle / Billfish 资源库导入。
//
// 两个产品用的是同一套库结构（Billfish 可直接打开 Eagle 库，反过来也基本成立）：
//   <库根>/metadata.json          → { folders: [{id, name, children}] }
//   <库根>/images/<id>.info      → 新版本是目录（内含 metadata.json + 缩略图 + 原图）
//                                  旧版本是单文件 JSON + 同目录的 <id>.<ext>
//
// 导入策略刻意「先落地再入库」：
//   1. 原图复制进 <dataDir>/imports/<库名>/<Eagle 文件夹路径>/，缩略图进 _thumbs/；
//      不引用原位置 —— 用户删掉 Eagle 之后库还得能看；
//   2. 再把整批条目拼成一份快照交给 library-portable.importLibrary —— 写入路径、
//      种子语义、合集挂载全部复用，不另开一条能写坏数据的口子。
//
// 字段映射：标签 → userTags，星级 → rating，备注 → note，Eagle 文件夹 → 合集。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {importLibrary, PORTABLE_FORMAT, PORTABLE_VERSION} from './library-portable.mjs';

const MAX_ITEMS = 20000;
const PROBE_SAMPLES = 3;
const CONCURRENCY = 4;
const UID = /^[a-f0-9]{32}$/;

const exists = async target => {
  try { await fsp.access(target); return true; } catch { return false; }
};

/** Windows 不允许的字符换成下划线；Eagle 的文件夹名经常带 / 与 :。 */
const safeName = value => String(value || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'unnamed';

function uidFor(libraryRoot, itemId) {
  return createHash('sha1').update(`eagle:${libraryRoot}:${itemId}`).digest('hex').slice(0, 32);
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

/** 库根可能在选中目录本身，也可能是它下面唯一那个 *.billfish / *.library 子目录。 */
async function resolveLibraryRoot(folder) {
  const direct = path.resolve(String(folder || ''));
  if (!(await exists(direct))) throw Error('这个目录不存在或磁盘未连接');
  const looksLikeLibrary = async dir => {
    const meta = await readJson(path.join(dir, 'metadata.json'));
    if (!meta || !Array.isArray(meta.folders)) return false;
    return exists(path.join(dir, 'images'));
  };
  if (await looksLikeLibrary(direct)) return {root: direct, meta: await readJson(path.join(direct, 'metadata.json'))};
  let entries = [];
  try { entries = await fsp.readdir(direct, {withFileTypes: true}); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(direct, entry.name);
    if (await looksLikeLibrary(child)) return {root: child, meta: await readJson(path.join(child, 'metadata.json'))};
  }
  return null;
}

/** folders 树 → id 到 {name, path} 的索引；path 用来在磁盘上还原层级。 */
function flattenFolders(meta) {
  const byId = new Map();
  const walk = (nodes, parents) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const id = String(node?.id ?? '');
      const name = String(node?.name ?? '');
      if (id) byId.set(id, {id, name, parents: [...parents]});
      walk(node?.children, [...parents, name].filter(Boolean));
    }
  };
  walk(meta?.folders, []);
  return byId;
}

/** 单个 .info（目录或文件）→ {info, assetPath, thumbPath}；读不出原图就返回 null。 */
async function readItem(infoPath, isDirectory, imagesDir) {
  if (isDirectory) {
    const info = await readJson(path.join(infoPath, 'metadata.json'));
    if (!info) return null;
    let children = [];
    try { children = await fsp.readdir(infoPath, {withFileTypes: true}); } catch { return null; }
    const files = [];
    for (const child of children) {
      if (!child.isFile()) continue;
      const full = path.join(infoPath, child.name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat?.isFile()) files.push({name: child.name, path: full, size: stat.size});
    }
    const thumbName = `${info.id}.png`.toLowerCase();
    const thumb = files.find(file => file.name.toLowerCase() === thumbName) || null;
    // 优先按 info.name + ext 精确命中；对不上再取「排除说明文件后最大的那个」。
    // metadata.json 往往比缩略图还大，按体积取第一个会把说明文件当成原图。
    const expected = `${String(info.name || '')}${info.ext ? `.${String(info.ext).toLowerCase()}` : ''}`.toLowerCase();
    const named = expected ? files.find(file => file.name.toLowerCase() === expected) : null;
    const asset = named
      || files.filter(file => file !== thumb && !/\.(json|info|txt|md)$/i.test(file.name)).sort((a, b) => b.size - a.size)[0]
      || null;
    return asset ? {info, assetPath: asset.path, assetBytes: asset.size, thumbPath: thumb?.path || null} : null;
  }
  const info = await readJson(infoPath);
  if (!info) return null;
  const ext = String(info.ext || '').toLowerCase();
  const candidate = path.join(imagesDir, `${info.id}.${ext}`);
  const stat = await fsp.stat(candidate).catch(() => null);
  if (!stat?.isFile()) return null;
  const thumb = path.join(imagesDir, `${info.id}.png`);
  return {info, assetPath: candidate, assetBytes: stat.size, thumbPath: (await exists(thumb)) ? thumb : null};
}

async function listInfoEntries(imagesDir) {
  let entries = [];
  try { entries = await fsp.readdir(imagesDir, {withFileTypes: true}); } catch { return null; }
  return entries.filter(entry => entry.name.endsWith('.info'));
}

/** 探测：只数条目、读少量样本，不做任何复制。 */
export async function probeThirdPartyLibrary(folder) {
  const resolved = await resolveLibraryRoot(folder);
  if (!resolved) throw Error('这个目录不像 Eagle / Billfish 资源库（需要 metadata.json 与 images 目录）');
  const imagesDir = path.join(resolved.root, 'images');
  const entries = await listInfoEntries(imagesDir);
  if (!entries) throw Error('这个库里没有 images 目录，无法读取条目');
  const folders = flattenFolders(resolved.meta);
  const samples = [];
  for (const entry of entries.slice(0, PROBE_SAMPLES)) {
    const item = await readItem(path.join(imagesDir, entry.name), entry.isDirectory(), imagesDir).catch(() => null);
    if (item?.info) samples.push({name: String(item.info.name || ''), tags: Array.isArray(item.info.tags) ? item.info.tags.slice(0, 5) : [], star: Number(item.info.star) || 0});
  }
  return {
    kind: 'eagle-compatible',
    root: resolved.root,
    name: path.basename(resolved.root).replace(/\.(billfish|library)$/i, ''),
    items: entries.length,
    folders: folders.size,
    samples,
  };
}

async function copyInto(from, to) {
  await fsp.mkdir(path.dirname(to), {recursive: true});
  let target = to;
  const ext = path.extname(to);
  const stem = ext ? to.slice(0, -ext.length) : to;
  for (let n = 2; await exists(target); n += 1) target = `${stem}-${n}${ext}`;
  await fsp.copyFile(from, target);
  const stat = await fsp.stat(target);
  return {path: target, bytes: stat.size};
}

/** 并发池：复制是 IO 密集但别开几千个句柄，4 路够把 SSD 喂满。 */
async function pool(items, worker) {
  let index = 0;
  const runners = Array.from({length: Math.min(CONCURRENCY, items.length || 1)}, async () => {
    while (index < items.length) {
      const at = index++;
      await worker(items[at], at);
    }
  });
  await Promise.all(runners);
}

/**
 * 导入整个资源库。
 * @returns 报告：added / skipped / folders / collections / libraryRoot（登记为导入根的那个目录）
 */
export async function importEagleLibrary({folder, dataDir, importRoots, storage, now = Date.now} = {}) {
  if (!storage) throw Error('数据库不可用，暂时无法导入');
  const resolved = await resolveLibraryRoot(folder);
  if (!resolved) throw Error('这个目录不像 Eagle / Billfish 资源库（需要 metadata.json 与 images 目录）');
  const imagesDir = path.join(resolved.root, 'images');
  const entries = await listInfoEntries(imagesDir);
  if (!entries) throw Error('这个库里没有 images 目录，无法读取条目');
  if (entries.length > MAX_ITEMS) throw Error(`这个库有 ${entries.length} 个条目，超过单次导入上限 ${MAX_ITEMS}`);

  const folders = flattenFolders(resolved.meta);
  const libraryName = safeName(path.basename(resolved.root).replace(/\.(billfish|library)$/i, ''));
  // 所有导入库共用一个根：本地文件扫描、缩略图接口都按「根 + 相对路径」鉴权。
  const importRoot = path.join(dataDir, 'imports');
  const libraryDir = path.join(importRoot, libraryName);
  await fsp.mkdir(path.join(libraryDir, '_thumbs'), {recursive: true});

  const report = {library: libraryName, source: resolved.root, libraryRoot: importRoot, added: 0, skipped: 0, collections: 0, assets: [], failures: []};
  const collectionMap = new Map();

  const tasks = entries.map(entry => ({path: path.join(imagesDir, entry.name), isDirectory: entry.isDirectory()}));
  const assets = [];
  await pool(tasks, async task => {
    const item = await readItem(task.path, task.isDirectory, imagesDir).catch(() => null);
    if (!item?.info?.id) { report.skipped += 1; return; }
    if (item.info.isDeleted) { report.skipped += 1; return; }
    const info = item.info;
    const ext = String(info.ext || path.extname(item.assetPath).slice(1) || '').toLowerCase();
    const uid = uidFor(resolved.root, info.id);
    if (!UID.test(uid)) { report.skipped += 1; return; }
    // Eagle 的一个项目可以属于多个文件夹：第一个决定落盘位置，全部映射成合集。
    const folderIds = Array.isArray(info.folders) ? info.folders.map(String) : [];
    const firstFolder = folderIds.map(id => folders.get(id)).find(Boolean);
    const relativeDir = firstFolder ? [...firstFolder.parents, firstFolder.name].map(safeName).join('/') : '';
    const targetExt = ext ? `.${ext}` : path.extname(item.assetPath);
    // Eagle 的 name 一般不含扩展名；带了也不重复加，免得出现 a.jpg.jpg。
    const rawName = String(info.name || path.basename(item.assetPath));
    const fileName = safeName(targetExt && rawName.toLowerCase().endsWith(targetExt.toLowerCase()) ? rawName.slice(0, -targetExt.length) : rawName);
    let copied = null;
    try {
      copied = await copyInto(item.assetPath, path.join(libraryDir, relativeDir, `${fileName}${targetExt}`));
    } catch (error) {
      report.skipped += 1;
      report.failures.push({name: String(info.name || ''), reason: error.message});
      return;
    }
    let thumbUrl = '';
    if (item.thumbPath) {
      try {
        await fsp.copyFile(item.thumbPath, path.join(libraryDir, '_thumbs', `${uid}.png`));
        thumbUrl = `/api/local/thumb?w=512&root=${encodeURIComponent(importRoot)}&rel=${encodeURIComponent(`${libraryName}/_thumbs/${uid}.png`)}`;
      } catch { /* 缩略图没有不影响条目本身 */ }
    }
    const tags = (Array.isArray(info.tags) ? info.tags : []).map(tag => String(tag).trim()).filter(Boolean).slice(0, 24);
    const model = {
      uid,
      platform: 'eagle',
      source: 'eagle',
      name: String(info.name || fileName),
      author: String(info.author || ''),
      url: String(info.url || ''),
      license: String(info.license || ''),
      ext,
      bytes: copied.bytes,
      filePath: copied.path,
      fileExists: true,
      addedAt: Number(info.btime) || Number(info.mtime) || now,
      thumbnail: thumbUrl,
      // 分类带上祖先链：Eagle 的 item.folders 只存直属文件夹，按父级筛选时才找得到它。
      categories: [...new Set(folderIds.flatMap(id => {
        const folder = folders.get(id);
        return folder ? [...folder.parents, folder.name] : [];
      }))],
      // userTags / rating / note 会被 importLibrary 当成「首次入库种子」写进用户域。
      userTags: tags,
      rating: Math.min(5, Math.max(0, Math.round(Number(info.star) || 0))),
      note: String(info.annotation || '').slice(0, 2000),
      downloadable: true,
    };
    assets.push(model);
    for (const id of folderIds) {
      const folder = folders.get(id);
      if (!folder) continue;
      const collection = collectionMap.get(id) || {id: `eagle-${createHash('sha1').update(`${resolved.root}:${id}`).digest('hex').slice(0, 12)}`, name: folder.name || '未命名文件夹', uids: []};
      collection.uids.push(uid);
      collectionMap.set(id, collection);
    }
  });

  if (!assets.length) {
    return {...report, collections: 0, assets: undefined, message: '这个库里没有可导入的项目'};
  }

  // 缩略图接口只认「已登记的导入根」：不登记的话卡片全是裂图。
  try { importRoots?.add?.(importRoot); } catch { /* 已存在或路径异常都不该阻断入库 */ }

  const payload = {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt: now,
    assets,
    trashed: [],
    collections: [...collectionMap.values()].filter(item => item.uids.length).map((item, index) => ({
      id: item.id,
      name: item.name,
      parentId: null,
      description: '',
      position: index,
      uids: item.uids,
    })),
  };
  const applied = await importLibrary({storage, payload, mode: 'merge', actor: 'eagle-import', now});
  return {
    library: report.library,
    source: report.source,
    libraryRoot: importRoot,
    added: applied.added,
    seeded: applied.seeded,
    collections: applied.collections,
    skipped: report.skipped,
    failures: report.failures.slice(0, 20),
    total: entries.length,
  };
}
