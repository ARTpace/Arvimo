// 查询条件下推：把「筛选 + 排序 + 分页」编译成一条 SQL，让 SQLite 只返回当前页的行。
//
// 为什么要有这一层（S2 的核心）：原先是 `SELECT * FROM assets` 全量读上来再逐行 JSON.parse
// 求值。20 万条实测：每次请求光「读行 + 派生」就 5.3 秒，而真正排一页只要 78 毫秒 ——
// 瓶颈不在求值，在把整个库搬进内存。下推之后一次查询只碰 60 行。
//
// 铁律：**能精确等价才下推，不能就如实返回 ok:false**。宁可慢（退回内存路径），
// 也不能出现「SQL 路径比内存路径少几条」—— 那种 bug 用户永远发现不了，但结果就是错的。
// 因此下面每个维度都标注了它与 library-filter-semantics.mjs 的等价依据。
import {parseSearchExpression} from './search-expression.mjs';
import {normalizeFilters} from './library-filter-semantics.mjs';
import {formatRegistry} from '../src/library/format-registry.js';
import {vocab,normOf} from './library-vocab.mjs';
import {NUMERIC_EXPR, searchPredicate} from './query-sql-search.mjs';

/** 参数上限：留足余量给 SQLite 的变量数限制，超了就退回内存而不是冒绑定失败的风险。 */
const MAX_PARAMS = 800;
const MAX_UIDS = 400;

/**
 * 排序规格。tiebreaker 统一用 rowid：JS 的排序是稳定的，输入顺序就是 SELECT * 的 rowid 顺序，
 * 少了这一项，并列行的先后就没人保证了。desc 是「整体反转」，所以每个方向一起反过来。
 */
const SORT_SPECS = Object.freeze({
  recent: [['a.added_at', 'DESC'], ['a.position', 'DESC']],
  oldest: [['a.added_at', 'ASC'], ['a.position', 'ASC']],
  position: [['a.position', 'ASC']],
  rating: [['a.rating', 'DESC'], ['a.added_at', 'DESC'], ['a.position', 'DESC']],
  // 色相缺失排最后（361 是 JS 里的哨兵值），分辨率/体积缺失排最后（JS 用 -1 / 0）。
  color: [['CASE WHEN a.color_h IS NULL THEN 361 ELSE a.color_h END', 'ASC'],
    ['a.added_at', 'DESC'], ['a.position', 'DESC']],
  resolution: [['CASE WHEN a.long_edge IS NULL THEN -1 ELSE a.long_edge END', 'DESC'],
    ['a.added_at', 'DESC'], ['a.position', 'DESC']],
  size: [['CASE WHEN a.bytes IS NULL THEN 0 ELSE a.bytes END', 'DESC'],
    ['a.added_at', 'DESC'], ['a.position', 'DESC']],
});

/** 这些排序依赖 payload 派生值或全量重排，SQL 复现不了（中文 collation / 哈希随机 / 合集手序）。 */
const UNSORTABLE = new Set(['name', 'popular', 'random', 'collection']);

/**
 * 排序索引提示：某些排序键恰好落在覆盖索引里，强制 SQLite 走那条索引，
 * 就能省掉「物化全部命中 uid → 临时 B 树排序」，改成沿索引顺序扫、凑够一页就停。
 *
 * 50 万条实测（标签筛选 + recent 排序）：自然计划 829ms → 强制 204ms（4×），
 * 且返回的 uid 序列与自然计划**逐条一致**（INDEXED BY 只约束用哪个索引，不改 ORDER BY；
 * 索引若满足不了 ORDER BY，SQLite 直接报「no query solution」而不是给出错序结果）。
 *
 * 索引必须满足两条：
 *   ① 首列是 a.state —— WHERE 里恒有 state 等值条件（state='all' 时本提示不适用）；
 *   ② 排序键与索引列同向 —— recent / oldest 都落在 (state, added_at, position) 上，
 *      反向扫描即可（added_at DESC 索引倒着扫就是 ASC）。
 * 评分 / 分辨率 / 体积排序不在表里：它们的排序键要么不在索引中（position 缺失），
 * 要么是 CASE 表达式（索引里根本没有这个值），强制指定只会更慢。
 */
const SORT_INDEX_HINTS = Object.freeze({
  recent: 'assets_cover_state_added_idx',
  oldest: 'assets_cover_state_added_idx',
});

