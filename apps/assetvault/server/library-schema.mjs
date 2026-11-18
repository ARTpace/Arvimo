// 资产库内核的 schema 契约：声明式迁移链，只加不改。
//
// 借鉴 Serpent 的 MIGRATIONS 设计（src/worker/library-service.ts:3623）：
// 每条迁移带 checksum，已应用的版本永不修改；新代码必须能打开旧库。
// 这里刻意不照搬它 60 条迁移 / 5 万行内核，只保留 AssetVault 当前需要的表，
// 后续能力（合集、智能合集、向量索引）走新版本追加，改动是「加一条 SQL」而非重构。
//
// 权威 / 派生分离：
//   state_meta 存前端原始 blob 字符串（权威，保证与 /api/library-state 字节级一致）；
//   assets / tags / assets_fts 是从 blob 派生的索引副本，任何时候都能重建。
import {createHash} from 'node:crypto';
import {V7_SQL} from './schema/v7-file-locations.mjs';
import {V8_SQL} from './schema/v8-tag-backfill.mjs';
import {V9_SQL} from './schema/v9-tag-management.mjs';
import {V10_SQL} from './schema/v10-label-rules.mjs';
import {V11_SQL} from './schema/v11-seed-key-compat.mjs';
import {V2_SQL} from './schema/v2-scale.mjs';
import {V3_SQL} from './schema/v3-query-index.mjs';
import {V4_SQL} from './schema/v4-tag-cover-index.mjs';
import {V5_SQL} from './schema/v5-derive-columns.mjs';
import {V6_SQL} from './schema/v6-vectors.mjs';

