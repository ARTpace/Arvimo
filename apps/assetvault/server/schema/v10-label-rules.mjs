export const V10_SQL=`
CREATE TABLE taxonomy_rules (
 rule_id TEXT PRIMARY KEY, source_id INTEGER NOT NULL, target_id INTEGER NOT NULL,
 match_norm TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
 UNIQUE(source_id,target_id,match_norm)
);
CREATE INDEX taxonomy_rules_source_idx ON taxonomy_rules(source_id);
`;
