// 数值范围协议：方向 / 宽高比 / 分辨率预设、同字段 OR、跨字段 AND、排除与 NULL 规则。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPECT_RATIO_TOLERANCE, ORIENTATION_PRESETS, ASPECT_RATIO_PRESETS, RESOLUTION_PRESETS,
  parseRange, normalizeRanges, aspectRatioPresetRange, rangeFromPreset, numericValue,
  matchesNumericRanges, rangeDetail,
} from '../src/library/numeric-filter.js';

const probe = (width, height, duration = null) => ({width, height, duration});

test('预设常量对齐参考实现：方向 2 项、宽高比 5 项、分辨率 3 项', () => {
  assert.equal(ORIENTATION_PRESETS.length, 2);
  assert.equal(ASPECT_RATIO_PRESETS.length, 5);
  assert.equal(RESOLUTION_PRESETS.length, 3);
  assert.equal(ASPECT_RATIO_TOLERANCE, 0.05);
  const range = aspectRatioPresetRange(16 / 9);
  assert.ok(range.min < 16 / 9 && range.max > 16 / 9);
  assert.equal(rangeFromPreset(ORIENTATION_PRESETS[0]).field, 'aspect');
  assert.equal(rangeFromPreset(ASPECT_RATIO_PRESETS[2]).field, 'aspect');
  assert.equal(rangeFromPreset(RESOLUTION_PRESETS[2]).min, 3200);
});

test('范围解析：对象 / 数组 / 字符串，空侧 = 不限，非法一律丢弃', () => {
  assert.deepEqual(parseRange({min: 1, max: 2}), {min: 1, max: 2});
  assert.deepEqual(parseRange([null, 0.95]), {min: null, max: 0.95});
  assert.deepEqual(parseRange('1000:2000'), {min: 1000, max: 2000});
  assert.equal(parseRange({min: '', max: ''}), null);
  assert.equal(parseRange({min: 5, max: 1}), null);
  assert.deepEqual(normalizeRanges([{field: 'aspect', min: 1.05}, {field: 'nope', min: 1}]),
    [{field: 'aspect', min: 1.05, max: null}]);
  assert.match(rangeDetail({field: 'longEdge', min: 3200, max: null}), /长边像素 ≥ 3200/);
});

test('probe 派生：宽高 / 长边 / 宽高比 / 时长', () => {
  assert.equal(numericValue(probe(2000, 1000), 'aspect'), 2);
  assert.equal(numericValue(probe(1000, 2000), 'longEdge'), 2000);
  assert.equal(numericValue(probe(1000, 2000), 'width'), 1000);
  assert.equal(numericValue(null, 'aspect'), null);
  assert.equal(numericValue(probe(100, 100, 12.5), 'duration'), 12.5);
});

test('同字段 OR、跨字段 AND、排除与无数据保留', () => {
  const wide = probe(2000, 1000), tall = probe(1000, 2000);
  const landscape = {field: 'aspect', min: 1.05, max: null};
  assert.equal(matchesNumericRanges(wide, [landscape]), true);
  assert.equal(matchesNumericRanges(tall, [landscape]), false);
  assert.equal(matchesNumericRanges(tall, [landscape], true), true, '排除时不含横图');
  assert.equal(matchesNumericRanges(null, [landscape]), false);
  assert.equal(matchesNumericRanges(null, [landscape], true), true, '排除保留未采样资产');
  const portrait = {field: 'aspect', min: null, max: 0.95};
  assert.equal(matchesNumericRanges(wide, [landscape, portrait]), true, '同字段多范围应 OR');
  assert.equal(matchesNumericRanges(tall, [portrait]), true);
  const twoFields = [landscape, {field: 'longEdge', min: 3000, max: null}];
  assert.equal(matchesNumericRanges(wide, twoFields), false, '跨字段必须 AND');
  assert.equal(matchesNumericRanges(probe(4000, 1000), twoFields), true);
  assert.equal(matchesNumericRanges(wide, []), true);
});
