// 用户显式登记的本地资产根目录（资产库「导入文件夹」）。
//
// 与 local-roots.json 分工不同：那份是取文件 / 缩略图接口的白名单快照，由扫描和拖出自动补写，
// 里面可能残留历史下载目录；这份只存用户主动导入、要参与扫描的根，重启后仍然生效。
// 扫描只读认领，不复制、不改名、不删除磁盘上的素材；移除根也只改这份配置。
import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'import-roots.json';

/** 统一成本机绝对路径：Windows 上正/反斜杠混用会让扫描根在 Set 和缓存 key 里分裂成两条。 */
function normalize(folder) {
  const value = typeof folder === 'string' ? folder.trim() : '';
  if (!value || value.includes('\0') || /^(\\\\|\/\/)/.test(value)) return null;
  if (!path.isAbsolute(value)) return null;
  return path.resolve(value);
}

function isDir(folder) {
  try { return fs.statSync(folder).isDirectory(); } catch { return false; }
}

/** 探一次目录：断盘 / 盘符没挂上 / 被删都算离线，但原因分开报，前端才能说清「为什么读不到」。 */
function probe(folder) {
  try {
    return fs.statSync(folder).isDirectory() ? {online: true} : {online: false, reason: 'not_directory'};
  } catch (error) {
    const code = String(error?.code || '');
    return {online: false, reason: code === 'ENOENT' ? 'missing' : (code === 'EACCES' ? 'denied' : (code || 'error'))};
  }
}

export function createImportRoots(dataDir) {
  const file = path.join(dataDir, FILE_NAME);
  let roots = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(saved) ? saved : saved?.roots;
    if (Array.isArray(list)) roots = [...new Set(list.map(normalize).filter(Boolean))];
  } catch {}

  const save = () => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(roots, null, 2), {encoding: 'utf8', mode: 0o600});
  };

  // 离线起点只在内存里记：重启后第一条 status() 会重新打点，不值得为它写盘。
  const offlineSince = new Map();

  return {
    file,
    list: () => [...roots],
    /** 磁盘暂时断开不删配置：扫描时跳过，盘回来了自动恢复。 */
    valid: () => roots.filter(isDir),
    /** 每个根的在线状态。扫描只用 valid()，这里给界面看「哪个盘掉了、掉了多久」。 */
    status: () => roots.map(folder => {
      const result = probe(folder);
      if (result.online) {
        offlineSince.delete(folder);
        return {path: folder, online: true, reason: null, offlineSince: null};
      }
      if (!offlineSince.has(folder)) offlineSince.set(folder, Date.now());
      return {path: folder, online: false, reason: result.reason, offlineSince: offlineSince.get(folder)};
    }),
    /**
     * 重新定位：把断裂的旧根换成新位置。
     * 只改配置 + 让调用方重扫 —— 本地包是按「根 + 相对路径」实时读盘的，
     * 重扫后卡片自然回来，不需要改写任何资产记录（这也是不复制文件的架构红利）。
     */
    relink(from, to) {
      const source = normalize(from);
      const target = normalize(to);
      if (!source || !target) throw Error('路径不完整');
      if (!roots.includes(source)) throw Error('这个目录不在导入列表里');
      if (!isDir(target)) throw Error('新位置不存在或磁盘未连接');
      const at = roots.indexOf(source);
      // 新位置本来就在列表里时直接去重，否则同一份素材会被两个根各扫一遍。
      const next = roots.filter(item => item !== source && item !== target);
      next.splice(Math.min(at, next.length), 0, target);
      roots = next;
      offlineSince.delete(source);
      save();
      return {relinked: true, from: source, to: target, roots: [...roots]};
    },
    add(folder) {
      const root = normalize(folder);
      if (!root) throw Error('请输入本机文件夹的完整路径');
      if (!isDir(root)) throw Error('文件夹不存在或磁盘未连接');
      if (roots.includes(root)) return {added: false, root, roots: [...roots]};
      roots.push(root);
      save();
      return {added: true, root, roots: [...roots]};
    },
    remove(folder) {
      const root = normalize(folder);
      if (!root || !roots.includes(root)) return {removed: false, roots: [...roots]};
      roots = roots.filter(item => item !== root);
      save();
      return {removed: true, root, roots: [...roots]};
    },
  };
}
