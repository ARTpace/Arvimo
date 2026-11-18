// 把「平台字段」补回 migrate-downloads-to-library.mjs 建出来的资产记录。
//
// 症状：材质 / HDRI 点开只剩一张平贴图，平台的交互式 3D 预览没了（ambientCG 官方 PBR 查看器 /
// Poly Haven 本地渲染 / FreeStylized 解包渲染），卡片也不再显示成「PBR 材质」。
//
// 原因：迁移脚本只写了本地文件字段（filePath / packageDir / localRel / thumbnail），
// 平台侧身份字段全丢：
//   · assetId    —— 三个平台都要靠它去取预览数据，缺了就是「这个材质缺少资产标识」；
//   · assetType  —— 脚本写的是单数 texture / env / model，前端只认复数 textures / hdris / models，
//                  于是材质被当成普通图片，连 2K 精度下拉框都不出现；
//   · maps       —— 预览面板要展示的通道列表。
// 而库里原本那条目录级记录（迁移时被合并进回收站的那条）是带这些字段的 —— 就是在这里丢的。
//
// 做的事（只动 payload，不动文件）：
//   1. 同 name + platform 的兄弟记录里找 assetId / maps / assetType 等平台字段，抄回活动记录；
//   2. 找不到兄弟记录时，从包内 info.json、或 sourceUrl（ambientcg.com/a/<id>）现推；
//   3. assetType 归一成平台词汇：texture→textures、env/hdri→hdris、model→models、pack→packs；
//   4. 材质补上 materialFormat / materialResolution / sourceType（SBSAR 走 Substance 预览分支）。
//
// 用法：node scripts/merge-platform-fields.mjs [--apply]

import fs from 'node:fs';
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

const PLURAL = {texture: 'textures', material: 'textures', env: 'hdris', hdri: 'hdris', skybox: 'hdris', model: 'models', pack: 'packs', image: 'images', images: 'images'};
const PLATFORM_FIELDS = ['assetId', 'maps', 'sourceType', 'materialFormat', 'materialResolution', 'viewerUrl', 'author', 'license', 'licenseUrl', 'substanceFile', 'substanceAssetId', 'substanceParent', 'downloadable'];

const looksLikeHttp = value => /^https?:\/\//i.test(String(value || ''));

/** 包内 info.json（迁移时复制过来的原始平台信息）。 */
function infoOf(pkgDir) {
  if (!pkgDir) return {};
  const file = path.join(pkgDir, 'info.json');
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function assetIdFromSourceUrl(url) {
  const m = /ambientcg\.com\/a\/([A-Za-z0-9]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

function main() {
  const {dataDir, archiveRoot, name} = resolveStore();
  console.log(`库：${name}\n资产根：${archiveRoot}\n模式：${APPLY ? '写入' : '体检（dry-run）'}\n`);

  const db = new Database(path.join(dataDir, 'library.db'));
  db.pragma('journal_mode = DELETE');
  const rows = db.prepare('SELECT uid, name, kind, source, platform, state, payload FROM assets').all();
  const byName = new Map();
  for (const row of rows) {
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch {}
    const key = `${row.name}|${row.platform}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({...row, payload});
  }

  const update = db.prepare('UPDATE assets SET payload = ?, rev = rev + 1, updated_at = ? WHERE uid = ?');
  const now = Date.now();
  let changed = 0;

  for (const row of rows) {
    if (row.state !== 'active' || row.source !== 'download') continue;
    if (!['ambientcg', 'polyhaven', 'freestylized'].includes(row.platform)) continue;
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch { continue; }
    const info = infoOf(payload.packageDir);
    const before = JSON.stringify(payload);

    // 1. 兄弟记录（含已进回收站的）里的平台字段
    const siblings = (byName.get(`${row.name}|${row.platform}`) || []).filter(s => s.uid !== row.uid && s.payload.assetId);
    for (const donor of siblings) {
      for (const field of PLATFORM_FIELDS) {
        if (payload[field] === undefined && donor.payload[field] !== undefined) payload[field] = donor.payload[field];
      }
      if (!Array.isArray(payload.maps) && Array.isArray(donor.payload.maps)) payload.maps = donor.payload.maps;
      if (!looksLikeHttp(payload.url) && looksLikeHttp(donor.payload.url)) payload.url = donor.payload.url;
    }

    // 2. info.json 兜底
    if (!payload.assetId && info.assetId) payload.assetId = String(info.assetId);
    if (!payload.assetId) payload.assetId = assetIdFromSourceUrl(payload.sourceUrl) || '';
    if (!Array.isArray(payload.maps) && Array.isArray(info.maps)) payload.maps = info.maps;
    for (const field of ['sourceType', 'materialFormat', 'materialResolution', 'author', 'license']) {
      if (payload[field] === undefined && info[field] !== undefined) payload[field] = info[field];
    }
    if (payload.substanceFile && !payload.sourceType) payload.sourceType = 'substance';
    if (!payload.materialFormat) payload.materialFormat = payload.sourceType === 'substance' ? 'SBSAR' : (info.format || 'JPG');
    if (!payload.materialResolution) payload.materialResolution = info.resolution || (payload.materialFormat === 'SBSAR' ? '2K' : '2K');
    if (!looksLikeHttp(payload.url) && looksLikeHttp(info.url)) payload.url = info.url;

    // 3. assetType 归一成平台词汇
    const wanted = PLURAL[payload.assetType] || PLURAL[{textures: 'textures', hdris: 'hdris', models: 'models', packs: 'packs'}[row.kind]] || payload.assetType;
    if (wanted && payload.assetType !== wanted) payload.assetType = wanted;

    if (JSON.stringify(payload) === before) continue;
    changed += 1;
    const diff = [];
    if (!payload.assetId) diff.push('缺 assetId');
    console.log(`  ${row.name}（${row.platform}）→ assetId=${payload.assetId || '—'} assetType=${payload.assetType} maps=${(payload.maps || []).length}${payload.sourceType ? ` ${payload.sourceType}` : ''}${diff.length ? ' ⚠ ' + diff.join(',') : ''}`);
    if (APPLY) update.run(JSON.stringify(payload), now, row.uid);
  }

  db.close();
  console.log(`\n${changed} 条记录补齐平台字段（${APPLY ? '已写入' : '待写入'}）`);
  if (!APPLY) console.log('加 --apply 才会写入。');
}

main();
