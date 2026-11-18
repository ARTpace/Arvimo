import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {filterTagEntries, normalizeTagQuery, tagHitLabel} from '../src/library/tag-search.js';

const read = name => readFileSync(new URL(`../src/library/${name}`, import.meta.url), 'utf8');

const entries = [
  ['木纹', 12],
  ['木地板', 5],
  ['Concrete', 30],
  ['来源:local', 88]
];

test('标签搜索：包含匹配且不分大小写，空关键词原样返回', () => {
  // 2026-11-14 用户反馈：标签一多只能滚着找，所以要给标签面板加搜索。
  assert.deepEqual(filterTagEntries(entries, '木').map(row => row[0]), ['木纹', '木地板']);
  assert.deepEqual(filterTagEntries(entries, 'con').map(row => row[0]), ['Concrete']);
  assert.deepEqual(filterTagEntries(entries, '  ').map(row => row[0]), entries.map(row => row[0]));
});

test('标签搜索：关键词里的全角空格与多余空白归一化后仍能命中', () => {
  assert.equal(normalizeTagQuery('  来源\u3000local '), '来源 local');
  assert.deepEqual(filterTagEntries(entries, '来源 local').map(row => row[0]), []);
  assert.deepEqual(filterTagEntries(entries, '来源:').map(row => row[0]), ['来源:local']);
});

test('标签搜索：无结果时命中提示写明 0，且不退回全量', () => {
  assert.deepEqual(filterTagEntries(entries, 'zzz'), []);
  assert.equal(tagHitLabel(0, entries.length, 'zzz'), '无匹配');
});

test('标签搜索：未搜索时不显示命中数字，避免标题行随输入跳动', () => {
  assert.equal(tagHitLabel(entries.length, entries.length, ''), '');
  assert.equal(tagHitLabel(2, entries.length, '木'), `2/${entries.length}`);
});

test('标签面板：输入框与 chips 容器同时存在，输入只重画 chips 不重建输入框', () => {
  const view = read('library-view.js');
  assert.match(view, /id="local-tag-query"/);
  assert.match(view, /data-tag-chips/);
  assert.match(view, /panel\.oninput=event=>\{/);
  // 输入框在重绘时用 state 里的词回填，切 tab 后搜索词不丢
  assert.match(view, /let tagQuery=''/);
  assert.match(view, /value="\$\{esc\(tagQuery\)\}"/);
});

test('标签面板：点标签后重绘侧栏，选中高亮与「已筛选」跟上', () => {
  const view = read('library-view.js');
  const clickBlock = view.slice(view.indexOf('panel.onclick=event=>{')).slice(0, 3000);
  assert.match(clickBlock, /state\.selected\.clear\(\);renderGrid\(\);\s*\n\s*renderLocalFilters\(\);/);
});

test('标签搜索框样式：抽屉和内联侧栏都吃 #library-filters 前缀，不另起一套类名', () => {
  const css = assembleLibraryStyles();
  assert.match(css, /#library-filters \.local-tag-input\{/);
  assert.match(css, /#library-filters \.local-tag-input:focus\{/);
  assert.match(css, /#library-filters \.local-tag-empty\{/);
});
