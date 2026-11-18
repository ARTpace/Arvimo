// 修「材质 / HDRI 卡片没有 3D 预览效果」。
//
// 现象：材质卡片封面要么是平铺的 Color 贴图，要么是「暂无缩略图」占位，丢了平台那张材质球预览。
// 原因：下载入库时缩略图按「包内基础色贴图」推出来的（pickPreview），平台自带的材质球图
// （ambientCG / PolyHaven / FreeStylized 的 preview）没被复制进包；另外同一个资产在库里
// 留下两条记录（下载器登记的 download 记录 + 目录扫描留下的 blob 记录），后者没有缩略图，
// 于是同一张卡出现两次、其中一张是占位。
//
// 做的事：
//   1. 给 材质 / HDRI 每个包下载平台预览图到包内 preview.jpg|png（已存在就跳过）；
//   2. 把该包对应的资产记录缩略图改成这张本地预览图（payload.thumbnail 同步）；
//   3. 合并重复记录：同一 (name, kind) 下保留有真实本地文件的那条，其余移入回收站；
//   4. 材质主文件若是法线/粗糙度这类通道图，改回 Color 贴图（双击预览才不是紫一片）。
//
// 用法：node scripts/repair-material-previews.mjs [--apply]
//   默认只体检（dry-run），--apply 才下载文件、改数据库和回收站状态。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const APPLY = process.argv.includes('--apply');
const appBase = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AssetVault');

function resolveStore() {
  const registry = JSON.parse(fs.readFileSync(path.join(appBase, 'libraries.json'), 'utf8'));
  const store = registry.stores.find(s => s.id === registry.activeId) || registry.stores[0];
  if (!store) throw new Error('没有可用资源库');
  return {dataDir: store.dataDir, archiveRoot: store.archiveRoot, name: store.name};
}

const KIND_DIRS = [['3D资产', '材质'], ['3D资产', 'HDRI']];
const PREVIEW_NAMES = ['preview.jpg', 'preview.png', 'preview.webp'];
const CHANNEL_RE = /(normal|roughness|metallic|metalness|ambient.?occlusion|displacement|height|cavity|specular|opacity|mask)/i;

