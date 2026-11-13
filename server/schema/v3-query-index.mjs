// V3：查询下推要的索引与派生列。只加不改，不动任何历史迁移。
//
// 依据是 20 万条实测（scratch 压测，不进版本库）：
//   · 无索引时首屏 178ms、带筛选的 COUNT 118ms —— 都还在做全表扫描；
//   · 改成「先取 uid 再取行」后，分页从 4146ms 降到 1239ms；
//   · 关键的一步是**覆盖索引**：uid 是 TEXT 主键，存在表里而不在二级索引里，
//     COUNT 时每一行都要回表读 uid，20 万行就是 20 万次随机读 —— 把 uid 放进索引尾部后，
//     同一条 COUNT 从 1817ms 掉到 1ms。
//   · 检索文本同样要物化成列：相关子查询拼一次标签要 1635ms，物化成列后 191ms。
//
// 索引按「WHERE 的等值列在前、ORDER BY 的列在后」排，让一次查询既能走索引过滤，
// 又能直接按索引顺序取前 N 行，不必为排序建临时 B 树。
//
// 为什么建一堆覆盖索引：SQLite 每个查询只用一个索引（除 OR 优化），
// `(state, added_at DESC, position DESC, uid)` 这一个就把「活跃 + 最近」这条最高频路径全吃掉了；
// 其余组合如果真需要，先看 EXPLAIN QUERY PLAN 再加，不要凭感觉堆。
export const V3_SQL = `
-- 标签检索文本：原始标签 ∪ 词表标准名 ∪ 别名，按码点排序。
-- 这是「词表是唯一事实源」在检索层的落点：搜「石材」必须能命中只打过 stone 的资产。
-- 物化成列而不是每次用相关子查询拼，是因为 20 万条实测 1635ms → 191ms。
ALTER TABLE assets ADD COLUMN tags_text TEXT;

-- 首屏：WHERE state=? ORDER BY added_at DESC, position DESC LIMIT 60
-- 索引尾部带 uid：COUNT 与分页都能只读索引不回表（uid 是 TEXT 主键，不在索引里就会每行回表）。
CREATE INDEX IF NOT EXISTS assets_cover_state_added_idx
  ON assets (state, added_at DESC, position DESC, uid);

-- 通用覆盖索引：标签筛选会把命中的 uid 收成一个集合，用它探测最划算
CREATE INDEX IF NOT EXISTS assets_cover_state_uid_idx
  ON assets (state, uid);

-- 评分筛选 / 按评分排序
CREATE INDEX IF NOT EXISTS assets_cover_state_rating_idx
  ON assets (state, rating DESC, added_at DESC, uid);

-- 平台 / 类型筛选（这两列的取值少，单列选择性差，所以带上 state 与排序键）
CREATE INDEX IF NOT EXISTS assets_cover_state_platform_idx
  ON assets (state, platform, added_at DESC, uid);
CREATE INDEX IF NOT EXISTS assets_cover_state_kind_idx
  ON assets (state, kind, added_at DESC, uid);

-- 排序维度：缺失值在 SQL 里被 CASE 换成哨兵值，这几条只在整库排序时用得上
CREATE INDEX IF NOT EXISTS assets_cover_state_long_edge_idx
  ON assets (state, long_edge DESC, uid);
CREATE INDEX IF NOT EXISTS assets_cover_state_bytes_idx
  ON assets (state, bytes DESC, uid);

-- 收藏是「少数派」条件：部分索引只收 favorite=1 的行，体积远小于全表索引
CREATE INDEX IF NOT EXISTS assets_cover_favorite_idx
  ON assets (state, favorite, uid) WHERE favorite = 1;

-- 回收站视图按 trashed_at 倒序，与活跃列表分开走
CREATE INDEX IF NOT EXISTS assets_cover_trashed_idx
  ON assets (trashed_at DESC, uid) WHERE state = 'trashed';
`;
