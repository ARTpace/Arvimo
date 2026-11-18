// 首先只开放只读预检。恢复协议验收前，不把 fs.rename 暴露给界面。
import fs from 'node:fs/promises';
import path from 'node:path';
import {localLocator} from './file-locations.mjs';

const reject = message => Object.assign(Error(message), {status: 409});

export async function checkedOrganizePath(root, rel, allowRoot = false) {
  const locator = rel === '' && allowRoot ? {root, rel: ''} : localLocator({localRoot: root, localRel: rel});
  if (!locator) throw reject('相对路径无效，不能越过登记目录');
  // 根本身和每一层都必须是真实目录/文件，不跟随 junction 或符号链接。
  let current = locator.root;
  for (const part of ['', ...locator.rel.split('/').filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw reject('整理预检不允许符号链接或 junction');
  }
  const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (compare(path.resolve(await fs.realpath(locator.root))) !== compare(path.resolve(locator.root))) throw reject('登记根的上级包含链接，请使用真实路径');
  return current;
}

export function createFileOrganizePreflight({storage, importRoots}) {
  async function inspect(folder) {
    const root = path.resolve(String(folder || ''));
    if (!importRoots.list().includes(root)) throw reject('仅支持已登记的导入目录');
    const result = await storage.withDb(conn => {
      const roots = conn.all('SELECT root_id,path,writable FROM file_roots');
      const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
      const entry = roots.find(row => key(row.path) === key(root));
      const locations = entry ? conn.all('SELECT * FROM file_locations WHERE root_id=? ORDER BY rel', [entry.root_id]) : [];
      const issues = [];
      const ownedUids = new Set(locations.map(item => item.asset_uid));
      // 只读诊断旧记录；既不重新分配 UID，也不静默吞掉同一路径的其他资产。
      for (const row of conn.all("SELECT uid,payload FROM assets WHERE json_valid(payload) AND json_extract(payload,'$.localRoot') IS NOT NULL")) {
        const model = JSON.parse(row.payload);
        if (typeof model.localRoot !== 'string' || key(path.resolve(model.localRoot)) !== key(root)) continue;
        const locator = localLocator(model);
        const owned = ownedUids.has(row.uid);
        if (!locator) issues.push({uid: row.uid, code: 'invalid-location', rel: model.localRel});
        else if (!owned) issues.push({uid: row.uid, code: 'location-conflict', rel: locator.rel});
      }
      return {root: entry || {path: root, root_id: null, writable: 0}, locations, issues};
    });
    if (!result) throw reject('数据库不可用，无法验证稳定身份');
    return {...result, registeredAssets: result.locations.length, filesystemWritesEnabled: false};
  }
  async function plan({folder, from, to}) {
    const report = await inspect(folder);
    if (report.issues.length) throw reject('目录存在定位冲突，请先解决冲突');
    const root = report.root.path;
    const source = await checkedOrganizePath(root, from);
    from = localLocator({localRoot: root, localRel: from}).rel;
    const target = localLocator({localRoot: root, localRel: to});
    if (!target) throw reject('目标相对路径无效');
    const compare = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (compare(target.rel) === compare(from)) throw reject('目标与源相同；仅大小写改名尚未开放');
    if (compare(target.rel).startsWith(compare(from) + '/')) throw reject('不能把目录移入自身');
    await checkedOrganizePath(root, path.posix.dirname(target.rel) === '.' ? '' : path.posix.dirname(target.rel), true);
    const destination = path.join(root, ...target.rel.split('/'));
    try { await fs.lstat(destination); throw reject('目标已经存在，不允许覆盖'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stat = await fs.lstat(source);
    if (!stat.isFile() && !stat.isDirectory()) throw reject('仅支持普通文件或完整目录');
    if (/\.(meta|blend|fbx|obj|gltf|usd[ac]?|unity|prefab|mat)$/i.test(from) && stat.isFile()) throw reject('依赖型素材必须连同完整素材包整理，不能单独移动');
    const affected = report.locations.filter(item => item.rel === from || item.rel.startsWith(from + '/'))
      .map(item => ({uid: item.asset_uid, locationId: item.location_id, from: item.rel, to: target.rel + item.rel.slice(from.length)}));
    return {rootId: report.root.root_id, from, to: target.rel, directory: stat.isDirectory(), affected,
      filesystemWritesEnabled: false, warnings: ['当前只读预检，不移动文件；目录内未入库的文件会随目录一起移动，依赖完整性需后续校验']};
  }
  return {inspect, plan};
}
