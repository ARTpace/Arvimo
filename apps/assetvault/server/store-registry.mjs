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

/** 归一化目录用于比较：Windows 大小写不敏感，尾部分隔符也无意义。 */
function normDir(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function defaultStore(base) {
  return {
    id: DEFAULT_STORE_ID,
    name: '默认资源库',
    dataDir: path.join(base, 'data'),
    downloadDir: path.join(base, 'downloads'),
    createdAt: 0,
    builtin: true,
  };
}

function cleanStore(raw, base) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const dataDir = String(raw.dataDir || '').trim();
  if (!id || !dataDir || !path.isAbsolute(dataDir)) return null;
  const downloadDir = String(raw.downloadDir || '').trim();
  return {
    id,
    name: String(raw.name || '').trim() || path.basename(dataDir) || id,
    dataDir: path.resolve(dataDir),
    downloadDir: downloadDir && path.isAbsolute(downloadDir) ? path.resolve(downloadDir) : path.join(path.dirname(path.resolve(dataDir)), 'downloads'),
    createdAt: Number(raw.createdAt) || 0,
    builtin: id === DEFAULT_STORE_ID,
  };
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
 * 当前生效的资源库；目录不存在的（U 盘拔了、目录被删）返回 null，
 * 让调用方回退到默认目录而不是起一个指向空气的服务。
 */
export function activeStore(base) {
  const registry = readStoreRegistry(base);
  const store = registry.stores.find(item => item.id === registry.activeId);
  if (!store) return null;
  try {
    if (!fs.existsSync(store.dataDir)) return null;
  } catch { return null; }
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

/** 新建一个空库登记（不初始化数据库 —— 下次以它启动时服务自己会建）。 */
export function createStore(base, {name, dir} = {}) {
  const registry = readStoreRegistry(base);
  const label = requireName(name);
  const target = dir ? String(dir).trim() : path.join(base, 'stores', `library-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`);
  if (!path.isAbsolute(target)) throw new StoreRejected('资源库目录必须是绝对路径');
  const dataDir = path.resolve(target);
  if (registry.stores.some(store => normDir(store.dataDir) === normDir(dataDir))) {
    throw new StoreRejected('这个目录已经登记过了');
  }
  fs.mkdirSync(dataDir, {recursive: true});
  try {
    fs.writeFileSync(path.join(dataDir, STORE_MARK), `${JSON.stringify({name: label, createdAt: Date.now()}, null, 2)}\n`);
  } catch {}
  const store = {
    id: `store-${randomUUID().slice(0, 8)}`,
    name: label,
    dataDir,
    downloadDir: path.join(path.dirname(dataDir), 'downloads'),
    createdAt: Date.now(),
  };
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

export function renameStore(base, id, name) {
  const registry = readStoreRegistry(base);
  const store = registry.stores.find(item => item.id === id);
  if (!store) throw new StoreRejected('找不到这个资源库');
  store.name = requireName(name);
  writeStoreRegistry(base, registry);
  return store;
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
