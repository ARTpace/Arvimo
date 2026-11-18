// 资产库查询层：把「搜索语法 + 多维过滤 + 排序 + 分页」做成一组纯函数。
//
// 设计取舍（重要）：语义只在这一处实现，SQLite 与内存降级共用同一份求值逻辑。
//   - 有 DB：从规范化表读行（server/library-db.mjs 的 all()），tags 表聚合成三层标签；
//   - 没 DB：直接把前端 blob 交给 library-blob.mjs 的 derive* 生成**同形**的行。
// 两条路径产出同样的 row，因此换引擎不会改变搜索结果 —— 桌面版 sidecar 没带原生依赖时
// 高级检索照样可用，只是 engine 字段从 'sqlite' 变成 'memory'。
// FTS5 trigram 索引（阶段 1 已建）留给阶段 3 做候选集加速，此处不引入第二套语义。
import {parseSearchExpression} from './search-expression.mjs';
import {deriveAssetRows, deriveTagRows, mergeDomains} from './library-blob.mjs';
// 格式注册表与筛选协议是前后端共用的纯 JS：SQLite 行、内存派生行、前端本地文件网格同一套语义。
import {formatsOfModel, formatRegistry} from '../src/library/format-registry.js';
import {numericValue} from '../src/library/numeric-filter.js';
import {COLOR_PRESETS, parseColorFilterValues, sampleMatchesTarget, colorMatchWindows} from '../src/library/color-filter.js';
// 新增维度的过滤语义单独成文件：library-query.mjs 只保留行派生 / 检索表达式 / 排序 / 分页。
import {normalizeFilters, matchesFilters, probeOfModel} from './library-filter-semantics.mjs';
// 类型归一与派生层（library-blob.mjs）共用同一份实现，避免两处判断漂移。
import {kindOf} from './asset-kind.mjs';
// 标签检索文本由词表决定：原始值 ∪ 标准名 ∪ 别名。SQL 下推路径拼的是同一个字符串，
// 两边不一致就会出现「同一个查询在一边命中、另一边落空」。
import {vocab} from './library-vocab.mjs';
export {normalizeFilters, matchesFilters, probeOfModel} from './library-filter-semantics.mjs';

export const SORTS = Object.freeze(['recent', 'oldest', 'name', 'rating', 'popular', 'position',
  'collection', 'random', 'color', 'resolution', 'size']);
export const DEFAULT_QUERY = Object.freeze({q: '', sort: 'recent', limit: 60, offset: 0});

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const lower = value => text(value).toLocaleLowerCase();
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const strings = value => (Array.isArray(value) ? value : []).map(text).map(item => item.trim()).filter(Boolean).slice(0, 100);

function categoriesOf(model) {
  const values = [
    ...(Array.isArray(model.categories) ? model.categories : []),
    model.category, model.assetType, kindOf(model),
  ];
  return [...new Set(values.map(item => typeof item === 'string' ? item.trim() : text(item?.name || item?.label)).filter(Boolean))];
}

