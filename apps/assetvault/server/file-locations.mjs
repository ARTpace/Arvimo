// 稳定定位记录只认领已有资产 UID，不根据路径重新生成资产身份。
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

export function localLocator(model) {
  const root = model?.localRoot, input = model?.localRel;
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || /^(\\\\|\/\/)/.test(root)) return null;
  if (typeof input !== 'string' || !input || input.includes('\0') || path.isAbsolute(input)) return null;
  const parts = input.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f:<>"|?*]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return {root: path.resolve(root), rel: parts.join('/')};
}

export function locationModel(model, location) {
  if (!location) return model;
  const root = location.path, rel = location.rel;
  const query = new URLSearchParams({root, rel}).toString();
  const updated = {...model, localRoot: root, localRel: rel,
    filePath: path.join(root, ...rel.split('/')), fileExists: location.availability === 'online',
    locationId: location.location_id, rootId: location.root_id};
  if (typeof model.localRel === 'string' && model.name === path.posix.basename(model.localRel.replace(/\\/g,'/')))
    updated.name = path.posix.basename(rel);
  // 只改本地定位字段；网页来源、原始导入来源与自定义封面不改。
  for (const key of ['url', 'previewUrl', 'thumbnail']) {
    if (typeof updated[key] !== 'string' || !/^\/api\/local\/(file|thumb)\?/.test(updated[key])) continue;
    const url = new URL(updated[key], 'http://local');
    // 封面可能是包内 preview.jpg 或用户另选的图片，不能把它改写为主文件。
    // 只有引用旧主文件本身的地址，才跟随稳定位置迁移。
    const oldRoot = String(model.localRoot || '');
    const oldRel = String(model.localRel || '').replace(/\\/g, '/');
    const imageRoot = url.searchParams.get('root');
    const imageRel = String(url.searchParams.get('rel') || '').replace(/\\/g, '/');
    const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    if (!oldRoot || !imageRoot || !same(path.resolve(oldRoot), path.resolve(imageRoot)) || !same(oldRel, imageRel)) continue;
    url.searchParams.set('root', root); url.searchParams.set('rel', rel);
    updated[key] = url.pathname + '?' + url.searchParams.toString();
  }
  if (!updated.url) updated.url = '/api/local/file?' + query;
  return updated;
}

/** 复用 DB 的事务；不读盘、不搬文件，重复保存不会重建身份。 */
export function createLocationRegistry(db) {
  const byUid = db.prepare(`SELECT l.*, r.path FROM file_locations l
    JOIN file_roots r ON r.root_id = l.root_id WHERE l.asset_uid = ? ORDER BY l.location_id LIMIT 2`);
  const collate = process.platform === 'win32' ? ' COLLATE NOCASE' : '';
  const rootByPath = db.prepare('SELECT root_id FROM file_roots WHERE path = ?' + collate);
  const addRoot = db.prepare('INSERT OR IGNORE INTO file_roots (root_id,path) VALUES (?,?)');
  const byPath = db.prepare('SELECT asset_uid FROM file_locations WHERE root_id = ? AND rel = ?' + collate);
  const addLocation = db.prepare(`INSERT INTO file_locations
    (location_id,asset_uid,root_id,rel,fingerprint,availability,mode) VALUES (?,?,?,?,?,?,?)`);
  function apply(model) {
    const known = byUid.all(model.uid);
    if (known.length === 1) return locationModel(model, known[0]);
    if (known.length > 1) return model; // 多位置待人工解析，绝不任意选一个改路径。
    const locator = localLocator(model);
    if (!locator) return model;
    // Windows 同一路径不同大小写共用根；其它平台保持大小写语义。
    const rootPath = process.platform === 'win32' ? locator.root.toLowerCase() : locator.root;
    const id = createHash('sha256').update(rootPath).digest('hex').slice(0, 32);
    addRoot.run(id, locator.root);
    const rootId = rootByPath.get(locator.root)?.root_id || id;
    const existing = byPath.get(rootId, locator.rel);
    if (existing) return model; // 同路径不同 UID 保留，诊断 API 明确报告冲突。
    addLocation.run(randomUUID(), model.uid, rootId, locator.rel, model.sha256 || '',
      model.fileExists === false ? 'missing' : 'online', model.storageMode || 'linked');
    return locationModel(model, byUid.all(model.uid)[0]);
  }
  function rebind(model) {
    const locator = localLocator(model);
    if (!locator) throw Error('文件定位无效');
    const known = byUid.all(model.uid);
    if (known.length > 1) throw Error('资产存在多个位置，需要先解决冲突');
    if (!known.length) return apply(model);
    let rootId = rootByPath.get(locator.root)?.root_id;
    if (!rootId) {
      rootId = randomUUID(); addRoot.run(rootId, locator.root);
    }
    const occupied = byPath.get(rootId, locator.rel);
    if (occupied && occupied.asset_uid !== model.uid) throw Error('目标位置已被其他资产引用');
    db.prepare(`UPDATE file_locations SET root_id=?,rel=?,fingerprint=?,availability='online'
      WHERE location_id=?`).run(rootId, locator.rel, model.sha256 || '', known[0].location_id);
    return apply(model);
  }
  return {apply, rebind};
}
