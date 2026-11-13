// 筛选图标条：维度注册表、激活判定、token 协议、持久化与装配契约。
// 面板涉及 DOM，这里用「纯函数真值 + 源码静态断言」两层钉住，避免引入 jsdom 依赖。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {paths} from '../src/library/icon-set.js';
import {
  FILTER_DIMENSIONS, SORT_DIMENSION, ALL_DIMENSIONS, FILTER_DOCK_STORAGE_KEY,
  KIND_CHIPS, SORT_CHIPS, RATING_CHIPS, FAVORITE_MODES, sortLabel, toggleToken, parseTokens,
  dimensionActive, readDockState, writeDockState,
} from '../src/library/filter-dimensions.js';
import {tagCandidates} from '../src/library/filter-panels.js';
import {SORTS} from '../server/library-query.mjs';

const read = name => fs.readFileSync(new URL(`../src/library/${name}`, import.meta.url), 'utf8');
const emptyFilters = () => ({q: '', rating: '', favorite: false, favoriteMode: 'any',
  tags: [], excludeTags: [], kinds: [], ratings: [], formats: [], colors: [], ranges: [],
  sort: 'recent', sortOrder: 'asc', activeCollection: ''});

test('维度清单顺序对齐参考工具栏，10 个维度全部真实可用', () => {
  assert.deepEqual(FILTER_DIMENSIONS.map(item => item.id),
    ['color', 'tags', 'kinds', 'rating', 'favorite', 'format', 'folders', 'source', 'more']);
  assert.equal(SORT_DIMENSION.id, 'sort');
  assert.equal(ALL_DIMENSIONS.length, 10);
  for (const dim of ALL_DIMENSIONS) {
    assert.ok(dim.label && dim.icon && dim.hint, `${dim.id} 元数据不全`);
    assert.ok(dim.ready, `${dim.id} 不该再是待接入维度`);
    assert.ok(paths[dim.icon], `${dim.id} 的图标 ${dim.icon} 不在 icon-set.js 里`);
  }
  assert.deepEqual(FILTER_DIMENSIONS.filter(item => !item.ready).map(item => item.id), []);
});

test('chip 清单与后端白名单同义：排序全集、精确评分、收藏三态', () => {
  assert.deepEqual(KIND_CHIPS.map(item => item.value), ['models', 'textures', 'hdris', 'images', 'packs']);
  assert.deepEqual(SORT_CHIPS.map(item => item.value), SORTS, '前端排序 chip 必须覆盖服务端 SORTS 全集');
  assert.equal(RATING_CHIPS.length, 6, '5 档星级 + 未评分');
  assert.equal(RATING_CHIPS.at(-1).value, '0');
  assert.deepEqual(FAVORITE_MODES.map(item => item.value), ['any', 'yes', 'no']);
  assert.equal(sortLabel('resolution'), '分辨率');
  assert.equal(sortLabel('不存在的排序'), '最近添加');
});

test('token 多选：普通点击只选一个 / 再点清空 / Shift 累加与移除', () => {
  assert.deepEqual(toggleToken([], '石头'), ['石头']);
  assert.deepEqual(toggleToken(['石头'], '石头'), []);
  assert.deepEqual(toggleToken(['石头', '木材'], '金属'), ['金属']);
  assert.deepEqual(toggleToken(['石头'], '木材', true), ['石头', '木材']);
  assert.deepEqual(toggleToken(['石头', '木材'], '木材', true), ['石头']);
  assert.deepEqual(parseTokens('石头, 木材，石头;金属'), ['石头', '木材', '金属']);
  assert.deepEqual(parseTokens([]), []);
});