const placeholders = list => list.map(() => '?').join(', ');

/**
 * 数值筛选字段 → assets 的列。
 * 宽高类字段（aspect / longEdge / resolution）同时用到 width 与 height。
 */
const NUMERIC_COLUMN = Object.freeze({
  rating: 'rating', width: 'width', height: 'height', aspect: 'width',
  longEdge: 'height', resolution: 'width', duration: 'duration',
});

/**
 * 检索表达式的字段 → assets 的列。
 * 返回的列名用于判断「这条检索能不能靠统一覆盖索引判定」——
 * 引用了索引之外的列（url / path / metadata）时，COUNT 就不能走那条索引。
 */
const SEARCH_COLUMN = Object.freeze({
  name: 'name', tags: 'tags_text', note: 'note', url: 'url', author: 'author',
  platform: 'platform', format: 'uid',
});

/** 检索表达式引用到的全部列（groups 展开后逐条看）。 */
function searchColumns(parsed) {
  const cols = new Set();
  const all = [];
  if (parsed?.clauses?.length) all.push(...parsed.clauses);
  for (const group of parsed?.groups || []) all.push(...group);
  for (const clause of all) {
    const field = clause?.field;
    if (!field) {
      // 无字段限定的全文检索：name / author / platform / note / tags 全都要读。
      cols.add('name'); cols.add('author'); cols.add('platform'); cols.add('note'); cols.add('tags_text');
      continue;
    }
    if (NUMERIC_COLUMN[field]) {
      // 宽高类字段要用到两列，NUMERIC_COLUMN 只记一列，这里补齐。
      if (field === 'aspect' || field === 'longEdge' || field === 'resolution') {
        cols.add('width'); cols.add('height');
      } else cols.add(NUMERIC_COLUMN[field]);
      continue;
    }
    if (SEARCH_COLUMN[field]) cols.add(SEARCH_COLUMN[field]);
    else cols.add(field); // 不可下推的字段（path / metadata / color）—— 编译阶段就会拒绝
  }
  return [...cols];
}

/**
 * 统一覆盖索引能覆盖的列：COUNT 用它做纯索引扫描。
 * 数值列（宽高 / 时长）与 url 不在其中 —— 一旦引用它们，就不能强制走这条索引。
 */
const COUNT_COVER_COLUMNS = new Set([
  'state', 'uid', 'rating', 'favorite', 'platform', 'kind', 'name', 'author', 'note', 'tags_text',
]);

/**
 * 「值得」用统一覆盖索引的列：只引用 state / uid 的查询（纯标签筛选）
 * 用现成的 (state, uid) 索引就够，不必绕远路。
 */
const COUNT_COVER_WORTH = new Set([
  'rating', 'favorite', 'platform', 'kind', 'name', 'author', 'note', 'tags_text',
]);

/** COUNT 用的统一覆盖索引（见 schema/v4-tag-cover-index.mjs）。 */
const COUNT_INDEX = 'assets_cover_state_fav_rating_kind_platform_text_idx';

export {NUMERIC_EXPR};

/**
 * 标签谓词。与 tagHit 的三分支一一对应：
 *   a) 选中值在词表里 → 展成「自身 + 子孙」的 norm 集合，资产词条 norm 命中即算；
 *   b) 资产词条是 pending（词表里的新词）→ 退回子串，等价于 JS 的「解析不到就 includes」；
 *   c) 选中值本身不在词表 → 全部走子串，等价于 tagHit 的第一个分支。
 * asset_tags.term_id 已经过 resolveTerm 归一，所以这里不会遇到 merged 词条。
 *
 * 写法上必须是**非相关子查询**（a.uid IN (SELECT ...)）而不是 EXISTS：
 * 相关子查询会对每一行资产重新跑一遍 JOIN，20 万条实测 3352ms；
 * 非相关的写法让 SQLite 把子查询结果物化成一张临时索引，探一次就够。
 */
