export const V7_SQL = `
CREATE TABLE file_roots (
 root_id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, writable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE file_locations (
 location_id TEXT PRIMARY KEY, asset_uid TEXT NOT NULL,
 root_id TEXT NOT NULL, rel TEXT NOT NULL, fingerprint TEXT NOT NULL,
 availability TEXT NOT NULL DEFAULT 'online', mode TEXT NOT NULL DEFAULT 'linked',
 UNIQUE(root_id, rel)
);
CREATE INDEX file_locations_asset_idx ON file_locations(asset_uid);
CREATE TABLE file_operations (
 operation_id TEXT PRIMARY KEY, state TEXT NOT NULL, plan TEXT NOT NULL,
 error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`;
