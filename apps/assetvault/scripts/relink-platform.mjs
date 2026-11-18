// 平台身份重连：当资产「掉链」——点开没有 3D 预览、卡片变成一张平铺贴图——
// 用它按证据链一路找回去，能接上的直接补好，接不上的明确列出来。
//
// 三条证据链，从便宜到贵：
//   ① 本地档案：DB payload → 包内 info.json / __info.json → tasks.json 下载任务
//   ② 平台反查：拿资产名去平台搜索接口，命中且**唯一**才接（--match 才联网）
//   ③ 人工指定：--set=<uid>:<platform>:<assetId>，用于 ArtStation 这类有 CF 挑战的平台
//
// 接上之后顺手把平台官方封面（那张材质球 / 模型渲染图）下载进包内 preview.*，
// 卡片和点开预览就都回到「和平台一致」的状态。
//
// 用法：
//   node scripts/relink-platform.mjs                    体检：只报告，不写
//   node scripts/relink-platform.mjs --apply            用本地档案补
//   node scripts/relink-platform.mjs --match --apply    本地档案不够时联网反查
//   node scripts/relink-platform.mjs --uid=abcd1234 --match --apply
//   node scripts/relink-platform.mjs --uid=abcd1234 --set=artstation:bLr6d --apply
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {platformCoverUrl, downloadCover, sketchfabSearchCover} from './lib/platform-covers.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sharp = require('sharp');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const MATCH = argv.includes('--match');
const ONLY = (argv.find(a => a.startsWith('--uid=')) || '').slice(6);
const SET = (argv.find(a => a.startsWith('--set=')) || '').slice(6);

const DATA_DIR = process.env.SFV_DATA_DIR || 'J:\\资产\\.assetvault\\data';
const DB_FILE = path.join(DATA_DIR, 'library.db');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const ARCHIVE_ROOT = path.resolve(DATA_DIR, '..', '..');

const PREVIEW_RE = /^preview\.(png|jpe?g|webp|gif|avif)$/i;
const MODEL_RE = /\.(glb|gltf|fbx|obj|stl|ply|3mf|usdz?|usd|blend)$/i;
const PREVIEWABLE = new Set(['sketchfab', 'artstation', 'polyhaven', 'ambientcg', 'freestylized']);
const HOSTS = [
  [/sketchfab\.com/i, 'sketchfab'],
  [/artstation\.com/i, 'artstation'],
  [/polyhaven\.com/i, 'polyhaven'],
  [/ambientcg\.com/i, 'ambientcg'],
  [/freestylized\.com/i, 'freestylized'],
  [/nvidia\/simready-assets/i, 'simready'],
];

/** 名称归一：只留字母数字，用来跨平台比对同一件资产。 */
const norm = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function platformFromUrl(url) {
  for (const [re, name] of HOSTS) if (re.test(String(url || ''))) return name;
  return '';
}

/** 从平台页面地址里抠出平台侧的资产 id。 */
function assetIdFromUrl(platform, url) {
  const raw = String(url || '');
  if (platform === 'sketchfab') return (raw.match(/models\/([0-9a-f]{32})/i) || [])[1] || '';
  if (platform === 'artstation') return (raw.match(/artwork\/([A-Za-z0-9]+)/) || [])[1] || '';
  if (platform === 'polyhaven') return (raw.match(/polyhaven\.com\/a\/([^/?#]+)/) || [])[1] || '';
  if (platform === 'ambientcg') return (raw.match(/asset\/([A-Za-z0-9]+)/) || [])[1] || '';
  if (platform === 'freestylized') return (raw.match(/\/(?:3d_models|material|skybox|materials)\/([a-z0-9_]+)/i) || [])[1] || '';
  if (platform === 'simready') return (raw.match(/simready-assets\/tree\/main\/([A-Za-z0-9_]+)/) || [])[1] || '';
  return '';
}

function packageDirOf(model) {
  const dir = String(model.packageDir || '');
  if (dir && fs.existsSync(dir)) return dir;
  const fp = String(model.filePath || '');
  if (!fp) return '';
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) return fp;
  return fs.existsSync(path.dirname(fp)) ? path.dirname(fp) : '';
}

function listPreview(dir) {
  try {
    return fs.readdirSync(dir, {withFileTypes: true})
      .filter(e => e.isFile() && PREVIEW_RE.test(e.name))
      .map(e => e.name)
      .sort((a, b) => (/jpe?g$/i.test(a) ? -1 : 0) - (/jpe?g$/i.test(b) ? -1 : 0))[0] || '';
  } catch { return ''; }
}

function readMeta(dir) {
  for (const name of ['info.json', '__info.json']) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (data && typeof data === 'object') return data;
    } catch { /* 没有或坏了就下一个 */ }
  }
  return {};
}

function mainModel(dir) {
  try {
    const entries = fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isFile() && MODEL_RE.test(e.name));
    return entries.map(e => path.join(dir, e.name)).sort((a, b) => a.length - b.length)[0] || '';
  } catch { return ''; }
}

