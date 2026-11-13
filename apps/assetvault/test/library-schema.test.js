import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {MIGRATIONS, SUPPORTED_SCHEMA_VERSION, STATE_KEYS, planMigrations} from '../server/library-schema.mjs';
import {createLibraryDb} from '../server/library-db.mjs';

test('迁移链版本连续，checksum 与 SQL 本体一致', () => {
  assert.equal(SUPPORTED_SCHEMA_VERSION, MIGRATIONS.at(-1).version);
  MIGRATIONS.forEach((item, index) => {
    assert.equal(item.version, index + 1);
    assert.match(item.checksum, /^[a-f0-9]{64}$/);
    assert.equal(item.checksum, createHash('sha256').update(item.sql).digest('hex'));
  });
  // ADR-02 四域分离：目录 / 用户 / 探测 / 会话各自独立存储，写入代价与库大小解耦。
  assert.deepEqual(STATE_KEYS, [
    'sfx-library-v2', 'sfx-library-user', 'sfx-library-probe', 'sfx-library-session',
    'sfx-discovery-v1', 'sfx-library-ui', 'sfx-local-index-v1',
  ]);
});

test('planMigrations 只补未应用的版本，篡改历史迁移会拒绝打开', () => {
  assert.deepEqual(planMigrations([]).map(m => m.version), MIGRATIONS.map(m => m.version));
  const applied = MIGRATIONS.map(m => ({version: m.version, checksum: m.checksum}));
  assert.deepEqual(planMigrations(applied), []);
  assert.throws(() => planMigrations([{version: 1, checksum: 'tampered'}]), /checksum 不匹配/);
  assert.throws(() => planMigrations([{version: 1, checksum: 'tampered'}, ...applied.slice(1)]), /checksum 不匹配/);
});

test('v1…v5 建出核心表与索引，重复打开不会重复迁移', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  try {
    const names = db.raw("SELECT name FROM sqlite_master WHERE type IN ('table','view')").map(row => row.name);
    for (const table of ['schema_migrations', 'state_meta', 'db_meta', 'assets', 'tags', 'assets_fts', 'collections', 'collection_assets', 'smart_collections',
      // V2：规模化与协作（词表 / 关系 / 审计 / 队列）
      'tag_terms', 'tag_facets', 'tag_aliases', 'asset_tags', 'asset_formats',
      'content_tags', 'audit_log', 'members', 'jobs', 'tag_counts',
      // V6：语义向量（可再生派生数据，独立于 assets）
      'asset_vectors']) assert.ok(names.includes(table), `缺少 ${table}`);
    // V3 / V4 是纯索引迁移（下推用），V5 是列化迁移（分类 / 可下载），V6 新增向量表，
    // 但迁移链必须整条跑完。
    assert.equal(db.counts().migrations, 6);

    // V4 的覆盖索引：uid 必须落在索引尾部，否则每行命中都要回表。
    // 这是 V3/V4 反复出现的同一条教训，用断言钉死，别让后人「顺手改回去」。
    const indexes = db.raw("SELECT name FROM sqlite_master WHERE type='index'").map(row => row.name);
    for (const name of ['asset_tags_term_uid_idx', 'asset_tags_uid_term_idx',
      'assets_cover_state_fav_rating_kind_platform_text_idx']) {
      assert.ok(indexes.includes(name), `缺少索引 ${name}`);
    }
    // V2 遗留的冗余索引必须已退休 —— 它们占着 180MB 却查不出新东西。
    assert.ok(!indexes.includes('asset_tags_uid_idx'), 'asset_tags_uid_idx 应已被 (uid, term_id) 取代');
    assert.ok(!indexes.includes('asset_tags_term_idx'), 'asset_tags_term_idx 应已被 (term_id, uid) 取代');

    const cols = db.raw("SELECT name FROM pragma_index_info('asset_tags_term_uid_idx')").map(row => row.name);
    assert.deepEqual(cols, ['term_id', 'uid'], '覆盖索引必须把 uid 放在尾部');
  } finally { db.close(); }
});

test('v2 派生：标签收敛到词表、三层来源保留、列化字段有值', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  const uidA = 'a'.repeat(32), uidB = 'b'.repeat(32);
  try {
    db.writeValues({
      'sfx-library-v2': JSON.stringify({
        models: [
          {uid: uidA, name: '石灯', tags: ['Stone'], assetType: 'model', addedAt: 111, resolution: '2048x1024', bytes: 4096},
          {uid: uidB, name: 'Robot', tags: ['stone'], assetType: 'texture', addedAt: 222},
        ],
        aiTags: {[uidA]: ['石头']}, userTags: {}, userMeta: {}, favorites: [], trashed: [],
      }),
    }, {replace: true});

    // 大小写不同的 Stone / stone 与中文「石头」全部收敛到同一个词条「石材」：
    // 词表种子在打开库时就已激活，别名不再各自留一条 pending 词。
    const terms = db.raw("SELECT term_id, value, norm, status FROM tag_terms WHERE norm IN ('stone','石头','石材') ORDER BY norm");
    assert.deepEqual(terms.map(row => [row.value, row.status]), [['石材', 'active']]);
    assert.deepEqual(db.raw(`SELECT facet FROM tag_facets WHERE term_id = ${terms[0].term_id} ORDER BY facet`)
      .map(row => row.facet), ['material', 'subject']);

    // 三层来源都在：platform 由采集写入，ai 先记 legacy（S4 换真实模型版本）。
    const rows = db.raw('SELECT uid, source, created_by FROM asset_tags ORDER BY uid, source');
    assert.deepEqual(rows, [
      {uid: uidA, source: 'ai', created_by: 'legacy'},
      {uid: uidA, source: 'platform', created_by: 'system'},
      {uid: uidB, source: 'platform', created_by: 'system'},
    ]);

    // 列化字段：查询阶段不必再解析 payload 求 kind / 分辨率 / 体积。
    const row = db.raw(`SELECT kind, width, height, long_edge, bytes, rev FROM assets WHERE uid = '${uidA}'`)[0];
    assert.deepEqual(row, {kind: 'models', width: 2048, height: 1024, long_edge: 2048, bytes: 4096, rev: 1});
    assert.equal(db.raw(`SELECT kind FROM assets WHERE uid = '${uidB}'`)[0].kind, 'textures');
  } finally { db.close(); }
});
