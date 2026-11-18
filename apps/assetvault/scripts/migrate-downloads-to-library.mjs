// 把「下载器」落在 downloads 里的素材包整理进资产库。
//
// 背景：下载产物一直落在 dataDir 之外的 downloads/<分类>/<包名>/，只写 tasks.json，
// 从不登记成资产；库搬到资产根之后，这些文件仍留在 C 盘，库里一条都看不到。
//
// 做的事（每一包 = 一条资产）：
//   1. 按 tasks.json 的 saved 任务找到包目录，同名（含 " (1)" 后缀 / 同名 .zip）归为一组；
//   2. 每组搬一份进 资产根/<分组>/<子类型>/<包名>（跨盘复制 → 核对文件数 → 才删源）；
//   3. 在 library.db 登记资产：filePath 指向包内主文件，缩略图用包内基础色贴图；
//   4. 写包内 __info.json（sidecar），更新 tasks.json 的 filePath；
//   5. 重复副本（含同名 zip）移到 资产根/.assetvault/trash/downloads-dups-<时间>/，不直接删。
//
// 用法：node scripts/migrate-downloads-to-library.mjs [--apply]
//   默认只体检（dry-run），--apply 才动文件与数据库。

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const appBase = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'AssetVault');

/** 定位库：以 libraries.json 的 active 库为准。 */
function resolveStore() {
  const registry = JSON.parse(fs.readFileSync(path.join(appBase, 'libraries.json'), 'utf8'));
  const store = registry.stores.find(s => s.id === registry.activeId) || registry.stores[0];
  if (!store) throw new Error('没有可用资源库');
  return {dataDir: store.dataDir, archiveRoot: store.archiveRoot, name: store.name};
}

// 分类目录：与 server/asset-folders.mjs 的 KIND_FOLDER 一致（那边是唯一真相源）。
const DIRS = {
  images: ['图片', '其他图片'],
  models: ['3D资产', '3D模型'],
  textures: ['3D资产', '材质'],
  hdris: ['3D资产', 'HDRI'],
  packs: ['3D资产', '资源包'],
};
const SINGULAR = {images: 'image', models: 'model', textures: 'texture', hdris: 'hdri', packs: 'pack'};

/** 包名归一：去掉 " (2)" 与同名 .zip，用来把重复下载归到一组。 */
const groupKeyOf = p => path.basename(String(p || ''))
  .replace(/\.zip$/i, '')
  .replace(/\s*\(\d+\)$/, '');

const IMAGE_RE = /\.(png|jpe?g|webp|tga|tif?f)$/i;
const MODEL_RE = /\.(glb|gltf|fbx|obj|usd|usdz|blend|stl)$/i;
// 同一包里常有 glb + fbx 两份：glb 优先（浏览器可预览），fbx 作为 Blender 侧的备份留在包里。
const MAIN_ORDER = [/\.glb$/i, /\.gltf$/i, /\.fbx$/i, /\.obj$/i, /\.usd[sz]?$/i, /\.blend$/i, /\.stl$/i,
  /\.hdr$/i, /\.exr$/i, /\.sbsar$/i, /\.zip$/i];

/** 主文件的扩展名决定类型：比平台标签可靠（ambientcg 也出 obj，freestylized 也有天空盒）。 */
function kindFromMain(mainRel, job = {}) {
  const ext = path.extname(String(mainRel || '')).toLowerCase();
  const platform = String(job.kind || job.platform || '').toLowerCase();
  const title = String(job.title || job.name || '');
  if (/^\.(hdr|exr)$/.test(ext)) return 'hdris';
  if (MODEL_RE.test(ext)) return 'models';
  if (ext === '.sbsar') return 'textures';
  if (ext === '.zip') return /sky|hdri|env/i.test(title) || platform === 'freestylized' && /sky/i.test(title) ? 'hdris' : 'packs';
  if (IMAGE_RE.test(ext)) return platform === 'ambientcg' || (Array.isArray(job.textures) && job.textures.length) ? 'textures' : 'images';
  return 'models';
}

/** 递归列文件（返回相对路径）。 */
async function listFiles(root, limit = 4000) {
  const out = [];
  const walk = async dir => {
    if (out.length > limit) return;
    let entries = [];
    try { entries = await fsp.readdir(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full));
    }
  };
  await walk(root);
  return out;
}

