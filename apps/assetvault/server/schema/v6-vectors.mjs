// V6：语义向量索引（ADR-15）。
//
// 为什么要单独一张表，而不是给 assets 加一列：
//   1. 一条向量 512 维 float32 = 2KB，1 万条就 20MB；把它塞进 assets 行里，所有
//      「只读目录」的查询（卡片列表、全选、计数）都要带着它一起从磁盘页里搬出来。
//   2. 向量会随「换 embedding 模型」整体作废重建，而 assets 是权威数据，不能跟着一起动。
//   3. 向量是可再生派生数据：表被删掉、模型换了，重新构建即可，不影响任何用户输入。
//
// 表里存 model + dim：换模型时旧向量原地不认（WHERE model = ? 取不到），不必先清空。
// hash 存「参与 embedding 的文本」的 sha1 —— 名称/标签/备注没改就不重算，
// 这是增量构建的全部依据（也是重跑一次只需几秒的原因）。
export const V6_SQL = `
CREATE TABLE IF NOT EXISTS asset_vectors (
  uid TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  hash TEXT NOT NULL,
  vec BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_vectors_model_idx ON asset_vectors (model);
`;
