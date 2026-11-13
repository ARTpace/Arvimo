// 颜色筛选协议：HSL 转换、环形色相、相似度窗口、多色 OR / 排除 / NULL 规则、偏好持久化。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_PRESETS, DEFAULT_COLOR_SIMILARITY, MAX_CUSTOM_FILTER_COLORS,
  hexToHsl, hslToHex, hueDelta, colorMatchWindows, parseColorFilterValues,
  sampleMatchesTarget, matchesColorFilter, colorFilterSummary,
  loadColorPreferences, saveColorPreferences, withCustomColorAdded, withCustomColorRemoved,
} from '../src/library/color-filter.js';

const memory = () => {
  const map = new Map();
  return {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map};
};

test('色卡预设与 HSL 值域：10 个预设，红蓝黑白色相正确', () => {
  assert.equal(COLOR_PRESETS.length, 10);
  assert.equal(COLOR_PRESETS.filter(item => item.kind === 'neutral').length, 2);
  assert.equal(Math.round(hexToHsl('#FF0000').h), 0);
  assert.equal(Math.round(hexToHsl('#0000FF').h), 240);
  assert.equal(hexToHsl('#000000').s, 0);
  assert.equal(hslToHex(0, 1, 0.5), '#FF0000');
  assert.equal(hueDelta(359, 1), 2, '色相必须按环形取小弧');
  assert.equal(hueDelta(0, 180), 180);
});

test('相似度越高窗口越紧；中性色走亮度分支而非色相分支', () => {
  const loose = colorMatchWindows(0), tight = colorMatchWindows(100);
  assert.ok(loose.hueSpan > tight.hueSpan && loose.lightDelta > tight.lightDelta);
  const red = parseColorFilterValues(['red'])[0];
  const black = parseColorFilterValues(['black'])[0];
  const gray = {h: 0, s: 0, l: 0.06};
  assert.equal(sampleMatchesTarget(red, red, colorMatchWindows(30)), true);
  assert.equal(sampleMatchesTarget({h: 200, s: 0.8, l: 0.5}, red, colorMatchWindows(90)), false);
  assert.equal(sampleMatchesTarget(gray, black, colorMatchWindows(30)), true, '低饱和黑灰应命中黑色卡');
  assert.equal(sampleMatchesTarget(gray, red, colorMatchWindows(30)), false, '灰度图不该误命中红');
});

test('协议入口：多色 OR、排除、无采样数据的 NULL 规则、坏值容错', () => {
  const blue = {h: 217, s: 0.83, l: 0.6};
  assert.equal(matchesColorFilter(blue, {values: ['red', 'blue'], similarity: 70}), true);
  assert.equal(matchesColorFilter(blue, {values: ['red'], similarity: 70}), false);
  assert.equal(matchesColorFilter(blue, {values: ['blue'], exclude: true}), false);
  assert.equal(matchesColorFilter(null, {values: ['blue']}), false, '包含模式不命中未采样资产');
  assert.equal(matchesColorFilter(null, {values: ['blue'], exclude: true}), true, '排除模式保留未采样资产');
  assert.equal(matchesColorFilter(blue, {values: []}), true);
  assert.equal(matchesColorFilter(blue, {values: ['不存在', '#GGGGGG']}), true, '坏值被丢弃等于没筛选');
  const custom = parseColorFilterValues(['#3B82F6']);
  assert.equal(custom[0].hex, '#3B82F6');
  assert.match(colorFilterSummary(['red', 'blue'], 40), /相似度 40%/);
});

test('偏好持久化：自定义色去重截断、相似度钳制、坏存档自愈', () => {
  const storage = memory();
  const base = loadColorPreferences(null);
  assert.equal(base.similarity, DEFAULT_COLOR_SIMILARITY);
  const added = withCustomColorAdded(base, '#aabbcc');
  assert.deepEqual(added.customColors, ['#AABBCC']);
  assert.equal(withCustomColorRemoved(added, '#AABBCC').customColors.length, 0);
  const many = withCustomColorAdded({...base, customColors: Array.from({length: 20}, (_, i) => `#${i.toString(16).padStart(6, '0')}`)}, '#abcdef');
  assert.equal(many.customColors.length, MAX_CUSTOM_FILTER_COLORS);
  saveColorPreferences(storage, {customColors: ['#112233'], similarity: 250});
  const loaded = loadColorPreferences(storage);
  assert.equal(loaded.similarity, 100);
  assert.deepEqual(loaded.customColors, ['#112233']);
  storage.setItem('sfx-color-filter-prefs-v1', '{bad');
  assert.equal(loadColorPreferences(storage).similarity, DEFAULT_COLOR_SIMILARITY);
  assert.doesNotThrow(() => saveColorPreferences({setItem() { throw Error('quota'); }}, base));
});
