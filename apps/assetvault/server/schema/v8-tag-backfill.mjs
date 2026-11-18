export const V8_SQL = `
ALTER TABLE tag_terms ADD COLUMN seed_key TEXT;
CREATE UNIQUE INDEX tag_terms_seed_key_idx ON tag_terms(seed_key) WHERE seed_key IS NOT NULL;
CREATE TABLE tag_rejections (
 uid TEXT NOT NULL, term_id INTEGER NOT NULL, source TEXT NOT NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(uid,term_id,source)
);
CREATE TABLE asset_label_progress (
 uid TEXT NOT NULL, channel TEXT NOT NULL, vocab_rev INTEGER NOT NULL,
 updated_at INTEGER NOT NULL, PRIMARY KEY(uid,channel)
);
CREATE TABLE label_backfill (
 channel TEXT PRIMARY KEY, vocab_rev INTEGER NOT NULL, state TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
 error TEXT, updated_at INTEGER NOT NULL
);
`;
