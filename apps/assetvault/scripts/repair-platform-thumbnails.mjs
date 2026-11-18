#!/usr/bin/env node
/**
 * 平台资产封面修正：把「库里显示包内 Color 贴图」的卡片改成包内 preview.*（= 平台官方渲染图）。
 *
 * 背景（2026-11-16）：平台搜索页的缩略图是官方渲染图（ambientCG 材质球、PolyHaven 球/全景），
 * 入库后却被 pickCover 挑中的包内贴图顶掉了，于是同一个资产在搜索里是球、在库里是一块花纹。
 *
 * 两件事：
 *   1) 记录层：thumbnail 指向包内 preview.*（本地文件，离线可看，内容就是平台那张）；
 *   2) 磁盘层：给包内 info.json 补 platform / assetId / thumbnail / sourceUrl，
 *      这是「DB 重建也能认回平台」的凭证（治本的一半，另一半是入库时写这些字段）。
 *
 * 默认 dry-run，加 --apply 才落盘。
 *
 *   node scripts/repair-platform-thumbnails.mjs
 *   node scripts/repair-platform-thumbnails.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DATA_DIR = process.env.SFV_DATA_DIR || 'J:\\资产\\.assetvault\\data';
const DB_FILE = path.join(DATA_DIR, 'library.db');
const ARCHIVE_ROOT = path.resolve(DATA_DIR, '..', '..');

const PREVIEW_RE = /^preview\.(png|jpe?g|webp|gif|avif)$/i;
const PLATFORM_ALIAS = {ambientcg: 'ambientcg', polyhaven: 'polyhaven', freestylized: 'freestylized', sketchfab: 'sketchfab', artstation: 'artstation'};

/** 平台识别：出处域名 > DB 的 platform 列 > 包内 info.json。
 *  域名最可靠 —— 迁移时曾把 Sketchfab 的包标成 artstation（Wizard Cat），只看 platform 列会一路错下去。 */
function platformOf(model, meta) {
  const url = String(model.sourceUrl || model.pageUrl || meta?.sourceUrl || meta?.source_url || meta?.url || '');
  const byHost = [
    [/sketchfab\.com/i, 'sketchfab'],
    [/artstation\.com/i, 'artstation'],
    [/ambientcg\.com/i, 'ambientcg'],
    [/polyhaven\.com/i, 'polyhaven'],
    [/freestylized\.com/i, 'freestylized'],
  ].find(([re]) => re.test(url));
  if (byHost) return byHost[1];
  const raw = String(model.platform || meta?.platform || meta?.source || '').toLowerCase();
  return PLATFORM_ALIAS[raw] || (/^https?:\/\//i.test(raw) ? '' : raw);
}

/**
 * 平台资产标识。各平台的「身份」长得不一样，不能一律拿包名：
 *   · sketchfab  → 32 位 uid（就是包内 info.json 的 uid / source_url 里那段）
 *   · artstation → 作品码（source_url 是 /artwork/<artId>）
 *   · ambientcg  → 资产码（Fabric085）
 *   · polyhaven / freestylized → slug（包名本身就是）
 */
function assetIdOf(model, meta, pkgDir) {
  const platform = platformOf(model, meta);
  const srcUrl = String(model.sourceUrl || meta?.sourceUrl || meta?.url || meta?.source_url || '');
  // 平台的形状校验优先于「已有值」：上一轮修复曾把包名（Fawkes、Ancient Temple）写成 assetId，
  // 那是错的 —— 平台要的是作品码 / 32 位 uid，包名喂进去只会拿到 404。
  if (platform === 'artstation') {
    const fromUrl = srcUrl.match(/artwork\/([A-Za-z0-9]+)/);
    if (fromUrl) return fromUrl[1];
    const explicit = String(model.assetId || meta?.assetId || '').trim();
    if (explicit && /^[A-Za-z0-9]{4,12}$/.test(explicit)) return explicit;
  }
  if (platform === 'sketchfab') {
    const fromUrl = srcUrl.match(/models\/([0-9a-f]{32})/i);
    if (fromUrl) return fromUrl[1];
    const explicit = String(model.assetId || meta?.assetId || '').trim();
    if (/^[0-9a-f]{32}$/i.test(explicit)) return explicit;
    const fromMeta = String(meta?.uid || '');
    if (/^[0-9a-f]{32}$/i.test(fromMeta)) return fromMeta;
  }
  const explicit = String(model.assetId || meta?.assetId || '').trim();
  if (explicit) return explicit;
  const base = path.basename(pkgDir);
  // ambientCG 的资产码是「单词+编号」挤压后的形状（Fabric 085 → Fabric085）。
  const squeezed = base.replace(/\s+/g, '');
  return /^[A-Za-z][A-Za-z0-9]*\d$/.test(squeezed) ? squeezed : base;
}

function previewUrl(root, relAbs, width = 512) {
  return `/api/local/thumb?w=${width}&root=${encodeURIComponent(root)}&rel=${encodeURIComponent(relAbs)}`;
}

function listPreviewFiles(dir) {
  try {
    return fs.readdirSync(dir, {withFileTypes: true})
      .filter(item => item.isFile() && PREVIEW_RE.test(item.name))
      .map(item => item.name)
      .sort();
  } catch { return []; }
}

/** 包目录：packageDir 优先，退到主文件所在目录。 */
function packageDirOf(model) {
  if (model.packageDir && fs.existsSync(model.packageDir)) return model.packageDir;
  const fp = String(model.filePath || '');
  if (!fp) return '';
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) return fp;
  const dir = path.dirname(fp);
  return fs.existsSync(dir) ? dir : '';
}