const thumbUrl = rel => `/api/local/thumb?w=384&root=${encodeURIComponent(ARCHIVE_ROOT)}&rel=${encodeURIComponent(rel)}`;
/** 现有缩略图是不是已经指向包内 preview.*（是就别重复改，宽度参数不同也算已经对）。 */
const isPreviewThumb = value => decodeURIComponent(String(value || '')).includes('preview.');
const taxonomyOf = (platform, kind) => (platform !== 'freestylized' ? undefined
  : kind === 'textures' ? 'material' : kind === 'hdris' ? 'skybox' : '3d_models');

// ── 下载任务：名称与 uid 两张索引 ──────────────────────────────────────────
let jobs = [];
try {
  const raw = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  jobs = Array.isArray(raw) ? raw : (raw.jobs || []);
} catch { /* 没有任务文件就当没有这类证据 */ }
const jobByName = new Map();
const jobByUid = new Map();
for (const job of jobs) {
  if (job.name) jobByName.set(norm(job.name), job);
  if (job.uid) jobByUid.set(job.uid, job);
}

// ── 平台反查（--match）───────────────────────────────────────────────────────
const polyhavenCache = new Map();
async function searchPolyhaven(kind, wanted) {
  const type = kind === 'textures' ? 'textures' : kind === 'hdris' ? 'hdris' : 'models';
  if (!polyhavenCache.has(type)) {
    const res = await fetch(`https://api.polyhaven.com/assets?t=${type}`, {headers: {'User-Agent': 'Mozilla/5.0'}});
    polyhavenCache.set(type, res.ok ? Object.keys(await res.json()) : []);
  }
  const hits = polyhavenCache.get(type).filter(slug => norm(slug) === wanted);
  return hits.length === 1 ? hits[0] : '';
}

async function searchSketchfab(name, wanted) {
  const url = `https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(name)}&count=8`;
  const res = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0'}});
  if (!res.ok) return null;
  const data = await res.json();
  const hits = (data.results || []).filter(item => norm(item.name) === wanted);
  if (hits.length !== 1) return null;
  const hit = hits[0];
  return {assetId: hit.uid, sourceUrl: `https://sketchfab.com/models/${hit.uid}`, coverUrl: sketchfabSearchCover(hit)?.url || ''};
}

async function searchFreestylized(name, wanted) {
  for (const taxonomy of ['3d_models', 'material', 'skybox']) {
    const url = `https://freestylized.com/wp-json/wp/v2/${taxonomy}?search=${encodeURIComponent(name)}&per_page=8`;
    const res = await fetch(url, {headers: {'User-Agent': 'Mozilla/5.0'}});
    if (!res.ok) continue;
    const rows = await res.json();
    const hits = (Array.isArray(rows) ? rows : []).filter(row => norm(row.slug) === wanted);
    if (hits.length === 1) return {assetId: hits[0].slug, sourceUrl: `https://freestylized.com/${taxonomy}/${hits[0].slug}/`};
  }
  return null;
}