test('激活态：每个维度独立，颜色 / 尺寸 / 排除 / 排序方向都算激活', () => {
  const base = emptyFilters();
  for (const id of ALL_DIMENSIONS.map(item => item.id)) assert.equal(dimensionActive(id, base), false, `${id} 不该默认激活`);
  assert.equal(dimensionActive('tags', {...base, tags: ['石头']}), true);
  assert.equal(dimensionActive('tags', {...base, excludeTags: ['demo']}), true);
  assert.equal(dimensionActive('kinds', {...base, kinds: ['models']}), true);
  assert.equal(dimensionActive('kinds', {...base, ranges: [{field: 'aspect', min: 1.05, max: null}]}), true);
  assert.equal(dimensionActive('color', {...base, colors: ['red']}), true);
  assert.equal(dimensionActive('rating', {...base, rating: '4'}), true);
  assert.equal(dimensionActive('rating', {...base, ratings: ['5']}), true);
  assert.equal(dimensionActive('favorite', {...base, favorite: true}), true);
  assert.equal(dimensionActive('favorite', {...base, favoriteMode: 'no'}), true);
  assert.equal(dimensionActive('format', {...base, formats: ['png']}), true);
  assert.equal(dimensionActive('sort', {...base, sort: 'name'}), true);
  assert.equal(dimensionActive('sort', {...base, sortOrder: 'desc'}), true);
  assert.equal(dimensionActive('more', {...base, q: 'tag:石头'}), true);
  assert.equal(dimensionActive('more', {...base, activeCollection: 'c1'}), true);
  assert.equal(dimensionActive('color', {...base, tags: ['红']}), false);
});

test('dock 状态持久化：坏存档 / 只读存储 / 非法 id 都不炸', () => {
  const map = new Map();
  const storage = {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
  };
  assert.deepEqual(readDockState(storage), {openId: ''});
  writeDockState(storage, 'format');
  assert.deepEqual(readDockState(storage), {openId: 'format'});
  assert.equal(JSON.parse(map.get(FILTER_DOCK_STORAGE_KEY)).version, 1);
  map.set(FILTER_DOCK_STORAGE_KEY, '{bad json');
  assert.deepEqual(readDockState(storage), {openId: ''});
  map.set(FILTER_DOCK_STORAGE_KEY, JSON.stringify({openId: '不存在的维度'}));
  assert.deepEqual(readDockState(storage), {openId: ''});
  assert.doesNotThrow(() => writeDockState({setItem() { throw Error('quota'); }}, 'tags'));
  assert.deepEqual(readDockState(null), {openId: ''});
});

test('标签候选：我的标签优先，平台与 AI 标签补位，大库只扫前 2000 项', () => {
  const state = {
    models: [{uid: 'a', tags: ['岩石']}, {uid: 'b', tags: ['木材']}],
    userTags: {a: ['石头'], b: ['石头', '草地']},
    aiTags: {a: ['石材']},
  };
  const list = tagCandidates(state);
  assert.equal(list[0], '石头', '我的标签按使用次数加权排最前');
  assert.ok(list.includes('草地') && list.includes('岩石') && list.includes('木材') && list.includes('石材'));
  assert.deepEqual(tagCandidates({models: [], userTags: {}, aiTags: {}}), []);
});

