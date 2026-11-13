import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMainState, deriveAssetRows, deriveTagRows, deriveFtsRows, splitState, assembleState} from '../server/library-blob.mjs';

const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
const main = {
  version: 2,
  models: [{uid: a, name: '国风石灯', author: 'Artist', tags: ['stone'], addedAt: 111}, {uid: b, name: 'Robot', tags: ['mech']}],
  aiTags: {[a]: ['石头', 'stone']}, userTags: {[a]: ['常用'], [b]: []},
  userMeta: {[a]: {rating: 9, note: '项目A'}},
  favorites: [b],
  trashed: [{uid: c, name: 'Deleted', trashedAt: 222, userMeta: {rating: 2, note: '暂存'}, userTags: ['旧标签']}],
  history: [], tasks: [], options: {},
};

test('损坏的 blob 退化为空格而不是抛错', () => {
  assert.deepEqual(parseMainState('not json'), {});
  assert.deepEqual(parseMainState('[]'), {});
  assert.deepEqual(parseMainState(null), {});
});

test('assets 保留数组顺序、区分回收站、评分截断、还原收藏', () => {
  const rows = deriveAssetRows(main, 999);
  assert.deepEqual(rows.map(r => r.uid), [a, b, c]);
  assert.deepEqual(rows.map(r => r.state), ['active', 'active', 'trashed']);
  assert.equal(rows[0].rating, 5);
  assert.equal(rows[0].note, '项目A');
  assert.equal(rows[0].favorite, 0);
  assert.equal(rows[1].favorite, 1);
  assert.equal(rows[2].rating, 2);
  assert.equal(rows[2].trashed_at, 222);
  assert.deepEqual(JSON.parse(rows[0].payload), main.models[0]);
});

test('三层标签覆盖平台 / AI / 我的标签与回收站自带标签', () => {
  const rows = deriveTagRows(main);
  const has = (uid, kind, tag) => rows.some(r => r.uid === uid && r.kind === kind && r.tag === tag);
  assert.ok(has(a, 'platform', 'stone'));
  assert.ok(has(a, 'ai', '石头'));
  assert.ok(has(a, 'user', '常用'));
  assert.ok(has(c, 'user', '旧标签'));
  assert.equal(rows.length, new Set(rows.map(r => `${r.uid}\u0000${r.kind}\u0000${r.tag}`)).size);
});

test('splitState 只收白名单 key，FTS 文本保留中文', () => {
  const values = {'sfx-library-v2': JSON.stringify(main), 'sfx-library-ui': '{}', '../../bad': 'no'};
  const split = splitState(values, 1000);
  assert.deepEqual(split.state.map(row => row.key), ['sfx-library-v2', 'sfx-library-ui']);
  assert.equal(split.assets.length, 3);
  assert.ok(split.fts.find(row => row.uid === a).body.includes('国风石灯'));
  assert.ok(split.fts.find(row => row.uid === a).body.includes('石头'));
  assert.deepEqual(deriveFtsRows([], []), []);
});

test('assembleState 原样返回字符串，保证前端字节级一致', () => {
  const original = JSON.stringify(main);
  const assembled = assembleState([{key: 'sfx-library-v2', value: original}, {key: 'junk', value: 'x'}]);
  assert.equal(assembled['sfx-library-v2'], original);
  assert.equal(assembled.junk, undefined);
});
