// 阶段 3：按需分页取数 + FTS5 候选集加速的纯函数层（无 IO、无第三方依赖）。
//
// 为什么还需要分页接口：阶段 2 的 /api/library/query 只返回精简卡片（toCard）与全部命中 uid，
// 前端要用它「按页取完整资产」就得再拼一次数据。这里补上一层：同样一套查询语义，
// 但 items 是完整 model（含三层标签、评分、备注），调用方拿一页就能直接画卡片。
import {queryAssets} from './library-query.mjs';

/** 候选集上限：宁可多筛一点，也不能因为截断而漏结果。 */
export const FTS_CANDIDATE_LIMIT = 20000;

/**
 * 只有「单个正向纯文本词」才允许用 FTS5 缩候选集。
 *
 * 收紧条件的理由（不是性能优化洁癖，是语义正确性）：
 *   - assets_fts 的 body 只覆盖 name / author / platform / note / tags，正好等于 fieldText 的
 *     默认全字段；一旦查询带 tag: / url: / metadata: 等字段限定，FTS 预筛就会漏命中。
 *   - 排除词 -x、OR 组、短语、字段语法的命中集合不是「词的交集」，不能靠一次 MATCH 表达。
 *   - trigram tokenizer 对 3 字符以下的词不成立；中文 2 字词走 LIKE 分支又不含 tags。
 * 其余情况一律走全量行 + queryAssets 完整求值，宁可慢也不改结果。
 */
export function simpleFtsTerm(q) {
  const value = String(q ?? '').trim();
  if (!value || !/^[\p{L}\p{N}]{3,}$/u.test(value)) return null;
  return value.toLocaleLowerCase();
}

/**
 * 完整资产行：payload 里的原始 model 是主体，再把规范化表里派生的用户判断补上。
 * 不改 model.tags（那是平台标签），三层标签单独放 tagKinds，由调用方决定怎么合并。
 */
export function toFullModel(row) {
  return {
    ...row.model,
    uid: row.uid,
    name: row.name || row.model.name,
    author: row.author || row.model.author,
    thumbnail: row.thumbnail || row.model.thumbnail,
    addedAt: row.model.addedAt ?? row.added_at,
    rating: row.rating,
    note: row.note,
    favorite: row.favorite,
    state: row.state,
    tagKinds: row.tagKinds,
    categories: row.categories,
    kind: row.kind,
  };
}

/** 与 /api/library/query 共用 queryAssets，只把「每页给什么」换成完整 model。 */
export function queryAssetPage(input = {}) {
  return queryAssets({...input, project: input.project || toFullModel});
}
