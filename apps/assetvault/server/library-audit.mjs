// 资产检查：库内「目录 ↔ 记录」的一致性体检与安全修复。
//
// 为什么要这块界面（2026-11-16）：下载目录搬进资产根以后，包目录既登记成资产、又还在
// 扫描根里，同一资产出两张卡；早期记录又只写主文件路径不写包目录，主文件一改名，
// 扫描侧就认不出这个目录已经有主。这些都不是「肉眼翻卡片能发现」的问题，得有一处
// 统一检查——巡检脚本已有一份，前端要能看能修，所以规则搬到这里，脚本改成薄壳。
//
// 修复只做「不会误伤」的三类，全部可恢复（asset:trash 进回收站，不删文件）：
//   1. 归属锚点：补 payload.packageDir（纯补字段）
//   2. 重复记录：同一包目录被多条记录占着 → 留最完整的一条，其余进回收站
// 悬空（文件真的没了）、未登记包只报告不处理：前者要主人决定留不留，后者可能是
// 主人刚拷进来还没登记的正常目录。
import fs from 'node:fs';
import path from 'node:path';
import {claimIndex, isClaimed, packageDirOf} from './asset-claim.mjs';

const SIDECARS = ['__info.json', 'info.json'];
const SKIP_DIRS = new Set(['node_modules', '__MACOSX', 'System Volume Information', '$RECYCLE.BIN']);

/** 资产根下找「包目录」：含 sidecar 的那一层，找到就不再往里钻。 */
export function findPackages(root, maxDepth = 3) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map(item => item.name));
    if (depth > 0 && SIDECARS.some(name => names.has(name))) { out.push(dir); return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** 包内身份：__info.json 优先（登记时写的），退回 info.json（下载器写的）。 */
export function sidecarUid(dir) {
  for (const name of SIDECARS) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (typeof data?.uid === 'string' && data.uid) return data.uid;
    } catch { /* 读坏或不存在就试下一个 */ }
  }
  return '';
}

const isDir = target => { try { return fs.statSync(target).isDirectory(); } catch { return false; } };
const exists = target => { try { fs.statSync(target); return true; } catch { return false; } };
const clip = (value, max = 120) => (String(value || '').length > max ? `…${String(value).slice(-max)}` : String(value || ''));

const EMPTY = { counts: { assets: 0, anchors: 0, dangling: 0, duplicates: 0, pending: 0, noThumb: 0 }, anchors: [], dangling: [], duplicates: [], pending: [], noThumb: [] };

/**
 * 只读体检。返回四类问题 + 明细（各限 limit 条，计数是全量）。
 * archiveRoot 只用来扫盘，storage 只读，不改任何数据。
 */
