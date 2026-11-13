// 查询层的新增筛选语义（颜色 / 数值范围 / 标签排除 / 评分多选 / 收藏三态）。
//
// 单独成文件是为了让 library-query.mjs 守住单文件行数红线，同时保证「跨维 AND、同维 OR、
// 排除模式保留无数据资产」这套规则只有一处实现。SQLite 与内存降级共用本模块，不产生第二套语义。
// 老请求不带新字段时 normalizeFilters 的输出与旧版一致，行为零变化（版本缝）。
import {formatRegistry} from '../src/library/format-registry.js';
import {buildFormatFilter, matchesFormatFilter} from '../src/library/format-filter-selection.js';
import {matchesColorFilter, DEFAULT_COLOR_SIMILARITY} from '../src/library/color-filter.js';
import {matchesNumericRanges, normalizeRanges} from '../src/library/numeric-filter.js';
// probeOfModel 搬到零依赖的 model-probe.mjs：派生层也要用它，不能反过来依赖整个过滤语义链。
import {probeOfModel} from './model-probe.mjs';
export {probeOfModel};
// 标签匹配要走词表：点「木材」必须能筛出「橡木 / 松木」，否则分面只是好看，归不了类。
import {vocab} from './library-vocab.mjs';

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const lower = value => text(value).toLocaleLowerCase();
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const strings = value => (Array.isArray(value) ? value : []).map(text).map(item => item.trim()).filter(Boolean).slice(0, 100);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};


/** 颜色匹配只吃单个代表主色；没采到主色的资产返回 null，交给 NULL 规则。 */
export const colorSampleOf = probe => probe?.hex ? {h: probe.h, s: probe.s, l: probe.l} : null;

function ratingRange(input) {
  if (Array.isArray(input)) return [number(input[0]) || 0, input.length > 1 ? number(input[1]) : 5];
  if (input && typeof input === 'object') return [number(input.min) || 0, input.max === undefined ? 5 : number(input.max)];
  if (input === undefined || input === null || input === '') return [0, 5];
  return [number(input) || 0, 5];
}

const ratingsOf = input => (Array.isArray(input) ? input : []).map(number)
  .map(value => Math.round(value)).filter(value => value >= 0 && value <= 5).slice(0, 6);

export function normalizeFilters(input = {}) {
  const data = object(input);
  const state = ['active', 'trashed', 'all'].includes(data.state) ? data.state : 'active';
  const similarity = Number(data.colorSimilarity);
  const favoriteMode = ['any', 'yes', 'no'].includes(data.favoriteMode) ? data.favoriteMode
    : (data.favorite === true ? 'yes' : 'any');
  return {
    state, rating: ratingRange(data.rating), favorite: data.favorite === true, favoriteMode,
    tags: strings(data.tags), excludeTags: strings(data.excludeTags),
    platforms: strings(data.platforms), kinds: strings(data.kinds),
    categories: strings(data.categories), downloadable: data.downloadable === true,
    uids: strings(data.uids), collection: text(data.collection),
    formats: buildFormatFilter(data.formats ?? [], data.excludeFormats === true),
    // 新维度：全部走「不传就不生效」，老前端 / 智能合集里的旧 payload 完全兼容。
    colors: strings(data.colors), colorSwatches: object(data.colorSwatches),
    colorSimilarity: Number.isFinite(similarity) ? Math.max(0, Math.min(100, Math.round(similarity))) : DEFAULT_COLOR_SIMILARITY,
    excludeColors: data.excludeColors === true,
    ratings: ratingsOf(data.ratings), excludeRating: data.excludeRating === true,
    ranges: normalizeRanges(data.ranges), excludeRanges: data.excludeRanges === true,
  };
}

const anyHit = (values, candidates) => {
  if (!candidates.length) return true;
  const hay = values.map(lower).join(' \u0001 ');
  return candidates.some(candidate => hay.includes(lower(candidate)));
};

/**
 * 标签匹配（比 anyHit 多一层词表展开）：
 *   1. 选中值在词表里 → 展开成「自身 + 全部子孙」，按 canonical 值精确比对。
 *      点「木材」能筛出「橡木 / 松木」；点「石材」能筛出「大理石 / 花岗岩」。
 *   2. 选中值不在词表里（用户自造标签 / 还没归并的新词）→ 退回子串匹配，
 *      保证「不认识的词仍然能筛」—— 归一化不能变成筛选的前置条件。
 * 别名天然生效：资产标签走 entryOf 解析，`wooden` 与 `木材` 落在同一个 norm 上。
 */
function tagHit(values, candidates) {
  if (!candidates.length) return true;
  return candidates.some(candidate => {
    const expanded = vocab.descendantValues(candidate);
    if (!expanded.length) {
      const needle = lower(candidate);
      return values.some(value => lower(value).includes(needle));
    }
    const wanted = new Set(expanded.map(value => vocab.entryOf(value).norm));
    const needle = lower(candidate);
    return values.some(value => {
      const entry = vocab.entryOf(value);
      return entry ? wanted.has(entry.norm) : lower(value).includes(needle);
    });
  });
}

/** collectionUids 由合集服务预先解析；probe 已在 normalizeRows 里派生好。 */
export function matchesFilters(row, filters, collectionUids = null) {
  if (filters.state !== 'all' && row.state !== filters.state) return false;
  if (row.rating < filters.rating[0] || row.rating > filters.rating[1]) return false;
  if (filters.favorite && !row.favorite) return false;
  if (filters.favoriteMode === 'yes' && !row.favorite) return false;
  if (filters.favoriteMode === 'no' && row.favorite) return false;
  if (filters.ratings.length) {
    const hit = filters.ratings.includes(row.rating);
    if (filters.excludeRating ? hit : !hit) return false;
  }
  if (filters.downloadable && row.model.downloadable !== true) return false;
  if (filters.uids.length && !filters.uids.includes(row.uid)) return false;
  if (collectionUids && !collectionUids.has(row.uid)) return false;
  if (!tagHit(row.tags, filters.tags)) return false;
  if (filters.excludeTags.length && tagHit(row.tags, filters.excludeTags)) return false;
  if (!anyHit([row.platform], filters.platforms)) return false;
  if (!anyHit([row.kind], filters.kinds)) return false;
  if (!anyHit(row.categories, filters.categories)) return false;
  if (!matchesFormatFilter(row.formats, filters.formats, formatRegistry)) return false;
  if (!matchesColorFilter(colorSampleOf(row.probe), {
    values: filters.colors, similarity: filters.colorSimilarity,
    swatches: filters.colorSwatches, exclude: filters.excludeColors,
  })) return false;
  if (!matchesNumericRanges(row.probe, filters.ranges, filters.excludeRanges)) return false;
  return true;
}
