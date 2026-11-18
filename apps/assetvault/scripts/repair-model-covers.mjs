// 模型资产封面修复：把「包内贴图当封面」换成「平台官方渲染图」或「本地模型渲染」。
//
// 背景（2026-11-16）：迁移下载目录时才用的 pickPreview 从包里挑基础色贴图当封面，
// 于是 Sketchfab / ArtStation 的模型卡显示成 mat0_c.jpg 那种平铺贴图，跟平台搜索结果
// 完全是两个东西。材质那批已经用 preview.* 修过，模型这批没管。
//
// 取图顺序：
//   1. 包内已有 preview.*（平台官方图，离线可看）        → 直接指向它
//   2. 平台图可下载（sketchfab / polyhaven / ambientcg / freestylized / simready 自带）
//      → 存包内 preview.*，再指向它
//   3. 下载不到（ArtStation 有 Cloudflare 挑战）→ 指向包内主模型文件，
//      卡片那一侧由 src/library/model-thumb.js 离屏渲一帧写进缩略图缓存
//
// 默认 dry-run，加 --apply 才写文件与数据库。可重复执行。
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sharp = require('sharp');

const APPLY = process.argv.includes('--apply');
const DATA_DIR = process.env.SFV_DATA_DIR || 'J:\\资产\\.assetvault\\data';
const DB_FILE = path.join(DATA_DIR, 'library.db');
const ARCHIVE_ROOT = path.resolve(DATA_DIR, '..', '..');

const PREVIEW_RE = /^preview\.(png|jpe?g|webp|gif|avif)$/i;
const MODEL_RE = /\.(glb|gltf|fbx|obj|stl|ply|3mf|usdz?|usd|blend)$/i;
/** 主模型优先级：网页同源格式优先，再 fbx（引擎友好），obj 最后。 */
const MAIN_ORDER = ['.glb', '.gltf', '.fbx', '.obj', '.usdz', '.usd', '.blend', '.stl', '.ply', '.3mf'];
const SKIP_DIRS = new Set(['textures', 'source', 'maps', 'Materials', 'Textures', '__MACOSX', '.metadata']);
const UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function listPreviewFiles(dir) {
  try {
    return fs.readdirSync(dir, {withFileTypes: true})
      .filter(item => item.isFile() && PREVIEW_RE.test(item.name))
      .map(item => item.name)
      .sort((a, b) => {
        const rank = n => (/jpe?g$/i.test(n) ? 0 : /png$/i.test(n) ? 1 : 2);
        return rank(a) - rank(b) || a.localeCompare(b);
      });
  } catch { return []; }
}

function packageDirOf(model) {
  if (model.packageDir && fs.existsSync(model.packageDir)) return model.packageDir;
  const fp = String(model.filePath || '');
  if (!fp) return '';
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) return fp;
  const dir = path.dirname(fp);
  return fs.existsSync(dir) ? dir : '';
}

/** 包内主模型：先看包根，再浅层子目录（freestylized 的 unpacked/.../source 就藏在里面）。 */
function mainModelOf(dir) {
  const scan = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, {withFileTypes: true}); } catch { return []; }
    const files = entries.filter(e => e.isFile() && MODEL_RE.test(e.name)).map(e => path.join(d, e.name));
    const subs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && depth > 0)
      .flatMap(e => scan(path.join(d, e.name), depth - 1));
    return files.concat(subs);
  };
  const all = scan(dir, 2);
  if (!all.length) return '';
  return all.sort((a, b) => {
    const ra = MAIN_ORDER.findIndex(ext => a.toLowerCase().endsWith(ext));
    const rb = MAIN_ORDER.findIndex(ext => b.toLowerCase().endsWith(ext));
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.length - b.length;
  })[0];
}

function previewUrl(relAbs, width = 512) {
  return `/api/local/thumb?w=${width}&root=${encodeURIComponent(ARCHIVE_ROOT)}&rel=${encodeURIComponent(relAbs)}`;
}

async function fetchBuffer(url) {
  const res = await fetch(url, {headers: UA, redirect: 'follow'});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Sketchfab：v3 API 匿名可读公开模型，取最大那张（1920 宽）。 */
async function sketchfabCover(assetId) {
  if (!/^[0-9a-f]{32}$/i.test(assetId)) return null;
  const data = JSON.parse((await fetchBuffer(`https://api.sketchfab.com/v3/models/${assetId}`)).toString('utf8'));
  const images = (data.thumbnails?.images || []).slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  if (!images.length) return null;
  const url = images[0].url;
  return {buf: await fetchBuffer(url), ext: '.jpg', src: url};
}

/** PolyHaven：CDN 契约 URL，slug 就是 assetId。 */
async function polyhavenCover(assetId) {
  const url = `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(assetId)}.png?width=1024&height=1024`;
  return {buf: await fetchBuffer(url), ext: '.png', src: url};
}

/** ambientCG：模型/材质同一套缩略图 CDN。 */
async function ambientcgCover(assetId) {
  const url = `https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/1024-JPG-242424/${encodeURIComponent(assetId)}.jpg`;
  return {buf: await fetchBuffer(url), ext: '.jpg', src: url};
}

/** FreeStylized：WP REST 的 featured media（模型分类是 3d_models），默认给 webp，转 jpg 统一。 */
async function freestylizedCover(assetId) {
  const api = `https://freestylized.com/wp-json/wp/v2/3d_models?slug=${encodeURIComponent(assetId)}&_embed=1`;
  const rows = JSON.parse((await fetchBuffer(api)).toString('utf8'));
  const media = Array.isArray(rows) ? rows[0]?._embedded?.['wp:featuredmedia']?.[0] : null;
  const sizes = media?.media_details?.sizes || {};
  const url = (sizes.large || sizes.medium_large || sizes.full || sizes.medium || {}).source_url;
  if (!url) return null;
  const raw = await fetchBuffer(url);
  const buf = await sharp(raw).jpeg({quality: 90}).toBuffer();
  return {buf, ext: '.jpg', src: url};
}

/** simready：包内自带官方缩略图（simready_usd/.thumbs/*_thumbnail.png），拷到包根当 preview。 */
function simreadyCover(dir) {
  const files = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, {withFileTypes: true}); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile() && /thumb.*\.(png|jpe?g)$/i.test(e.name)) files.push(p);
    }
  };
  walk(dir, 3);
  if (!files.length) return null;
  return {file: files[0], ext: path.extname(files[0]).toLowerCase()};
}

