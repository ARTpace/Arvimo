// 多资源库切换的注册表（ADR-12）。
//
// 约束：AssetVault 里所有「数据目录」都由 resolveUserPaths() 一次性决定（storage / 备份 /
// 采集 / 下载记录 / 登录令牌全挂在它上面），进程内改不了。所以切库不是热切换，
// 而是「改注册表里的 activeId → 重启服务进程」。这样每个模块拿到的仍是同一个目录，
// 不需要把十几个模块改成惰性取目录，也不会出现两个库串数据。
//
// 注册表固定存在 %APPDATA%/AssetVault/libraries.json —— **不能**放进 dataDir，
// 否则切到别的库就再也看不见这份清单了。
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const REGISTRY_FILE = 'libraries.json';
export const REGISTRY_VERSION = 1;
export const DEFAULT_STORE_ID = 'default';
const STORE_MARK = '.assetvault-store.json';
// 库自带的数据目录：<资产根>/.assetvault/data。
// 同行都这么做（Billfish 的 .bf/、灵犬的 items.db 都在库根里），好处是整个库
// 拷到另一台机器就能直接打开。点开头的目录扫描器本来就会跳过，不会被当成资产。
export const LIBRARY_META_DIR = '.assetvault';
export const libraryDataDir = archiveRoot => path.join(path.resolve(archiveRoot), LIBRARY_META_DIR, 'data');

/** 归一化目录用于比较：Windows 大小写不敏感，尾部分隔符也无意义。 */
function normDir(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 目录名只保留文件系统允许的字符：库名是给人看的，不能让它把路径搞坏。 */
function folderName(value) {
  const name = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  return name || '资源库';
}

/**
 * 归档根：按分类树落盘的资产根，目录名就是库名 —— 用户改名，磁盘跟着改。
 * 默认库放 base/<库名>，自建库放「库目录的父级/<库名>」，和库数据目录做邻居。
 */
function archiveRootFor(base, {dataDir, name, builtin} = {}) {
  if (builtin) return path.join(base, folderName(name || '默认资源库'));
  const resolved = path.resolve(dataDir || path.join(base, 'data'));
  // 新布局 dataDir = <库根>/.assetvault/data → 库根就是祖父目录，不要再往下套一层库名。
  // 老清单（dataDir 与资产根是兄弟）仍走下面的旧算法，读一次注册表就自然兼容。
  if (path.basename(path.dirname(resolved)) === LIBRARY_META_DIR) return path.dirname(path.dirname(resolved));
  const target = path.dirname(resolved);
  const candidate = path.join(target, folderName(name));
  // 归档根绝不能就是库数据目录本身：改名会连 library.db 和 imports 一起搬，
  // 而 DB 里存的是绝对路径，搬完所有托管资产就全断了。
  if (normDir(candidate) === normDir(resolved)) return `${resolved}-assets`;
  return candidate;
}

function defaultStore(base) {
  const store = {
    id: DEFAULT_STORE_ID,
    name: '默认资源库',
    dataDir: '',
    downloadDir: path.join(base, 'downloads'),
    createdAt: 0,
    builtin: true,
  };
  // 默认库的资产根是 base/默认资源库，库数据放它里面 —— 整个文件夹拷走就是一个完整的库。
  store.archiveRoot = archiveRootFor(base, store);
  store.dataDir = libraryDataDir(store.archiveRoot);
  return store;
}

function cleanStore(raw, base) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const dataDir = String(raw.dataDir || '').trim();
  if (!id || !dataDir || !path.isAbsolute(dataDir)) return null;
  const downloadDir = String(raw.downloadDir || '').trim();
  const store = {
    id,
    name: String(raw.name || '').trim() || path.basename(dataDir) || id,
    dataDir: path.resolve(dataDir),
    downloadDir: downloadDir && path.isAbsolute(downloadDir) ? path.resolve(downloadDir) : path.join(path.dirname(path.resolve(dataDir)), 'downloads'),
    createdAt: Number(raw.createdAt) || 0,
    builtin: id === DEFAULT_STORE_ID,
  };
  // 老清单没有 archiveRoot：按库名现算，读一次就补齐，不用手工迁移配置。
  const archiveRoot = String(raw.archiveRoot || '').trim();
  store.archiveRoot = archiveRoot && path.isAbsolute(archiveRoot) ? path.resolve(archiveRoot) : archiveRootFor(base, store);
  return store;
}

/** 读注册表。坏文件不抛错：留一份 .invalid 存档，然后按默认库继续 —— 启动不能被打断。 */
export function readStoreRegistry(base) {
  const file = path.join(base, REGISTRY_FILE);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { fs.renameSync(file, `${file}.invalid-${Date.now()}`); } catch {}
    }
    const fallback = {version: REGISTRY_VERSION, activeId: DEFAULT_STORE_ID, stores: [defaultStore(base)]};
    return fallback;
  }
  const stores = [];
  const seen = new Set();
  for (const item of Array.isArray(raw?.stores) ? raw.stores : []) {
    const store = cleanStore(item, base);
    if (!store) continue;
    const key = normDir(store.dataDir);
    if (seen.has(key)) continue;
    seen.add(key);
    stores.push(store);
  }
  // 默认库永远在列表里（它可能从未被写进文件）。
  if (!stores.some(store => store.id === DEFAULT_STORE_ID)) stores.unshift(defaultStore(base));
  const activeId = stores.some(store => store.id === raw?.activeId) ? raw.activeId : DEFAULT_STORE_ID;
  return {version: REGISTRY_VERSION, activeId, stores};
}