const db = new Database(DB_FILE, {readonly: !APPLY, fileMustExist: true});
db.pragma('busy_timeout = 8000');

const rows = db.prepare(`
  SELECT uid, name, platform, thumbnail, payload
  FROM assets
  WHERE state = 'active'
    AND platform IS NOT NULL AND platform != '' AND platform != 'local'
  ORDER BY platform, name
`).all();

let fixed = 0, already = 0, noPreview = 0, identityFixed = 0;
const needDownload = [];
const metaPatched = new Set();
let metaWrites = 0;

const upd = APPLY
  ? db.prepare('UPDATE assets SET thumbnail = ?, payload = ?, rev = rev + 1, updated_at = ? WHERE uid = ?')
  : null;
const now = Date.now();

for (const row of rows) {
  let model;
  try { model = JSON.parse(row.payload || '{}'); } catch { continue; }
  const pkgDir = packageDirOf(model);
  if (!pkgDir) { noPreview += 1; continue; }

  const metaPath = path.join(pkgDir, 'info.json');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* 没登记过 */ }

  // ── 磁盘层：补 info.json 的平台凭证（只补空字段，绝不动已有值）────────────────
  const platform = platformOf(model, meta);
  const assetId = assetIdOf(model, meta, pkgDir);
  const platformThumb = String(
    model.platformThumbnail
    || (/^https?:\/\//i.test(String(model.thumbnail || '')) ? model.thumbnail : '')
    || (/^https?:\/\//i.test(String(meta?.thumbnail || '')) ? meta.thumbnail : ''),
  ).trim();
  const sourceUrl = String(model.sourceUrl || model.pageUrl || meta?.sourceUrl || meta?.source_url || meta?.url || '').trim();

  if (meta && (platform || assetId || platformThumb)) {
    let dirty = false;
    // assetId 是派生字段：以「按平台规则推出来的值」为准。上一轮曾把包名写进去过，
    // 那种错误值得直接覆盖 —— 平台要的是作品码 / 32 位 uid，包名换不来数据。
    if (platform && meta.platform !== platform) { meta.platform = platform; dirty = true; }
    if (assetId && meta.assetId !== assetId) { meta.assetId = assetId; dirty = true; }
    if (platformThumb && !meta.thumbnail) { meta.thumbnail = platformThumb; dirty = true; }
    // sourceUrl 只有包内完全没有出处时才补；`url` 已经被 artstation/sketchfab 用来存作品页了。
    if (sourceUrl && !meta.sourceUrl && !meta.url) { meta.sourceUrl = sourceUrl; dirty = true; }
    if (dirty) {
      metaPatched.add(metaPath);
      metaWrites += 1;
      if (APPLY) {
        const tmp = `${metaPath}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, metaPath);
      }
    }
  }

  // ── 记录层 A：把平台身份写回 payload ───────────────────────────────────────
  // 这才是「3D 预览消失」的正因：payload 里没有 assetId，前端拿不到平台数据，
  // 只能退化成一张图片。uid 不动（标签/收藏都按它关联），只补平台身份。
  let identityDirty = false;
  if (assetId && model.assetId !== assetId) { model.assetId = assetId; identityDirty = true; }
  if (platform && model.platform !== platform) { model.platform = platform; identityDirty = true; }
  if (sourceUrl && !model.sourceUrl) { model.sourceUrl = sourceUrl; identityDirty = true; }
  if (identityDirty) {
    identityFixed += 1;
    if (APPLY) {
      db.prepare('UPDATE assets SET payload = ?, platform = ?, rev = rev + 1, updated_at = ? WHERE uid = ?')
        .run(JSON.stringify(model), platform || row.platform, now, row.uid);
    }
  }

  // ── 记录层 B：包内有 preview.* 就指向它（平台官方渲染图，本地离线可看）──────────
  // 没有 preview.* 时退一步用平台官方图外链（info.json 里有的包，例如 ambientCG 那些
  // 只下了主文件、没下预览图的）—— 有图总比显示一块平铺贴图强。
  const current = String(model.thumbnail || '');
  const previews = listPreviewFiles(pkgDir);
  if (!previews.length) {
    if (platformThumb && current !== platformThumb) {
      model.thumbnail = platformThumb;
      model.platformThumbnail = platformThumb;
      fixed += 1;
      if (APPLY) upd.run(platformThumb, JSON.stringify(model), now, row.uid);
      else console.log(`  ${row.platform.padEnd(12)} ${String(row.name).slice(0, 34).padEnd(34)} → 平台外链`);
      continue;
    }
    noPreview += 1;
    needDownload.push({uid: row.uid, name: row.name, platform: row.platform, pkgDir, assetId});
    continue;
  }
  const previewRel = path.relative(ARCHIVE_ROOT, path.join(pkgDir, previews[0])).split(path.sep).join('/');
  const wanted = previewUrl(ARCHIVE_ROOT, previewRel);
  if (current === wanted && row.thumbnail === wanted) { already += 1; continue; }

  model.thumbnail = wanted;
  if (platformThumb) model.platformThumbnail = platformThumb;
  fixed += 1;
  if (APPLY) upd.run(wanted, JSON.stringify(model), now, row.uid);
  else console.log(`  ${row.platform.padEnd(12)} ${String(row.name).slice(0, 34).padEnd(34)} → ${previews[0]}`);
}

// 库是 journal_mode=DELETE（为了整个库目录能整体同步），没有 WAL 可 checkpoint。
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* DELETE 模式下忽略 */ }

console.log(`\n${APPLY ? '已写入' : '预演'}：`);
console.log(`  平台资产         ${rows.length} 条`);
console.log(`  改指 preview.*   ${fixed} 条`);
console.log(`  补平台身份       ${identityFixed} 条`);
console.log(`  已是 preview.*   ${already} 条`);
console.log(`  包内无 preview   ${noPreview} 条`);
console.log(`  info.json 补字段 ${metaWrites} 处（${metaPatched.size} 个包）`);

if (needDownload.length) {
  console.log(`\n这些包还没有官方预览图（属于「联网下载平台缩略图」那一档，本次不动）：`);
  for (const item of needDownload.slice(0, 20)) {
    console.log(`  ${String(item.platform).padEnd(12)} ${String(item.name).slice(0, 40)}`);
  }
  if (needDownload.length > 20) console.log(`  …还有 ${needDownload.length - 20} 个`);
}

if (!APPLY) console.log('\n以上为预演。确认后加 --apply 落盘。');
