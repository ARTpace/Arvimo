// 修复早期 v8 未含 seed_key 的历史库；已有该字段的库由执行器跳过 ADD。
export const V11_ADD_SEED_KEY='ALTER TABLE tag_terms ADD COLUMN seed_key TEXT;';
export const V11_SQL=`${V11_ADD_SEED_KEY}
CREATE UNIQUE INDEX IF NOT EXISTS tag_terms_seed_key_idx ON tag_terms(seed_key) WHERE seed_key IS NOT NULL;
`;
