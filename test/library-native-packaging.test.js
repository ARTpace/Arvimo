// 桌面版 SQLite 原生依赖装配：文件清单、闭包校验、幂等清理、真实 ABI 冒烟。
// 不碰 SFX_DATA_DIR，也不写仓库里的装配目录，全部在 mkdtemp 临时目录里跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  RUNTIME_PACKAGES, PACKAGE_LAYOUT, validateDependencyClosure,
  assembleSqliteNative, smokeSqliteNative,
} from '../sketchfab-exporter-tauri/scripts/copy-sqlite-native.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = path.join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sqlite-pack-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const libraryProject = path.join(dir, 'library');
  const sidecar = path.join(dir, 'sidecar');
  const modules = path.join(libraryProject, 'node_modules');
  const write = (rel, content = '') => {
    const file = path.join(modules, rel);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content);
  };
  const manifest = (name, version, dependencies, main) => write(path.join(name, 'package.json'),
    JSON.stringify({name, version, main, dependencies}));
  manifest('better-sqlite3', '12.11.1', {bindings: '^1.5.0', 'prebuild-install': '^7.1.1'}, 'lib/index.js');
  write('better-sqlite3/LICENSE', 'MIT');
  write('better-sqlite3/README.md', 'docs only');
  write('better-sqlite3/lib/index.js', "module.exports = require('./database');");
  write('better-sqlite3/lib/database.js', 'module.exports = function Database() {};');
  write('better-sqlite3/src/foo.cpp', 'c++ source');
  write('better-sqlite3/deps/sqlite3.c', 'c source');
  write(NATIVE, 'fake addon');
  manifest('bindings', '1.5.0', {'file-uri-to-path': '1.0.0'}, './bindings.js');
  write('bindings/LICENSE.md', 'MIT');
  write('bindings/bindings.js', 'module.exports = function bindings() {};');
  manifest('file-uri-to-path', '1.0.0', {}, './index.js');
  write('file-uri-to-path/LICENSE', 'MIT');
  write('file-uri-to-path/index.js', 'module.exports = function fileUriToPath() {};');
  return {dir, libraryProject, sidecar, modules, write, manifest};
}

const at = (sidecar, ...parts) => path.join(sidecar, 'node_modules', ...parts);

test('装配只带运行期闭包：JS / .node / LICENSE / package.json，C++ 源码与文档不进包', t => {
  const {libraryProject, sidecar, modules} = makeFixture(t);
  assert.equal(validateDependencyClosure(modules), undefined);
  const result = assembleSqliteNative({libraryProject, sidecar});

  assert.deepEqual(result.packages, RUNTIME_PACKAGES);
  assert.equal(result.version, '12.11.1');
  assert.equal(result.smoke, null, '没给 node.exe 就跳过 ABI 冒烟，不能假装验过');
  for (const name of RUNTIME_PACKAGES) {
    assert.ok(fs.existsSync(at(sidecar, name, 'package.json')), `${name} 缺包清单`);
  }
  for (const file of [
    path.join('better-sqlite3', 'lib', 'index.js'),
    path.join('better-sqlite3', 'lib', 'database.js'),
    NATIVE, 'better-sqlite3/LICENSE', 'bindings/bindings.js',
    'bindings/LICENSE.md', 'file-uri-to-path/index.js', 'file-uri-to-path/LICENSE',
  ]) assert.ok(fs.existsSync(at(sidecar, file)), `运行期文件缺失：${file}`);
  for (const file of [
    'better-sqlite3/README.md', path.join('better-sqlite3', 'src', 'foo.cpp'),
    path.join('better-sqlite3', 'deps', 'sqlite3.c'),
  ]) assert.equal(fs.existsSync(at(sidecar, file)), false, `不该进包：${file}`);
  assert.ok(result.files.length >= 10);
  assert.ok(result.files.every(rel => !rel.includes('..')));
});

