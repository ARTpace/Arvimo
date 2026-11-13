// 自动备份与恢复：DB 与权威状态一起备份；恢复失败保留现库。
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const STAMP = /^\d{8}-\d{6}(?:-\d{3})?$/;
// 同一个 storage 的多个服务实例共用互斥，定时/手动操作不能互踩。
const operations = new WeakMap();
const issuedStamps = new WeakMap();
function serialize(storage, action) {
  const result = (operations.get(storage) || Promise.resolve()).then(action);
  operations.set(storage, result.catch(() => {}));
  return result;
}
function stampOf(date) {
  const p = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
function configOf() {
  const minutes = Number(process.env.AV_BACKUP_INTERVAL_MIN);
  const keep = Number(process.env.AV_BACKUP_KEEP);
  return {
    intervalMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 6 * 60 * 60 * 1000,
    keep: Number.isFinite(keep) && keep > 0 ? Math.min(Math.floor(keep), 100) : 5,
  };
}
async function exists(target) {
  try { await fs.access(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function copyOptional(source, target) {
  try { await fs.copyFile(source, target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// 只允许缺失的可选输入；权限、复制错误不能冒充完整备份。
async function copyDir(source, target) {
  let names;
  try { names = await fs.readdir(source); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await fs.mkdir(target, {recursive: true});
  for (const name of names) {
    if (name.endsWith('.tmp')) continue;
    const from = path.join(source, name);
    const to = path.join(target, name);
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) throw Error('备份不允许符号链接');
    if (stat.isDirectory()) await copyDir(from, to);
    else await fs.copyFile(from, to);
  }
  return true;
}
async function inventory(folder, prefix = '') {
  const files = {};
  for (const entry of await fs.readdir(folder, {withFileTypes: true})) {
    if (entry.name === 'meta.json' && !prefix) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) throw Error('备份不允许符号链接');
    if (entry.isDirectory()) Object.assign(files, await inventory(file, name));
    else files[name] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  }
  return files;
}
/** 仅检查暂存副本；v2 无摘要，仍检查 JSON 与 SQLite，不迁移当前库。 */
async function validateSnapshot(folder) {
  const meta = JSON.parse(await fs.readFile(path.join(folder, 'meta.json'), 'utf8'));
  const files = await inventory(folder);
  if (meta.version >= 3 && JSON.stringify(Object.entries(files).sort()) !== JSON.stringify(Object.entries(meta.files || {}).sort())) {
    throw Error('备份完整性校验失败');
  }
  if (!files['library.db'] && !files['library-state.json'] && !Object.keys(files).some(name => name.startsWith('state/'))) {
    throw Error('备份缺少数据文件');
  }
  if (meta.hasDatabase && !files['library.db']) throw Error('备份缺少数据库');
  for (const name of Object.keys(files).filter(name => name.endsWith('.json'))) {
    JSON.parse(await fs.readFile(path.join(folder, name), 'utf8'));
  }
  if (files['library.db']) {
    const module = createRequire(import.meta.url)(process.env.AV_SQLITE_MODULE || 'better-sqlite3');
    const Database = module.default || module.Database || module;
    const db = new Database(path.join(folder, 'library.db'), {readonly: true, fileMustExist: true});
    try {
      if (db.pragma('quick_check', {simple: true}) !== 'ok') throw Error('备份数据库完整性校验失败');
    } finally {
      db.close();
      // WAL 模式只读检查也会创建空 sidecar；不属于快照，不能发布或安装。
      await fs.rm(path.join(folder, 'library.db-wal'), {force: true});
      await fs.rm(path.join(folder, 'library.db-shm'), {force: true});
    }
  }
}

/** 目录布局：<dataDir>/backups/<时间戳>/{library.db, state/, library-state.json, meta.json} */
export function createBackupService({storage, dir, keep, intervalMs, now = Date.now, onWarn = () => {}} = {}) {
  if (!storage) throw Error('缺少资产库存储实例');
  const root = dir || path.join(storage.dataDir, 'backups');
  const options = configOf();
  const limit = keep || options.keep;
  const every = intervalMs || options.intervalMs;
  let timer = null;

  async function list() {
    let names = [];
    try { names = await fs.readdir(root); } catch { return []; }
    const items = [];
    for (const name of names.filter(item => STAMP.test(item)).sort().reverse()) {
      let meta = null;
      try { meta = JSON.parse(await fs.readFile(path.join(root, name, 'meta.json'), 'utf8')); } catch { /* 仍显示损坏项 */ }
      items.push({name, at: meta?.at ?? null, assets: meta?.assets ?? null, size: meta?.size ?? null, hasDatabase: meta?.hasDatabase === true});
    }
    return items;
  }
  async function prune(protectedNames = []) {
    let names = [];
    try { names = await fs.readdir(root); } catch { return 0; }
    const sorted = names.filter(item => STAMP.test(item)).sort();
    let removed = 0;
    for (const name of sorted.filter(name => !protectedNames.includes(name)).slice(0, Math.max(0, sorted.length - limit))) {
      try { await fs.rm(path.join(root, name), {recursive: true, force: true}); removed++; }
      catch (error) { onWarn(`旧备份清理失败（${name}）：${error.message}`); }
    }
    return removed;
  }
  /** 先写临时目录、校验、再发布；恢复前安全备份不执行清理。 */
  async function runNow({cleanup = true} = {}) {
    const stamp = stampOf(new Date(now()));
    const previous = issuedStamps.get(storage);
    let index = previous?.stamp === stamp ? previous.index + 1 : 1;
    let name = index === 1 ? stamp : `${stamp}-${String(index).padStart(3, '0')}`;
    while (await exists(path.join(root, name))) {
      index += 1;
      name = `${stamp}-${String(index).padStart(3, '0')}`;
    }
    issuedStamps.set(storage, {stamp, index});
    const target = path.join(root, name);
    const temp = `${target}.tmp`;
    await fs.mkdir(root, {recursive: true});
    await fs.rm(temp, {recursive: true, force: true});
    await fs.mkdir(temp, {recursive: true});
    let hasDatabase = false;
    let assets = null;
    try {
      await storage.ensureIndex();
      const dbFile = path.join(temp, 'library.db');
      const stats = await storage.withDb(conn => conn.backupTo(dbFile).then(() => conn.counts()));
      hasDatabase = !!stats;
      assets = stats?.assets ?? null;
      await copyDir(storage.stateDir, path.join(temp, 'state'));
      await copyOptional(path.join(storage.dataDir, 'library-state.json'), path.join(temp, 'library-state.json'));
      if (!hasDatabase && await exists(path.join(storage.dataDir, 'library.db'))) throw Error('当前数据库无法备份');
      await fs.writeFile(path.join(temp, 'meta.json'), JSON.stringify({
        at: now(), stamp: name, assets, hasDatabase, version: 3, files: await inventory(temp),
      }), 'utf8');
      await validateSnapshot(temp);
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, {recursive: true, force: true});
      throw error;
    }
    if (cleanup) await prune();
    return {name, assets, hasDatabase};
  }
  async function tick() {
    try { await serialize(storage, () => runNow()); }
    catch (error) { onWarn(`资产库自动备份失败：${error.message}`); }
  }
  async function restore(name) {
    const id = String(name ?? '').trim();
    if (!STAMP.test(id)) throw Error('备份编号无效');
    const source = path.join(root, id);
    if (!await exists(source)) throw Error('备份不存在');
    // 暂存目录不参与 prune；复制/校验失败时当前库完全不动。
    const work = await fs.mkdtemp(path.join(storage.dataDir, '.restore-'));
    const staged = path.join(work, 'staged');
    const rollback = path.join(work, 'rollback');
    let retainRollback = false;
    try {
      await copyDir(source, staged);
      await validateSnapshot(staged);
      // 安全副本失败则关闭恢复，不能在没有后路时继续破坏性替换。
      const safety = await runNow({cleanup: false});
      await storage.exclusive(async () => {
        await fs.mkdir(rollback);
        const entries = [
          ['state', storage.stateDir],
          ...['library-state.json', 'library.db', 'library.db-wal', 'library.db-shm']
            .map(name => [name, path.join(storage.dataDir, name)]),
        ];
        const moved = [];
        const installed = [];
        try {
          // 原文件（含 WAL/SHM）只移动不删除，回滚不依赖再次复制或安全副本。
          for (const [name, target] of entries) {
            if (await exists(target)) {
              await fs.rename(target, path.join(rollback, name));
              moved.push([name, target]);
            }
          }
          for (const [name, target] of entries.slice(0, 3)) {
            if (await exists(path.join(staged, name))) {
              await fs.rename(path.join(staged, name), target);
              installed.push(target);
            }
          }
        } catch (error) {
          try {
            for (const target of installed.reverse()) await fs.rm(target, {recursive: true, force: true});
            for (const [name, target] of moved.reverse()) await fs.rename(path.join(rollback, name), target);
          } catch (rollbackError) {
            retainRollback = true;
            throw new AggregateError([error, rollbackError], `恢复及回滚失败；原文件保留于 ${rollback}；安全备份 ${safety.name}`);
          }
          throw error;
        }
      });
      await prune([safety.name]);
      return {restored: id, safety};
    } finally {
      if (!retainRollback) await fs.rm(work, {recursive: true, force: true});
    }
  }
  return {
    list,
    runNow: () => serialize(storage, () => runNow()),
    restore: name => serialize(storage, () => restore(name)),
    prune: () => serialize(storage, () => prune()),
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, every);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    get config() { return {dir: root, keep: limit, intervalMs: every}; },
  };
}
