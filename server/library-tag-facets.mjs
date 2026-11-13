// 分面标签视图：标签面板的**服务端一次成型**数据。
//
// 为什么要服务端算：50 万资产 / 300 万条 asset_tags 时，前端遍历 state.models 数标签会卡死；
// 这里读的是物化计数表 tag_counts（重建索引时同一事务里刷新），一条 join 就够。
//
// 面的语义（与 scale-architecture.md §5.1 一致）：
//   · 一个词可以出现在多个面下（木材 = 材质 ∩ 题材），这是「边」不是「列」；
//   · 计数按 uid 去重且挂在词上，所以同一个词在不同面下的数字必然相等 —— 不会出现
//     「材质 100 + 题材 100 但库里只有 120 个资产」这种加不上的错觉。
import {FACETS} from './library-vocab.seed.mjs';

const byName = (a, b) => a.value.localeCompare(b.value, 'zh');

/**
 * @param conn   library-db 连接（只用到 all / getMeta）
 * @param limit  每个面最多返回多少个值（防止长尾把面板撑爆；0 表示不限）
 */
export function tagFacetView(conn, {limit = 120} = {}) {
  const terms = conn.all(`SELECT t.term_id AS id, t.value AS value, t.status AS status,
      t.parent_id AS parentId, COALESCE(c.asset_count, 0) AS count
    FROM tag_terms t LEFT JOIN tag_counts c ON c.term_id = t.term_id
    WHERE t.status <> 'merged'`, []);
  const facetRows = conn.all('SELECT term_id AS id, facet FROM tag_facets', []);

  const facetsOf = new Map();
  for (const row of facetRows) {
    const bucket = facetsOf.get(row.id) || [];
    bucket.push(row.facet);
    facetsOf.set(row.id, bucket);
  }

  const byId = new Map(terms.map(term => [term.id, term]));
  const node = term => ({
    value: term.value,
    count: term.count,
    status: term.status,
    facets: facetsOf.get(term.id) || [],
    parent: term.parentId ? (byId.get(term.parentId)?.value ?? null) : null,
  });

  const buckets = new Map(Object.keys(FACETS).map(key => [key, []]));
  const unfiled = [];
  for (const term of terms) {
    const node_ = node(term);
    const keys = node_.facets.filter(key => buckets.has(key));
    // 没有任何面归属的词（用户新造、还没进词表）单独一栏，绝不悄悄丢掉 ——
    // 它们正是审计面板要收敛的对象。
    if (!keys.length) { unfiled.push(node_); continue; }
    for (const key of keys) buckets.get(key).push(node_);
  }

  const facets = Object.entries(FACETS).map(([key, label]) => {
    const values = buckets.get(key).sort((a, b) => b.count - a.count || byName(a, b));
    return {
      key, label,
      total: values.length,
      // 总资产数按词去重后的最大值估算不合适，交给前端按需读取，不在这里编造。
      values: limit > 0 ? values.slice(0, limit) : values,
      truncated: limit > 0 && values.length > limit,
    };
  });

  return {
    rev: Number(conn.getMeta('vocab_rev')) || 0,
    syncedAt: Number(conn.getMeta('vocab_synced_at')) || 0,
    facets,
    unfiled: unfiled.sort((a, b) => b.count - a.count || byName(a, b)).slice(0, limit > 0 ? limit : undefined),
    totals: {
      terms: terms.length,
      active: terms.filter(term => term.status === 'active').length,
      pending: terms.filter(term => term.status === 'pending').length,
      unfiled: unfiled.length,
    },
  };
}
