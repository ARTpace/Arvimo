import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
// 筛选面板 v2 视觉契约：图标注册表、滑条映射、皮肤、控件工厂与「少文字」静态约束。
// 面板涉及真实 DOM，这里用纯函数真值 + 源码静态断言 + 极小假 DOM 三层钉住，不引入 jsdom。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {paths} from '../src/library/icon-set.js';
import {FILTER_DIMENSIONS, ALL_DIMENSIONS, SORT_CHIPS, KIND_CHIPS, FAVORITE_MODES} from '../src/library/filter-dimensions.js';
import {GROUP_META} from '../src/library/format-registry.js';
import {
  PANEL_VISUALS, FORMAT_GROUP_VISUALS, SORT_VISUALS, KIND_VISUALS, FAVORITE_VISUALS,
  ORIENTATION_VISUALS, RESOLUTION_STOPS, FILTER_SKINS, FILTER_SKIN_KEY, readSkin, writeSkin,
  RATING_SLIDER_MAX, sliderToRatings, ratingsToSlider, ratingSliderLabel,
  sliderToResolutionRange, resolutionToSlider, PANEL_TIPS,
} from '../src/library/filter-visuals.js';
import {
  iconButton, iconChip, sliderRow, setSlider, bindSlider, segmented, probeStatusHtml,
} from '../src/library/filter-panel-common.js';
import {RANGE_SCALES} from '../src/library/filter-panel-more.js';

const read = name => fs.readFileSync(new URL(`../src/library/${name}`, import.meta.url), 'utf8');

test('视觉注册表：每个维度 / 分组 / 排序 / 类型 / 收藏态都有真实图标', () => {
  for (const dim of ALL_DIMENSIONS) {
    assert.ok(PANEL_VISUALS[dim.id]?.icon, `${dim.id} 缺图标`);
    assert.ok(paths[PANEL_VISUALS[dim.id].icon], `${dim.id} 图标不在 icon-set.js`);
    assert.ok(PANEL_TIPS[dim.id], `${dim.id} 缺 tooltip 说明`);
  }
  assert.equal(FILTER_DIMENSIONS.length, 9, '九个常驻维度（新增目录 / 来源与分类）');
  for (const group of GROUP_META) assert.ok(paths[FORMAT_GROUP_VISUALS[group.id]?.icon], `格式组 ${group.id} 缺图标`);
  for (const item of SORT_CHIPS) assert.ok(paths[SORT_VISUALS[item.value]?.icon], `排序 ${item.value} 缺图标`);
  for (const item of KIND_CHIPS) assert.ok(paths[KIND_VISUALS[item.value]?.icon], `类型 ${item.value} 缺图标`);
  for (const item of FAVORITE_MODES) assert.ok(paths[FAVORITE_VISUALS[item.value]?.icon], `收藏 ${item.value} 缺图标`);
  assert.equal(ORIENTATION_VISUALS.length, 3, '横 / 方 / 竖');
  assert.equal(RESOLUTION_STOPS.length, 4, '不限 + 1K/2K/4K');
  assert.deepEqual(Object.keys(RANGE_SCALES), ['aspect', 'longEdge', 'width', 'height', 'duration']);
});

test('星级滑条 ↔ 精确评分数组：0 不限、N = ≥N 星、6 = 未评分', () => {
  assert.equal(RATING_SLIDER_MAX, 6);
  assert.deepEqual(sliderToRatings(0), []);
  assert.deepEqual(sliderToRatings(5), ['5']);
  assert.deepEqual(sliderToRatings(4), ['4', '5']);
  assert.deepEqual(sliderToRatings(1), ['1', '2', '3', '4', '5']);
  assert.deepEqual(sliderToRatings(6), ['0']);
  assert.equal(ratingsToSlider([]), 0);
  assert.equal(ratingsToSlider(['4', '5']), 4);
  assert.equal(ratingsToSlider(['0']), 6);
  assert.equal(ratingSliderLabel(0), '不限');
  assert.equal(ratingSliderLabel(3), '≥3★');
  assert.equal(ratingSliderLabel(6), '未评分');
});

test('分辨率滑条 ↔ ranges：只在 longEdge 上替换，不动自定义范围', () => {
  assert.equal(sliderToResolutionRange(0), null);
  const range = sliderToResolutionRange(3);
  assert.equal(range.field, 'longEdge');
  assert.equal(range.min, 3200);
  assert.equal(resolutionToSlider([range]), 3);
  assert.equal(resolutionToSlider([{id: 'custom:aspect:1:2', field: 'aspect', min: 1, max: 2}]), 0);
  assert.equal(resolutionToSlider([]), 0);
});

