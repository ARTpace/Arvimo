import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assembleLibraryStyles, cardStyleFiles} from '../scripts/lib/library-styles.mjs';

function fixture(t, app, files = {}) {
  const path = mkdtempSync(join(tmpdir(), 'av-card-styles-'));
  t.after(() => rmSync(path, {recursive:true, force:true}));
  mkdirSync(join(path, 'cards'));
  writeFileSync(join(path, 'app.css'), app);
  for (const name of cardStyleFiles) writeFileSync(join(path, 'cards', `${name}.css`), files[name] || '');
  return pathToFileURL(path + '/');
}

test('按占位位置展开，保留跨文件覆盖顺序和响应式作用域', t => {
  const root = fixture(t, '.a{color:red}@media(max-width:500px){/* @card-style board-card/base */}.a{color:blue}/* @card-style asset-card/custom */', {
    'board-card':'/* @section base */\n.a{width:200px}/* @endsection */',
    'asset-card':'/* @section custom */\n.a{color:green}/* @endsection */',
  });
  assert.equal(assembleLibraryStyles(root), '.a{color:red}@media(max-width:500px){.a{width:200px}}.a{color:blue}.a{color:green}');
});

test('缺少段落或存在未引用段落时中止构建，避免静默丢样式', t => {
  assert.throws(() => assembleLibraryStyles(fixture(t, '/* @card-style board-card/missing */')), /缺少/);
  assert.throws(() => assembleLibraryStyles(fixture(t, '', {'board-card':'/* @section unused */\n.x{}/* @endsection */'})), /未引用/);
});

test('重复段落和重复引用都会被拒绝', t => {
  const block = '/* @section base */\n.x{}/* @endsection */';
  assert.throws(() => assembleLibraryStyles(fixture(t, '', {'board-card':block + block})), /重复卡片样式段/);
  assert.throws(() => assembleLibraryStyles(fixture(t, '/* @card-style board-card/base *//* @card-style board-card/base */', {'board-card':block})), /重复引用/);
});

test('真实项目四类卡片样式完整，所有占位均展开', () => {
  const css = assembleLibraryStyles();
  for (const selector of ['.model-card{', '.pkg-collage{', '.album-folder-stack{', '.bd-card{']) assert.ok(css.includes(selector), selector);
  assert.doesNotMatch(css, /\/\* @card-style /);
});
