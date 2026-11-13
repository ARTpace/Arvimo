// 阶段 4：前后端共用的差量协议（src/library/state-mutations.js）纯函数契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffMainState, applyMutations, stable, validateMutationValue,
  MAX_MUTATION_OPS, MAIN_STATE_KEY,
} from '../src/library/state-mutations.js';

const uid = char => char.repeat(32);
const a = uid('a'), b = uid('b');
const base = (over = {}) => ({
  version: 2, models: [{uid: a, name: '石灯', tags: ['stone'], addedAt: 1}],
  aiTags: {}, userMeta: {}, userTags: {}, favorites: [], history: [], tasks: [], trashed: [], options: {}, ...over,
});
const raw = value => JSON.stringify(value);

test('diff 只产出变化的键；apply 重放后与整块写入完全等价', () => {
  const before = base();
  const after = base({
    userMeta: {[a]: {rating: 5, note: '项目A'}}, userTags: {[b]: ['常用']},
    favorites: [a], history: [{kind: 'search', params: {q: '石灯'}}],
  });
  const diff = diffMainState(raw(before), raw(after));
  assert.ok(diff, '纯元数据变化必须可差量');
  assert.equal(diff.unchanged, false);
  assert.equal(diff.ops.length, 4, 'userMeta / userTags / favorites / history 各一条');
  assert.deepEqual(diff.ops.map(op => op.field).sort(), ['favorites', 'history', 'userMeta', 'userTags']);
  assert.deepEqual(applyMutations(before, diff.ops), after, '重放结果必须等于整块写入');
  assert.deepEqual(applyMutations(applyMutations(before, diff.ops), diff.ops), after, '绝对赋值语义必须幂等');
  assert.equal(diff.data.version, 2, '返回已解析的 after 供前端缓存');
  assert.equal(MAIN_STATE_KEY, 'sfx-library-v2');
});

test('键级差量：两个来源分别改不同资产，互不覆盖', () => {
  const current = base();
  const one = [{op: 'set', field: 'userMeta', key: a, value: {rating: 5, note: ''}}];
  const two = [{op: 'set', field: 'userMeta', key: b, value: {rating: 2, note: 'B'}}];
  const left = applyMutations(applyMutations(current, one), two);
  const right = applyMutations(applyMutations(current, two), one);
  assert.deepEqual(left, right, '顺序无关的绝对赋值');
  assert.equal(left.userMeta[a].rating, 5);
  assert.equal(left.userMeta[b].rating, 2);
  assert.equal(current.userMeta[a], undefined, 'applyMutations 不得改入参');
});

test('models / trashed / version / 未知字段变化一律退回整块', () => {
  const before = base();
  assert.equal(diffMainState(before, base({models: []})), null);
  assert.equal(diffMainState(before, base({trashed: [{uid: a, trashedAt: 1}]})), null);
  assert.equal(diffMainState(before, base({version: 3})), null);
  assert.equal(diffMainState(before, base({someNewField: 1})), null);
  assert.equal(diffMainState('{broken', raw(before)), null, '损坏的 before 不能当空库算差量');
});

test('stable 忽略键顺序，unchanged 的写入不产生 op', () => {
  assert.equal(stable({x: 1, y: [2, 3]}), stable({y: [2, 3], x: 1}));
  const before = base({userMeta: {[a]: {rating: 3, note: ''}}});
  const reordered = JSON.parse(raw({
    options: {}, tasks: [], history: [], trashed: [], favorites: [],
    userTags: {}, userMeta: {[a]: {note: '', rating: 3}}, aiTags: {},
    models: before.models, version: 2,
  }));
  const diff = diffMainState(before, reordered);
  assert.equal(diff.unchanged, true, '只是序列化顺序不同，不应触发写入');
  assert.deepEqual(diff.ops, []);
  assert.deepEqual(applyMutations(before, []), before);
});

test('非法键 / 非法值 / 超量 op 全部被拒，绝不写脏数据', () => {
  assert.equal(validateMutationValue('userMeta', {rating: 6, note: ''}, a), false);
  assert.equal(validateMutationValue('userMeta', {rating: 3, note: 'x'.repeat(2001)}, a), false);
  assert.equal(validateMutationValue('userTags', ['ok'], 'not-a-uid'), false);
  assert.equal(validateMutationValue('userTags', ['x'.repeat(201)], a), false);
  assert.equal(validateMutationValue('favorites', [a, 'oops']), false);
  assert.equal(validateMutationValue('userMeta', undefined, a), false);
  assert.throws(() => applyMutations(base(), [{op: 'set', field: 'models', value: []}]), /不支持的变更字段/);
  assert.throws(() => applyMutations(base(), [{op: 'delete', field: 'userMeta', key: 'short'}]), /32 位资产 uid/);
  assert.throws(() => applyMutations(base(), [{op: 'set', field: 'userMeta', key: a, value: {rating: 9, note: ''}}]), /变更值无效/);
  assert.throws(() => applyMutations(base(), new Array(MAX_MUTATION_OPS + 1).fill({op: 'set', field: 'favorites', value: []})), /变更数量超限/);
  assert.equal(diffMainState(base(), base({userTags: {'oops': ['x']}})), null, 'diff 阶段就挡住非法键，避免运行时才报错');
});

test('delete op 能移除单个键，且不碰同字段其它资产', () => {
  const current = base({userTags: {[a]: ['A'], [b]: ['B']}});
  const next = applyMutations(current, [{op: 'delete', field: 'userTags', key: a}]);
  assert.equal(next.userTags[a], undefined);
  assert.deepEqual(next.userTags[b], ['B']);
  const diff = diffMainState(current, next);
  assert.deepEqual(diff.ops, [{op: 'delete', field: 'userTags', key: a}]);
});
