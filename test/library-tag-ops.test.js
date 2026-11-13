// ADR-02 翻译层单测：一份「主状态 diff」必须被准确拆成按域的写入指令。
// 纯函数，不碰网络与数据库；任何看不懂的变化都必须 fallback 到整块写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import {translateStateChange} from '../src/library/tag-ops.js';

const a = 'a'.repeat(32), b = 'b'.repeat(32);
const state = (over = {}) => ({
  version: 2, models: [{uid: a, name: '石灯'}], trashed: [],
  aiTags: {}, userTags: {}, userMeta: {}, favorites: [],
  assetProbe: {}, history: [], tasks: [], options: {}, ...over,
});

test('没有变化时所有域都是空的 —— 一次空保存不该发任何请求体', () => {
  const result = translateStateChange(state(), state());
  assert.equal(result.fallback, false);
  assert.deepEqual(result.ops, []);
  assert.deepEqual(result.session, {});
  assert.equal(result.probe, null);
  assert.equal(result.catalog, null);
  assert.deepEqual(result.removes, []);
});

test('评分与备注各自成一个 asset.set，删除 uid 会清回默认值', () => {
  const before = state({userMeta: {[a]: {rating: 3, note: '旧备注'}}});
  const after = state({userMeta: {[a]: {rating: 5, note: '新备注'}, [b]: {rating: 0, note: ''}}});
  const {ops} = translateStateChange(before, after);
  assert.deepEqual(ops.filter(op => op.uid === a), [
    {op: 'asset.set', uid: a, field: 'rating', value: 5},
    {op: 'asset.set', uid: a, field: 'note', value: '新备注'},
  ]);
  assert.equal(ops.filter(op => op.uid === b).length, 0, '新加一个全默认值不产生 op');
  const cleared = translateStateChange(before, state()).ops;
  assert.deepEqual(cleared, [
    {op: 'asset.set', uid: a, field: 'rating', value: 0},
    {op: 'asset.set', uid: a, field: 'note', value: ''},
  ]);
});

test('标签是集合语义：只发差集，来源随字段走', () => {
  const before = state({userTags: {[a]: ['旧', '保留']}, aiTags: {[a]: ['模型']}});
  const after = state({userTags: {[a]: ['保留', '新']}, aiTags: {[a]: ['模型', '石材']}});
  assert.deepEqual(translateStateChange(before, after).ops, [
    {op: 'tag.remove', uid: a, source: 'user', value: '旧'},
    {op: 'tag.add', uid: a, source: 'user', value: '新'},
    {op: 'tag.add', uid: a, source: 'ai', value: '石材'},
  ]);
});

test('收藏只发翻转的那些 uid，重复提交幂等', () => {
  const before = state({favorites: [a]});
  const after = state({favorites: [b]});
  assert.deepEqual(translateStateChange(before, after).ops, [
    {op: 'asset.set', uid: a, field: 'favorite', value: false},
    {op: 'asset.set', uid: b, field: 'favorite', value: true},
  ]);
  assert.deepEqual(translateStateChange(after, after).ops, []);
});

test('会话域、探测域各自独立，互不牵连', () => {
  const history = [{kind: 'search', params: {q: '石灯'}}];
  const probe = {[a]: {v: 1, hex: '#112233', h: 20, s: 0.3, l: 0.4, width: 1024, height: 1024, at: 1}};
  const result = translateStateChange(state(), state({history, assetProbe: probe}));
  assert.deepEqual(result.session, {history});
  assert.deepEqual(result.probe, probe);
  assert.equal(result.catalog, null, '只改会话与探测不该重写目录');
  assert.deepEqual(result.ops, []);
});

test('5.4：恢复拆成 asset:restore（不算删除）；回收站真正清空才发 removes', () => {
  const before = state({trashed: [{uid: b, name: '旧', trashedAt: 1}]});
  const restored = translateStateChange(before, state({models: [{uid: a, name: '石灯'}, {uid: b, name: '新'}], trashed: []}));
  assert.deepEqual(restored.removes, [], '恢复不是彻底删除');
  assert.equal(restored.restore.length, 1);
  assert.equal(restored.catalog, null, '纯移动不回传整块目录');

  const purged = translateStateChange(before, state());
  assert.deepEqual(purged.removes, [b]);
  assert.equal(purged.catalog, null, '5.4 起纯 purge 只发显式删除');
});

test('看不懂的变化一律 fallback：版本号、未知字段、脏 uid、超量 op', () => {
  assert.equal(translateStateChange(state(), state({version: 3})).fallback, true);
  assert.equal(translateStateChange(state(), state({futureField: 1})).fallback, true);
  assert.equal(translateStateChange(state(), state({userTags: {'不是 uid': ['标签']}})).fallback, true);
  assert.equal(translateStateChange(state(), state({favorites: ['不是 uid']})).fallback, true);
  assert.equal(translateStateChange(state(), state({options: []})).fallback, true);
  const many = Object.fromEntries(Array.from({length: 801}, (_, i) => [i.toString(16).padStart(32, '0'), {rating: 1, note: ''}]));
  assert.equal(translateStateChange(state(), state({userMeta: many})).fallback, true);
});