function tagPredicate(candidate, negate = false) {
  const needle = String(candidate).toLocaleLowerCase();
  const expanded = vocab.descendantValues(candidate);
  const join = negate ? 'a.uid NOT IN' : 'a.uid IN';
  // 数据库层级包括用户自定义关系；UNION 去重也能阻止旧脏环无限递归。
  const dynamic=`SELECT at4.uid FROM asset_tags at4 WHERE at4.term_id IN (
    WITH RECURSIVE descendants(id) AS (
      SELECT term_id FROM tag_terms WHERE status<>'merged' AND (norm=? OR term_id IN (SELECT term_id FROM tag_aliases WHERE alias_norm=?))
      UNION SELECT child.term_id FROM tag_terms child JOIN descendants d ON child.parent_id=d.id WHERE child.status<>'merged'
    ) SELECT id FROM descendants)`;
  const dynamicParams=[normOf(candidate),normOf(candidate)];
  if (!expanded.length) {
    // 词表外的词：按原始标签文本做子串（与 tagHit 的字符串分支逐字对齐）
    return {
      sql: `${join} (SELECT uid FROM tags WHERE instr(lower(tag), ?) > 0 UNION ${dynamic})`,
      params: [needle,...dynamicParams],
    };
  }
  const norms = [...new Set(expanded.map(value => vocab.entryOf(value)?.norm).filter(Boolean))];
  if (!norms.length) return {sql: '0', params: []};
  return {
    sql: `${join} (SELECT at3.uid FROM asset_tags at3 JOIN tag_terms t3 ON t3.term_id = at3.term_id
      WHERE (t3.norm IN (${placeholders(norms)})
        OR (t3.status = 'pending' AND instr(lower(t3.value), ?) > 0)) UNION ${dynamic})`,
    params: [...norms, needle,...dynamicParams],
  };
}

/**
 * 一次编译。返回 {ok:true, where, params, orderBy, limit, offset} 或 {ok:false, reason}。
 * reason 只用于诊断输出，不参与业务判断。
 */
