// 搜索表达式 → SQL 谓词（纯函数，无 IO）。
//
// 只做一件事：把 parseSearchExpression 的结果翻译成与 matchesQuery 等价的 SQL 片段。
// 翻译不了就返回 null —— 由上层退回内存求值，绝不输出「看起来像但语义不同」的 SQL。
//
// 等价性靠三处纪律保证：
//   1. 字符串比较统一走 instr(lower(x), ?) > 0，与 JS 的 x.toLowerCase().includes() 同义；
//   2. 数值比较把 needle 在编译期解析成区间，不再让 SQL 解析「>=2000」这种写法；
//   3. 排除子句一律 COALESCE(<谓词>, 0) = 0 —— NULL 参与 NOT 会得 NULL，与 JS 的 !false 不同。
import {formatRegistry} from '../src/library/format-registry.js';

/**
 * 标签检索文本：原始值 ∪ 词表标准名 ∪ 该词的全部别名（物化在 assets.tags_text）。
 *
 * 必须与 library-query 的 fieldText(row,'tags') 逐字节一致 —— 两边拼出的字符串只要差一点，
 * 「同一个查询在一边命中、另一边落空」就会发生，而这种 bug 用户永远发现不了。
 * 物化成列而不是每次拼：20 万条实测相关子查询 1635ms、物化列 191ms。
 */
export const TAGS_TEXT = 'a.tags_text';

/**
 * fieldText 的默认分支：名称/作者/平台/备注/标签拼成一整串再做子串匹配。
 * 每段都用 COALESCE 包住：SQLite 的 || 遇到 NULL 会把整串变成 NULL，而 JS 那边只会得到空串。
 */
const ALL_TEXT = `(COALESCE(a.name, '') || ' ' || COALESCE(a.author, '') || ' ' || COALESCE(a.platform, '')
  || ' ' || COALESCE(a.note, '') || ' ' || COALESCE(${TAGS_TEXT}, ''))`;

/** numericValue(probe, field) 的等价表达式：probe 缺一边宽高时整体视为 NULL。 */
const PIXELS = 'a.width > 0 AND a.height > 0';
const NUMERIC_EXPR = Object.freeze({
  rating: 'a.rating',
  width: `CASE WHEN ${PIXELS} THEN a.width END`,
  height: `CASE WHEN ${PIXELS} THEN a.height END`,
  longEdge: `CASE WHEN ${PIXELS} THEN MAX(a.width, a.height) END`,
  resolution: `CASE WHEN ${PIXELS} THEN MAX(a.width, a.height) END`,
  aspect: `CASE WHEN ${PIXELS} THEN a.width * 1.0 / a.height END`,
  duration: 'CASE WHEN a.duration > 0 THEN a.duration END',
});
export {NUMERIC_EXPR};

const NUMERIC_FIELDS = new Set(Object.keys(NUMERIC_EXPR));

/** 与 library-query 的 numericHit 同一套解析；返回 null 表示「这一条永远不命中」。 */
function numericPredicate(expr, needle, ceiling) {
  const match = /^([<>]=?)?(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/.exec(needle);
  if (!match) return {sql: '0', params: []};
  const min = Number(match[2]);
  const op = match[1] || '';
  const max = match[3] === undefined ? (op ? (op.startsWith('<') ? min : ceiling) : ceiling) : Number(match[3]);
  if (op === '<') return {sql: `(${expr} < ?)`, params: [min]};
  if (op === '<=') return {sql: `(${expr} <= ?)`, params: [min]};
  if (op === '>') return {sql: `(${expr} > ?)`, params: [min]};
  if (op === '>=') return {sql: `(${expr} >= ?)`, params: [min]};
  const lo = Math.min(min, max), hi = Math.max(min, max);
  if (hi === Infinity) return {sql: `(${expr} >= ?)`, params: [lo]};
  return {sql: `(${expr} BETWEEN ? AND ?)`, params: [lo, hi]};
}

/** `ext:png` 是精确匹配：命中某个后缀，或命中某个格式分组 id。 */
function formatPredicate(needle) {
  const group = formatRegistry.groups.find(item => item.id === needle);
  const known = formatRegistry.knownExts.includes(needle);
  const exts = group ? [...group.exts] : (known ? [needle] : []);
  if (!exts.length) return {sql: '0', params: []};
  return {
    sql: `EXISTS (SELECT 1 FROM asset_formats af WHERE af.uid = a.uid AND af.ext IN (${exts.map(() => '?').join(', ')}))`,
    params: exts,
  };
}

/**
 * 单条 clause → 谓词。返回 null 表示不可下推（字段语义依赖 payload 派生结果）。
 * path / category / color / metadata 这四类必须退回内存：它们不是列，硬翻译必然错。
 */
export function clausePredicate(clause) {
  const needle = String(clause.values?.[0] ?? '').toLocaleLowerCase();
  if (!needle) return {sql: '1', params: []};
  const field = clause.field;
  if (field === 'format') return formatPredicate(needle);
  if (NUMERIC_FIELDS.has(field)) {
    return numericPredicate(NUMERIC_EXPR[field], needle, field === 'rating' ? 5 : Infinity);
  }
  const expr = field === 'name' ? 'a.name'
    : field === 'tags' ? TAGS_TEXT
    : field === 'note' ? 'a.note'
    : field === 'url' ? 'a.url'
    : field === 'author' ? 'a.author'
    : field === 'platform' ? 'a.platform'
    : field === null || field === undefined ? ALL_TEXT
    : null;
  if (!expr) return null;
  // 左操作数可能为 NULL（group_concat 空集）：COALESCE 让 instr 收到空串，与 JS 的 '' 一致。
  return {sql: `(instr(lower(COALESCE(${expr}, '')), ?) > 0)`, params: [needle]};
}

/**
 * 整条搜索表达式 → WHERE 片段。
 * clauses = AND，groups = OR(AND(...))；exclude 的 clause 取反（null-safe）。
 * 返回 null = 表达式里有不可下推的 clause，调用方应整条退回内存。
 */
export function searchPredicate(parsed) {
  const compileGroup = clauses => {
    const parts = [];
    const params = [];
    for (const clause of clauses) {
      const hit = clausePredicate(clause);
      if (!hit) return null;
      parts.push(clause.exclude ? `COALESCE(${hit.sql}, 0) = 0` : hit.sql);
      params.push(...hit.params);
    }
    return {sql: parts.length ? parts.join(' AND ') : '1', params};
  };
  if (parsed.groups?.length) {
    const compiled = parsed.groups.map(compileGroup);
    if (compiled.some(item => !item)) return null;
    return {
      sql: `(${compiled.map(item => `(${item.sql})`).join(' OR ')})`,
      params: compiled.flatMap(item => item.params),
    };
  }
  return compileGroup(parsed.clauses || []);
}