/** DB 行 / blob 派生行 → 统一查询行。payload 里保留完整 model，供字段检索与后续扩展取用。 */
export function normalizeRows(assetRows = [], tagRows = []) {
  const byUid = new Map();
  for (const row of tagRows) {
    if (!row?.uid) continue;
    const entry = byUid.get(row.uid) || {all: [], kinds: {platform: [], ai: [], user: []}};
    const tag = text(row.tag);
    if (!tag) continue;
    entry.all.push(tag);
    if (entry.kinds[row.kind]) entry.kinds[row.kind].push(tag);
    byUid.set(row.uid, entry);
  }
  return (Array.isArray(assetRows) ? assetRows : []).map(row => {
    let model = {};
    try { model = JSON.parse(row.payload); } catch { /* 坏行不能拖垮整库查询 */ }
    if (!model || typeof model !== 'object') model = {};
    const tags = byUid.get(row.uid) || {all: [], kinds: {platform: [], ai: [], user: []}};
    const formats = formatsOfModel(model);
    const allTags = [...new Set([...tags.all, ...(Array.isArray(model.tags) ? model.tags.map(text) : [])])];
    return {
      uid: text(row.uid), name: text(row.name), author: text(row.author),
      url: text(row.url), platform: text(row.platform), thumbnail: text(row.thumbnail),
      rating: number(row.rating), note: text(row.note), favorite: !!row.favorite,
      state: row.state === 'trashed' ? 'trashed' : 'active',
      position: number(row.position), added_at: number(row.added_at), trashed_at: number(row.trashed_at),
      tags: allTags,
      // 检索文本 ≠ 展示标签：展示只给用户当初打的字，检索额外带上词表标准名与别名。
      // 排序规则与 SQL 侧一致（码点序），保证两条路径拼出的字符串逐字节相同。
      searchTags: vocab.searchValues(allTags),
      tagKinds: tags.kinds, categories: categoriesOf(model), kind: kindOf(model), model,
      // 从 payload 派生，不动 SQLite schema：DB 与内存降级两条路径天然同形。
      formats,
      formatGroups: [...new Set(formats.map(ext => formatRegistry.get(ext)?.group).filter(Boolean))],
      // 封面探测缓存（颜色 / 宽高 / 时长）也在这里统一派生，查询层不关心它来自 blob 还是 DB。
      probe: probeOfModel(model),
    };
  }).filter(row => row.uid);
}

/** 内存降级入口：只认前端持久化的那份 blob，与 DB 派生索引共用 derive*。 */
export function rowsFromState(values = {}, now = Date.now()) {
  // 内存降级路径也要看全三域：派生表在 DB 模式下看到的是合并后的 state，
  // 降级路径只看主 blob 的话，两条路径会给出不同的筛选结果。
  const data = mergeDomains(values);
  return normalizeRows(deriveAssetRows(data, now), deriveTagRows(data));
}

/** 字段别名 → 该行对应文本。null 字段 = 全字段（名称/作者/平台/备注/标签）。 */
export function fieldText(row, field) {
  // 标签检索文本：原始值 ∪ 标准名 ∪ 别名。row.searchTags 由词表算出，
  // SQL 下推侧拼的是同一个字符串（query-sql-search.mjs 的 TAGS_TEXT）。
  const tagText = (row.searchTags || row.tags || []).join(' ');
  switch (field) {
    case 'name': return row.name;
    case 'tags': return tagText;
    case 'note': return row.note;
    case 'url': return row.url;
    case 'author': return row.author;
    case 'platform': return row.platform;
    case 'category': return [...row.categories, row.kind].join(' ');
    case 'format': return [...(row.formats || []), ...(row.formatGroups || [])].join(' ');
    case 'rating': return String(row.rating);
    case 'color': {
      if (!row.probe?.hex) return '';
      const sample = {h: row.probe.h, s: row.probe.s, l: row.probe.l};
      const windows = colorMatchWindows();
      const names = COLOR_TARGETS.filter(target => sampleMatchesTarget(sample, target, windows)).map(target => target.id);
      return [row.probe.hex, ...names].join(' ');
    }
    case 'aspect': return String(numericValue(row.probe, 'aspect') ?? '');
    case 'width': return String(numericValue(row.probe, 'width') ?? '');
    case 'height': return String(numericValue(row.probe, 'height') ?? '');
    case 'resolution':
    case 'longEdge': return String(numericValue(row.probe, 'longEdge') ?? '');
    case 'duration': return String(numericValue(row.probe, 'duration') ?? '');
    case 'path': return [row.model.filePath, row.model.root, row.model.rel, row.model.folder].map(text).filter(Boolean).join(' ');
    case 'metadata': return [JSON.stringify(row.model), row.note].join(' ');
    default: return [row.name, row.author, row.platform, row.note, tagText].join(' ');
  }
}

