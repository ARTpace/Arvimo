import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSyncRecord} from '../server/sync-three-way.mjs';

const merge = (base, local, remote) => mergeSyncRecord({base, local, remote});
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

test('无变化、单端改变、双方同改收敛，顶层独立字段分别合并', () => {
  assert.deepEqual(merge({}, {}, {}), {record: {}, conflicts: []});
  assert.deepEqual(merge({note: '旧', rating: 1}, {note: '新', rating: 1}, {note: '旧', rating: 2}),
    {record: {note: '新', rating: 2}, conflicts: []});
  assert.deepEqual(merge({note: '旧'}, {note: '新'}, {note: '新'}), {record: {note: '新'}, conflicts: []});
  assert.deepEqual(merge({note: '旧'}, {note: '旧'}, {note: '远端'}).record, {note: '远端'});
});

test('缺失与 null、空字符串、零、false、空数组分别保留，不以 truthy 合并', () => {
  for (const value of [null, '', 0, false, []]) {
    assert.deepEqual(merge({x: '旧'}, {x: value}, {x: '旧'}), {record: {x: value}, conflicts: []});
    assert.deepEqual(merge({}, {x: value}, {}), {record: {x: value}, conflicts: []});
    assert.deepEqual(merge({x: value}, {}, {x: value}), {record: {}, conflicts: []});
    const result = merge({x: '旧'}, {}, {x: value});
    assert.deepEqual(result.record, {x: '旧'});
    assert.deepEqual(result.conflicts[0], {scope: 'field', field: 'x',
      base: {present: true, value: '旧'}, local: {present: false}, remote: {present: true, value}});
  }
  assert.deepEqual(merge({}, {x: null}, {x: ''}).record, {});
});

test('冲突保留 base 与双方值；时间戳不裁决其他字段胜负', () => {
  const result = merge({note: '基线', updatedAt: 1}, {note: '本地', updatedAt: 2}, {note: '远端', updatedAt: 999});
  assert.deepEqual(result.record, {note: '基线', updatedAt: 1});
  assert.deepEqual(result.conflicts.map(item => item.field), ['note', 'updatedAt']);
  assert.deepEqual(result.conflicts[0], {scope: 'field', field: 'note', base: {present: true, value: '基线'},
    local: {present: true, value: '本地'}, remote: {present: true, value: '远端'}});
});

test('对象键顺序无关、嵌套按原子字段，数组顺序有意义且不求并集', () => {
  assert.deepEqual(merge({x: {a: 1, b: 2}}, {x: {b: 2, a: 1}}, {x: {a: 3}}),
    {record: {x: {a: 3}}, conflicts: []});
  const nested = merge({x: {a: 1, b: 2}}, {x: {a: 3, b: 2}}, {x: {a: 1, b: 4}});
  assert.equal(nested.conflicts.length, 1);
  assert.deepEqual(nested.record, {x: {a: 1, b: 2}});
  const arrays = merge({tags: ['a', 'b']}, {tags: ['b', 'a']}, {tags: ['a']});
  assert.equal(arrays.conflicts.length, 1);
  assert.deepEqual(arrays.record.tags, ['a', 'b']);
  assert.deepEqual(merge({tags: ['a']}, {tags: []}, {tags: ['a']}).record.tags, []);
});

test('单端显式删除和恢复传播，缺失整个记录不偷偷当删除', () => {
  const live = {deleted: false, note: '旧'};
  assert.deepEqual(merge(live, {...live, deleted: true}, live), {record: {deleted: true, note: '旧'}, conflicts: []});
  const tombstone = {...live, deleted: true};
  assert.deepEqual(merge(tombstone, tombstone, live), {record: live, conflicts: []});
  assert.deepEqual(merge(live, tombstone, tombstone), {record: tombstone, conflicts: []});
  for (const missing of [null, undefined]) {
    assert.throws(() => merge(live, missing, live), TypeError);
    assert.throws(() => merge(live, live, missing), TypeError);
    assert.throws(() => merge(missing, live, live), TypeError);
  }
});

test('删除对编辑/恢复为 record 冲突，保留整条 base，不混合写入删除记录', () => {
  const base = {deleted: false, note: '基线', rating: 1};
  const deleted = {...base, deleted: true};
  const edited = {...base, note: '新备注', rating: 5};
  for (const [local, remote] of [[deleted, edited], [edited, deleted]]) {
    const result = merge(base, local, remote);
    assert.deepEqual(result.record, base);
    assert.deepEqual(result.conflicts, [{scope: 'record', reason: 'delete_vs_edit',
      base: {present: true, value: base}, local: {present: true, value: local}, remote: {present: true, value: remote}}]);
  }
  const restored = {...deleted, deleted: false};
  const editedTombstone = {...deleted, note: '墓碑被编辑'};
  assert.equal(merge(deleted, restored, editedTombstone).conflicts[0].scope, 'record');
});

test('冻结输入、共享引用允许，输出及冲突快照不共享输入引用', () => {
  const shared = {a: [1, 2]};
  const base = freeze({x: shared, y: shared});
  const local = freeze({x: {a: [3]}, y: shared});
  const remote = freeze({x: {a: [4]}, y: shared});
  const result = merge(base, local, remote);
  result.record.y.a.push(5);
  result.conflicts[0].base.value.a.push(6);
  assert.deepEqual(base.y.a, [1, 2]);
  assert.deepEqual(result.record.x.a, [1, 2]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(merge(Object.create(null), {}, {}), {record: {}, conflicts: []});
});

test('拒绝非严格 JSON、稀疏数组、访问器、循环、原型污染键且不执行 getter', () => {
  const cyclic = {}; cyclic.x = cyclic;
  const accessor = {}; Object.defineProperty(accessor, 'x', {get() { throw Error('不应执行 getter'); }, enumerable: true});
  const hidden = {}; Object.defineProperty(hidden, 'x', {value: 1});
  const extraArray = [1]; extraArray.extra = 2;
  class CustomArray extends Array {}
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol('x'), new Date(), new Map(),
    new Set(), /x/, new Float32Array([1]), new CustomArray(1), cyclic, accessor, hidden, new Array(2), extraArray, Object.assign({}, {[Symbol('x')]: 1})]) {
    assert.throws(() => merge({}, {x: value}, {}), TypeError);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const polluted = JSON.parse(`{"nested":{"${key}":{"polluted":true}}}`);
    assert.throws(() => merge({}, polluted, {}), /不安全/);
  }
  assert.equal({}.polluted, undefined);
  assert.throws(() => merge({}, Object.create({inherited: true}), {}), TypeError);
  for (const value of [null, 'true', 1]) assert.throws(() => merge({}, {deleted: value}, {}), /deleted/);
});