/** 包内主文件：模型 > HDRI > SBSAR > zip，最后退回最大的图。 */
async function pickMain(dir, files) {
  for (const re of MAIN_ORDER) {
    const hit = files.filter(f => re.test(f)).sort((a, b) => a.length - b.length)[0];
    if (hit) return hit;
  }
  let best = '';
  let bestSize = -1;
  for (const f of files) {
    if (!IMAGE_RE.test(f)) continue;
    const size = await fsp.stat(path.join(dir, f)).then(s => s.size).catch(() => 0);
    if (size > bestSize) { best = f; bestSize = size; }
  }
  return best;
}

/** 包内预览图：优先基础色贴图，其次任意图片。 */
function pickPreview(files) {
  const score = f => {
    const n = f.toLowerCase();
    if (/preview|cover|thumb|render|screenshot/.test(n)) return 0;
    if (/(^|[^a-z])(base)?color|c_rgba|diff|albedo/.test(n)) return 1;
    if (/mat0_?c/.test(n)) return 2;
    if (IMAGE_RE.test(n)) return 3;
    return 99;
  };
  return files.filter(f => IMAGE_RE.test(f)).sort((a, b) => score(a) - score(b) || a.length - b.length)[0] || '';
}

const cleanName = name => String(name || '')
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120) || 'asset';

/** 目标重名时加 (2)(3)，绝不覆盖既有资产。 */
async function uniqueDir(target) {
  const exists = async p => fsp.access(p).then(() => true, () => false);
  if (!(await exists(target))) return target;
  const dir = path.dirname(target);
  const base = path.basename(target);
  for (let i = 2; i < 200; i += 1) {
    const next = path.join(dir, `${base} (${i})`);
    if (!(await exists(next))) return next;
  }
  throw new Error(`目标重名过多：${target}`);
}

/** 跨盘搬目录：只复制并核对文件数，**不删源**。
 *  用系统 cp 而不是 fs.cp：Node 22 的 fs.cp 在几百个文件上慢一个数量级（实测 734MB 的包
 *  两分钟没复制完，cp -r 只要 12 秒）。删源交给外部的 shell 步骤（node 的批量删除会触发保护）。 */
async function copyInto(src, dest) {
  await fsp.mkdir(path.dirname(dest), {recursive: true});
  if (!APPLY) return {dry: true, dest};
  const stat = await fsp.lstat(src);
  if (stat.isFile()) {
    await fsp.copyFile(src, dest);
    return {dry: false, dest};
  }
  await new Promise((resolve, reject) => {
    execFile('cp', ['-r', src, dest], {maxBuffer: 8 * 1024 * 1024}, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim())); else resolve();
    });
  });
  const [a, b] = [(await listFiles(src)).length, (await listFiles(dest)).length];
  if (a !== b) throw new Error(`复制不完整（${a} → ${b}）：${src}`);
  return {dry: false, dest};
}

const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

const human = n => `${(n / 1024 / 1024).toFixed(1)}MB`;

