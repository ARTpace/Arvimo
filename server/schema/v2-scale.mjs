// V2：规模化与协作所需的表。V1 一个字节都不改（checksum 保护）。
//
// 这一段只做「加」，不做「改」：
//   - 新增词表三件套（tag_terms / tag_facets / tag_aliases）：面是边，不是列。
//   - 新增 asset_tags 承载协作与审计所需的 source / model_version / created_by；
//     旧的 tags(uid,kind,tag) 保留，作为 S1 期间的兼容投影，S2 结束再删。
//   - assets 列化：把筛选与排序真正需要的字段从 payload 里提出来，避免查询时逐行 JSON.parse。
//   - jobs / audit_log / members / content_tags / tag_counts 为 S3-S4 预留；
//     先建表不加逻辑，避免以后再加一次迁移。
//
// 可重入性：全部语句都是 CREATE TABLE IF NOT EXISTS / ADD COLUMN。
// ADD COLUMN 在已存在的库上重复执行会报错，因此本段只能由迁移链执行一次（version=2 保证）。
export const V2_SQL = `
CREATE TABLE IF NOT EXISTS tag_terms (
  term_id    INTEGER PRIMARY KEY,
  value      TEXT NOT NULL UNIQUE,
  norm       TEXT NOT NULL UNIQUE,
  parent_id  INTEGER REFERENCES tag_terms(term_id),
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','pending','merged')),
  merged_into INTEGER REFERENCES tag_terms(term_id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tag_terms_parent_idx ON tag_terms (parent_id);
CREATE INDEX IF NOT EXISTS tag_terms_status_idx ON tag_terms (status);

CREATE TABLE IF NOT EXISTS tag_facets (
  term_id INTEGER NOT NULL REFERENCES tag_terms(term_id),
  facet   TEXT NOT NULL,
  PRIMARY KEY (term_id, facet)
);
CREATE INDEX IF NOT EXISTS tag_facets_facet_idx ON tag_facets (facet);

CREATE TABLE IF NOT EXISTS tag_aliases (
  alias_norm TEXT PRIMARY KEY,
  term_id    INTEGER NOT NULL REFERENCES tag_terms(term_id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_tags (
  uid           TEXT NOT NULL,
  term_id       INTEGER NOT NULL REFERENCES tag_terms(term_id),
  source        TEXT NOT NULL CHECK (source IN ('platform','ai','user')),
  model_version TEXT,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (uid, term_id, source)
);
CREATE INDEX IF NOT EXISTS asset_tags_term_idx ON asset_tags (term_id, source);
CREATE INDEX IF NOT EXISTS asset_tags_uid_idx  ON asset_tags (uid);

CREATE TABLE IF NOT EXISTS content_tags (
  hash          TEXT PRIMARY KEY,
  tags          TEXT NOT NULL,
  model_version TEXT,
  vocab_rev     INTEGER,
  tagged_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  uid     TEXT,
  term_id INTEGER,
  detail  TEXT,
  rev     INTEGER
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx  ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_uid_idx ON audit_log (uid, at DESC);

CREATE TABLE IF NOT EXISTS members (
  member_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id     TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN
             ('queued','running','paused','succeeded','failed','cancelled')),
  priority   INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL DEFAULT '{}',
  progress   REAL NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_state_priority_idx ON jobs (state, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS jobs_kind_state_idx     ON jobs (kind, state);

CREATE TABLE IF NOT EXISTS tag_counts (
  term_id     INTEGER PRIMARY KEY,
  asset_count INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS asset_formats (
  uid TEXT NOT NULL,
  ext TEXT NOT NULL,
  PRIMARY KEY (uid, ext)
);
CREATE INDEX IF NOT EXISTS asset_formats_ext_idx ON asset_formats (ext);

ALTER TABLE assets ADD COLUMN kind         TEXT;
ALTER TABLE assets ADD COLUMN width        INTEGER;
ALTER TABLE assets ADD COLUMN height       INTEGER;
ALTER TABLE assets ADD COLUMN long_edge    INTEGER;
ALTER TABLE assets ADD COLUMN bytes        INTEGER;
ALTER TABLE assets ADD COLUMN color_h      INTEGER;
ALTER TABLE assets ADD COLUMN duration     REAL;
ALTER TABLE assets ADD COLUMN content_hash TEXT;
ALTER TABLE assets ADD COLUMN rev          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN updated_at   INTEGER;

CREATE INDEX IF NOT EXISTS assets_kind_idx      ON assets (kind, added_at);
CREATE INDEX IF NOT EXISTS assets_long_edge_idx ON assets (long_edge);
CREATE INDEX IF NOT EXISTS assets_bytes_idx     ON assets (bytes);
CREATE INDEX IF NOT EXISTS assets_color_h_idx   ON assets (color_h);
CREATE INDEX IF NOT EXISTS assets_hash_idx      ON assets (content_hash);

INSERT OR IGNORE INTO tag_terms (value, norm, status, created_at)
SELECT DISTINCT trim(tag), lower(trim(tag)), 'pending', CAST(strftime('%s','now') AS INTEGER) * 1000
FROM tags
WHERE trim(tag) <> '';

INSERT OR IGNORE INTO asset_tags (uid, term_id, source, created_at, created_by)
SELECT t.uid, m.term_id, t.kind, CAST(strftime('%s','now') AS INTEGER) * 1000, 'migration'
FROM tags t
JOIN tag_terms m ON m.norm = lower(trim(t.tag))
WHERE trim(t.tag) <> '';
`;
