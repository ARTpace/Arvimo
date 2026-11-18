import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {syncVocab} from '../server/vocab-sync.mjs';
import {tagFacetView} from '../server/library-tag-facets.mjs';

const state = models => ({'sfx-library-v2': JSON.stringify({
  models, aiTags: {}, userTags: {}, userMeta: {}, favorites: [], trashed: [],
})});

test('内置稳定 seed ID 改名保留 term_id、旧名称别名与排除；冲突回滚不推进版本',()=>{
 const db=createLibraryDb({Database,file:':memory:'});
 try{
  const native=db.native(),facets={subject:'题材'};
  syncVocab(native,{rev:100,facets,terms:[{id:'test-fixed',value:'测试旧名称',facets:['subject']}]});
  const id=db.all("SELECT term_id FROM tag_terms WHERE seed_key='test-fixed'")[0].term_id;
  db.run("INSERT INTO tag_rejections VALUES (?,?,?,?)",['a'.repeat(32),id,'ai',1]);
  syncVocab(native,{rev:101,facets,terms:[{id:'test-fixed',value:'测试新名称',facets:['subject']}]});
  assert.equal(db.all("SELECT term_id FROM tag_terms WHERE norm='测试新名称'")[0].term_id,id);
  assert.equal(db.all("SELECT term_id FROM tag_aliases WHERE alias_norm='测试旧名称'")[0].term_id,id);
  assert.equal(db.all('SELECT term_id FROM tag_rejections')[0].term_id,id);
  assert.throws(()=>syncVocab(native,{rev:102,facets,terms:[{id:'duplicate',value:'甲',facets:['subject']},{id:'duplicate',value:'乙',facets:['subject']}]}),/重复/);
  assert.equal(db.getMeta('vocab_rev'),'101');assert.equal(db.all("SELECT * FROM tag_terms WHERE norm='甲'").length,0);
 }finally{db.close();}
});

test('打开库即把种子词表激活，并把同名别名合并到 canonical', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  const uid = 'a'.repeat(32);
  try {
    db.writeValues(state([
      {uid, name: '石灯', tags: ['Stone', 'wood', '木头'], assetType: 'model', addedAt: 111},
    ]), {replace: true});

    // V2 迁移建的 pending 词条被种子转正；别名不单独留词条。
    const terms = db.raw("SELECT term_id, value, status FROM tag_terms WHERE norm IN ('石材','木材','stone','wood','木头') ORDER BY norm");
    assert.deepEqual(terms.map(row => [row.value, row.status]), [['木材', 'active'], ['石材', 'active']]);

    // 三条标签（Stone / wood / 木头）收敛到两条记录：「木材」被 wood 与 木头 重复命中，
    // 同 uid + 同 term + 同来源只保留一行（这正是集合语义该有的样子）。
    const ids = new Map(terms.map(row => [row.value, row.term_id]));
    const rows = db.raw('SELECT uid, term_id, source FROM asset_tags ORDER BY term_id');
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map(row => row.term_id)), new Set([ids.get('石材'), ids.get('木材')]));

    // 面是边：双面词同时出现在两个面下。
    const facets = db.raw(`SELECT facet FROM tag_facets WHERE term_id = ${ids.get('木材')} ORDER BY facet`);
    assert.deepEqual(facets.map(row => row.facet), ['material', 'subject']);

    // 层级解析成 term_id，不是字符串。
    const oak = db.raw("SELECT parent_id FROM tag_terms WHERE value = '橡木'")[0];
    assert.equal(oak.parent_id, ids.get('木材'));

    // 别名表可反查，且指向 canonical。
    assert.equal(db.raw("SELECT term_id FROM tag_aliases WHERE alias_norm = 'wood'")[0].term_id, ids.get('木材'));
  } finally { db.close(); }
});

