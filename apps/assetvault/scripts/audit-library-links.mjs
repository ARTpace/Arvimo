// 库内「目录 ↔ 记录」一致性巡检（命令行版）。
//
// 规则不在这里：判据与修复动作都在 server/library-audit.mjs，前端「资产检查」面板
// 用的是同一份。这个脚本只是把同一份报告打到终端，给批量排查 / 服务没起来时用。
//
// 用法：node scripts/audit-library-links.mjs [--apply]
//   默认只读。--apply 只补 payload.packageDir。重复记录别在这里清 —— 那条路不双写 blob，
//   下次整块合并写会把旧 blob 抬回来，清了个寂寞。要清就去前端「资产检查」点修复。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {auditLibrary} from '../server/library-audit.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const APPLY = process.argv.includes('--apply');
const appBase = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AssetVault');

function resolveStore() {
  const registry = JSON.parse(fs.readFileSync(path.join(appBase, 'libraries.json'), 'utf8'));
  const store = registry.stores.find(s => s.id === registry.activeId) || registry.stores[0];
  if (!store) throw new Error('没有可用资源库');
  return { dataDir: store.dataDir, archiveRoot: store.archiveRoot, name: store.name };
}

const store = resolveStore();
const db = new Database(path.join(store.dataDir, 'library.db'));
db.pragma('journal_mode = DELETE');
// auditLibrary 只要求一个「能跑 SELECT」的 storage；写入仍走下面的直接 UPDATE。
const storage = { withDb: async handler => handler({ all: sql => db.prepare(sql).all() }) };

const report = await auditLibrary({ storage, archiveRoot: store.archiveRoot, limit: 12 });
const counts = report.counts;

console.log(`资源库 ${store.name} · ${store.archiveRoot}`);
console.log(`活动资产 ${counts.assets} 条\n`);
console.log(`[汇总] 锚点缺失 ${counts.anchors} · 重复记录 ${counts.duplicates} · 路径失效 ${counts.dangling} · 未登记包 ${counts.pending} · 无缩略图 ${counts.noThumb}\n`);

if (report.anchors.length) {
  console.log('[锚点] 记录里没写包目录（可补）');
  for (const item of report.anchors) console.log(`   ${String(item.name).slice(0, 34)} → ${item.dir.replace(store.archiveRoot, '.')}`);
  if (counts.anchors > report.anchors.length) console.log(`   … 另外 ${counts.anchors - report.anchors.length} 条`);
}
if (report.duplicates.length) {
  console.log('\n[重复] 同一包目录被多条记录占着');
  for (const group of report.duplicates) {
    console.log(`   ${group.dir}`);
    console.log(`      保留 ${group.keep.name.slice(0, 28)} · 移除 ${group.drops.length} 条（${group.drops.map(drop => drop.uid.slice(0, 8)).join(', ')}）`);
  }
}
if (report.dangling.length) {
  console.log('\n[悬空] 路径失效（仅报告）');
  for (const item of report.dangling) console.log(`   ${item.what} · ${item.platform || '?'} · ${String(item.name).slice(0, 28)} · ${item.target.replace(store.archiveRoot, '.') || '(无)'}`);
}
if (report.pending.length) {
  console.log('\n[未登记] 目录有身份、库里没记录（仅报告）');
  for (const item of report.pending) console.log(`   ${item.rel} ${item.uid ? `(uid ${String(item.uid).slice(0, 8)})` : ''}`);
}

if (APPLY && counts.anchors) {
  const now = Date.now();
  const update = db.prepare('UPDATE assets SET payload=?, rev=rev+1, updated_at=? WHERE uid=?');
  const rows = db.prepare("SELECT uid, payload FROM assets WHERE state='active'").all();
  const patch = new Map(report.anchors.map(item => [item.uid, item.dir]));
  let applied = 0;
  db.transaction(() => {
    for (const row of rows) {
      const dir = patch.get(row.uid);
      if (!dir) continue;
      let model;
      try { model = JSON.parse(row.payload || '{}'); } catch { continue; }
      model.packageDir = dir;
      update.run(JSON.stringify(model), now, row.uid);
      applied += 1;
    }
  })();
  console.log(`\n已补写 ${applied} 条 packageDir。重复记录请在前端「资产检查」里清（那边会双写 blob）。`);
} else if (counts.anchors) {
  console.log('\n（加 --apply 才补锚点；重复记录请在前端「资产检查」里处理）');
}

const healthy = !counts.anchors && !counts.duplicates && !counts.dangling && !counts.pending;
console.log(`\n${healthy ? '结论：目录与记录完全对得上。' : '结论：以上为报告。'}`);
db.close();
