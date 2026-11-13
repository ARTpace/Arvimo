import test from 'node:test';
import assert from 'node:assert/strict';
import {planSyncHeadCommit} from '../server/sync-head-plan.mjs';

const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const old = () => ({schemaVersion: 1, generation: 3, commitId: a, parentCommit: null, snapshotHash: b});
const update = () => ({previous: old(), rawEtag: '"opaque-etag"', snapshotHash: c, commitId: b});

test('初建仅使用 ifNoneMatch 星号，generation1且无parent', () => {
  assert.deepEqual(planSyncHeadCommit({previous: null, rawEtag: null, snapshotHash: a, commitId: b}), {
    head: {schemaVersion: 1, generation: 1, commitId: b, parentCommit: null, snapshotHash: a},
    condition: {ifNoneMatch: '*'},
  });
  for (const rawEtag of [undefined, '', '"etag"', '*']) {
    assert.throws(() => planSyncHeadCommit({previous: null, rawEtag, snapshotHash: a, commitId: b}), TypeError);
  }
});

test('更新绑定旧commit、递增generation，ETag原样保留', () => {
  const input = update();
  input.rawEtag = '"a,b\\opaque-ÿ"';
  assert.deepEqual(planSyncHeadCommit(input), {
    head: {schemaVersion: 1, generation: 4, commitId: b, parentCommit: a, snapshotHash: c},
    condition: {ifMatch: input.rawEtag},
  });
});

test('缺失/弱/列表/控制字符/非quoted ETag一律失败关闭', () => {
  for (const rawEtag of [undefined, null, '', '*', 'abc', 'W/"abc"', 'w/"abc"', '"a", "b"',
    ' "a"', '"a" ', '"a"\n', '"a\r\nb"', '"a\nb"', '"a\tb"', '"a\x7fb"', '"中文"']) {
    assert.throws(() => planSyncHeadCommit({...update(), rawEtag}), TypeError, String(rawEtag));
  }
});

test('generation溢出与复用commit拒绝，最大合法递增可用', () => {
  const input = update();
  input.previous.generation = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(planSyncHeadCommit(input).head.generation, Number.MAX_SAFE_INTEGER);
  input.previous.generation = Number.MAX_SAFE_INTEGER;
  assert.throws(() => planSyncHeadCommit(input), /溢出/);
  assert.throws(() => planSyncHeadCommit({...update(), commitId: a}), /不可相同/);
});

test('previous严格exact schema，拒绝非JSON/额外键/危险原型', () => {
  for (const previous of [undefined, [], new Date(), Object.create({}), 'head', 1, true,
    {...old(), schemaVersion: 2}, {...old(), schemaVersion: '1'}, {...old(), generation: 0},
    {...old(), generation: -1}, {...old(), generation: 1.2}, {...old(), generation: NaN},
    {...old(), generation: Infinity}, {...old(), generation: 1n}, {...old(), generation: '1'},
    {...old(), commitId: a.toUpperCase()}, {...old(), parentCommit: ''}, {...old(), snapshotHash: null},
    {...old(), extra: null}, {...old(), toJSON() { throw Error('must not execute'); }},
    JSON.parse(JSON.stringify(old()).replace('"schemaVersion":1', '"__proto__":{},"schemaVersion":1'))]) {
    assert.throws(() => planSyncHeadCommit({...update(), previous}), TypeError);
  }
  const missing = old(); delete missing.parentCommit;
  assert.throws(() => planSyncHeadCommit({...update(), previous: missing}), TypeError);
  const symbol = {...old(), [Symbol('hidden')]: 1};
  assert.throws(() => planSyncHeadCommit({...update(), previous: symbol}), TypeError);
  const hidden = old(); Object.defineProperty(hidden, 'commitId', {value: a, enumerable: false});
  assert.throws(() => planSyncHeadCommit({...update(), previous: hidden}), TypeError);
  const nullProto = Object.assign(Object.create(null), old());
  assert.equal(planSyncHeadCommit({...update(), previous: nullProto}).head.parentCommit, a);
});

test('输入与previous访问器及Proxy完全不执行', () => {
  let calls = 0;
  for (const key of ['previous', 'rawEtag', 'snapshotHash', 'commitId']) {
    const input = update();
    Object.defineProperty(input, key, {enumerable: true, get() { calls += 1; throw Error('getter'); }});
    assert.throws(() => planSyncHeadCommit(input), TypeError);
  }
  for (const key of Object.keys(old())) {
    const previous = old();
    Object.defineProperty(previous, key, {enumerable: true, get() { calls += 1; throw Error('getter'); }});
    assert.throws(() => planSyncHeadCommit({...update(), previous}), TypeError);
  }
  const proxy = new Proxy({}, {getPrototypeOf() { calls += 1; throw Error('trap'); }, ownKeys() { calls += 1; throw Error('trap'); }});
  assert.throws(() => planSyncHeadCommit(proxy), TypeError);
  assert.throws(() => planSyncHeadCommit({...update(), previous: proxy}), TypeError);
  assert.equal(calls, 0);
});

test('输入hash严格格式与输入对象exact校验', () => {
  for (const key of ['snapshotHash', 'commitId']) {
    for (const value of [null, undefined, a.toUpperCase(), a + '\n', 'a'.repeat(63), 'g'.repeat(64), {}, 123]) {
      assert.throws(() => planSyncHeadCommit({...update(), [key]: value}), TypeError);
    }
  }
  for (const input of [undefined, null, [], {...update(), extra: true}, Object.create(update())]) {
    assert.throws(() => planSyncHeadCommit(input), TypeError);
  }
});

test('冻结输入不变，输出每次独立且不保留输入引用', () => {
  const previous = Object.freeze(old());
  const input = Object.freeze({...update(), previous});
  const before = JSON.stringify(input);
  const first = planSyncHeadCommit(input), second = planSyncHeadCommit(input);
  assert.notEqual(first, second);
  assert.notEqual(first.head, second.head);
  assert.notEqual(first.condition, second.condition);
  first.head.parentCommit = 'mutated';
  first.condition.ifMatch = 'mutated';
  assert.equal(second.head.parentCommit, a);
  assert.equal(second.condition.ifMatch, input.rawEtag);
  assert.equal(JSON.stringify(input), before);
});
