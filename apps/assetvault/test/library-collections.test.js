// 合集服务：验证「assets 派生表整批重建后合集仍然存活」这条核心设计。
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {
  listCollections, saveCollection, deleteCollection, setCollectionItems,
  collectionUids, saveSmartRule,
} from '../server/library-collections.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
const NOW = 1_700_000_000_000;
const state = {'sfx-library-v2': JSON.stringify({version: 2, models: [{uid: a, name: 'A'}, {uid: b, name: 'B'}], favorites: [], aiTags: {}, userTags: {}, userMeta: {}, trashed: [], history: [], tasks: [], options: {}})};
const fixture = () => createLibraryDb({Database, file: ':memory:'});

test('新建 / 改名 / 排序 / 列表带资产数量', () => {
  const db = fixture();
  try {
    const id = saveCollection(db, {name: '  项目A  ', description: '石头', color: '#f00', position: 2}, NOW);
    assert.match(id, /^c-[a-f0-9]{16}$/);
    assert.deepEqual(listCollections(db).map(item => [item.name, item.position, item.color, item.assetCount]), [['项目A', 2, '#f00', 0]]);
    saveCollection(db, {id, name: '项目A-改'}, NOW);
    assert.equal(listCollections(db)[0].name, '项目A-改');
    assert.equal(listCollections(db)[0].createdAt, NOW, '更新不改创建时间');
  } finally { db.close(); }
});

test('add / remove / set 三种操作与去重', () => {
  const db = fixture();
  try {
    const id = saveCollection(db, {name: 'X'}, NOW);
    assert.deepEqual(setCollectionItems(db, id, [a, b, a], 'add'), {count: 2});
    assert.deepEqual([...collectionUids(db, id)].sort(), [a, b].sort());
    setCollectionItems(db, id, [a], 'remove');
    assert.deepEqual([...collectionUids(db, id)], [b]);
    setCollectionItems(db, id, [c, a], 'set');
    assert.deepEqual([...collectionUids(db, id)].sort(), [a, c].sort());
    assert.equal(listCollections(db)[0].assetCount, 2);
    assert.throws(() => setCollectionItems(db, id, [], 'wat'), /不支持/);
  } finally { db.close(); }
});

test('派生表整批重建不会清空合集（collection_assets 存 uid 而非外键）', () => {
  const db = fixture();
  try {
    const id = saveCollection(db, {name: '跨重建'}, NOW);
    setCollectionItems(db, id, [a], 'add');
    db.writeValues(state, {replace: true, stamp: NOW});
    db.writeValues({...state, 'sfx-library-ui': '{}'}, {replace: true, stamp: NOW});
    assert.equal(db.counts().assets, 2);
    assert.deepEqual([...collectionUids(db, id)], [a], '重建 assets 后合集归属仍在');
    assert.equal(listCollections(db)[0].assetCount, 1);
  } finally { db.close(); }
});

test('父子层级：删除父合集只把子合集提升为顶层，不连带删除', () => {
  const db = fixture();
  try {
    const parent = saveCollection(db, {name: '父'}, NOW);
    const child = saveCollection(db, {name: '子', parentId: parent}, NOW);
    assert.equal(listCollections(db).find(item => item.id === child).parentId, parent);
    assert.equal(deleteCollection(db, parent), true);
    assert.equal(listCollections(db).length, 1);
    assert.equal(listCollections(db)[0].parentId, null);
    assert.equal(deleteCollection(db, 'missing'), false);
    assert.throws(() => saveCollection(db, {id: child, name: '子', parentId: child}), /自己/);
    assert.throws(() => saveCollection(db, {name: '孤儿', parentId: 'nope'}), /上级合集不存在/);
    assert.throws(() => saveCollection(db, {name: '   '}), /名称不能为空/);
  } finally { db.close(); }
});

test('智能合集只存规则、不存结果快照；删除时三张表一起清理', () => {
  const db = fixture();
  try {
    const id = saveCollection(db, {name: '高分资产', smart: {q: 'rating:4', filters: {favorite: true}, sort: 'rating'}}, NOW);
    const item = listCollections(db).find(entry => entry.id === id);
    assert.deepEqual(item.smart, {q: 'rating:4', filters: {favorite: true}, sort: 'rating', sortOrder: 'asc', seed: ''});
    assert.equal(db.all('SELECT count(*) AS n FROM smart_collections', [])[0].n, 1);
    saveSmartRule(db, id, {q: 'tag:stone', filters: null, sort: 'no-such-sort'});
    assert.deepEqual(listCollections(db)[0].smart, {q: 'tag:stone', filters: {}, sort: 'recent', sortOrder: 'asc', seed: ''});
    setCollectionItems(db, id, [a], 'set');
    assert.equal(deleteCollection(db, id), true);
    assert.equal(db.all('SELECT count(*) AS n FROM collection_assets', [])[0].n, 0);
    assert.equal(db.all('SELECT count(*) AS n FROM smart_collections', [])[0].n, 0);
  } finally { db.close(); }
});
