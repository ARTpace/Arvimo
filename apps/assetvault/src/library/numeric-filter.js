// 数值范围筛选协议（前后端共用，纯函数）。
//
// 预设常量与容差移植自 Serpent src/renderer/filter-presets.ts（MIT）：方向用比值区间、
// 宽高比用 ±5% 容差、分辨率按长边分 1K/2K/4K 桶。协议统一为
//   ranges: [{field, min, max}] —— 同字段多范围 OR、跨字段 AND、exclude 整体取反。
// 值全部来自缩略图探测缓存 probe（width/height/duration），没有探测数据的资产走 NULL 规则。

export const ASPECT_RATIO_TOLERANCE = 0.05;
export const NUMERIC_FIELDS = Object.freeze(['aspect', 'longEdge', 'width', 'height', 'duration']);

export const ORIENTATION_PRESETS = Object.freeze([
  {id: 'landscape', label: '横图', field: 'aspect', min: 1.05, max: null},
  {id: 'portrait', label: '竖图', field: 'aspect', min: null, max: 0.95},
].map(Object.freeze));

export const ASPECT_RATIO_PRESETS = Object.freeze([
  {id: '16:9', label: '16:9', ratio: 16 / 9},
  {id: '4:3', label: '4:3', ratio: 4 / 3},
  {id: '1:1', label: '1:1', ratio: 1},
  {id: '3:4', label: '3:4', ratio: 3 / 4},
  {id: '9:16', label: '9:16', ratio: 9 / 16},
].map(Object.freeze));

export const RESOLUTION_PRESETS = Object.freeze([
  {id: '1k', label: '1K 及以下', field: 'longEdge', min: null, max: 2239},
  {id: '2k', label: '2K', field: 'longEdge', min: 2240, max: 3199},
  {id: '4k', label: '4K 及以上', field: 'longEdge', min: 3200, max: null},
].map(Object.freeze));

export const NUMERIC_FIELD_LABELS = Object.freeze({
  aspect: '宽高比', longEdge: '长边像素', width: '宽度像素', height: '高度像素', duration: '时长（秒）',
});

const number = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const bound = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return number(value);
};

/** 接受 {min,max} / [min,max] / 'min:max'，空侧 = 不限。非法一律返回 null，不进查询。 */
export function parseRange(input) {
  if (Array.isArray(input)) return normalizeRange({min: input[0], max: input[1]});
  if (typeof input === 'string' || typeof input === 'number') {
    const [min, max] = String(input).split(':');
    return normalizeRange({min, max: max === undefined ? min : max});
  }
  if (input && typeof input === 'object') return normalizeRange(input);
  return null;
}

export function normalizeRange({min, max} = {}) {
  const lo = bound(min, null), hi = bound(max, null);
  if (lo === null && hi === null) return null;
  if (lo !== null && hi !== null && lo > hi) return null;
  return {min: lo, max: hi};
}

/** 协议入口：只收白名单字段，最多 32 段范围，脏数据静默丢弃。 */
export function normalizeRanges(values = []) {
  const list = Array.isArray(values) ? values : [];
  const ranges = [];
  for (const item of list.slice(0, 32)) {
    if (!item || typeof item !== 'object') continue;
    const field = String(item.field || '').trim();
    if (!NUMERIC_FIELDS.includes(field)) continue;
    const range = normalizeRange(item);
    if (range) ranges.push({field, ...range});
  }
  return ranges;
}

export function aspectRatioPresetRange(ratio) {
  const value = number(ratio);
  if (!value || value <= 0) return null;
  return normalizeRange({min: (value * (1 - ASPECT_RATIO_TOLERANCE)).toFixed(3),
    max: (value * (1 + ASPECT_RATIO_TOLERANCE)).toFixed(3)});
}

/** 预设 → 可直接塞进 filters.ranges 的一段范围。 */
export function rangeFromPreset(preset) {
  if (!preset) return null;
  const range = preset.field ? normalizeRange(preset) : aspectRatioPresetRange(preset.ratio);
  return range ? {field: preset.field || 'aspect', ...range} : null;
}

/** probe（封面探测缓存）→ 某个数值字段；没有数据返回 null，交给 NULL 规则处理。 */
export function numericValue(probe, field) {
  if (!probe || typeof probe !== 'object') return null;
  const width = number(probe.width), height = number(probe.height);
  const hasPixels = width !== null && height !== null && width > 0 && height > 0;
  switch (field) {
    case 'width': return hasPixels ? width : null;
    case 'height': return hasPixels ? height : null;
    case 'longEdge': return hasPixels ? Math.max(width, height) : null;
    case 'aspect': return hasPixels ? width / height : null;
    case 'duration': {
      const value = number(probe.duration);
      return value !== null && value > 0 ? value : null;
    }
    default: return null;
  }
}

const inRange = (value, range) => value !== null
  && (range.min === null || value >= range.min)
  && (range.max === null || value <= range.max);

/**
 * 同字段 OR、跨字段 AND。exclude 时整体取反，且「无探测数据」的资产保留
 * （与 Serpent 的数值 clause 一致：NOT ... OR column IS NULL）。
 */
export function matchesNumericRanges(probe, ranges = [], exclude = false) {
  const list = normalizeRanges(ranges);
  if (!list.length) return true;
  const byField = new Map();
  for (const range of list) {
    if (!byField.has(range.field)) byField.set(range.field, []);
    byField.get(range.field).push(range);
  }
  let hit = true;
  for (const [field, group] of byField) {
    const value = numericValue(probe, field);
    if (!group.some(range => inRange(value, range))) { hit = false; break; }
  }
  return exclude ? !hit : hit;
}

export function rangeDetail(range) {
  const label = NUMERIC_FIELD_LABELS[range.field] || range.field;
  const format = value => value === null ? '' : (Math.abs(value) < 10 ? Number(value.toFixed(3)) : Math.round(value));
  if (range.min === null) return `${label} ≤ ${format(range.max)}`;
  if (range.max === null) return `${label} ≥ ${format(range.min)}`;
  return `${label} ${format(range.min)}–${format(range.max)}`;
}