test('装配契约：图标条 → store → 扩展缝 → 高级检索 → 面板全链接通', () => {
  const dock = read('filter-dock.js');
  for (const pattern of [
    /toolbar\.prepend\(dock\)/, /aria-expanded/, /aria-controls="fd-pop"/,
    /pointerdown/, /Escape/, /writeDockState\(storage/, /readDockState\(storage/,
    /registerClearHook/, /setExtraFilters/, /setQueryOptions/, /setOnFormatSync/,
    /activeFilterChips/, /assetvault:probe-progress/, /clearDimension/,
  ]) assert.match(dock, pattern, `图标条缺交互：${pattern}`);
  const state = read('filter-state.js');
  for (const pattern of [/filtersToPayload/, /activeFilterChips/, /clearDimension/, /FILTER_SNAPSHOT_KEY/])
    assert.match(state, pattern, `筛选状态缺 ${pattern}`);
  const panels = read('filter-panels.js');
  for (const id of ['color', 'tags', 'kinds', 'rating', 'favorite', 'format', 'more', 'sort'])
    assert.match(panels, new RegExp(`\\b${id}:\\s*\\w+`), `缺 ${id} 面板分支`);
  assert.match(read('filter-panel-basic.js'), /setDockFormatUI/, 'dock 的格式面板要注册进同步链');
  assert.match(read('filter-panel-colors.js'), /fd-swatch/, '颜色必须是真色卡而非说明页');
  assert.match(read('filter-panel-shapes.js'), /ASPECT_RATIO_PRESETS/, '形状面板要有宽高比预设');
  assert.match(read('filter-panel-tags.js'), /contextmenu/, '标签面板要支持右键排除');
  assert.match(read('filter-panel-more.js'), /fd-collection-smart/, '更多面板要接智能合集');
  const query = read('advanced-query.js');
  for (const pattern of [/\.\.\.extraFilters/, /setDockFormatUI/, /registerClearHook/,
    /state\.sort = sort\.value/, /setQueryOptions/, /listCollections/, /applyCollection/])
    assert.match(query, pattern, `高级检索缺扩展缝：${pattern}`);
  const app = read('app.js');
  assert.match(app, /createFilterDock\(\{/);
  assert.match(app, /controls:query\.controls/);
  assert.match(app, /createAssetProbe/);
});

test('命令条：1440 不折行、图标带悬停短标签、长状态压成「图标 + 数字」', () => {
  // 抽屉的 DOM 模板已拆到 filter-panel-drawer.js；filter-dock.js 只管状态编排。
  const dock = read('filter-dock.js');
  const drawer = read('filter-panel-drawer.js');
  const css = read('app.css');
  const html = read('index.html');
  const app = read('app.js');

  // 1) 短标签是配置表的产物，且不能比图标名字还长（悬停标签只是提示，不是标题）。
  for (const dim of FILTER_DIMENSIONS) {
    assert.ok(dim.short, `${dim.id} 缺 short：悬停标签没有文字可显示`);
    assert.ok([...dim.short].length <= 3, `${dim.id} 的短标签超过 3 字，又回到长文字的老路`);
  }
  // 维度键从命令条的横排改成抽屉里的竖排轨道：抽屉头部已经写着维度全名，
  // 轨道上只留 title 提示（2026-11-12 把九颗图标收进抽屉）。
  assert.match(drawer, /class="fd-rail-btn"/, '维度轨道要有按键');
  assert.match(drawer, /title="\$\{esc\(PANEL_TIPS\[row\.id\] \|\| row\.hint\)\}"/, '轨道键要带 title 提示');
  assert.match(drawer, /<strong>\$\{esc\(dim\.label\)\}<\/strong>/, '抽屉头部要写维度全名');

  // 2) 标签必须绝对定位：宽度展开会推开邻居，正是之前「弹开其他按键」的突兀来源。
  assert.match(css, /\.fd-label,[\s\S]{0,120}position:absolute/, '悬停标签要脱离 flex 流');
  assert.match(css, /:hover \.fd-label/, '要有悬停展开规则');
  assert.match(css, /prefers-reduced-motion|transition:opacity/, '展开只做透明度/位移，不做布局跳动');

  // 3) 1440px 窗口是一行的常态：1480 断点只许 nowrap，折行留给 1180 以下。
  assert.match(css, /@media\(max-width:1480px\)\{[\s\S]{0,600}flex-wrap:nowrap!important/,
    '1440 断点不能再折行');
  assert.match(css, /@media\(max-width:1180px\)\{[\s\S]{0,200}flex-wrap:wrap/,
    '窄屏兜底折行要留在 1180 以下');

  // 4) 动作键用可见短标签替换原来的 .vh 长文字。
  for (const [id, text] of [['local-rescan', '扫描'], ['tag-all', 'AI 标签'], ['tag-manage', '标签']]) {
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]{0,160}class="tb-label">${text}<`), `${id} 缺短标签`);
  }
  assert.match(read('board-hub.js'), /class="tb-label">画板</, '画板入口也要短标签');

  // 5) 磁盘包数只留图标 + 数字，整句进 title（以前一个人独吞 18ch，把动作键全推到右边）。
  assert.match(app, /status\.title=title/, '完整说明要进 title');
  assert.ok(!/status\.textContent=`磁盘上另有/.test(app), '长句不能再当正文渲染');
});