/** 原子写：先写临时文件再 rename，半截文件不会留在原地。 */
export function writeStoreRegistry(base, registry) {
  const file = path.join(base, REGISTRY_FILE);
  fs.mkdirSync(base, {recursive: true});
  const payload = {version: REGISTRY_VERSION, activeId: registry.activeId, stores: registry.stores};
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return payload;
}

/**
 * 当前生效的资源库。选中的库目录不在了（U 盘拔了、目录被删）就退回默认库，
 * 而不是起一个指向空气的服务；默认库是内置的，永远都在。
 */
export function activeStore(base) {
  const registry = readStoreRegistry(base);
  const fallback = registry.stores.find(item => item.builtin) || null;
  const store = registry.stores.find(item => item.id === registry.activeId);
  if (!store) return fallback;
  // 默认库永远「在」：它的数据目录在 <默认资源库>/.assetvault/data，首次启动时才创建，
  // 不能因为还没建就判成不存在（那会把服务指回 base/data，跟注册表说的位置分家）。
  if (store.builtin) return store;
  try {
    if (!fs.existsSync(store.dataDir)) return fallback;
  } catch { return fallback; }
  return store;
}

export class StoreRejected extends Error {}

function requireName(value) {
  const name = String(value || '').trim();
  if (!name) throw new StoreRejected('资源库名称不能为空');
  if (name.length > 40) throw new StoreRejected('资源库名称最多 40 个字');
  return name;
}

/**
 * 列表：补上每个库的磁盘实况（是否存在、数据库大小、最后修改时间）。
 * 只 stat 不打开数据库 —— 列表要能秒回，打开别人的库会拉起另一个 sqlite 句柄。
 */
export function listStores(base, {dataDir, downloadDir} = {}) {
  const registry = readStoreRegistry(base);
  const current = normDir(dataDir || '');
  const stores = registry.stores.map(store => {
    const dbFile = path.join(store.dataDir, 'library.db');
    let exists = false, bytes = 0, updatedAt = 0;
    try {
      exists = fs.existsSync(store.dataDir);
      const stat = exists ? fs.statSync(dbFile) : null;
      if (stat) { bytes = stat.size; updatedAt = stat.mtimeMs; }
      else if (exists) updatedAt = fs.statSync(store.dataDir).mtimeMs;
    } catch {}
    return {
      id: store.id,
      name: store.name,
      dataDir: store.dataDir,
      downloadDir: store.downloadDir,
      archiveRoot: store.archiveRoot,
      builtin: !!store.builtin,
      exists,
      bytes,
      updatedAt,
      active: normDir(store.dataDir) === current,
      selected: store.id === registry.activeId,
    };
  });
  return {activeId: registry.activeId, currentDir: dataDir || '', stores};
}

/** 用户显式点选的资产目录：必须是绝对路径，也不能和库数据目录重合。 */
function requireAssetsDir(value, dataDir) {
  const raw = String(value || '').trim();
  if (!raw) throw new StoreRejected('资产目录不能为空');
  if (!path.isAbsolute(raw)) throw new StoreRejected('资产目录必须是绝对路径');
  const dir = path.resolve(raw);
  if (dataDir && normDir(dir) === normDir(dataDir)) throw new StoreRejected('资产目录不能和库数据目录是同一个文件夹');
  return dir;
}

/** 新建一个空库登记（不初始化数据库 —— 下次以它启动时服务自己会建）。 */
export function createStore(base, {name, dir, assetsDir} = {}) {
  const registry = readStoreRegistry(base);
  const label = requireName(name);
  // dir 是用户选的「库文件夹」：资产直接放它里面，库数据藏在 .assetvault/data。
  // 一个文件夹 = 一个完整库，拷到别的机器上不用再找配置和数据库。
  const target = dir ? String(dir).trim() : path.join(base, 'stores', folderName(label));
  if (!path.isAbsolute(target)) throw new StoreRejected('资源库目录必须是绝对路径');
  const root = path.resolve(target);
  const dataDir = libraryDataDir(root);
  if (registry.stores.some(store => normDir(store.dataDir) === normDir(dataDir) || normDir(store.archiveRoot) === normDir(root))) {
    throw new StoreRejected('这个目录已经登记过了');
  }
  const picked = assetsDir ? requireAssetsDir(assetsDir, dataDir) : '';
  fs.mkdirSync(dataDir, {recursive: true});
  const store = {
    id: `store-${randomUUID().slice(0, 8)}`,
    name: label,
    dataDir,
    downloadDir: path.join(root, 'downloads'),
    archiveRoot: '',
    createdAt: Date.now(),
  };
  store.archiveRoot = picked || root;
  try {
    fs.writeFileSync(path.join(dataDir, STORE_MARK), `${JSON.stringify({name: label, archiveRoot: store.archiveRoot, createdAt: store.createdAt}, null, 2)}\n`);
  } catch {}
  registry.stores.push(store);
  writeStoreRegistry(base, registry);
  return store;
}

