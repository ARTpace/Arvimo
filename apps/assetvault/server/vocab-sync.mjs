// 词表种子 → SQLite 的同步器。
//
// 为什么不是迁移：词表是**产品数据**，主人会不断加词/改别名。走迁移就等于每次改词都要发一个
// schema 版本，而且历史迁移还被 checksum 冻死。这里用 `db_meta.vocab_rev` 做幂等闸门：
// rev 没变就直接返回，变了就在一个事务里整体对齐。
//
// 同步做四件事（顺序不能换）：
//   1. canonical 词条落地并激活（V2 迁移把它们先建成 pending，这里转正）
//   2. 父级关系（父级可能排在子级后面，必须等所有词条都建完再连）
//   3. 面归属（整体替换：从种子里删掉的面要真的消失，不能残留）
//   4. 别名 + **合并**：库里如果已经有「木头」「wood」这类 pending 词条，
//      把它们标成 merged 并把 asset_tags 迁移到 canonical term —— 这是「同义词合并可见」的实现点。
import {FACETS, VOCAB_REV, TERMS} from './library-vocab.seed.mjs';
import {normOf} from './library-vocab.mjs';

/** 物化标签计数：标签面板一次查询拿到全部数字，不必每次 GROUP BY 三百万行。 */
export function refreshTagCounts(db, stamp = Date.now()) {
  db.exec('DELETE FROM tag_counts');
  db.prepare(`INSERT INTO tag_counts (term_id, asset_count, updated_at)
    SELECT term_id, count(DISTINCT uid), ? FROM asset_tags GROUP BY term_id`).run(stamp);
}

/**
 * 把词表对齐到指定版本。返回 {applied, rev, created, merged, aliases}。
 * 全程单事务：合并中途失败不会留下「一半 term 指向 canonical、一半还指着旧词」的脏状态。
 */
export function syncVocab(db, {rev = VOCAB_REV, terms = TERMS, facets = FACETS, now = Date.now} = {}) {
  const readMeta = db.prepare('SELECT value FROM db_meta WHERE key = ?');
  const current = readMeta.get('vocab_rev')?.value ?? null;
  if (current !== null && String(current) === String(rev)) {
    return {applied: false, rev, created: 0, merged: 0, aliases: 0};
  }

  const stamp = now();
  const stats = {applied: true, rev, created: 0, merged: 0, aliases: 0};
  const facetKeys = new Set(Object.keys(facets));
  const selTerm = db.prepare('SELECT term_id, status, merged_into FROM tag_terms WHERE norm = ?');
  const insTerm = db.prepare("INSERT INTO tag_terms (value, norm, status, created_at) VALUES (?, ?, 'active', ?)");
  const actTerm = db.prepare("UPDATE tag_terms SET value = ?, status = 'active' WHERE term_id = ? AND status <> 'merged'");
  const delFacets = db.prepare('DELETE FROM tag_facets WHERE term_id = ?');
  const insFacet = db.prepare('INSERT OR IGNORE INTO tag_facets (term_id, facet) VALUES (?, ?)');
  const setParent = db.prepare('UPDATE tag_terms SET parent_id = ? WHERE term_id = ?');
  const insAlias = db.prepare(`INSERT INTO tag_aliases (alias_norm, term_id, created_at) VALUES (?, ?, ?)
    ON CONFLICT(alias_norm) DO UPDATE SET term_id = excluded.term_id`);
  const markMerged = db.prepare("UPDATE tag_terms SET status = 'merged', merged_into = ? WHERE term_id = ?");
  const moveTags = db.prepare('UPDATE OR IGNORE asset_tags SET term_id = ? WHERE term_id = ?');
  const dropTags = db.prepare('DELETE FROM asset_tags WHERE term_id = ?');
  const setMeta = db.prepare('INSERT INTO db_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  /** 词条表 → norm → term_id。merged 的词条不给 id：尊重人工归并，不用种子把它复活。 */
  const canonicalIds = new Map();
  const pending = [];

  const run = db.transaction(() => {
    for (const raw of terms) {
      const value = String(raw?.value ?? '').trim();
      const norm = normOf(value);
      if (!norm) continue;
      const hit = selTerm.get(norm);
      if (hit && hit.status === 'merged') continue;
      if (hit) {
        actTerm.run(value, hit.term_id);
        canonicalIds.set(norm, hit.term_id);
      } else {
        const id = Number(insTerm.run(value, norm, stamp).lastInsertRowid);
        canonicalIds.set(norm, id);
        stats.created++;
      }
      pending.push({raw, norm});
    }

    for (const {raw, norm} of pending) {
      const id = canonicalIds.get(norm);
      const parent = raw.parent ? canonicalIds.get(normOf(raw.parent)) : null;
      if (parent) setParent.run(parent, id);
    }

    for (const {raw, norm} of pending) {
      const id = canonicalIds.get(norm);
      delFacets.run(id);
      for (const facet of raw.facets || []) if (facetKeys.has(facet)) insFacet.run(id, facet);
    }

    for (const {raw, norm} of pending) {
      const id = canonicalIds.get(norm);
      for (const alias of raw.aliases || []) {
        const aliasNorm = normOf(alias);
        if (!aliasNorm || aliasNorm === norm) continue;
        insAlias.run(aliasNorm, id, stamp);
        stats.aliases++;
        // 别名在库里已经是一条真实词条（老数据里的 "wood"）→ 合并过去，绝不并存。
        const stale = selTerm.get(aliasNorm);
        if (!stale || stale.term_id === id) continue;
        if (stale.status === 'merged' && stale.merged_into === id) continue;
        markMerged.run(id, stale.term_id);
        // 先尝试改指向（PK 冲突的会被 OR IGNORE 跳过），再把剩下的重复行删掉。
        moveTags.run(id, stale.term_id);
        dropTags.run(stale.term_id);
        stats.merged++;
      }
    }

    setMeta.run('vocab_rev', String(rev));
    setMeta.run('vocab_synced_at', String(stamp));
  });
  run();

  // 合并改变了 term 归属，计数必须重算；否则面板上的数字会停在上一次重建。
  if (stats.merged) refreshTagCounts(db, stamp);
  return stats;
}
