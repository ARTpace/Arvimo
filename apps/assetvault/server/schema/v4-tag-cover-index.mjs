// V4：标签筛选、列筛选、文本检索的覆盖索引。只加不改，不动任何历史迁移。
//
// 这一版解决三件事，全部来自 50 万条实测（scratch 压测，不进版本库）：
//
//   ① asset_tags 的覆盖索引 —— 标签谓词要取 uid，而 uid 不在二级索引里，
//      于是每一行命中都要回表。364 万行上做 9.2 万次随机回表，单条 COUNT 要 602ms，
//      把 uid 放进索引尾部后 155ms（3.9×）。
//      这是 V3 那条教训的第二次出现：V3 修的是 assets 表，这次修的是 asset_tags 表。
//
//   ② assets 的统一覆盖索引 —— 让「平台 / 类型 / 评分 / 收藏 / 文本检索」的 COUNT
//      变成纯索引扫描，不必逐行回表。
//
//   ③ 排序索引提示 —— 由 query-sql.mjs 编译时给出（见 SORT_INDEX_HINTS），
//      配合 library-db.mjs 的命中量门槛使用。
//
// 代价与收益（50 万条实测）：
//   新增索引体积 ≈ 190MB（库的 9%），删掉 V2 遗留的冗余索引回收 ≈ 180MB，净增约 10MB。
//   换来的是：标签筛选 COUNT 快 3.9 倍、列筛选 COUNT 快 58~153 倍、
//             文本检索 COUNT 快 7 倍、标签筛选取页快 4 倍。
export const V4_SQL = `
-- 覆盖索引：term_id 等值定位后，uid 直接从索引里读，不必回 asset_tags 表。
-- 标签谓词（a.uid IN (SELECT at3.uid FROM asset_tags ...)）因此变成纯索引扫描。
CREATE INDEX IF NOT EXISTS asset_tags_term_uid_idx
  ON asset_tags (term_id, uid);

-- 反向覆盖索引：按 uid 取该资产的全部标签时也不必回表。
-- 词表刷新（重算检索文本）走这条路径。
CREATE INDEX IF NOT EXISTS asset_tags_uid_term_idx
  ON asset_tags (uid, term_id);

-- V2 遗留的两条 asset_tags 索引退休：
--   asset_tags_uid_idx  (uid)        → 被 (uid, term_id) 完全覆盖，左前缀相同
--   asset_tags_term_idx (term_id, source) → 被 (term_id, uid) 完全覆盖
-- 留着只是白占空间：50 万条下这两条约 180MB，而它们查的问题现在都有覆盖索引了。
DROP INDEX IF EXISTS asset_tags_uid_idx;
DROP INDEX IF EXISTS asset_tags_term_idx;

-- 统一覆盖索引：把「面板筛选会用到的列」和「检索会读到的列」放进同一条索引。
--
-- 问题一：平台 / 类型是子串匹配（instr(lower(列), ?)），
--   SQLite 用 (state, rating) 索引筛出候选后必须**逐行回表**才能读到 platform / kind。
--   50 万条实测这条 COUNT 要 3010ms（冷缓存 3.4s）—— 24 万次随机读。
-- 问题二：关键词检索要读 name / author / note / tags_text，这些列都不在二级索引里，
--   于是 48.5 万行逐行回表 → 3868ms。
-- 关键点：只要这些列在索引里，instr 谓词就能直接在索引上求值，不必回表。
--
-- 列顺序是实测定的，不能随意调整：
--   favorite 在 rating 之前 —— favorite 是等值条件（可 seek），rating 是范围条件
--     （范围会截断后续列的可用性）。放错位置的实测对比：
--       (state, rating, platform, kind, uid)            → 收藏+评分 COUNT 1087ms（反而更慢）
--       (state, favorite, rating, platform, kind, uid)  → 收藏+评分 COUNT    3ms
--   文本列放在最后 —— 它们只用于覆盖，不参与定位。
--
-- 注意这条索引**只给 COUNT 用**（见 library-db.mjs 的 countIndexHint）：
-- 它不含 added_at / position，给不了 ORDER BY，强行拿来做分页反而要全量排序。
--
-- 50 万条实测收益：
--   平台+类型+评分 COUNT：3010ms →  52ms（58×）
--   收藏+评分      COUNT： 460ms →   3ms（153×）
--   关键词检索     COUNT：3868ms → 548ms（7×）
--   体积代价：约 58MB（库的 2.9%）。
CREATE INDEX IF NOT EXISTS assets_cover_state_fav_rating_kind_platform_text_idx
  ON assets (state, favorite, rating, kind, platform, name, author, note, tags_text, uid);
`;