test('缺 .node 二进制直接中止装配，不产半成品', t => {
  const {libraryProject, sidecar, modules} = makeFixture(t);
  fs.rmSync(path.join(modules, NATIVE));
  assert.throws(() => assembleSqliteNative({libraryProject, sidecar}), /原生模块没编译成功/);
  assert.equal(fs.existsSync(at(sidecar, 'better-sqlite3')), false);
});

test('闭包里冒出未声明的依赖时报错，避免装完才发现合集是灰的', t => {
  const {libraryProject, sidecar, modules, manifest} = makeFixture(t);
  manifest('better-sqlite3', '99.0.0', {bindings: '^1.5.0', 'brand-new-loader': '1.0.0'}, 'lib/index.js');
  assert.throws(() => validateDependencyClosure(modules), /brand-new-loader/);
  assert.throws(() => assembleSqliteNative({libraryProject, sidecar}), /brand-new-loader/);
  assert.ok(PACKAGE_LAYOUT['better-sqlite3'], '清单和布局必须成对维护');
});

test('重复装配会清掉旧 ABI 残留，但不误删别的包', t => {
  const {libraryProject, sidecar} = makeFixture(t);
  const stale = at(sidecar, 'better-sqlite3', 'build', 'Release', 'old-abi.node');
  const other = at(sidecar, 'another-package', 'index.js');
  for (const file of [stale, other]) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, 'x');
  }
  assembleSqliteNative({libraryProject, sidecar});
  assert.equal(fs.existsSync(stale), false, '旧二进制必须清掉');
  assert.ok(fs.existsSync(other), '只清自己负责的包目录');
  assert.equal(assembleSqliteNative({libraryProject, sidecar}).files.length > 0, true);
});

/**
 * 运行期闭包 = 从 library-db.mjs 出发，本地相对 import 走到的全部文件。
 * 之前这里是手写清单，每加一个模块就要记得补，漏了就只有在装配后才炸；
 * 改成走一遍 import 图，让清单自己长出来 —— 这类漂移不该靠人记。
 */
function runtimeClosure(entry = path.join('server', 'library-db.mjs')) {
  const seen = new Set();
  const walk = rel => {
    const key = rel.split(path.sep).join('/');
    if (seen.has(key)) return;
    seen.add(key);
    const code = fs.readFileSync(path.join(root, key), 'utf8');
    for (const match of code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(key), match[1]));
      const file = /\.(mjs|js|cjs|json)$/.test(target) ? target : `${target}.mjs`;
      if (fs.existsSync(path.join(root, file))) walk(file);
    }
  };
  walk(entry);
  return [...seen];
}

const realBinary = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
test('真机冒烟：用宿主 Node 从装配目录加载真实 addon，迁移链 + FTS5 trigram 都过',
  {skip: fs.existsSync(realBinary) ? false : '本机未安装 better-sqlite3 原生模块'}, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-sqlite-smoke-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const sidecar = path.join(dir, 'sidecar');
    // 运行期闭包由 import 图算出：schema 分片、词表种子、零依赖小模块都会被带上，
    // 否则装配后的 sidecar 会在 import 解析阶段就崩 —— 这正是本用例要拦住的问题。
    const closure = runtimeClosure();
    assert.ok(closure.includes('server/library-db.mjs'));
    assert.ok(closure.includes('server/schema/v2-scale.mjs'), 'schema 分片必须进闭包');
    assert.ok(closure.includes('server/library-vocab.seed.mjs'), '词表种子必须进闭包');
    for (const rel of closure) {
      const file = path.join(sidecar, rel);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.copyFileSync(path.join(root, rel), file);
    }
    const result = assembleSqliteNative({libraryProject: root, sidecar, nodeExe: process.execPath});
    assert.match(result.smoke, /SQLITE_OK modules=\d+ migrations=[1-9]/);
    assert.ok(fs.existsSync(at(sidecar, NATIVE)));
    assert.match(smokeSqliteNative({sidecar, nodeExe: process.execPath}), /SQLITE_OK/);
    assert.equal(fs.readdirSync(sidecar).some(name => name.startsWith('.sqlite-smoke-')), false,
      '冒烟临时脚本必须删干净，不能打进安装包');
  });