async function main() {
  const store = resolveStore();
  const {dataDir, archiveRoot} = store;
  const tasksFile = path.join(dataDir, 'tasks.json');
  const dbFile = path.join(dataDir, 'library.db');
  console.log(`库：${store.name}\n数据：${dataDir}\n资产根：${archiveRoot}\n模式：${APPLY ? '写入' : '体检（dry-run）'}\n`);

  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const jobs = (tasks.jobs || []).filter(j => j.state === 'saved' && j.filePath);
  const dirJobs = jobs.filter(j => fs.existsSync(j.filePath) && fs.statSync(j.filePath).isDirectory());
  const fileJobs = jobs.filter(j => fs.existsSync(j.filePath) && fs.statSync(j.filePath).isFile());
  const goneJobs = jobs.filter(j => !fs.existsSync(j.filePath));
  console.log(`已保存任务 ${jobs.length} 条：目录 ${dirJobs.length}、单文件 ${fileJobs.length}、文件已不在 ${goneJobs.length}\n`);

  // 目录型按包名归组；同名 zip / 旧副本都算组内重复。
  const groups = new Map();
  for (const job of dirJobs) {
    const key = groupKeyOf(job.filePath);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  console.log(`可用包 ${dirJobs.length} 个，归为 ${groups.size} 组\n`);

  const db = new Database(dbFile);
  db.pragma('journal_mode = DELETE');
  let position = db.prepare('SELECT COALESCE(MAX(position), 0) n FROM assets').get().n;
  const rootRow = db.prepare('SELECT root_id FROM file_roots WHERE path = ?').get(archiveRoot);
  if (!rootRow) throw new Error(`file_roots 里没有资产根：${archiveRoot}`);

  if (APPLY) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(dbFile, `${dbFile}.bak-dlmove-${stamp}`);
    await fsp.copyFile(tasksFile, `${tasksFile}.bak-dlmove-${stamp}`);
    console.log(`已备份 library.db / tasks.json（.bak-dlmove-${stamp}）\n`);
  }

  const report = {moved: [], duplicates: [], skipped: [], missing: goneJobs.map(j => j.filePath)};
  const cleanup = [];
  let movedBytes = 0;

  for (const [key, list] of groups) {
    // 组内保留：无 (n) 后缀 > 非 project- 目录 > 字节更大的
    list.sort((a, b) => {
      const score = j => (path.basename(j.filePath).includes('(') ? 2 : 0) + (j.filePath.includes('project-') ? 1 : 0);
      return score(a) - score(b) || (b.bytes || 0) - (a.bytes || 0);
    });
    const keep = list[0];
    const src = keep.filePath;
    const files = await listFiles(src);
    const mainRel = await pickMain(src, files);
    const name = cleanName(keep.title || keep.name || key);
    if (!mainRel) { report.skipped.push({name, reason: '包内没有可登记的主文件', src}); continue; }

    const kind = kindFromMain(mainRel, keep);
    const [group, sub] = DIRS[kind] || DIRS.models;
    const previewRel = pickPreview(files);
    // 平台身份字段必须跟着资产一起入库：少了 assetId / maps / 复数 assetType，
    // 材质卡就退回一张平贴图，官方 3D 预览（/api/ambientcg/preview、Poly Haven 渲染、FreeStylized 解包）全废。
    let platformInfo = {};
    try { platformInfo = JSON.parse(fs.readFileSync(path.join(src, 'info.json'), 'utf8')); } catch {}
    const target = await uniqueDir(path.join(archiveRoot, group, sub, name));
    const bytes = (await fsp.stat(path.join(src, mainRel))).size;
    movedBytes += bytes;

    console.log(`[${kind}] ${name}  →  ${group}/${sub}/${path.basename(target)}  (主文件 ${mainRel.replace(/\\/g, '/')}，同组副本 ${list.length - 1} 个)`);

    // 重复副本（含同名 zip）：库里留一份就够，源目录只进待删清单，不再往 J 盘复制一份
    for (const dup of [...list.slice(1), ...fileJobs.filter(j => groupKeyOf(j.filePath) === key)]) {
      if (APPLY) {
        dup.state = 'cancelled';
        dup.warning = `重复副本，已并入「${name}」`;
      }
      report.duplicates.push(dup.filePath);
      cleanup.push(dup.filePath);
    }

    if (!APPLY) { report.moved.push({name, from: src, to: target, kind}); continue; }

    await copyInto(src, target);
    cleanup.push(src);
    const mainPath = path.join(target, mainRel);
    const hash = await sha256(mainPath).catch(() => null);

    // —— 登记资产 ——
    const relOf = p => path.relative(archiveRoot, p).split(path.sep).join('/');
    const q = (root, rel) => `root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`;
    const uid = randomUUID().replace(/-/g, '');
    const now = Date.now();
    const mainQ = q(archiveRoot, relOf(mainPath));
    const thumbQ = previewRel ? q(archiveRoot, relOf(path.join(target, previewRel))) : mainQ;
    const payload = {
      uid,
      url: `/api/local/file?${mainQ}`,
      previewUrl: `/api/local/file?${mainQ}`,
      thumbnail: `/api/local/thumb?w=512&${thumbQ}`,
      assetType: platformInfo.assetType || keep.assetType || ({textures: 'textures', hdris: 'hdris', models: 'models', packs: 'packs', images: 'images'}[kind] || 'images'),
      assetId: platformInfo.assetId || keep.assetId || '',
      ...(Array.isArray(platformInfo.maps) && platformInfo.maps.length ? {maps: platformInfo.maps} : {}),
      ...(platformInfo.format ? {materialFormat: platformInfo.format} : {}),
      ...(platformInfo.resolution ? {materialResolution: platformInfo.resolution} : {}),
      ...(platformInfo.sourceType ? {sourceType: platformInfo.sourceType} : {}),
      localRoot: archiveRoot,
      localRel: relOf(mainPath),
      name,
      title: keep.title || name,
      author: keep.author || '',
      license: keep.license || '',
      platform: keep.platform || keep.kind || 'download',
      source: 'download',
      sourceUrl: keep.url || '',
      format: keep.format || '',
      filePath: mainPath,
      packageDir: target,
      storageMode: 'linked',
      fileExists: true,
      ext: path.extname(mainPath).slice(1).toLowerCase(),
      bytes,
      addedAt: now,
      downloadable: !!keep.downloadable,
      ...(Array.isArray(keep.textures) && keep.textures.length ? {textures: keep.textures} : {}),
      ...(Array.isArray(keep.tags) && keep.tags.length ? {tags: keep.tags} : {}),
    };
    position += 1;
    db.prepare(`INSERT INTO assets
      (uid, position, state, payload, name, author, url, platform, thumbnail, rating, note, favorite, added_at, trashed_at, source,
       kind, width, height, long_edge, bytes, color_h, duration, content_hash, rev, updated_at, tags_text, category_text, downloadable)
      VALUES (@uid, @position, 'active', @payload, @name, @author, @url, @platform, @thumbnail, 0, '', 0, @added_at, NULL, 'download',
       @kind, 0, 0, 0, @bytes, NULL, NULL, @hash, 1, @updated_at, @tags_text, @category_text, @downloadable)`)
      .run({
        uid, position, payload: JSON.stringify(payload), name, author: payload.author,
        url: payload.url, platform: payload.platform, thumbnail: payload.thumbnail,
        added_at: now, bytes, hash, updated_at: now, kind,
        tags_text: `来源:${payload.platform}`, category_text: `${SINGULAR[kind]} ${kind}`,
        downloadable: payload.downloadable ? 1 : 0,
      });
    const rowid = db.prepare('SELECT rowid FROM assets WHERE uid = ?').get(uid).rowid;
    db.prepare('INSERT INTO assets_fts (rowid, uid, body) VALUES (?, ?, ?)')
      .run(rowid, uid, `${name} ${payload.author} ${payload.platform} 来源:${payload.platform}`.trim());
    if (payload.ext) db.prepare('INSERT OR IGNORE INTO asset_formats (uid, ext) VALUES (?, ?)').run(uid, payload.ext);
    // 同一个 rel 只应有一条位置记录：重跑脚本时覆盖旧的，而不是撞唯一约束。
    db.prepare(`INSERT OR REPLACE INTO file_locations (location_id, asset_uid, root_id, rel, fingerprint, availability, mode)
      VALUES (?, ?, ?, ?, ?, 'online', 'linked')`)
      .run(randomUUID(), uid, rootRow.root_id, relOf(mainPath), hash);

    // 包内说明书：整个包目录拷走也带着元数据
    await fsp.writeFile(path.join(target, '__info.json'), JSON.stringify({
      schema: 'assetvault/sidecar@1',
      uid, name, kind, ext: payload.ext, bytes,
      platform: payload.platform, author: payload.author, license: payload.license,
      sourceUrl: payload.sourceUrl, addedAt: new Date(now).toISOString(),
    }, null, 1), 'utf8').catch(() => {});

    keep.filePath = target;
    report.moved.push({uid, name, from: src, to: target, kind, bytes});
  }

  if (APPLY) {
    // 文件早已不在的任务留着只会让下载面板一直显示「文件不存在」，一并标记掉。
    for (const job of goneJobs) {
      job.state = 'cancelled';
      job.warning = '文件已不存在（此前清理时删除）';
    }
    fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 1), 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dataDir, `downloads-migrate-${stamp}.json`), JSON.stringify(report, null, 1), 'utf8');
    // 源目录清单：交给外部 shell 删除（node 的批量删除会触发保护）
    const cleanupFile = path.join(dataDir, `downloads-cleanup-${stamp}.txt`);
    fs.writeFileSync(cleanupFile, cleanup.join('\n'), 'utf8');
    console.log(`\n源目录清单 ${cleanup.length} 条：${cleanupFile}`);
  }
  const byKind = report.moved.reduce((acc, m) => (acc[m.kind] = (acc[m.kind] || 0) + 1, acc), {});
  console.log(`\n${APPLY ? '完成' : '体检结果'}：登记 ${report.moved.length} 条资产 ${JSON.stringify(byKind)}，主文件合计 ${human(movedBytes)}`);
  console.log(`重复副本 ${report.duplicates.length} 个${APPLY ? '已移入回收站' : '待移入回收站'}，跳过 ${report.skipped.length} 个，任务指向的文件已删除 ${report.missing.length} 条`);
  for (const s of report.skipped) console.log(`  跳过：${s.name}（${s.reason}）`);
  db.close();
}

main().catch(error => { console.error('失败：', error); process.exit(1); });