test('皮肤：坏存档回默认、切换可持久化、非法值不写入', () => {
  const map = new Map();
  const storage = {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value)};
  assert.equal(readSkin(storage), FILTER_SKINS[0]);
  writeSkin(storage, 'violet');
  assert.equal(readSkin(storage), 'violet');
  assert.equal(JSON.parse(map.get(FILTER_SKIN_KEY)).skin, 'violet');
  writeSkin(storage, 'nope');
  assert.equal(JSON.parse(map.get(FILTER_SKIN_KEY)).skin, 'nope', '写入层不拦，读取层兜底');
  assert.equal(readSkin(storage), FILTER_SKINS[0], '非法值退回默认皮肤');
  map.set(FILTER_SKIN_KEY, '{bad');
  assert.equal(readSkin(storage), FILTER_SKINS[0]);
  assert.equal(readSkin(null), FILTER_SKINS[0]);
});

test('控件工厂：零文字图标按钮 / 滑条填充比例 / 分段', () => {
  const button = iconButton({icon: 'ban', title: '排除', active: true, tone: '#fb7185'});
  assert.match(button, /aria-pressed="true"/);
  assert.match(button, /title="排除"/);
  assert.match(button, /--fv-tone:#fb7185/);
  assert.ok(!button.includes('<span>'), '图标按钮默认不带文字');
  const chip = iconChip({value: 'name', icon: 'type', label: '名称', active: true});
  assert.match(chip, /data-value="name"/);
  assert.match(chip, /<span>名称<\/span>/);
  const slider = sliderRow({id: 'x', icon: 'star', min: 0, max: 6, value: 3, display: '≥3★'});
  assert.match(slider, /data-slider="x"/);
  assert.match(slider, /--fd-fill:50%/);
  assert.match(slider, /type="range"/);
  assert.match(segmented([{value: 'a', icon: 'plus'}, {value: 'b', icon: 'minus'}], 'b'), /data-value="b"/);
  assert.match(probeStatusHtml(), /fd-probe-scan/);
  assert.match(probeStatusHtml(), /fv-probe-bar/);
});

test('滑条绑定：拖动即时更新填充与气泡，setSlider 不触发回环', () => {
  const calls = [];
  const input = {min: '0', max: '100', step: '1', value: '0'};
  const out = {textContent: ''};
  const row = {style: {setProperty(key, value) { this[key] = value; }}, querySelector: () => out};
  input.closest = selector => selector === '.fv-slider' ? row : null;
  input.addEventListener = (name, handler) => { calls.push({name, handler}); };
  const host = {querySelector: () => input};
  bindSlider(host, value => calls.push({value}), {format: value => `${value}%`});
  assert.equal(calls.length, 1);
  setSlider(host, 30, {display: '30%'});
  assert.equal(input.value, '30');
  assert.equal(out.textContent, '30%');
  assert.equal(row.style['--fd-fill'], '30%');
  input.value = '70';
  calls[0].handler();
  assert.equal(calls.at(-1).value, 70);
  assert.equal(out.textContent, '70%');
});

test('面板减负：无大段说明、无复选框、无重复标题，参数一律走滑条', () => {
  const panels = ['filter-panel-colors.js', 'filter-panel-shapes.js', 'filter-panel-tags.js',
    'filter-panel-basic.js', 'filter-panel-more.js', 'format-filter.js'];
  for (const name of panels) {
    const source = read(name);
    assert.ok(!source.includes('<p class="fd-hint"'), `${name} 仍有大段说明段落`);
    assert.ok(!source.includes('type="checkbox"'), `${name} 仍有复选框`);
    assert.ok(!source.includes('panelHead('), `${name} 仍有重复面板标题`);
    assert.ok(!source.includes('panelFoot('), `${name} 仍有文字 footer`);
  }
  for (const name of ['filter-panel-colors.js', 'filter-panel-shapes.js', 'filter-panel-tags.js',
    'filter-panel-basic.js', 'filter-panel-more.js', 'format-filter.js'])
    assert.match(read(name), /iconButton\(|iconChip\(|sliderRow\(|segmented\(/, `${name} 没用新控件工厂`);
  for (const name of ['filter-panel-colors.js', 'filter-panel-shapes.js',
    'filter-panel-tags.js', 'filter-panel-basic.js', 'filter-panel-more.js'])
    assert.match(read(name), /sliderRow\(/, `${name} 缺滑条`);
});

test('dock 壳：图标头、清除本维度、皮肤缝、紧凑激活 chips', () => {
  // 抽屉结构模板已拆到 filter-panel-drawer.js，状态编排留在 filter-dock.js；契约跨两个文件。
  const dock = read('filter-dock.js') + read('filter-panel-drawer.js');
  for (const pattern of [/fd-pop-ic/, /fd-pop-reset/, /fd-pop-badge/, /PANEL_TIPS/,
    /readSkin\(storage\)/, /setSkin/, /fd-clear-all/, /iconButton/])
    assert.match(dock, pattern, `dock 缺 ${pattern}`);
  assert.ok(!dock.includes('已启用筛选'), '激活条不再有说明文字');
  const css = assembleLibraryStyles();
  for (const pattern of [/--fd-hi:/, /data-skin="violet"/, /::-webkit-slider-thumb/,
    /\.fv-swatches/, /\.fv-slider/, /--fd-fill/, /\.fv-ratio/, /\.fd-swatch\.is-on/])
    assert.match(css, pattern, `样式缺 ${pattern}`);
});