export function compileQuery({q = '', filters = {}, sort = 'recent', sortOrder = 'asc',
  limit = 60, offset = 0, collectionUids = null, collectionId = ''} = {}) {
  const fail = reason => ({ok: false, reason});
  const conditions = [];
  const params = [];
  let size = 0;
  /**
   * indexOnly 回答一个问题：「WHERE 里的每条谓词，能否只靠覆盖索引
   * (state, added_at, position, uid) 判定，不必回表？」
   *
   * 能 → 允许强制走排序索引（沿索引顺序扫、凑够一页就停，省掉临时排序）。
   * 不能 → 强制会把「顺序读表」变成「随机读表」，反而更慢：
   *       50 万条实测，文本检索从 1.0s 涨到 5.1s。
   * 所以凡是引用了索引之外的列（rating / favorite / platform / kind / 文本 / 数值区间），
   * 都要标 needsRow。
   */
  let indexOnly = true;
  /**
   * referenced 记录 WHERE 引用了 assets 的哪些列 —— COUNT 要用统一覆盖索引，
   * 必须确认「引用的列全都在那条索引里」，否则会把顺序读表变成随机读表。
   */
  const referenced = new Set();
  const add = (sql, values = [], {needsRow = false, cols = []} = {}) => {
    conditions.push(sql);
    params.push(...values);
    size += values.length;
    if (needsRow) indexOnly = false;
    for (const col of cols) referenced.add(col);
  };

  if (UNSORTABLE.has(sort)) return fail(`排序 ${sort} 依赖派生值或全量重排`);
  const spec = SORT_SPECS[sort] || SORT_SPECS.recent;
  // 未知排序名会落到 recent 的比较器上，索引提示要跟着走同一套键，否则提示会指向不相干的索引。
  const effectiveSort = SORT_SPECS[sort] ? sort : 'recent';
  const normalized = normalizeFilters(filters);

  // —— 基础维度：全部是真列，与 matchesFilters 逐条对应 ——
  if (normalized.state !== 'all') add('a.state = ?', [normalized.state], {cols: ['state']});
  if (normalized.rating[0] > 0) add('a.rating >= ?', [normalized.rating[0]], {needsRow: true, cols: ['rating']});
  if (normalized.rating[1] < 5) add('a.rating <= ?', [normalized.rating[1]], {needsRow: true, cols: ['rating']});
  if (normalized.favorite || normalized.favoriteMode === 'yes') add('a.favorite = 1', [], {needsRow: true, cols: ['favorite']});
  if (normalized.favoriteMode === 'no' && !normalized.favorite) add('a.favorite = 0', [], {needsRow: true, cols: ['favorite']});
  if (normalized.ratings.length) {
    const list = `a.rating IN (${placeholders(normalized.ratings)})`;
    add(normalized.excludeRating ? `COALESCE(${list}, 0) = 0` : list, normalized.ratings, {needsRow: true, cols: ['rating']});
  }
  if (normalized.uids.length) {
    if (normalized.uids.length > MAX_UIDS) return fail('uids 列表过长');
    add(`a.uid IN (${placeholders(normalized.uids)})`, normalized.uids, {cols: ['uid']});
  }
  // downloadable 读 payload.model.downloadable —— V5 起有了 downloadable 列，
  // 等值条件比 json_extract 便宜两个数量级，不再整条退回内存。
  if (normalized.downloadable) add('a.downloadable = 1', [], {needsRow: true, cols: ['downloadable']});

  // 合集：优先用集合（API 已解析），否则用 exists 子查询避开大 IN 列表。
  if (collectionUids) {
    if (collectionUids.size > MAX_UIDS) {
      add(`EXISTS (SELECT 1 FROM collection_assets ca WHERE ca.collection_id = ? AND ca.asset_id = a.uid)`,
        [collectionId], {cols: ['uid']});
    } else if (collectionUids.size) {
      const uids = [...collectionUids];
      add(`a.uid IN (${placeholders(uids)})`, uids, {cols: ['uid']});
    } else add('0');
  }

  // 平台 / 类型：JS 走 anyHit 的子串包含，所以这里也是 instr，不能改成等值。
  // 多选是 **OR**（anyHit 用 some）：选了「sketchfab / artstation」是「命中任一」，不是「同时满足」。
  const anyOf = (values, expr) => {
    if (!values.length) return null;
    const parts = values.map(value => `(instr(lower(COALESCE(${expr}, '')), ?) > 0)`);
    return {sql: `(${parts.join(' OR ')})`, params: values.map(value => value.toLocaleLowerCase())};
  };
  const platformHit = anyOf(normalized.platforms, 'a.platform');
  if (platformHit) add(platformHit.sql, platformHit.params, {needsRow: true, cols: ['platform']});
  const kindHit = anyOf(normalized.kinds, 'a.kind');
  if (kindHit) add(kindHit.sql, kindHit.params, {needsRow: true, cols: ['kind']});
  // categories 的取值是 categories[] ∪ category ∪ assetType ∪ kind（见 categoriesOf）。
  // V5 把它物化成小写拼接的 category_text，于是子串匹配可以下推：
  // 与 anyOf 同样是 **OR**（勾了「家具 / 场景」是命中任一），也同样是 instr 子串，
  // 因为内存路径的 anyHit 就是 contains，改成等值会让「选了 terrain 却漏掉 ground terrain」。
  const categoryHit = anyOf(normalized.categories, 'a.category_text');
  if (categoryHit) add(categoryHit.sql, categoryHit.params, {needsRow: true, cols: ['category_text']});

  // —— 标签：见 tagPredicate 的三分支说明 ——
  // 多选同样是 **OR**（tagHit 用 some）：勾了「木材 / 写实」是命中任一，不是同时具备。
  if (normalized.tags.length) {
    const parts = [];
    const values = [];
    for (const value of normalized.tags) {
      const hit = tagPredicate(value);
      parts.push(`(${hit.sql})`);
      values.push(...hit.params);
    }
    add(`(${parts.join(' OR ')})`, values, {cols: ['uid']});
  }
  for (const value of normalized.excludeTags) {
    const hit = tagPredicate(value, true);
    // tagHit 是 some()：任一排除词命中就整条排除。uid 与子查询里的 uid 都非空，
    // 所以 NOT IN 与「取反后的 IN」完全等价（不会出现 NULL 语义陷阱）。
    add(hit.sql, hit.params, {cols: ['uid']});
  }

  // —— 格式：asset_formats 一行一个后缀；unknown 是「没有任何已知后缀」的反集 ——
  const formatFilter = normalized.formats;
  if (formatFilter?.active) {
    const exts = [...formatFilter.set];
    const hasSelected = exts.length
      ? `a.uid IN (SELECT uid FROM asset_formats WHERE ext IN (${placeholders(exts)}))`
      : '0';
    let hitSql = hasSelected;
    let hitParams = exts;
    if (formatFilter.unknown) {
      const known = [...formatRegistry.knownExts];
      hitSql = `(${hasSelected} OR a.uid NOT IN (SELECT uid FROM asset_formats WHERE ext IN (${placeholders(known)})))`;
      hitParams = [...exts, ...known];
    }
    add(formatFilter.exclude ? `NOT (${hitSql})` : hitSql, hitParams, {cols: ['uid']});
  }

  // 颜色是 HSL 距离 + 自定义色，窗口计算在 color-filter.js 里，SQL 复现必然出错。
  if (normalized.colors.length || Object.keys(normalized.colorSwatches || {}).length || normalized.excludeColors) {
    return fail('颜色筛选走 HSL 距离计算');
  }

  // —— 数值范围：同字段 OR、跨字段 AND、exclude 整体取反（与 matchesNumericRanges 一致）——
  if (normalized.ranges.length) {
    const byField = new Map();
    for (const range of normalized.ranges) {
      if (!byField.has(range.field)) byField.set(range.field, []);
      byField.get(range.field).push(range);
    }
    const parts = [];
    for (const [field, group] of byField) {
      const expr = NUMERIC_EXPR[field];
      if (!expr) return fail(`数值字段 ${field} 没有列`);
      const ors = group.map(range => {
        const bounds = [];
        const values = [];
        if (range.min !== null) { bounds.push(`${expr} >= ?`); values.push(range.min); }
        if (range.max !== null) { bounds.push(`${expr} <= ?`); values.push(range.max); }
        params.push(...values); size += values.length;
        return `(${bounds.join(' AND ')})`;
      });
      parts.push(`(${ors.join(' OR ')})`);
    }
    const hitSql = `(${parts.join(' AND ')})`;
    conditions.push(normalized.excludeRanges ? `COALESCE(${hitSql}, 0) = 0` : hitSql);
    indexOnly = false;
    // 数值列（宽高 / 体积 / 时长 / 色相）不在统一覆盖索引里 → COUNT 不能用那条索引。
    for (const field of byField.keys()) referenced.add(NUMERIC_COLUMN[field] || field);
  }

  // —— 检索表达式 ——
  const parsed = parseSearchExpression(q);
  if ((parsed.clauses || []).length || (parsed.groups || []).length) {
    const search = searchPredicate(parsed);
    if (!search) return fail('检索表达式含不可下推字段（category / path / color / metadata）');
    // 文本检索一律要回表：命中条件是 instr(lower(列), ?)，列不在排序索引里。
    add(search.sql, search.params, {needsRow: true});
    for (const col of searchColumns(parsed)) referenced.add(col);
  }

  if (size > MAX_PARAMS) return fail(`参数过多（${size}）`);

  const desc = sortOrder === 'desc';
  const orderBy = [
    ...spec.map(([expr, dir]) => `${expr} ${desc ? (dir === 'ASC' ? 'DESC' : 'ASC') : dir}`),
    // 稳定排序的替身：非 desc 保持 rowid 升序，desc 整体反转后即 rowid 降序。
    `a.rowid ${desc ? 'DESC' : 'ASC'}`,
  ].join(', ');

  // COUNT 用的覆盖索引：引用的列全在索引里、且至少有一列「值得」用它，才给提示。
  const cols = [...referenced];
  const countIndexHint = (normalized.state !== 'all'
    && cols.length
    && cols.every(col => COUNT_COVER_COLUMNS.has(col))
    && cols.some(col => COUNT_COVER_WORTH.has(col))) ? COUNT_INDEX : '';

  return {
    ok: true,
    where: conditions.length ? conditions.join(' AND ') : '1',
    params,
    orderBy,
    // 排序索引提示：只有 state 被等值约束、且所有谓词都能靠索引判定时才给。
    // 后者是关键：一旦有谓词要回表，强制走索引就把顺序读表变成了随机读表。
    indexHint: (normalized.state !== 'all' && indexOnly) ? (SORT_INDEX_HINTS[effectiveSort] || '') : '',
    // COUNT 索引提示：与上面相反 —— 它要的是「不回表」，所以谓词可以多，
    // 但引用的列必须在索引里。
    countIndexHint,
    limit: Math.max(1, Math.min(500, Math.round(Number(limit)) || 60)),
    offset: Math.max(0, Math.round(Number(offset)) || 0),
  };
}