test('词表同步幂等：rev 不变不重复写，计数随重建刷新', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  const uid = 'b'.repeat(32);
  try {
    db.writeValues(state([{uid, name: '木箱', tags: ['wood'], assetType: 'model', addedAt: 1}]), {replace: true});
    const before = db.raw('SELECT count(*) AS n FROM tag_terms')[0].n;
    assert.equal(syncVocab(db.native()).applied, false);
    assert.equal(db.raw('SELECT count(*) AS n FROM tag_terms')[0].n, before);

    const wood = db.raw("SELECT term_id FROM tag_terms WHERE value = '木材'")[0].term_id;
    const counted = db.raw(`SELECT asset_count FROM tag_counts WHERE term_id = ${wood}`)[0];
    assert.equal(counted.asset_count, 1);
  } finally { db.close(); }
});

test('库里已有的别名旧词条会被真正合并，而不是并存', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  const uid = 'c'.repeat(32);
  try {
    db.writeValues(state([{uid, name: '木箱', tags: ['wood'], assetType: 'model', addedAt: 1}]), {replace: true});
    // 模拟「词表还没有这个词」时期的脏数据：手动插一条 pending 的 wood，并挂到资产上。
    db.exec(`INSERT INTO tag_terms (value, norm, status, created_at) VALUES ('wood', 'wood', 'pending', 1)`);
    const stale = db.raw("SELECT term_id FROM tag_terms WHERE norm = 'wood'")[0].term_id;
    const target = db.raw("SELECT term_id FROM tag_terms WHERE value = '木材'")[0].term_id;
    assert.notEqual(stale, target);

    db.exec(`INSERT OR IGNORE INTO asset_tags (uid, term_id, source, created_at) VALUES ('${uid}', ${stale}, 'user', 1)`);
    // rev 写回旧版本，模拟词表升级触发一次同步。
    db.exec("UPDATE db_meta SET value = '0' WHERE key = 'vocab_rev'");
    assert.equal(syncVocab(db.native()).merged >= 1, true);

    const merged = db.raw(`SELECT status, merged_into FROM tag_terms WHERE term_id = ${stale}`)[0];
    assert.deepEqual(merged, {status: 'merged', merged_into: target});
    // 挂在旧词上的标签已经迁到 canonical，旧 term 不再持有任何资产。
    assert.equal(db.raw(`SELECT count(*) AS n FROM asset_tags WHERE term_id = ${stale}`)[0].n, 0);
    assert.equal(db.raw(`SELECT count(*) AS n FROM asset_tags WHERE term_id = ${target}`)[0].n >= 1, true);
  } finally { db.close(); }
});

test('分面视图：一个词挂多个面，计数按资产去重且各面一致', () => {
  const db = createLibraryDb({Database, file: ':memory:'});
  const a = 'd'.repeat(32), b = 'e'.repeat(32);
  try {
    db.writeValues({
      'sfx-library-v2': JSON.stringify({
        models: [
          {uid: a, name: '木椅', tags: ['wood', '卡通'], assetType: 'model', addedAt: 1},
          {uid: b, name: '木桌', tags: ['wood'], assetType: 'model', addedAt: 2},
        ],
        aiTags: {}, userTags: {[b]: ['stone']}, userMeta: {}, favorites: [], trashed: [],
      }),
    }, {replace: true});

    const view = tagFacetView(db, {limit: 0});
    const facet = key => view.facets.find(item => item.key === key);
    const pick = (key, value) => facet(key).values.find(item => item.value === value);
    const woodMaterial = pick('material', '木材');
    const woodSubject = pick('subject', '木材');
    assert.equal(woodMaterial.count, 2);
    assert.equal(woodSubject.count, 2, '同一个词在两个面下的数字必须相等');

    // 用户标签 stone 归一到 石材，同样挂在两个面下。
    assert.equal(pick('material', '石材').count, 1);
    assert.equal(pick('subject', '石材').count, 1);

    assert.ok(view.rev > 0);
    assert.equal(view.totals.pending, 0, '种子内的词都已 active');
    assert.deepEqual(view.facets.map(item => item.key), ['style', 'subject', 'material', 'usage', 'mood', 'tech', 'software', 'license', 'platform']);
  } finally { db.close(); }
});
