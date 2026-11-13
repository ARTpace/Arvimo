// 桌面版（Tauri / NSIS）SQLite 原生依赖装配。
//
// 为什么必须有这一步：sidecar 的 server/library-db.mjs 用 import('better-sqlite3') 惰性加载，
// 而安装包里原本没有 node_modules —— 内核永远加载失败、静默退回纯文件模式，于是
// /api/library/collections 与 smart-collections 全部 503。装配时把运行期闭包放进
// sidecar-server/node_modules/，Node 的裸导入从 server/ 逐级向上自然命中，服务端零改动。
//
// 纪律：
//  - 只带运行期文件（JS + .node + package.json + LICENSE），C++ 源码 / deps / 安装期工具不带。
//  - 依赖清单是数据；每次装配都做闭包校验，升级 better-sqlite3 换了加载方式会立刻报错，
//    不会出现「打完包才发现合集还是灰的」。
//  - 用安装包内置的 node.exe 亲自加载一次：ABI、迁移链、FTS5 trigram 一次验完。
//    N-API 二进制跨 Node 22 小版本兼容，但换大版本必须重建 —— 光看文件在不在不算数。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';

/** 运行期依赖闭包。prebuild-install 只在 npm install 阶段用，永不进包。 */
export const RUNTIME_PACKAGES = Object.freeze([
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
]);
const INSTALL_ONLY_DEPS = new Set(['prebuild-install']);
const NATIVE_FILE = path.join('build', 'Release', 'better_sqlite3.node');

/** 每个包的装配布局：递归复制哪些目录、根目录放行哪些后缀。 */
export const PACKAGE_LAYOUT = Object.freeze({
  'better-sqlite3': {dirs: ['lib', path.join('build', 'Release')], rootExts: ['.js', '.json', '.node']},
  bindings: {dirs: [], rootExts: ['.js', '.json']},
  'file-uri-to-path': {dirs: [], rootExts: ['.js', '.json', '.d.ts']},
});
const CODE_EXTS = new Set(['.js', '.cjs', '.mjs', '.json', '.node', '.d.ts']);
const LICENSE_RE = /^licen[cs]e(\..+)?$/i;

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), {recursive: true});
  fs.copyFileSync(from, to);
}

/** 升级了依赖却没同步清单时，宁可中止打包也不产出一个运行时才崩的安装包。 */
export function validateDependencyClosure(modulesRoot) {
  const missing = [];
  for (const name of RUNTIME_PACKAGES) {
    const manifest = path.join(modulesRoot, name, 'package.json');
    if (!fs.existsSync(manifest)) { missing.push(`${name}（包不存在，请执行 npm install）`); continue; }
    if (!PACKAGE_LAYOUT[name]) { missing.push(`${name}（缺装配布局）`); continue; }
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (INSTALL_ONLY_DEPS.has(dep) || RUNTIME_PACKAGES.includes(dep)) continue;
      missing.push(`${name} → ${dep}`);
    }
  }
  if (missing.length) throw Error(`原生依赖闭包出现未装配的包：${missing.join('、')}。请更新 RUNTIME_PACKAGES / PACKAGE_LAYOUT`);
}

