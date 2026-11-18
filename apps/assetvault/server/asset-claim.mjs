// 资产「归属锚点」：判断一个磁盘目录是否已经登记成资产。
//
// 背景（2026-11-16）：下载目录搬进资产根以后，同一个包目录既被登记成资产、又还躺在
// 扫描根里，于是同一资产出两张卡（一张平台缩略图、一张「N 张」图集）。scan 路由原来
// 只对零散 files 去重，packages 原样返回 —— 这就是重复卡的来路。
//
// 第一版判据是「靠推断」：记录里只有主文件路径（filePath），包目录要靠前缀反推。
// 主文件一改名、包一搬、包内 uid 一不一致，推断就断，重复卡复现。现在改成
// 「写入即锚定」：入库时把包目录写进 payload.packageDir（anchorPackage），判据第一
// 优先比这个事实字段；uid 与前缀只作兜底。规则集中在本模块，scan 路由与巡检脚本
// 共用一份，避免两边各写一套慢慢漂移。
import fs from 'node:fs';
import path from 'node:path';

/** 包目录的识别标记：登记过的目录里必有其一。 */
const SIDECARS = ['__info.json', 'info.json'];

/** filePath → 推导出的包目录。目录很少变，命中就缓存；查不到不缓存（可能还没创建）。 */
const dirCache = new Map();

function statSafe(target) {
  try { return fs.statSync(target); } catch { return null; }
}

function hasSidecar(dir) {
  return SIDECARS.some(name => fs.existsSync(path.join(dir, name)));
}

/** 目录的规范形式（绝对路径、小写）：Windows 上大小写不一致也要能对上。 */
export function dirKey(dir) {
  try { return path.resolve(String(dir)).toLowerCase(); } catch { return ''; }
}

/**
 * 记录对应的包目录 —— 事实，不是推断。
 *
 * 1. payload.packageDir 且目录还在 → 直接用它（快路径，一次 stat）。
 * 2. filePath 本身是目录（目录型资产）→ 是包才用。
 * 3. filePath 的父目录里有 sidecar → 父目录就是包。
 * 4. 否则是包外散图（父目录是分类目录，如 `材质/`）→ 没有包目录。
 */
export function packageDirOf(model) {
  if (!model || typeof model !== 'object') return '';
  const saved = String(model.packageDir || '').trim();
  if (saved && statSafe(saved)?.isDirectory()) return saved;

  const file = String(model.filePath || '').trim();
  if (!file) return '';
  const cached = dirCache.get(file);
  if (cached) return cached;

  const stat = statSafe(file);
  if (stat?.isDirectory()) {
    if (hasSidecar(file)) { dirCache.set(file, file); return file; }
    return '';
  }
  const dir = path.dirname(file);
  if (hasSidecar(dir)) { dirCache.set(file, dir); return dir; }
  // 主文件常在包内的 textures/ models/ unpacked/ 子目录里，sidecar 在包根：
  // 向上找最近的一层 sidecar（最多 2 层，够覆盖 `包/textures/x.jpg` 这类最深的结构）。
  let up = path.dirname(dir);
  for (let depth = 0; depth < 2 && up && up !== path.dirname(up); depth += 1) {
    if (hasSidecar(up)) { dirCache.set(file, up); return up; }
    up = path.dirname(up);
  }
  return '';
}

/**
 * 写入前统一补锚点：把包目录写进记录。
 * 返回 true 表示补了（调用方据此决定要不要记日志）。
 */
export function anchorPackage(model) {
  if (!model || typeof model !== 'object') return false;
  const dir = packageDirOf(model);
  if (!dir || model.packageDir === dir) return false;
  model.packageDir = dir;
  return true;
}

/**
 * 由库里的活动资产行建一张「已被认领」索引。
 * rows 只要 {uid, payload}：路径锚点全在 payload 里。
 */
export function claimIndex(rows = []) {
  const dirs = new Set();
  const uids = new Set();
  const files = [];
  for (const row of rows) {
    const uid = String(row?.uid || '').toLowerCase();
    if (uid) uids.add(uid);
    let model = {};
    try { model = JSON.parse(row?.payload || '{}') || {}; } catch { /* 单条读坏不影响整体 */ }
    if (model.packageDir) {
      const key = dirKey(model.packageDir);
      if (key) dirs.add(key);
    }
    if (model.filePath) {
      const key = dirKey(model.filePath);
      if (key) files.push(key);
    }
  }
  return { dirs, uids, files };
}

/** 扫描出来的包（root + rel），绝对路径的规范形式。 */
export function packageKeyOf(pkg) {
  const rel = String(pkg?.rel || '').split('/').filter(Boolean);
  return dirKey(path.resolve(String(pkg?.root || ''), ...rel));
}

/** 这个包是否已经有资产记录认领（有主就不该再出「素材包」卡）。 */
export function isClaimed(pkg, index) {
  if (!index) return false;
  const key = packageKeyOf(pkg);
  if (key && index.dirs.has(key)) return true;
  const uid = String(pkg?.uid || '').toLowerCase();
  if (uid && index.uids.has(uid)) return true;
  // 记录只写了包内主文件（下载器落盘的常态）：包目录是那个文件的前缀。
  if (key) return index.files.some(file => file === key || file.startsWith(key + path.sep));
  return false;
}

/**
 * 这个包「本该是资产、却查不到记录」—— 有包内身份（uid 或 sidecar）但没人认领。
 * 前端据此显示「未登记」角标：漏登记要明说，不能悄悄伪装成普通素材包
 * （那正是这次重复卡的观感来源）。
 */
export function isPendingClaim(pkg) {
  return pkg?.category !== 'images' && Boolean(String(pkg?.uid || '').trim() || pkg?.hasMeta === true);
}
