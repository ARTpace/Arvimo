#!/usr/bin/env node
// 把资产库的数据目录搬进库内：<资产根>/.assetvault/data
//
// 为什么搬：成熟的素材库（Billfish 的 .bf/、灵犬的 items.db、Eagle 的 metadata.json）
// 都把「谁有哪个资产、打了什么标签」写在库目录里，整个文件夹拷到另一台机器就能打开。
// 我们的库数据原本住在 %APPDATA%，换机器/重装就只剩磁盘上的裸文件，标签收藏全丢。
//
// 用法：
//   node scripts/move-data-into-library.mjs                 # 只体检，打印会搬什么
//   node scripts/move-data-into-library.mjs --apply         # 真搬（必须先退出桌面版/停掉服务）
//   node scripts/move-data-into-library.mjs --from <目录>    # 指定源（默认自动挑资产最多的那个）
//   node scripts/move-data-into-library.mjs --store <id>     # 指定资源库（默认当前选中的）
//
// 安全策略：先复制 → 校验 database 完整性 → 改注册表 → 旧目录改名留档 →
// 在原位置留一张 data-moved.json 字条（桌面版还在传旧路径时靠它自动改道）。
// 任何一步失败都不会动旧目录。

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {REGISTRY_FILE, readStoreRegistry, writeStoreRegistry, libraryDataDir} from '../server/store-registry.mjs';
import {resolveUserPaths} from '../server/data-dir.mjs';

const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at >= 0 ? String(args[at + 1] || '') : ''; };
const apply = args.includes('--apply');
const fromArg = flag('--from');
const storeArg = flag('--store');
const port = Number(flag('--port') || process.env.SFX_PORT || 4179);

// 可再生、且体积极大的东西不跟着库走：浏览器登录态属于这台机器，
// 缓存删了会自动重建；搬它们只会让复制从几秒变成几分钟。
const SKIP_DIRS = new Set([
  'browser', 'browsers', 'artstation-browser-profile', 'http-cache',
  'preview-cache', 'drag-cache', 'thumb-cache', 'workers', 'backups', 'cache',
]);
// artflow-board.json 是旧版画布的存档（v2，assets 里是早就删掉的画布素材），
// 只在库里完全没有画板时才被读一次；库里已有 canvas_project 数据时它永远不会生效，
// 留着只是 35MB 死重。需要时它会跟着旧目录一起进留档。
const skipFile = name => /\.(bak-|sync-conflict-|migrated-)/.test(name)
  || name === 'data-moved.json' || name === 'artflow-board.json';

const die = message => { console.error(`\n✗ ${message}\n`); process.exit(1); };
const human = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const userPaths = resolveUserPaths();
const base = userPaths.base;
let registry;
try {
  registry = readStoreRegistry(base);
} catch (error) {
  die(`读不了注册表 ${path.join(base, REGISTRY_FILE)}：${error.message}`);
}
const store = registry.stores.find(item => item.id === (storeArg || registry.activeId));
if (!store) die(`注册表里找不到资源库 ${storeArg || registry.activeId}`);

const archiveRoot = store.archiveRoot || userPaths.archiveRoot;
const target = libraryDataDir(archiveRoot);

/** 数一下某个目录里有多少资产，用来判断哪份数据才是"真身"。 */
function countAssets(dir) {
  const file = path.join(dir, 'library.db');
  if (!fs.existsSync(file)) return -1;
  try {
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const db = new Database(file, {readonly: true, fileMustExist: true});
    try {
      return db.prepare('select count(*) as n from assets').get().n;
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

const devData = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../_local/desktop-dev/data');
const candidates = [...new Set([fromArg, store.dataDir, userPaths.dataDir, path.join(base, 'data'), devData].filter(Boolean))]
  .filter(dir => { try { return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'library.db')); } catch { return false; } })
  .map(dir => ({dir: path.resolve(dir), assets: countAssets(dir)}))
  .sort((a, b) => b.assets - a.assets);

if (!candidates.length) die('没找到任何带 library.db 的数据目录');
const source = candidates[0];

/** 预演：算要搬多少、跳过什么。 */
function plan(src) {
  const stats = {files: 0, bytes: 0, skipped: []};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) { stats.skipped.push(`${rel}/`); continue; }
        walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (skipFile(entry.name)) { stats.skipped.push(rel); continue; }
      stats.files += 1;
      try { stats.bytes += fs.statSync(path.join(dir, entry.name)).size; } catch {}
    }
  };
  walk(src, '');
  return stats;
}