/** 色卡预设 → 可比对目标，模块加载时算一次；color:blue 因此能按色相窗口命中。 */
const COLOR_TARGETS = COLOR_PRESETS.map(item => parseColorFilterValues([item.id])[0]).filter(Boolean);
const NUMERIC_SEARCH_FIELDS = new Set(['rating', 'width', 'height', 'aspect', 'longEdge', 'resolution', 'duration']);

const searchValue = (row, field) => {
  if (field === 'rating') return row.rating;
  if (field === 'resolution') return numericValue(row.probe, 'longEdge');
  return numericValue(row.probe, field);
};

/** rating:>=4 / width:2000-4000 / aspect:1.7 / duration:>10 共用的比较器。 */
function numericHit(row, field, needle) {
  const value = searchValue(row, field);
  if (value === null || value === undefined) return false;
  const range = /^([<>]=?)?(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/.exec(needle);
  if (!range) return false;
  const min = Number(range[2]);
  const ceiling = field === 'rating' ? 5 : Infinity;
  const max = range[3] === undefined
    ? (range[1] ? (range[1].startsWith('<') ? min : ceiling) : ceiling) : Number(range[3]);
  const op = range[1] || '';
  if (op === '<' || op === '<=') return op === '<' ? value < min : value <= min;
  if (op === '>' || op === '>=') return op === '>' ? value > min : value >= min;
  return value >= Math.min(min, max) && value <= Math.max(min, max);
}

function clauseHit(row, clause) {
  const needle = lower(clause.values?.[0]);
  if (!needle) return true;
  // 后缀是离散值，用精确匹配：ext:png 不该命中 .pngx，format:image 命中分组 id。
  if (clause.field === 'format') return (row.formats || []).includes(needle) || (row.formatGroups || []).includes(needle);
  if (NUMERIC_SEARCH_FIELDS.has(clause.field)) return numericHit(row, clause.field, needle);
  return lower(fieldText(row, clause.field)).includes(needle);
}

/** clauses = AND；groups = OR(AND(...))，与 Serpent 的 SearchQuery 契约一致。 */
export function matchesQuery(row, parsed = {clauses: [], groups: []}) {
  const test = clause => clause.exclude ? !clauseHit(row, clause) : clauseHit(row, clause);
  if (parsed.groups?.length) return parsed.groups.some(group => group.every(test));
  return (parsed.clauses || []).every(test);
}

function hash(value) {
  let h = 2166136261;
  for (const char of String(value)) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const bytesOf = model => number(model.bytes ?? model.fileSize ?? model.size);

export function sortRows(rows, sort = 'recent', seed = '', positions = null, order = 'asc') {
  const list = [...rows];
  const byName = (a, b) => a.name.localeCompare(b.name, 'zh');
  const byRecent = (a, b) => b.added_at - a.added_at || b.position - a.position;
  let sorted;
  switch (sort) {
    case 'name': sorted = list.sort(byName); break;
    case 'oldest': sorted = list.sort((a, b) => a.added_at - b.added_at || a.position - b.position); break;
    case 'rating': sorted = list.sort((a, b) => b.rating - a.rating || byRecent(a, b)); break;
    case 'popular': sorted = list.sort((a, b) => number(b.model.likes) - number(a.model.likes) || byRecent(a, b)); break;
    case 'position': sorted = list.sort((a, b) => a.position - b.position); break;
    // 阶段 3：合集手动顺序。position 由 collection_assets 提供，缺位置的资产排后面。
    case 'collection': {
      const rank = row => positions?.get(row.uid) ?? Number.MAX_SAFE_INTEGER;
      sorted = list.sort((a, b) => rank(a) - rank(b) || byRecent(a, b));
      break;
    }
    case 'random': sorted = list.sort((a, b) => hash(a.uid + seed) - hash(b.uid + seed)); break;
    // 新增：依赖封面探测缓存；没采到数据的资产排后面，不假装它有值。
    case 'color': sorted = list.sort((a, b) =>
      (a.probe?.hex ? a.probe.h : 361) - (b.probe?.hex ? b.probe.h : 361) || byRecent(a, b)); break;
    case 'resolution': sorted = list.sort((a, b) =>
      (numericValue(b.probe, 'longEdge') ?? -1) - (numericValue(a.probe, 'longEdge') ?? -1) || byRecent(a, b)); break;
    case 'size': sorted = list.sort((a, b) => bytesOf(b.model) - bytesOf(a.model) || byRecent(a, b)); break;
    default: sorted = list.sort(byRecent);
  }
  // 排序方向是独立维度：reverse 比给每个比较器乘 -1 更不容易破坏「并列回退到最近添加」的次序。
  return order === 'desc' ? sorted.reverse() : sorted;
}

export function toCard(row) {
  // 卡片渲染需要的字段必须一次给全：assetType 决定「材质 / HDRI / 图片 / 模型」与预览分支，
  // url / license 决定点开大图与许可提示。之前只给 uid/name/platform/thumbnail，
  // 服务端分页或画板里的卡片就会退化成「3D ASSET + 打不开预览」。
  return {
    uid: row.uid, name: row.name, author: row.author, platform: row.platform,
    thumbnail: row.thumbnail, rating: row.rating, favorite: row.favorite,
    state: row.state, tags: row.tags, note: row.note, addedAt: row.added_at,
    likes: number(row.model.likes), downloadable: row.model.downloadable === true,
    assetType: text(row.model.assetType) || text(row.kind) || '',
    localRoot: text(row.model.localRoot), localRel: text(row.model.localRel),
    previewUrl: text(row.model.previewUrl),
    typeOverride: row.model.typeOverride || '',
    formatCheck: row.model.formatCheck || null,
    url: text(row.model.url),
    license: text(row.model.license),
    source: text(row.model.source),
    // AI 生成图的提示词/工具（服务端扫描 PNG 文本块回填），前端据此归到「AI生成」子类。
    aiMeta: row.model.aiMeta || null,
  };
}

/**
 * 一次完整查询。rows 由调用方准备（DB 或内存），因此本函数可脱离文件系统单测。
 * 返回 uids 是**全部命中**而非当前页：前端把整个集合注入本地筛选，分页只影响 items。
 */
export function queryAssets({rows = [], q = '', filters = {}, sort = 'recent', limit = 60, offset = 0,
  collectionUids = null, collectionPositions = null, candidateUids = null, seed = '', project = toCard,
  uidScope = 'all', sortOrder = 'asc'} = {}) {
  const parsed = parseSearchExpression(q);
  const normalized = normalizeFilters(filters);
  const safeLimit = Math.max(1, Math.min(500, Math.round(number(limit)) || 60));
  const safeOffset = Math.max(0, Math.round(number(offset)) || 0);
  // FTS5 候选集只是「预筛」：最终仍由下面同一套语义判定，结果必须与不加速时完全一致。
  const scoped = candidateUids ? rows.filter(row => candidateUids.has(row.uid)) : rows;
  const hits = sortRows(scoped.filter(row => matchesFilters(row, normalized, collectionUids) && matchesQuery(row, parsed)),
    sort, seed, collectionPositions, sortOrder === 'desc' ? 'desc' : 'asc');
  const page = hits.slice(safeOffset, safeOffset + safeLimit);
  return {
    total: hits.length, limit: safeLimit, offset: safeOffset,
    items: page.map(project),
    // 默认仍返回全部命中 uid（阶段 2 契约）；阶段 4 的按页取数传 uidScope:'page'，
    // 大库时不再把上万个 uid 一次性传回浏览器，total 仍是完整命中数。
    uids: (uidScope === 'page' ? page : hits).map(row => row.uid),
  };
}
