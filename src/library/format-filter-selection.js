// 格式筛选的纯函数层：一个逗号字符串就是全部状态，chip 与分组复选框只是它的编辑器。
//
// 语义移植自 Serpent src/renderer/dimension-filter-selection.ts 与
// src/shared/text-media.ts（MIT）：普通点击=只选它 / 再点清空，Shift+点击=OR 累加或移除，
// 分组复选框三态（none/partial/all），`text` 在前端不展开、在查询层展开成 TEXT_EXTS，
// `unknown` 走「不在已知扩展名集合」的反集谓词，`exclude` 对整个命中式取反。
//
// 与 Serpent 的差异（有意为之）：`hdf` 计为已知格式，不会被「其他」误命中；
// 后端不做 SQL LIKE，改为从资产 model 派生扩展名后共用 matchesFormatFilter()，
// 于是 SQLite 与内存降级、服务端查询与前端本地网格四处的语义完全一致。
import {
  formatRegistry, FORMAT_TEXT_TOKEN, FORMAT_UNKNOWN_TOKEN,
  hasUnknownFormat,
} from './format-registry.js';

export const MAX_FORMAT_FILTER_VALUES = 256;

/** 'png, jpg, mp4' / '.PNG，mp4' / ['png','jpg'] → ['png','jpg','mp4']。 */
export function parseFormatTokens(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return raw.split(/[,，;；\s]+/u)
    .map(token => token.trim().toLowerCase().replace(/^\./u, ''))
    .filter(Boolean);
}

/** 去点 / 小写 / 去重；保留 text 与 unknown 不展开，避免前端把 45 个文本后缀塞进请求。 */
export function compactFormatFilterTokens(tokens) {
  return [...new Set(parseFormatTokens(tokens))].slice(0, MAX_FORMAT_FILTER_VALUES);
}

export function formatTokensHas(value, ext) {
  const needle = String(ext ?? '').trim().toLowerCase().replace(/^\./u, '');
  return !!needle && parseFormatTokens(value).includes(needle);
}

/** 普通点击覆盖为唯一值（再点清空）；Shift 点击累加 / 从累加里移除。 */
export function toggleFormatToken(value, ext, shiftKey = false) {
  const token = String(ext ?? '').trim().toLowerCase().replace(/^\./u, '');
  if (!token) return String(value ?? '');
  const tokens = compactFormatFilterTokens(value);
  const exists = tokens.includes(token);
  if (shiftKey) return (exists ? tokens.filter(item => item !== token) : [...tokens, token]).join(', ');
  const isSoleSelection = tokens.length === 1 && exists;
  return isSoleSelection ? '' : token;
}

export function formatGroupSelectionState(value, extensions = []) {
  const group = (Array.isArray(extensions) ? extensions : []).map(item => String(item).toLowerCase());
  if (!group.length) return 'none';
  const selected = group.filter(ext => formatTokensHas(value, ext)).length;
  return selected === 0 ? 'none' : selected === group.length ? 'all' : 'partial';
}

/** 全选时只清本组，未全选时把本组缺的并进来（其它组的选中不动）。 */
export function toggleFormatGroup(value, extensions = []) {
  const tokens = compactFormatFilterTokens(value);
  const group = new Set(compactFormatFilterTokens(extensions));
  if (formatGroupSelectionState(value, [...group]) === 'all') return tokens.filter(token => !group.has(token)).join(', ');
  const next = [...tokens];
  for (const token of group) if (!next.includes(token)) next.push(token);
  return next.slice(0, MAX_FORMAT_FILTER_VALUES).join(', ');
}

export function formatFilterHasUnknownToken(value) {
  return (Array.isArray(value) ? value : parseFormatTokens(value))
    .some(token => String(token).trim().toLowerCase() === FORMAT_UNKNOWN_TOKEN);
}

/** 查询层展开：text → 全部文本后缀；unknown 跳过（由反集谓词处理）；其余原样。 */
export function expandFormatFilterTokens(tokens, registry = formatRegistry) {
  const out = [];
  for (const token of compactFormatFilterTokens(tokens)) {
    if (token === FORMAT_UNKNOWN_TOKEN) continue;
    if (token === FORMAT_TEXT_TOKEN) { out.push(...registry.textExts); continue; }
    out.push(token);
  }
  return [...new Set(out)];
}

/** 归一化成可复用的匹配器。values 可以是数组或逗号字符串。 */
export function buildFormatFilter(values = [], exclude = false, registry = formatRegistry) {
  const exts = expandFormatFilterTokens(values, registry);
  const unknown = formatFilterHasUnknownToken(values);
  return Object.freeze({
    active: exts.length > 0 || unknown,
    exts: Object.freeze(exts),
    set: new Set(exts),
    unknown,
    exclude: exclude === true,
  });
}

/**
 * exts = 该资产的所有扩展名（小写无点）。正向命中 = 选中后缀有交集 或 (unknown 且无已知格式)；
 * 排除模式对整个命中式取反，与 Serpent `NOT (combined)` 一致。
 */
export function matchesFormatFilter(exts, filter, registry = formatRegistry) {
  if (!filter?.active) return true;
  const list = Array.isArray(exts) ? exts : [];
  const hit = list.some(ext => filter.set.has(String(ext).toLowerCase()))
    || (filter.unknown && hasUnknownFormat(list, registry));
  return filter.exclude ? !hit : hit;
}

/** 面板状态提示：把 text / unknown 换成中文标签，排除态加前缀。 */
export function describeFormatFilter(values = [], exclude = false) {
  const tokens = compactFormatFilterTokens(values);
  if (!tokens.length) return '未选择格式';
  const label = token => token === FORMAT_TEXT_TOKEN ? '文本' : token === FORMAT_UNKNOWN_TOKEN ? '其他' : `.${token}`;
  return `${exclude ? '排除 ' : ''}${tokens.slice(0, 4).map(label).join('、')}${tokens.length > 4 ? ` 等 ${tokens.length} 项` : ''}`;
}