function copyPackage(modulesRoot, targetRoot, name, copied) {
  const layout = PACKAGE_LAYOUT[name];
  const from = path.join(modulesRoot, name);
  if (!fs.existsSync(from)) throw Error(`缺少运行期依赖 ${name}：请在库工程执行 npm install`);
  const to = path.join(targetRoot, name);
  const record = dst => copied.push(path.relative(targetRoot, dst).split(path.sep).join('/'));

  for (const entry of fs.readdirSync(from, {withFileTypes: true})) {
    if (entry.isDirectory()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (entry.name !== 'package.json' && !LICENSE_RE.test(entry.name) && !layout.rootExts.includes(ext)) continue;
    const dst = path.join(to, entry.name);
    copyFile(path.join(from, entry.name), dst);
    record(dst);
  }
  for (const dir of layout.dirs) {
    const src = path.join(from, dir);
    if (!fs.existsSync(src)) continue;
    const walk = (srcDir, dstDir) => {
      for (const entry of fs.readdirSync(srcDir, {withFileTypes: true})) {
        if (entry.isDirectory()) { walk(path.join(srcDir, entry.name), path.join(dstDir, entry.name)); continue; }
        if (!CODE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
        const dst = path.join(dstDir, entry.name);
        copyFile(path.join(srcDir, entry.name), dst);
        record(dst);
      }
    };
    walk(src, path.join(to, dir));
  }
}

/**
 * 冒烟脚本走真实的 library-db.mjs → import('better-sqlite3')，所以解析路径、ABI、
 * 迁移 SQL、FTS5 trigram 虚表全都在目标 node.exe 上过一遍。临时文件跑完即删。
 */
const SMOKE_SOURCE = `
import {openLibraryDb} from './server/library-db.mjs';
const file = process.argv[2];
let warning = '';
let migrations = 0;
const conn = await openLibraryDb({file, onWarn: message => { warning = message; }});
if (!conn) throw Error('SQLite 内核加载失败：' + warning);
try {
  migrations = conn.counts().migrations;
  if (migrations < 1) throw Error('迁移链没有执行');
  if (!Array.isArray(conn.search('三角龙模型', 5))) throw Error('FTS5 trigram 检索不可用');
} finally { conn.close(); }
console.log('SQLITE_OK modules=' + process.versions.modules + ' migrations=' + migrations);
`;

export function smokeSqliteNative({sidecar, nodeExe}) {
  if (!nodeExe || !fs.existsSync(nodeExe)) return null;
  const smokeFile = path.join(sidecar, `.sqlite-smoke-${process.pid}.mjs`);
  const dbFile = path.join(os.tmpdir(), `assetvault-sqlite-smoke-${process.pid}-${Date.now()}.db`);
  fs.writeFileSync(smokeFile, SMOKE_SOURCE, 'utf8');
  const env = {...process.env};
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  try {
    const out = execFileSync(nodeExe, [smokeFile, dbFile], {
      cwd: sidecar, env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!String(out).includes('SQLITE_OK')) throw Error(`冒烟没有通过：${String(out).trim()}`);
    return String(out).trim();
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim().slice(0, 1200);
    throw Error(`内置 Node 加载 SQLite 原生模块失败（ABI / 依赖不匹配）：${detail}\n`
      + '请用与内置 node.exe 相同大版本的 Node 执行 npm install && npm rebuild better-sqlite3，再重新打包。');
  } finally {
    for (const file of [smokeFile, dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`]) {
      try { fs.unlinkSync(file); } catch {}
    }
  }
}

/**
 * 把运行期闭包装进 sidecar-server/node_modules 并可选做 ABI 冒烟。
 * 只清理本模块负责的包目录，其它人放在同一 node_modules 里的依赖不会被误删。
 */
export function assembleSqliteNative({libraryProject, sidecar, nodeExe = null, onLog = () => {}} = {}) {
  if (!libraryProject || !sidecar) throw Error('缺少 libraryProject / sidecar 路径');
  const modulesRoot = path.join(libraryProject, 'node_modules');
  const targetRoot = path.join(sidecar, 'node_modules');
  validateDependencyClosure(modulesRoot);

  const pkg = JSON.parse(fs.readFileSync(path.join(modulesRoot, 'better-sqlite3', 'package.json'), 'utf8'));
  if (!fs.existsSync(path.join(modulesRoot, 'better-sqlite3', NATIVE_FILE))) {
    throw Error(`缺少 ${NATIVE_FILE}：原生模块没编译成功，请执行 npm rebuild better-sqlite3 后重新打包`);
  }
  for (const name of RUNTIME_PACKAGES) fs.rmSync(path.join(targetRoot, name), {recursive: true, force: true});
  const copied = [];
  for (const name of RUNTIME_PACKAGES) copyPackage(modulesRoot, targetRoot, name, copied);
  if (!fs.existsSync(path.join(targetRoot, 'better-sqlite3', NATIVE_FILE))) throw Error('原生模块复制失败');

  const smoke = smokeSqliteNative({sidecar, nodeExe});
  onLog(`✓ SQLite 原生依赖：better-sqlite3@${pkg.version} + ${RUNTIME_PACKAGES.length} 包 / ${copied.length} 文件`
    + (smoke ? `，${smoke}` : '（未提供 node.exe，跳过 ABI 冒烟）'));
  return {version: pkg.version, packages: [...RUNTIME_PACKAGES], files: copied, smoke};
}