const COVERERS = {
  sketchfab: sketchfabCover,
  polyhaven: polyhavenCover,
  ambientcg: ambientcgCover,
  freestylized: freestylizedCover,
};

const db = new Database(DB_FILE, {readonly: !APPLY, fileMustExist: true});
db.pragma('busy_timeout = 8000');

const rows = db.prepare(`
  SELECT uid, name, platform, thumbnail, payload
  FROM assets
  WHERE state = 'active'
    AND kind = 'models'
    AND platform IS NOT NULL AND platform != '' AND platform != 'local'
  ORDER BY platform, name
`).all();

const upd = APPLY
  ? db.prepare('UPDATE assets SET thumbnail = ?, payload = ?, rev = rev + 1, updated_at = ? WHERE uid = ?')
  : null;
const now = Date.now();

let usePreview = 0, downloaded = 0, fallbackModel = 0, already = 0;
const failed = [];

for (const row of rows) {
  const model = JSON.parse(row.payload || '{}');
  const dir = packageDirOf(model);
  if (!dir) { failed.push([row.platform, row.name, '包目录不存在']); continue; }
  const assetId = String(model.assetId || '').trim();
  const platform = String(row.platform || '').toLowerCase();
  const existing = listPreviewFiles(dir);

  let nextThumb = '';
  let note = '';
  let platformSrc = '';

  if (existing.length) {
    nextThumb = previewUrl(path.relative(ARCHIVE_ROOT, path.join(dir, existing[0])));
    note = '已有 preview';
    usePreview += 1;
  } else {
    // ── 平台图：能下就下，下完落盘 ──────────────────────────────────────────
    let got = null;
    try {
      if (platform === 'simready') {
        const found = simreadyCover(dir);
        if (found) {
          const target = path.join(dir, `preview${found.ext}`);
          if (!APPLY) { got = {local: target}; } else {
            fs.copyFileSync(found.file, target);
            got = {local: target};
          }
        }
      } else if (COVERERS[platform] && assetId) {
        const res = await COVERERS[platform](assetId);
        if (res) {
          const target = path.join(dir, `preview${res.ext}`);
          if (APPLY) fs.writeFileSync(target, res.buf);
          got = {local: target, src: res.src};
          platformSrc = res.src || '';
        }
      }
    } catch (err) {
      note = `平台图失败(${err.message})`;
    }

    if (got) {
      nextThumb = previewUrl(path.relative(ARCHIVE_ROOT, got.local));
      downloaded += 1;
      note = note || `下载 ${path.basename(got.local)}`;
    } else {
      // ── 退路：指到主模型文件，前端渲一帧 ────────────────────────────────
      const main = mainModelOf(dir);
      if (main) {
        nextThumb = previewUrl(path.relative(ARCHIVE_ROOT, main));
        fallbackModel += 1;
        note = `${note ? note + ' → ' : ''}本地渲染 ${path.basename(main)}`;
      } else {
        failed.push([platform, row.name, note || '无平台图也无主模型']);
        continue;
      }
    }
  }

  const changed = String(model.thumbnail || '') !== nextThumb || String(row.thumbnail || '') !== nextThumb;
  if (!changed) { already += 1; continue; }

  console.log(`${APPLY ? '' : '[预演] '}${row.platform.padEnd(12)} ${row.name.slice(0, 30).padEnd(30)} ${note}`);

  if (APPLY) {
    model.thumbnail = nextThumb;
    if (platformSrc) model.platformThumbnail = platformSrc;
    model.previewSource = platform === 'artstation' ? 'local-render' : (platformSrc ? platform : 'local-preview');
    // 包内元信息同步：换机器 / DB 重建时仍能找回平台出处与预览图。
    for (const name of ['info.json', '__info.json']) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (platformSrc) meta.thumbnail = platformSrc;
        meta.previewSource = model.previewSource;
        fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n');
      } catch { /* 坏 json 不动它 */ }
    }
    upd.run(nextThumb, JSON.stringify(model), now, row.uid);
  }
  await sleep(120);
}

console.log('\n模型资产 %d 条：已有 preview %d、下载平台图 %d、改用本地渲染 %d、无需改动 %d',
  rows.length, usePreview, downloaded, fallbackModel, already);
if (failed.length) {
  console.log('仍然没有封面 %d 条：', failed.length);
  for (const f of failed) console.log('   ', f.join(' | '));
}
if (!APPLY) console.log('\n（预演模式，未写入。加 --apply 执行）');
