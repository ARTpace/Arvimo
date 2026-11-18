// 一次性维护脚本：把受管导入目录（dataDir/imports）里的资产搬到资产根（archiveRoot），
// 按「分组/子类型」两级分类目录摆放，与平台下载的落点统一。
//
// 为什么需要搬：
//   imports 是早期的托管副本目录（拖入 / 复制进库 / Eagle 导入都落这儿），
//   资产根是下载与分类树的落盘根。两套落点意味着「同一批资产在磁盘上分两个地方」，
//   用户整理目录时看不见全貌，C 盘还白占一份。
//
// 安全约定：
//   · 默认 dry-run，只打印清单；带 --apply 才动文件。
//   · 动之前先把 library.db 复制一份 .bak-migrate-<时间戳>。
//   · 文件用**复制**而不是移动 —— 源目录原样留着，确认卡片正常后再手动清；
//     中途失败最多是多一份副本，不会出现「两边都没有」。
//   · 资产记录走 createLocationRegistry().rebind()，root_id / location_id / url 一起重绑，
//     不手写 SQL，也不重新生成资产身份（收藏、标签、UID 全保留）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {resolveUserPaths} from '../server/data-dir.mjs';
import {assetFolder} from '../server/asset-folders.mjs';
import {createLocationRegistry} from '../server/file-locations.mjs';
import {inspectAssetFormat} from '../server/image-sniff.mjs';
import {formatKind} from '../src/library/format-registry.js';

const apply = process.argv.includes('--apply');
const {dataDir, archiveRoot} = resolveUserPaths();
const sourceRoot = path.resolve(dataDir, 'imports');
const dbFile = path.join(dataDir, 'library.db');

const norm = value => {
  try { return path.resolve(String(value || '')).toLowerCase(); } catch { return ''; }
};
const base = value => path.basename(String(value || '').split(/[\\/]/).pop() || '');

if (!fs.existsSync(dbFile)) { console.error(`找不到资产库：${dbFile}`); process.exit(1); }

const db = new Database(dbFile, {readonly: !apply});
const rows = db.prepare('SELECT uid,payload FROM assets').all();
const targets = [];
for (const row of rows) {
  let model;
  try { model = JSON.parse(row.payload); } catch { continue; }
  const file = typeof model.filePath === 'string' ? path.resolve(model.filePath) : '';
  const root = typeof model.localRoot === 'string' ? path.resolve(model.localRoot) : '';
  const inImports = (root && norm(root) === norm(sourceRoot)) || (file && norm(file).startsWith(norm(sourceRoot) + path.sep));
  if (!inImports) continue;
  if (!file || !fs.existsSync(file)) { targets.push({uid: row.uid, model, file, skipped: '源文件不存在'}); continue; }
  const name = base(file);
  // AI 生成器导出的文件名常带提示词原文（含逗号、括号、句点），path.extname 会把
  // 「…outdoors」后半截当成扩展名，classifyAsset 于是判成「待分类」。
  // 这里以文件头为准：扩展名不认识就按真实格式补上，让迁移后的文件能被系统预览、也能分类。
  // 注意 formatKind 对未知扩展名返回 'other'（truthy），所以必须显式排掉它。
  const knownExt = value => {
    const v = String(value || '').replace(/^\./, '').trim();
    if (!v || v.length > 5 || !/^[a-z0-9]+$/i.test(v)) return '';
    const kind = formatKind(`asset.${v}`);
    return kind && kind !== 'other' ? v.toLowerCase() : '';
  };
  const rawExt = knownExt(path.extname(name).slice(1));
  const ext = rawExt || knownExt(model.ext) || (inspectAssetFormat(file).effective || '');
  const storedName = rawExt || !ext ? name : `${name}.${ext}`;
  const rel = path.join(assetFolder({...model, ext: ext || undefined, filename: storedName, filePath: storedName}), storedName);
  targets.push({uid: row.uid, model, file, name: storedName, rel});
}

let total = 0, copied = 0, skipped = 0, failed = 0;
const plan = [];
for (const item of targets) {
  total++;
  if (item.skipped) { skipped++; console.log(`跳过  ${item.name || item.uid}：${item.skipped}`); continue; }
  let dest = path.join(archiveRoot, item.rel);
  if (path.resolve(dest) === path.resolve(item.file)) { skipped++; continue; }
  // 目标已存在：同名但内容不同就加序号，绝不覆盖用户在资产根里已有的文件。
  let index = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(item.name), stem = item.name.slice(0, item.name.length - ext.length);
    dest = path.join(archiveRoot, path.dirname(item.rel), `${stem} (${index + 1})${ext}`);
    if (++index > 50) break;
  }
  plan.push({...item, dest});
}

const byFolder = plan.reduce((acc, item) => {
  const folder = path.dirname(item.rel);
  (acc[folder] = acc[folder] || []).push(item.name);
  return acc;
}, {});

console.log(`\n资产根：${archiveRoot}`);
console.log(`受管导入目录：${sourceRoot}`);
console.log(`待迁移：${plan.length} 个（共扫到 ${total} 条记录，跳过 ${skipped}）\n`);
for (const [folder, names] of Object.entries(byFolder)) {
  console.log(`  ${folder}  ${names.length} 个`);
  if (names.length <= 6) names.forEach(name => console.log(`      · ${name}`));
  else { names.slice(0, 4).forEach(name => console.log(`      · ${name}`)); console.log(`      · … 其余 ${names.length - 4} 个`); }
}
if (!apply) {
  console.log('\n这是预览（没有改动任何文件）。确认后加 --apply 执行。');
  db.close();
  process.exit(0);
}
if (!plan.length) { console.log('没有需要迁移的记录。'); db.close(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${dbFile}.bak-migrate-${stamp}`;
fs.copyFileSync(dbFile, backup);
console.log(`\n已备份资产库：${backup}`);

const registry = createLocationRegistry(db);
const update = db.prepare('UPDATE assets SET payload=? WHERE uid=?');
const manifest = {stamp, archiveRoot, sourceRoot, backup, moved: []};

for (const item of plan) {
  try {
    await fsp.mkdir(path.dirname(item.dest), {recursive: true});
    await fsp.copyFile(item.file, item.dest, fs.constants.COPYFILE_EXCL);
    const rel = path.relative(archiveRoot, item.dest).split(path.sep).join('/');
    let next = {...item.model, localRoot: archiveRoot, localRel: rel, filePath: item.dest};
    next = registry.rebind(next);
    update.run(JSON.stringify(next), item.uid);
    manifest.moved.push({uid: item.uid, from: item.file, to: item.dest});
    copied++;
    console.log(`复制  ${item.name} → ${path.dirname(rel)}`);
  } catch (error) {
    failed++;
    console.error(`失败  ${item.name}：${error.message}`);
  }
}

const manifestFile = path.join(dataDir, `migrate-imports-${stamp}.json`);
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
db.close();
console.log(`\n完成：复制 ${copied}，失败 ${failed}，跳过 ${skipped}`);
console.log(`迁移清单：${manifestFile}`);
console.log('源目录 dataDir/imports 里的文件保持原样，确认界面正常后可自行清理。');