const V1_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE state_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE assets (
  uid TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'trashed')),
  payload TEXT NOT NULL,
  name TEXT,
  author TEXT,
  url TEXT,
  platform TEXT,
  thumbnail TEXT,
  rating INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER,
  trashed_at INTEGER,
  source TEXT NOT NULL DEFAULT 'blob'
);
CREATE INDEX assets_state_position_idx ON assets (state, position);
CREATE INDEX assets_added_at_idx ON assets (added_at);
CREATE TABLE tags (
  uid TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('platform', 'ai', 'user')),
  tag TEXT NOT NULL,
  PRIMARY KEY (uid, kind, tag)
);
CREATE INDEX tags_tag_idx ON tags (tag);
CREATE VIRTUAL TABLE assets_fts USING fts5 (
  uid UNINDEXED,
  body,
  tokenize = 'trigram'
);
CREATE TABLE collections (
  collection_id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_asset_id TEXT,
  icon TEXT,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE collection_assets (
  collection_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, asset_id)
);
CREATE INDEX collection_assets_asset_idx ON collection_assets (asset_id);
CREATE TABLE smart_collections (
  collection_id TEXT PRIMARY KEY,
  query TEXT NOT NULL DEFAULT '',
  filters TEXT NOT NULL DEFAULT '{}',
  sort TEXT NOT NULL DEFAULT 'recent',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** 迁移条目：SQL 本身即契约，checksum 防止「改了历史迁移」这类不可恢复的破坏。 */
function entry(version, name, sql) {
  return {version, name, sql, checksum: createHash('sha256').update(sql).digest('hex')};
}

// V2 起，迁移 SQL 按领域分片放在 schema/ 下；本文件只保留「链 + 校验」。
// V1 的 SQL 仍留在原地不搬：checksum 已冻结，移动位置虽然不改内容，但没有收益且徒增风险。
export const MIGRATIONS = Object.freeze([
  entry(1, 'core-library-state', V1_SQL),
  entry(2, 'scale-and-collaboration', V2_SQL),
  entry(3, 'query-pushdown-index', V3_SQL),
  entry(4, 'tag-cover-index', V4_SQL),
  entry(5, 'derive-columns', V5_SQL),
  entry(6, 'semantic-vectors', V6_SQL),
  entry(7, 'stable-file-locations', V7_SQL),
  entry(8, 'resumable-tag-backfill', V8_SQL),
  entry(9, 'custom-tag-management', V9_SQL),
  entry(10, 'taxonomy-split-rules', V10_SQL),
  entry(11, 'legacy-v8-seed-key-compat', V11_SQL),
]);
export const SUPPORTED_SCHEMA_VERSION = MIGRATIONS.at(-1).version;

/**
 * ADR-02：状态拆成四个域，各自独立存储、各自独立写入。
 *
 * 为什么必须拆：主 blob 曾经把「目录 + 用户数据 + 探测缓存 + 会话现场」揉成一串 JSON。
 * 后果是打一个标签要重写整串（50 万资产时 209MB），记一次搜索历史也要重写整串，
 * 而写进去又会撞上 16MB 的前端契约上限 —— 越大的库越写不动，这是死循环。
 * 拆开之后，每一域都有自己的写入者与写入代价：
 *   - 目录域（models/trashed）：前端整块写，代价 ∝ 本地目录条数，低频；
 *   - 用户域（标签/评分备注/收藏）：**服务端 DB 权威**，前端只发集合语义 op，代价 ∝ 受影响行；
 *   - 探测域（封面探测缓存）：前端整块写，代价 ∝ 探测过的资产数，可重建；
 *   - 会话域（历史/任务/选项）：前端整块写，体量只有几 KB，与库大小无关。
 *
 * 拆域之后派生层仍然是「一份看得全的 state」：mergeDomains() 负责合并，
 * 派生表的语义不变，只是写入不再互相拖累。
 */
export const MAIN_STATE_KEY = 'sfx-library-v2';
/** 用户域：AI 标签、我的标签、评分备注、收藏。权威在服务端 DB。 */
export const USER_STATE_KEY = 'sfx-library-user';
/** 封面探测缓存：可重建的派生数据，独立成域以免每次探测都重写目录 blob。 */
export const PROBE_STATE_KEY = 'sfx-library-probe';
/** 会话域：搜索历史、下载任务、导出选项。 */
export const SESSION_STATE_KEY = 'sfx-library-session';

export const STATE_KEYS = Object.freeze([
  MAIN_STATE_KEY, USER_STATE_KEY, PROBE_STATE_KEY, SESSION_STATE_KEY,
  'sfx-discovery-v1',
  'sfx-library-ui',
  'sfx-local-index-v1',
]);

/**
 * 逐域版本戳在 db_meta 里的键前缀（轻量表，几行小记录）。
 *
 * 为什么需要它：state_meta 里存着目录域的 209MB 原串，判断「文件与 DB 谁新」
 * 若去查 state_meta，光扫那一行就要 200ms、取 value 要 680ms —— 记一次搜索历史
 * 会被拖到 7 秒。把戳同步写进 db_meta，常态下比较只需扫几行小记录；
 * 老库没有戳时读一次 state_meta.updated_at 补齐，行为不变、无需新增迁移。
 */
export const STATE_STAMP_PREFIX = 'state_stamp:';
export const stateStampKey = key => `${STATE_STAMP_PREFIX}${key}`;

/** 用户域字段：标签 / 评分备注 / 收藏。权威在服务端 DB，前端只发集合语义 op。 */
export const USER_FIELDS = Object.freeze(['aiTags', 'userTags', 'userMeta', 'favorites']);
/** 探测域字段：封面探测缓存。可重建，独立成域避免每次探测重写目录 blob。 */
export const PROBE_FIELDS = Object.freeze(['assetProbe']);
/** 会话域字段：搜索历史 / 下载任务 / 导出选项。 */
export const SESSION_FIELDS = Object.freeze(['history', 'tasks', 'options']);
/** 目录域字段：资产主体与回收站。 */
export const CATALOG_FIELDS = Object.freeze(['models', 'trashed']);

/**
 * 把已落库的迁移记录与新链对齐：缺的补上，已存在的只校验 checksum。
 * 返回的 pending 由调用方在事务内执行，保证「半个迁移」永远不会出现在磁盘上。
 */
export function planMigrations(applied = [], chain = MIGRATIONS) {
  const known = new Map(applied.map(row => [Number(row.version), row]));
  const pending = [];
  for (const item of chain) {
    const old = known.get(item.version);
    // 仅兼容已核对的早期 v8（未含 seed_key）；v11 负责补字段，不改写旧迁移记录。
    const legacyV8=item.version===8&&item.checksum==='ecc02fa8c71d3163d10d42d64099eabf2dc73d1d574d5cc4bb201584d416ffd2'
      &&old?.checksum==='eb50f21a908d606a3422e42a0c3331c1aa04d32b72fc4f1302886aebb62c063a';
    if (old && old.checksum !== item.checksum && !legacyV8) {
      throw Error(`资产库迁移 v${item.version} 的 checksum 不匹配，拒绝打开被改动过的库`);
    }
    if (!old) pending.push(item);
  }
  return pending;
}