/** 改选。只写注册表，进程当前仍连着旧库 —— 重启后才生效。 */
export function selectStore(base, id, {dataDir} = {}) {
  const registry = readStoreRegistry(base);
  const store = registry.stores.find(item => item.id === id);
  if (!store) throw new StoreRejected('找不到这个资源库');
  if (!fs.existsSync(store.dataDir)) throw new StoreRejected(`目录不存在：${store.dataDir}`);
  registry.activeId = store.id;
  writeStoreRegistry(base, registry);
  return {store, restartRequired: normDir(store.dataDir) !== normDir(dataDir || '')};
}

/**
 * 改「资产目录」：只换新文件落盘的根，不搬已存在的文件。
 *
 * 不搬是有意的 —— 托管导入（dataDir/imports）和 library.db 里存的都是绝对路径，
 * 一次静默搬迁会把正在浏览的卡片全部指空。旧目录里有东西就回给前端一句提示，
 * 由用户自己在资源管理器里处理。
 */
export function relocateStore(base, id, {assetsDir} = {}) {
  const registry = readStoreRegistry(base);
  const store = registry.stores.find(item => item.id === id);
  if (!store) throw new StoreRejected('找不到这个资源库');
  const next = requireAssetsDir(assetsDir, store.dataDir);
  const previous = store.archiveRoot;
  if (normDir(next) === normDir(previous)) return {...store, unchanged: true, previous, leftBehind: null};
  store.archiveRoot = next;
  writeStoreRegistry(base, registry);
  try {
    fs.writeFileSync(path.join(store.dataDir, STORE_MARK), `${JSON.stringify({name: store.name, archiveRoot: next, createdAt: store.createdAt || Date.now()}, null, 2)}\n`);
  } catch {}
  let leftBehind = null;
  try {
    if (previous && fs.existsSync(previous) && fs.readdirSync(previous).length) leftBehind = previous;
  } catch {}
  // 库数据住在旧资产根里（自包含布局）：换根之后数据没跟过去，新库只剩资产。
  // 这里如实告诉前端，别让人以为已经搬完了 —— 搬数据要停服务，见 scripts/move-data-into-library.mjs。
  const dataInside = previous && isInsideOf(store.dataDir, previous) ? previous : null;
  return {...store, previous, leftBehind, dataInside, dataDir: store.dataDir};
}

/** child 是否在 parent 目录之内（不含相等）。 */
function isInsideOf(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 改名 = 改显示名 + 把归档根目录一起改名，磁盘上一眼就能对上。
 * 目标目录已存在（用户手工建过同名夹）时不动文件，只保住旧目录继续用，
 * 避免把两批资产混到一个没人预期的位置。
 */
export function renameStore(base, id, name) {
  const registry = readStoreRegistry(base);
  const store = registry.stores.find(item => item.id === id);
  if (!store) throw new StoreRejected('找不到这个资源库');
  const label = requireName(name);
  const nextName = {dataDir: store.dataDir, name: label, builtin: store.builtin};
  const nextRoot = archiveRootFor(base, nextName);
  let moved = false;
  let keptOld = false;
  if (normDir(nextRoot) !== normDir(store.archiveRoot || '')) {
    const currentExists = fs.existsSync(store.archiveRoot);
    if (!currentExists) {
      store.archiveRoot = nextRoot; // 还没落过文件：直接换指向，不建空目录
    } else if (!fs.existsSync(nextRoot)) {
      try {
        fs.renameSync(store.archiveRoot, nextRoot);
        store.archiveRoot = nextRoot;
        moved = true;
      } catch {
        keptOld = true;
      }
    } else {
      keptOld = true; // 同名目录已存在，不合并
    }
  }
  store.name = label;
  writeStoreRegistry(base, registry);
  try {
    fs.writeFileSync(path.join(store.dataDir, STORE_MARK), `${JSON.stringify({name: label, archiveRoot: store.archiveRoot, createdAt: store.createdAt || Date.now()}, null, 2)}\n`);
  } catch {}
  return {...store, moved, keptOld};
}

/** 只从清单里摘掉，磁盘上一个字节都不删。 */
export function removeStore(base, id, {dataDir} = {}) {
  const registry = readStoreRegistry(base);
  if (id === DEFAULT_STORE_ID) throw new StoreRejected('默认资源库不能移除');
  const store = registry.stores.find(item => item.id === id);
  if (!store) throw new StoreRejected('找不到这个资源库');
  if (normDir(store.dataDir) === normDir(dataDir || '')) throw new StoreRejected('正在使用的资源库不能移除，请先切换到别的库');
  registry.stores = registry.stores.filter(item => item.id !== id);
  if (!registry.stores.some(item => item.id === registry.activeId)) registry.activeId = DEFAULT_STORE_ID;
  writeStoreRegistry(base, registry);
  return {removed: store.id, dataDir: store.dataDir};
}
