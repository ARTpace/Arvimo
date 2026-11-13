// V5：把「分类」与「可下载性」两列化，让筛选条上除颜色外的所有维度都能下推。
//
// 为什么要动这两列：
//   阶段 5.6 之前，`categories` 与 `downloadable` 只存在 payload 里，
//   query-sql.mjs 遇到它们就 `return fail(...)` —— 整条查询退回「全量读 + JS 求值」。
//   那意味着：只要用户在筛选条上点了「分类」，50 万资产就要整库搬进内存跑一遍。
//   而这两个值的来源其实完全确定（分类 = categories[] ∪ category ∪ assetType ∪ kind，
//   可下载 = payload.downloadable === true），没有任何一格需要运行时上下文。
//
// 只加不改：两条 ADD COLUMN 都是可重入的（SQLite 对重复列会报错，所以迁移链本身保证只跑一次）。
export const V5_SQL = `
-- 分类检索文本：小写拼接的多个分类值，SQL 侧用 instr(lower(...), ?) 做子串匹配，
-- 与内存路径的 anyHit(categories) 语义一致（多选是 OR）。
ALTER TABLE assets ADD COLUMN category_text TEXT;
-- 可下载性：布尔列，等值条件比 json_extract 便宜两个数量级。
ALTER TABLE assets ADD COLUMN downloadable INTEGER NOT NULL DEFAULT 0;

-- 分类谓词要回表读 category_text（不在 V4 的覆盖索引里），但它是纯文本子串，
-- 给一条轻量索引只对「分类 = 某值」这种等值/前缀场景有意义；这里不加，
-- 因为 instr 用不上 B 树，加了只会白占体积（V4 的教训：索引不是越多越好）。
`;