const info = plan(source.dir);
console.log(`\n资源库      ${store.name}  (${store.id})`);
console.log(`资产根      ${archiveRoot}`);
console.log(`目标数据目录 ${target}`);
console.log(`\n源目录候选（按资产条数排序，取第一个）`);
for (const item of candidates) {
  const mark = item.dir === source.dir ? '→' : ' ';
  console.log(` ${mark} ${String(item.assets).padStart(5)} 条  ${item.dir}`);
}
console.log(`\n要搬 ${info.files} 个文件，约 ${human(info.bytes)}`);
if (info.skipped.length) console.log(`跳过 ${info.skipped.length} 项缓存/备份（可再生）：${info.skipped.slice(0, 6).join('、')}${info.skipped.length > 6 ? ' …' : ''}`);

if (!apply) {
  console.log('\n预演结束。确认无误后加 --apply 执行（请先退出桌面版）。\n');
  process.exit(0);
}

if (path.resolve(source.dir) === path.resolve(target)) {
  console.log('\n✓ 已经在库内了，不需要搬。\n');
  process.exit(0);
}
if (fs.existsSync(path.join(target, 'library.db'))) {
  die(`目标位置已经有库数据：${target}\n  先确认要保留哪一份，再手工处理。`);
}

const busy = await new Promise(resolve => {
  const socket = net.connect({host: '127.0.0.1', port});
  const done = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(800);
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.once('timeout', () => done(false));
});
if (busy) die(`端口 ${port} 还在服务中，库正被打开。先退出桌面版 / 停掉 node 服务再执行。`);

/** 复制树：只搬必要的东西，保留原目录结构。 */
function copyTree(src, dst) {
  fs.mkdirSync(dst, {recursive: true});
  for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyTree(path.join(src, entry.name), path.join(dst, entry.name));
      continue;
    }
    if (skipFile(entry.name)) continue;
    fs.copyFileSync(path.join(src, entry.name), path.join(dst, entry.name));
  }
}

console.log('\n复制中…');
copyTree(source.dir, target);

// 校验：文件在、表能读、行数对得上。不对就把目标清掉，源目录一根头发都不动。
const expected = countAssets(source.dir);
const actual = countAssets(target);
if (actual < 0) {
  fs.rmSync(target, {recursive: true, force: true});
  die('复制出来的 library.db 打不开，已回滚（源目录未改动）');
}
if (expected >= 0 && actual !== expected) {
  fs.rmSync(target, {recursive: true, force: true});
  die(`行数对不上：源 ${expected} 条 / 新 ${actual} 条，已回滚（源目录未改动）`);
}

// 改注册表：从这个进程之后，库数据就住在资产根里。
store.dataDir = target;
writeStoreRegistry(base, registry);
try {
  fs.writeFileSync(path.join(target, '.assetvault-store.json'),
    `${JSON.stringify({name: store.name, archiveRoot: store.archiveRoot, createdAt: store.createdAt || Date.now()}, null, 2)}\n`);
} catch {}

// 旧目录改名留档，原位置放一张字条给还传旧路径的客户端看。
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const archive = `${source.dir}.migrated-${stamp}`;
try {
  fs.renameSync(source.dir, archive);
  fs.mkdirSync(source.dir, {recursive: true});
  fs.writeFileSync(path.join(source.dir, 'data-moved.json'),
    `${JSON.stringify({movedTo: target, at: Date.now(), note: '库数据已并入资产根，此目录仅作回滚留档'}, null, 2)}\n`);
} catch (error) {
  console.warn(`\n! 注册表已更新，但旧目录改名失败：${error.message}`);
}

console.log(`\n✓ 搬完了：${actual} 条资产记录已住进 ${target}`);
console.log(`  旧目录留档：${archive}（确认没问题后可删）`);
console.log(`  旧路径留了 data-moved.json，桌面版还传老路径时会自动改道。`);
console.log('\n重启桌面版生效。若服务是手动起的，直接重启 node 即可。\n');