/** 平台预览图地址：材质球 / 全景图，正是卡片上那张「3D 预览效果」。 */
async function previewUrlOf(info) {
  const platform = String(info.platform || '').toLowerCase();
  const id = String(info.assetId || '').trim();
  if (/^https?:\/\//i.test(String(info.thumbnail || ''))) return String(info.thumbnail);
  if (platform === 'ambientcg' && id) {
    return `https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/1024-JPG-242424/${id}.jpg`;
  }
  if (platform === 'polyhaven' && id) {
    return `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(id)}.png?width=1024&height=1024`;
  }
  if (platform === 'freestylized' && id) {
    // 只有 WP 接口能给 featured media；material / skybox 两种路径都试。
    for (const kind of ['material', 'skybox', 'hdri']) {
      try {
        const res = await fetch(`https://freestylized.com/wp-json/wp/v2/${kind}?slug=${encodeURIComponent(id)}&_embed=1`, {signal: AbortSignal.timeout(30000)});
        if (!res.ok) continue;
        const list = await res.json();
        const media = list?.[0]?._embedded?.['wp:featuredmedia']?.[0];
        const sizes = media?.media_details?.sizes || {};
        const url = sizes.large?.source_url || sizes.medium_large?.source_url || sizes.medium?.source_url || media?.source_url || '';
        // 去掉 -300x300 这类缩放后缀，换原图更清晰。
        if (/^https:\/\//i.test(url)) return url.replace(/-\d+x\d+(?=\.[a-z]+$)/i, '');
      } catch { /* 下一个 kind */ }
    }
  }
  return '';
}

async function downloadPreview(url, dir) {
  const res = await fetch(url, {signal: AbortSignal.timeout(60000)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) throw new Error(`不是图片：${type}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 2048) throw new Error('文件太小，多半是错误页');
  const ext = type.includes('png') ? '.png' : type.includes('webp') ? '.webp' : '.jpg';
  const file = path.join(dir, `preview${ext}`);
  await fsp.writeFile(file, bytes);
  return file;
}

/** 包里现有的预览图（含 info.json 声明的 thumbnail 已落地成文件的情况）。 */
function existingPreview(dir) {
  for (const name of PREVIEW_NAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file) && fs.statSync(file).size > 2048) return file;
  }
  return null;
}

const enc = value => encodeURIComponent(value);
const thumbUrlFor = (root, file) => `/api/local/thumb?w=512&root=${enc(root)}&rel=${enc(path.relative(root, file).split(path.sep).join('/'))}`;

async function main() {
  const {dataDir, archiveRoot, name} = resolveStore();
  const dbFile = path.join(dataDir, 'library.db');
  console.log(`库：${name}\n数据：${dataDir}\n资产根：${archiveRoot}\n模式：${APPLY ? '写入' : '体检（dry-run）'}\n`);

  // —— 1. 收集包与预览图 ——
  const packages = [];
  for (const parts of KIND_DIRS) {
    const base = path.join(archiveRoot, ...parts);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const infoFile = path.join(dir, 'info.json');
      if (!fs.existsSync(infoFile)) continue;
      let info = {};
      try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { continue; }
      packages.push({dir, info});
    }
  }
  console.log(`材质 / HDRI 包 ${packages.length} 个`);

  const previews = new Map(); // 包目录 → 预览图文件（null 表示取不到）
  for (const pkg of packages) {
    const rel = path.relative(archiveRoot, pkg.dir).split(path.sep).join('/');
    let file = existingPreview(pkg.dir);
    if (file) { previews.set(pkg.dir, file); console.log(`  已有预览  ${rel}`); continue; }
    let url = '';
    try { url = await previewUrlOf(pkg.info); } catch { url = ''; }
    if (!url) { previews.set(pkg.dir, null); console.log(`  没有平台图  ${rel}`); continue; }
    if (!APPLY) { previews.set(pkg.dir, url); console.log(`  待下载    ${rel}  ←  ${url.slice(0, 80)}`); continue; }
    try {
      file = await downloadPreview(url, pkg.dir);
      previews.set(pkg.dir, file);
      console.log(`  已下载    ${rel}  ←  ${path.basename(file)}`);
    } catch (error) {
      previews.set(pkg.dir, null);
      console.log(`  下载失败  ${rel}：${error.message}`);
    }
  }

  // —— 2. 缩略图指到包内预览图 ——
  const db = new Database(dbFile);
  db.pragma('journal_mode = DELETE');
  const rows = db.prepare('SELECT uid, name, kind, source, thumbnail, payload, state FROM assets').all();
  const patch = db.prepare('UPDATE assets SET thumbnail = ?, payload = ?, rev = rev + 1, updated_at = ? WHERE uid = ?');
  const now = Date.now();
  let touched = 0;
  for (const row of rows) {
    if (row.state === 'trashed') continue;
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { continue; }
    const pkgDir = payload.packageDir || (payload.filePath ? path.dirname(payload.filePath) : '');
    if (!pkgDir || !previews.has(pkgDir)) continue;
    const file = previews.get(pkgDir);
    if (!file) continue;
    if (APPLY && !fs.existsSync(file)) continue;
    const url = APPLY ? thumbUrlFor(archiveRoot, file) : 'preview.*';
    if (APPLY && row.thumbnail === url && payload.thumbnail === url) continue;
    payload.thumbnail = url;
    if (!APPLY) { console.log(`  缩略图 → 预览图：${row.name}`); touched += 1; continue; }
    patch.run(url, JSON.stringify(payload), now, row.uid);
    touched += 1;
  }
  console.log(`\n缩略图更新 ${touched} 条（${APPLY ? '已写入' : '待写入'}）`);

  // —— 3. 材质主文件从通道图改回 Color ——
  let mainFixed = 0;
  for (const row of rows) {
    if (row.state === 'trashed' || row.kind !== 'textures') continue;
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { continue; }
    const rel = String(payload.localRel || '');
    if (!rel || !CHANNEL_RE.test(path.basename(rel))) continue;
    const dir = path.dirname(path.join(archiveRoot, rel));
    const color = ['Color.jpg', 'Color.png', 'color.jpg', 'color.png'].map(n => path.join(dir, n)).find(f => fs.existsSync(f))
      || fs.readdirSync(dir).filter(n => /color/i.test(n) && !CHANNEL_RE.test(n)).map(n => path.join(dir, n))[0];
    if (!color) continue;
    const colorRel = path.relative(archiveRoot, color).split(path.sep).join('/');
    const fileQ = `root=${enc(archiveRoot)}&rel=${enc(colorRel)}`;
    payload.localRel = colorRel;
    payload.filePath = color;
    payload.url = `/api/local/file?${fileQ}`;
    payload.previewUrl = `/api/local/file?${fileQ}`;
    payload.ext = path.extname(color).slice(1).toLowerCase();
    payload.bytes = fs.statSync(color).size;
    console.log(`  主文件 ${row.name}：${path.basename(rel)} → ${path.basename(colorRel)}`);
    if (APPLY) patch.run(row.thumbnail, JSON.stringify(payload), now, row.uid);
    mainFixed += 1;
  }
  console.log(`主文件修正 ${mainFixed} 条（${APPLY ? '已写入' : '待写入'}）`);

  // —— 4. 合并重复记录：留「有真实文件」的那条，其余进回收站 ——
  const groups = new Map();
  for (const row of rows) {
    if (row.state === 'trashed') continue;
    if (!['models', 'textures', 'hdris', 'packs'].includes(row.kind)) continue;
    const key = `${row.name}|${row.kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const trash = db.prepare("UPDATE assets SET state = 'trashed', trashed_at = ?, rev = rev + 1, updated_at = ? WHERE uid = ?");
  let dropped = 0;
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const score = row => {
      let payload = {};
      try { payload = JSON.parse(row.payload || '{}'); } catch {}
      const file = payload.filePath || '';
      let value = 0;
      if (file && fs.existsSync(file) && fs.statSync(file).isFile()) value += 4;
      if (row.source === 'download') value += 2;
      if (row.thumbnail) value += 1;
      return value;
    };
    const sorted = [...list].sort((a, b) => score(b) - score(a));
    const keep = sorted[0];
    for (const row of sorted.slice(1)) {
      console.log(`  合并 ${key}：保留 ${keep.source}(${keep.uid.slice(0, 6)})，回收站 ${row.source}(${row.uid.slice(0, 6)})`);
      if (APPLY) trash.run(now, now, row.uid);
      dropped += 1;
    }
  }
  console.log(`重复记录 ${dropped} 条（${APPLY ? '已进回收站' : '待进回收站'}）`);

  db.close();
  if (!APPLY) console.log('\n体检结束。加 --apply 才会下载预览图、改库。');
}

main().catch(error => { console.error(error); process.exit(1); });
