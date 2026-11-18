// 维护脚本：把资产根里「已经落盘、但分类目录不对」的资产挪到当前规则算出来的位置。
//
// 什么时候用：
//   · 分类规则升级（比如 AI 生成器命名规则补全）之后，老文件还压在旧目录里；
//   · 手工往资产根里拖过文件，目录和侧栏对不上。
//
// 与 migrate-imports 的区别：那个脚本搬的是 dataDir/imports 里的旧副本（跨盘复制），
// 这个只在资产根内部**移动**（同一分区 rename，瞬间完成，不产生副本）。
//
// 安全约定：
//   · 默认 dry-run；--apply 才动。
//   · 先备份 library.db。
//   · 只处理 filePath 落在当前资产根下的记录 —— 外链资产（linked 到 DCC 工程目录）绝不碰。
//   · 目标已存在时加序号，不覆盖。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {resolveUserPaths} from '../server/data-dir.mjs';
import {assetFolder} from '../server/asset-folders.mjs';
import {createLocationRegistry} from '../server/file-locations.mjs';

const apply = process.argv.includes('--apply');
const {dataDir, archiveRoot} = resolveUserPaths();
const dbFile = path.join(dataDir, 'library.db');

const norm = value => {
  try { return path.resolve(String(value || '')).toLowerCase(); } catch { return ''; }
};
const base = value => path.basename(String(value || '').split(/[\\/]/).pop() || '');

if (!fs.existsSync(dbFile)) { console.error(`找不到资产库：${dbFile}`); process.exit(1); }

const db = new Database(dbFile, {readonly: !apply});
const rows = db.prepare("SELECT uid,payload FROM assets WHERE state='active'").all();
const rootPrefix = norm(archiveRoot) + path.sep;
const plan = [];
let outside = 0;

for (const row of rows) {
  let model;
  try { model = JSON.parse(row.payload); } catch { continue; }
  const file = typeof model.filePath === 'string' ? path.resolve(model.filePath) : '';
  if (!file || !norm(file).startsWith(rootPrefix)) { outside++; continue; }
  if (!fs.existsSync(file)) continue;
  const name = base(file);
  const rel = path.join(assetFolder({...model, filename: name, filePath: name}), name);
  const dest = path.join(archiveRoot, rel);
  if (path.resolve(path.dirname(dest)) === path.resolve(path.dirname(file))) continue;
  plan.push({uid: row.uid, model, file, name, rel, dest, from: path.relative(archiveRoot, path.dirname(file))});
}

const moves = [];
for (const item of plan) {
  let dest = item.dest, index = 1;
  const ext = path.extname(item.name), stem = item.name.slice(0, item.name.length - ext.length);
  while (fs.existsSync(dest) && norm(dest) !== norm(item.file)) {
    dest = path.join(path.dirname(item.dest), `${stem} (${index + 1})${ext}`);
    if (++index > 50) break;
  }
  moves.push({...item, dest});
}

const byMove = moves.reduce((acc, item) => {
  const key = `${item.from} → ${path.dirname(item.rel)}`;
  (acc[key] = acc[key] || []).push(item.name);
  return acc;
}, {});

console.log(`\n资产根：${archiveRoot}`);
console.log(`库外资产（不动）：${outside} 个`);
console.log(`需要归位：${moves.length} 个\n`);
for (const [key, names] of Object.entries(byMove)) {
  console.log(`  ${key}  ${names.length} 个`);
  names.slice(0, 4).forEach(name => console.log(`      · ${name}`));
  if (names.length > 4) console.log(`      · … 其余 ${names.length - 4} 个`);
}

if (!apply) {
  console.log('\n这是预览（没有改动任何文件）。确认后加 --apply 执行。');
  db.close();
  process.exit(0);
}
if (!moves.length) { console.log('没有需要归位的资产。'); db.close(); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${dbFile}.bak-reclassify-${stamp}`;
fs.copyFileSync(dbFile, backup);
console.log(`\n已备份资产库：${backup}`);

const registry = createLocationRegistry(db);
const update = db.prepare('UPDATE assets SET payload=? WHERE uid=?');
const manifest = {stamp, archiveRoot, backup, moved: []};
let done = 0, failed = 0;

for (const item of moves) {
  try {
    await fsp.mkdir(path.dirname(item.dest), {recursive: true});
    await fsp.rename(item.file, item.dest);
    const rel = path.relative(archiveRoot, item.dest).split(path.sep).join('/');
    let next = {...item.model, localRoot: archiveRoot, localRel: rel, filePath: item.dest};
    next = registry.rebind(next);
    update.run(JSON.stringify(next), item.uid);
    manifest.moved.push({uid: item.uid, from: item.file, to: item.dest});
    done++;
  } catch (error) {
    failed++;
    console.error(`失败  ${item.name}：${error.message}`);
  }
}

const manifestFile = path.join(dataDir, `reclassify-${stamp}.json`);
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
db.close();
console.log(`\n完成：移动 ${done}，失败 ${failed}`);
console.log(`归位清单：${manifestFile}`);