export async function auditLibrary({ storage, archiveRoot, limit = 40 } = {}) {
  if (!storage || !archiveRoot) return { ...EMPTY };
  let rows = null;
  try {
    rows = await storage.withDb(conn => conn.all("SELECT uid, name, kind, platform, thumbnail, payload FROM assets WHERE state='active'"));
  } catch { rows = null; }
  if (!rows) return { ...EMPTY };
  const index = claimIndex(rows);

  // 先扫盘：包目录 + 包内 uid。连 filePath 都没有的老记录，只能靠 uid 认亲。
  const dirs = findPackages(archiveRoot);
  const dirByUid = new Map();
  for (const dir of dirs) {
    const uid = sidecarUid(dir);
    if (uid) dirByUid.set(uid.toLowerCase(), dir);
  }

  const anchors = [];
  const dangling = [];
  const noThumb = [];
  const byDir = new Map();
  const byName = new Map();

  for (const row of rows) {
    let model = {};
    try { model = JSON.parse(row.payload || '{}') || {}; } catch { /* 单条读坏不影响整体 */ }
    const saved = String(model.packageDir || '');
    const target = (saved && isDir(saved)) ? saved : (packageDirOf(model) || dirByUid.get(String(row.uid || '').toLowerCase()) || '');
    if (target && target !== saved) anchors.push({ uid: row.uid, name: row.name, platform: row.platform, dir: target });

    const dir = target || saved;
    const file = String(model.filePath || '');
    if (dir && !isDir(dir)) dangling.push({ uid: row.uid, name: row.name, platform: row.platform, kind: row.kind, what: '包目录', target: dir });
    else if (!dir && file && !exists(file)) dangling.push({ uid: row.uid, name: row.name, platform: row.platform, kind: row.kind, what: '主文件', target: file });
    else if (!dir && !file) dangling.push({ uid: row.uid, name: row.name, platform: row.platform, kind: row.kind, what: '路径为空', target: '' });

    if (!String(row.thumbnail || '').trim()) noThumb.push({ uid: row.uid, name: row.name, platform: row.platform, kind: row.kind });

    if (dir) {
      const key = path.resolve(dir).toLowerCase();
      if (!byDir.has(key)) byDir.set(key, []);
      byDir.get(key).push({ uid: row.uid, name: row.name, platform: row.platform, thumbnail: String(row.thumbnail || ''), file, dir });
    }
    const named = `${row.name}\u0000${row.kind}`;
    if (!byName.has(named)) byName.set(named, []);
    byName.get(named).push(row.uid);
  }

  // 同一包目录多条记录：这才是真重复（同名不同目录多半是不同文件，不算）。
  const duplicates = [];
  for (const [key, list] of byDir) {
    if (list.length < 2) continue;
    // 留「有缩略图 + 主文件还在」的那条，其次有缩略图的，最后才取第一条。
    const score = item => (item.file && exists(item.file) ? 2 : 0) + (item.thumbnail ? 1 : 0);
    const sorted = [...list].sort((a, b) => score(b) - score(a));
    duplicates.push({ dir: key, keep: sorted[0], drops: sorted.slice(1) });
  }

  const pending = [];
  for (const dir of dirs) {
    const uid = sidecarUid(dir);
    const rel = path.relative(archiveRoot, dir).split(path.sep).join('/');
    if (isClaimed({ root: archiveRoot, rel, uid }, index)) continue;
    pending.push({ rel, uid, dir });
  }

  const sample = list => list.slice(0, limit);
  return {
    counts: {
      assets: rows.length,
      anchors: anchors.length,
      dangling: dangling.length,
      duplicates: duplicates.length,
      pending: pending.length,
      noThumb: noThumb.length,
    },
    anchors: sample(anchors),
    dangling: sample(dangling),
    // 明细里带完整路径会让面板过长，这里给出相对资产根的尾巴，够认得出是哪个包。
    duplicates: sample(duplicates).map(item => ({
      dir: clip(item.dir, 90),
      keep: { uid: item.keep.uid, name: item.keep.name, platform: item.keep.platform },
      drops: item.drops.map(drop => ({ uid: drop.uid, name: drop.name, platform: drop.platform })),
    })),
    pending: sample(pending).map(item => ({ rel: item.rel, uid: item.uid })),
    noThumb: sample(noThumb),
  };
}

/**
 * 安全修复：只补锚点、只把重复记录里多余的那几条移进回收站。
 * 走 mutateAssets(syncBlob:true) —— 它同时回写 blob，否则「移进回收站的记录」
 * 会被下一次整块合并写用旧 blob 复活（这是 5.2 那层双写要解决的问题）。
 */
export async function repairLibrary({ storage, archiveRoot, kinds = ['anchors', 'duplicates'] } = {}) {
  const report = await auditLibrary({ storage, archiveRoot, limit: 5000 });
  const ops = [];
  if (kinds.includes('anchors')) {
    for (const item of report.anchors) ops.push({ op: 'asset:patch', uid: item.uid, patch: { packageDir: item.dir } });
  }
  if (kinds.includes('duplicates')) {
    for (const group of report.duplicates) {
      for (const drop of group.drops) ops.push({ op: 'asset:trash', uid: drop.uid });
    }
  }
  if (!ops.length) return { applied: 0, changes: [], report };
  let result;
  try {
    result = await storage.mutateAssets(ops, { actor: 'library-audit', syncBlob: true });
  } catch (error) {
    return { applied: 0, error: error.message, report };
  }
  const applied = Number(result?.applied) || 0;
  // 修完再体检一次，前端直接拿新报告刷新面板（省一次往返）。
  const after = await auditLibrary({ storage, archiveRoot });
  return { applied, changes: result?.changes || [], report: after };
}
