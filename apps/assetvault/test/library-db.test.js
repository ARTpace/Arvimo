import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32);
const values = {
  'sfx-library-v2': JSON.stringify({
    version: 2,
    models: [{uid: a, name: '国风石灯', author: 'Artist', tags: ['stone'], addedAt: 111}, {uid: b, name: 'Robot', tags: ['mech']}],
    aiTags: {[a]: ['石头']}, userTags: {[a]: ['常用']}, userMeta: {[a]: {rating: 4, note: '项目A'}},
    favorites: [b], trashed: [], history: [], tasks: [], options: {},
  }),
  'sfx-library-ui': '{"linkPanelOpen":true}',
};
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assetvault-db-'));

test('包内平台封面识别真实 rel，不受查询参数顺序和缓存参数影响', () => {
  const db=createLibraryDb({Database,file:':memory:'});
  try{
    const remote='https://cdn.example.com/platform.jpg';
    const previews=[
      '/api/local/thumb?root=library&rel=pack%2Fpreview.jpg&w=384&v=123',
      '/api/local/thumb?w=384&root=library&rel=pack%2Fpreview.jpg',
      '/api/local/file?rel=pack%2FPREVIEW.PNG&root=library',
    ];
    for(const thumbnail of previews){
      db.applyAssetOps([{op:'asset:add',uid:a,model:{uid:a,name:'材质',platform:'ambientcg',thumbnail,platformThumbnail:remote}}]);
      const row=db.all('SELECT thumbnail,payload FROM assets WHERE uid=?',[a])[0];
      assert.equal(row.thumbnail,thumbnail);
      assert.equal(JSON.parse(row.payload).thumbnail,thumbnail);
    }
  }finally{db.close();}
});

test('写入后原字符串逐字节读回，派生索引同步生成', () => {
  const dir = temp();
  const db = createLibraryDb({Database, file: path.join(dir, 'library.db')});
  try {
    db.writeValues(values, {replace: true});
    assert.equal(db.readValues()['sfx-library-v2'], values['sfx-library-v2']);
    assert.equal(db.readValues()['sfx-library-ui'], values['sfx-library-ui']);
    // 迁移版本会随 schema 增长，只断言派生表计数与「迁移已执行」，不写死版本号。
    const counts = db.counts();
    assert.deepEqual({assets: counts.assets, tags: counts.tags, assetTags: counts.assetTags, collections: counts.collections}, {assets: 2, tags: 4, assetTags: 4, collections: 0});
    assert.ok(counts.migrations >= 4, '迁移应全部执行');
    assert.equal(db.raw('SELECT rating, favorite FROM assets ORDER BY position').length, 2);
    assert.equal(db.raw(`SELECT rating FROM assets WHERE uid = '${a}'`)[0].rating, 4);
  } finally { db.close(); fs.rmSync(dir, {recursive: true, force: true}); }
});

test('FTS5 trigram 支持中文子串、英文词与短词回退', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  try {
    db.writeValues(values, {replace: true});
    assert.deepEqual(db.search('国风').map(r => r.uid), [a]);
    assert.deepEqual(db.search('stone').map(r => r.uid), [a]);
    assert.deepEqual(db.search('Robot').map(r => r.uid), [b]);
    assert.deepEqual(db.search('Ro').map(r => r.uid), [b]);
    assert.deepEqual(db.search(''), []);
    assert.deepEqual(db.search('不存在的词'), []);
  } finally { db.close(); }
});

test('部分 key 写入不清空资产索引，合集数据不属于派生表也不会被覆盖', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  try {
    db.writeValues(values, {replace: true});
    db.exec(`INSERT INTO collections (collection_id, name, created_at, updated_at) VALUES ('c1', '项目A', 1, 1)`);
    db.exec(`INSERT INTO collection_assets (collection_id, asset_id) VALUES ('c1', '${a}')`);
    db.writeValues({'sfx-library-ui': '{}'});
    assert.equal(db.counts().assets, 2);
    assert.equal(db.counts().collections, 1);
    assert.equal(db.raw('SELECT * FROM collection_assets').length, 1);
  } finally { db.close(); }
});

test('重新打开同一个库不会重复执行迁移', () => {
  const dir = temp();
  const file = path.join(dir, 'library.db');
  const first = createLibraryDb({Database, file});
  first.writeValues(values, {replace: true});
  first.setMeta('snapshot_at', '123');
  const applied = first.counts().migrations;
  first.close();
  const second = createLibraryDb({Database, file});
  try {
    // 与首次打开后的版本数比对，而不是钉死某个版本号：新增迁移不应让这条测试变红。
    assert.equal(second.counts().migrations, applied, '重新打开不应重复套用迁移');
    assert.equal(second.getMeta('snapshot_at'), '123');
    assert.equal(second.counts().assets, 2);
  } finally { second.close(); fs.rmSync(dir, {recursive: true, force: true}); }
});

test('篡改过的历史迁移拒绝打开，保护旧库不被破坏', () => {
  const dir = temp();
  const file = path.join(dir, 'library.db');
  const raw = new Database(file);
  raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)');
  raw.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?, ?)').run('core', 'wrong', 'now');
  raw.close();
  assert.throws(() => createLibraryDb({Database, file}), /checksum 不匹配/);
  fs.rmSync(dir, {recursive: true, force: true});
});