/** 名称反查：只在「唯一命中」时返回，多平台命中一律不自动接（宁可让人指定）。 */
async function matchByPlatformSearch(row, model) {
  const wanted = norm(row.name);
  if (!wanted) return null;
  const hint = platformFromUrl(model.sourceUrl || model.url) || String(row.platform || '');
  if (hint === 'sketchfab') {
    const hit = await searchSketchfab(row.name, wanted);
    return hit ? {platform: 'sketchfab', ...hit} : null;
  }
  if (hint === 'polyhaven') {
    const slug = await searchPolyhaven(row.kind, wanted);
    return slug ? {platform: 'polyhaven', assetId: slug, sourceUrl: `https://polyhaven.com/a/${slug}`} : null;
  }
  if (hint === 'freestylized') {
    const hit = await searchFreestylized(row.name, wanted);
    return hit ? {platform: 'freestylized', ...hit} : null;
  }
  // 平台未知：三家都问一遍，只有唯一一家命中才算数。
  const found = [];
  const sf = await searchSketchfab(row.name, wanted);
  if (sf) found.push({platform: 'sketchfab', ...sf});
  const fs2 = await searchFreestylized(row.name, wanted);
  if (fs2) found.push({platform: 'freestylized', ...fs2});
  const ph = await searchPolyhaven(row.kind, wanted);
  if (ph) found.push({platform: 'polyhaven', assetId: ph, sourceUrl: `https://polyhaven.com/a/${ph}`});
  return found.length === 1 ? found[0] : null;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const db = new Database(DB_FILE, {readonly: !APPLY, fileMustExist: true});
db.pragma('busy_timeout = 8000');

let rows = db.prepare(`
  SELECT uid, name, kind, platform, thumbnail, payload
  FROM assets
  WHERE state = 'active'
  ORDER BY platform, name
`).all();
if (ONLY) rows = rows.filter(row => row.uid.startsWith(ONLY));

const upd = APPLY ? db.prepare('UPDATE assets SET platform = ?, thumbnail = ?, payload = ?, rev = rev + 1, updated_at = ? WHERE uid = ?') : null;
const now = Date.now();

let relinked = 0, coverFixed = 0, stillBroken = 0, healthy = 0;
const report = [];

for (const row of rows) {
  const model = JSON.parse(row.payload || '{}');
  const dir = packageDirOf(model);
  if (!dir) continue;
  const meta = readMeta(dir);
  const job = jobByUid.get(row.uid) || jobByName.get(norm(row.name)) || null;

  // ① 本地档案：谁说得出平台和 id 就听谁的（出处域名优先于 platform 列的陈旧值）
  let platform = platformFromUrl(model.sourceUrl) || platformFromUrl(model.url) || platformFromUrl(meta.sourceUrl)
    || platformFromUrl(meta.source_url) || platformFromUrl(meta.url) || String(row.platform || model.platform || meta.platform || '').toLowerCase();
  if (platform === 'local') platform = '';
  let assetId = String(model.assetId || meta.assetId || meta.artId || '').trim();
  let sourceUrl = String(model.sourceUrl || meta.sourceUrl || meta.source_url || model.url || meta.url || job?.source_url || '').trim();

  // ② 从任务记录补（下载器当时抓到的平台身份）
  if (!assetId && job) assetId = String(job.assetId || job.assetUid || job.artId || '').trim();
  if (!sourceUrl && job?.source_url) {
    sourceUrl = String(job.source_url);
    platform = platform || platformFromUrl(sourceUrl);
  }
  // ③ 从出处地址反推 id
  if (platform && !assetId) assetId = assetIdFromUrl(platform, sourceUrl);
  // ④ 目录名兜底：ambientCG 的 assetId 就是「名称挤压」（Fabric 085 → Fabric085）
  if (!assetId && platform === 'ambientcg') {
    const squeezed = path.basename(dir).replace(/\s+/g, '');
    if (/^[A-Za-z][A-Za-z0-9]*\d$/.test(squeezed)) assetId = squeezed;
  }
  // ⑤ 人工指定优先于一切
  if (SET) {
    const [p, id] = SET.split(':');
    if (p) platform = p;
    if (id) assetId = id;
    if (!sourceUrl && platform && assetId) {
      sourceUrl = platform === 'sketchfab' ? `https://sketchfab.com/models/${assetId}`
        : platform === 'artstation' ? `https://www.artstation.com/artwork/${assetId}`
        : platform === 'polyhaven' ? `https://polyhaven.com/a/${assetId}` : sourceUrl;
    }
  }
  // ⑥ 联网反查
  if (MATCH && (!platform || !assetId)) {
    const hit = await matchByPlatformSearch(row, model).catch(() => null);
    if (hit) {
      platform = hit.platform;
      assetId = hit.assetId;
      sourceUrl = hit.sourceUrl;
    }
    await sleep(150);
  }

  const identityOk = !!(platform && assetId && PREVIEWABLE.has(platform) || platform === 'simready' && assetId);
  const preview = listPreview(dir);

  // 身份齐了就把平台官方封面补进包（本地已有 preview 就不动）
  let coverFile = '';
  if (identityOk && !preview) {
    const coverUrl = await platformCoverUrl(platform, assetId, {taxonomy: taxonomyOf(platform, row.kind)}).catch(() => null);
    if (coverUrl) {
      const got = await downloadCover(coverUrl).catch(() => null);
      if (got) {
        const buf = got.ext === '.webp' || got.ext === '.avif' ? await sharp(got.buf).jpeg({quality: 90}).toBuffer() : got.buf;
        const ext = got.ext === '.webp' || got.ext === '.avif' ? '.jpg' : got.ext;
        const target = path.join(dir, `preview${ext}`);
        coverFile = target;
        if (APPLY) fs.writeFileSync(target, buf);
      }
    }
    await sleep(120);
  } else if (preview) {
    coverFile = path.join(dir, preview);
  }

  // 缩略图：平台封面 > 平台外链 > 主模型（前端渲）> 原样
  let nextThumb = String(row.thumbnail || '');
  if (coverFile) nextThumb = thumbUrl(path.relative(ARCHIVE_ROOT, coverFile));
  else if (!nextThumb && identityOk) {
    const coverUrl = await platformCoverUrl(platform, assetId, {taxonomy: taxonomyOf(platform, row.kind)}).catch(() => null);
    if (coverUrl) nextThumb = coverUrl;
    else {
      const main = mainModel(dir);
      if (main) nextThumb = thumbUrl(path.relative(ARCHIVE_ROOT, main));
    }
  }

  const identityChanged = (platform && platform !== String(row.platform || '')) || (assetId && assetId !== String(model.assetId || ''));
  const thumbChanged = !!nextThumb && nextThumb !== String(row.thumbnail || '')
    && !(isPreviewThumb(row.thumbnail) && isPreviewThumb(nextThumb));
  if (!identityChanged && !thumbChanged) { healthy += 1; continue; }

  if (identityChanged) relinked += 1;
  if (thumbChanged && coverFile) coverFixed += 1;
  report.push([
    APPLY ? '' : '[预演] ',
    row.platform || '(空)',
    row.name.slice(0, 30),
    identityChanged ? `→ ${platform}:${assetId}` : '身份未变',
    thumbChanged ? (coverFile ? '封面=包内预览图' : `封面=${nextThumb.startsWith('http') ? '平台外链' : '本地模型渲染'}`) : '封面未变',
  ].join(' | '));

  if (APPLY) {
    if (identityChanged) {
      model.platform = platform;
      model.assetId = assetId;
      if (sourceUrl) model.sourceUrl = sourceUrl;
      for (const name of ['info.json', '__info.json']) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          data.platform = platform;
          data.assetId = assetId;
          if (sourceUrl) data.sourceUrl = sourceUrl;
          fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
        } catch { /* 坏 json 不动 */ }
      }
    }
    if (thumbChanged) model.thumbnail = nextThumb;
    upd.run(platform || row.platform, nextThumb, JSON.stringify(model), now, row.uid);
  }
}

for (const line of report) console.log(line);

// 仍然接不上的：算「掉链」的只有本来属于某个平台、却缺 assetId 的资产。
// 本地拖进来 / AI 生成的素材本来就没有平台身份，不在这份清单里（否则几百条噪音）。
const broken = rows.filter(row => {
  const model = JSON.parse(row.payload || '{}');
  const dir = packageDirOf(model);
  if (!dir) return false;
  const platform = String(row.platform || model.platform || '').toLowerCase();
  const assetId = String(model.assetId || '').trim();
  const fromPlatform = PREVIEWABLE.has(platform) || platform === 'simready';
  return fromPlatform && !assetId;
});
if (broken.length) {
  stillBroken = broken.length;
  console.log('\n身份仍然缺失 %d 条（这些点开只能看本地文件）：', broken.length);
  for (const row of broken.slice(0, 40)) console.log('   ', row.uid.slice(0, 8), row.name.slice(0, 40));
}

console.log('\n共 %d 条：重连身份 %d、补封面 %d、本来就好 %d、仍缺身份 %d',
  rows.length, relinked, coverFixed, healthy, stillBroken);
if (!APPLY) console.log('（预演模式，未写入。加 --apply 执行；需要联网反查再加 --match）');
