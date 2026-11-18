// 分面标签视图：标签面板的**服务端一次成型**数据。
//
// 为什么要服务端算：50 万资产 / 300 万条 asset_tags 时，前端遍历 state.models 数标签会卡死；
// 这里读的是物化计数表 tag_counts（重建索引时同一事务里刷新），一条 join 就够。
//
// 面的语义（与 scale-architecture.md §5.1 一致）：
//   · 一个词可以出现在多个面下（木材 = 材质 ∩ 题材），这是「边」不是「列」；
//   · 计数按 uid 去重且挂在词上，所以同一个词在不同面下的数字必然相等 —— 不会出现
//     「材质 100 + 题材 100 但库里只有 120 个资产」这种加不上的错觉。
import {FACETS, MARKER_PREFIXES} from './library-vocab.seed.mjs';

const byName = (a, b) => a.value.localeCompare(b.value, 'zh');

/** 标记前缀（如「来源:」）命中哪一面。规则来自词表种子，不在前端另写一份。 */
function markerFacet(value) {
  for (const [prefix, facet] of Object.entries(MARKER_PREFIXES)) {
    if (value.startsWith(prefix)) return facet;
  }
  return null;
}

/**
 * @param conn   library-db 连接（只用到 all / getMeta）
 * @param limit  每个面最多返回多少个值（防止长尾把面板撑爆；0 表示不限）
 */
/**
 * 词表全量：给前端建「词 → 面」索引用。
 *
 * 为什么单独给一份而不是让前端从 facets[] 反推：
 *   · facets[] 只含**有计数的**词，前端拿它当全量词表会把「还没标到资产上的词」漏掉；
 *   · 别名不在 facets[] 里 —— 而库里同一个意思常常写着三种（architecture / building / 建筑），
 *     不带别名就归不了一类，筛选时也点不中别名那份资产；
 *   · 层级（parent）不在 facets[] 里，选中父类时就没法把子孙一起筛出来。
 *
 * 键名压缩成单字母：这个结构会原样发给前端，四百多条词条用长键名会白白多传一倍体积。
 */
function vocabPayload(conn, terms, byId, facetsOf) {
  const aliasRows = conn.all('SELECT alias_norm, term_id FROM tag_aliases', []);
  const aliasesOf = new Map();
  for (const row of aliasRows) {
    const bucket = aliasesOf.get(row.term_id) || [];
    bucket.push(row.alias_norm);
    aliasesOf.set(row.term_id, bucket);
  }
  return {
    // 面的定义与顺序：分组标题和分组次序都从这儿来，前端不自己排。
    facets: {...FACETS},
    order: Object.keys(FACETS),
    // 每条词：v=标准名 f=归属面 a=别名 p=父级标准名
    terms: terms.map(term => {
      const own = facetsOf.get(term.id) || [];
      // 标记前缀的词（如「来源:local」）不是词条，靠前缀规则认面。
      const marker = own.length ? null : markerFacet(term.value);
      return {
        v: term.value,
        f: marker ? [marker] : [...own],
        a: (aliasesOf.get(term.id) || []).slice().sort(),
        p: term.parentId ? (byId.get(term.parentId)?.value ?? null) : null,
      };
    }),
  };
}

export function tagFacetView(conn, {limit = 120} = {}) {
  const terms = conn.all(`SELECT t.term_id AS id, t.value AS value, t.status AS status,
      t.parent_id AS parentId, COALESCE(c.asset_count, 0) AS count
    FROM tag_terms t LEFT JOIN tag_counts c ON c.term_id = t.term_id
    WHERE t.status <> 'merged' AND t.retired=0`, []);
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
    // 词表全量：前端按面分组的唯一依据。面由词表决定，不由写标签的一方决定。
    vocab: vocabPayload(conn, terms, byId, facetsOf),
    totals: {
      terms: terms.length,
      active: terms.filter(term => term.status === 'active').length,
      pending: terms.filter(term => term.status === 'pending').length,
      unfiled: unfiled.length,
    },
  };
}
