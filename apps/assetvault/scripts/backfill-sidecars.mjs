// 维护脚本：给资产根里已有的资产补写 __info.json（sidecar）。
//
// 默认 dry-run：只打印前几个样例，不写文件。
// 加 --apply 才落盘。内容没变的资产会跳过（微力同步不会被无意义地触发）。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {resolveUserPaths} from '../server/data-dir.mjs';
import {writeSidecar, sidecarPayload, sidecarPathFor} from '../server/asset-sidecar.mjs';

const apply = process.argv.includes('--apply');
const {dataDir, archiveRoot} = resolveUserPaths();
const dbFile = path.join(dataDir, 'library.db');

if (!fs.existsSync(dbFile)) { console.error(`找不到资产库：${dbFile}`); process.exit(1); }

const prefix = path.resolve(archiveRoot).toLowerCase() + path.sep;
const db = new Database(dbFile, {readonly: true});
const rows = db.prepare("SELECT payload FROM assets WHERE state='active'").all();

// 真实像素尺寸只有读文件头才知道（DB 里的 probe 是缩略图尺寸，不能用）。
let sharp = null;
try { sharp = (await import('sharp')).default; } catch {}
const IMAGE_EXT = /^(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i;
async function sizeOf(file) {
  if (!sharp || !IMAGE_EXT.test(path.extname(file).slice(1))) return null;
  try {
    const meta = await sharp(file).metadata();
    return meta.width && meta.height ? {width: meta.width, height: meta.height} : null;
  } catch { return null; }
}

let inside = 0, outside = 0, missingFile = 0, written = 0, unchanged = 0, failed = 0;
const samples = [];

for (const row of rows) {
  let model;
  try { model = JSON.parse(row.payload); } catch { continue; }
  const file = typeof model.filePath === 'string' ? path.resolve(model.filePath) : '';
  if (!file || !file.toLowerCase().startsWith(prefix)) { outside++; continue; }
  inside++;
  if (!fs.existsSync(file)) { missingFile++; continue; }
  const size = await sizeOf(file);
  const next = size ? {...model, ...size} : model;
  if (!apply) {
    if (samples.length < 2) samples.push({file, payload: sidecarPayload(next)});
    continue;
  }
  try {
    const target = sidecarPathFor(file);
    const existed = fs.existsSync(target);
    const changed = writeSidecar(file, next);
    if (changed) written++; else unchanged++;
    if (!existed && changed && written <= 3) console.log(`新增  ${path.basename(target)} ← ${path.basename(file).slice(0, 46)}`);
  } catch (error) {
    failed++;
    console.error(`失败  ${path.basename(file)}：${error.message}`);
  }
}

console.log(`\n资产根：${archiveRoot}`);
console.log(`库内资产：${inside} 个（库外 ${outside} 个不动，文件缺失 ${missingFile} 个）`);

if (!apply) {
  for (const sample of samples) {
    console.log(`\n--- ${path.relative(archiveRoot, sample.file)} ---`);
    console.log(JSON.stringify(sample.payload, null, 2));
  }
  console.log('\n这是预览（没有写任何文件）。确认格式后加 --apply 执行。');
  db.close();
  process.exit(0);
}

console.log(`完成：写入 ${written}，内容未变 ${unchanged}，失败 ${failed}`);
db.close();
