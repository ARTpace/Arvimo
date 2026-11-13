import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {encodeSyncSnapshot, decodeSyncSnapshot} from '../server/sync-snapshot-object.mjs';

const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const decode = buffer => decodeSyncSnapshot(buffer, {hash: digest(buffer), bytes: buffer.length});
const raw = value => Buffer.from(JSON.stringify(value));
const MAX = 8 * 1024 * 1024;

test('固定封装编码、SHA-256、键序确定且数组顺序保留', () => {
  const encoded = encodeSyncSnapshot({z: [2, 1], a: {y: false, x: '中文'}});
  const expected = Buffer.from('{"schemaVersion":1,"snapshot":{"a":{"x":"中文","y":false},"z":[2,1]}}');
  assert.deepEqual(encoded.buffer, expected);
  assert.equal(encoded.hash, digest(expected));
  assert.equal(encoded.bytes, expected.length);
  assert.deepEqual(encodeSyncSnapshot({a: {x: '中文', y: false}, z: [2, 1]}), encoded);
  assert.notEqual(encodeSyncSnapshot({a: {x: '中文', y: false}, z: [1, 2]}).hash, encoded.hash);
  assert.deepEqual(decodeSyncSnapshot(encoded.buffer, {hash: encoded.hash, bytes: encoded.bytes}), {a: {x: '中文', y: false}, z: [2, 1]});
});

test('多字节按 UTF-8 限制，恰好 8 MiB 接受，多一字节拒绝', () => {
  const overhead = encodeSyncSnapshot({x: ''}).bytes;
  const value = '中'.repeat(Math.floor((MAX - overhead) / 3)) + 'a'.repeat((MAX - overhead) % 3);
  const encoded = encodeSyncSnapshot({x: value});
  assert.equal(encoded.bytes, MAX);
  assert.equal(decodeSyncSnapshot(encoded.buffer, {hash: encoded.hash, bytes: MAX}).x, value);
  assert.throws(() => encodeSyncSnapshot({x: `${value}a`}), /上限/);
  const over = Buffer.concat([encoded.buffer, Buffer.from(' ')]);
  assert.throws(() => decodeSyncSnapshot(over, {hash: digest(over), bytes: over.length}), TypeError);
});

test('输入冻结且输出 detached，null prototype 对象可用', () => {
  const input = Object.freeze({a: Object.freeze([Object.freeze({x: null})]), zero: 0, no: false, empty: ''});
  const encoded = encodeSyncSnapshot(input);
  const decoded = decodeSyncSnapshot(encoded.buffer, {hash: encoded.hash, bytes: encoded.bytes});
  decoded.a[0].x = '新';
  assert.equal(input.a[0].x, null);
  const nullProto = Object.create(null); nullProto.x = 1;
  assert.deepEqual(decode(encodeSyncSnapshot(nullProto).buffer), {x: 1});
});

test('tamper、hash格式、bytes类型/范围/实际不一致均拒绝', () => {
  const encoded = encodeSyncSnapshot({a: 1});
  const changed = Buffer.from(encoded.buffer); changed[changed.length - 3] ^= 1;
  assert.throws(() => decodeSyncSnapshot(changed, {hash: encoded.hash, bytes: encoded.bytes}), /SHA-256/);
  for (const hash of ['A'.repeat(64), 'x'.repeat(64), 'a'.repeat(63), null, 0]) {
    assert.throws(() => decodeSyncSnapshot(encoded.buffer, {hash, bytes: encoded.bytes}), TypeError);
  }
  for (const bytes of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', encoded.bytes - 1]) {
    assert.throws(() => decodeSyncSnapshot(encoded.buffer, {hash: encoded.hash, bytes}), TypeError);
  }
  assert.throws(() => decodeSyncSnapshot(new Uint8Array(encoded.buffer), {hash: encoded.hash, bytes: encoded.bytes}), /Buffer/);
  assert.throws(() => decodeSyncSnapshot(encoded.buffer, {hash: encoded.hash, bytes: encoded.bytes, extra: 1}), TypeError);
});

test('损坏 UTF-8/JSON 与未知版本/字段/根类型拒绝，校验成功不等于任意JSON可用', () => {
  for (const buffer of [Buffer.from([0xc3, 0x28]), Buffer.from('{'), raw({schemaVersion: 2, snapshot: {}}),
    raw({schemaVersion: '1', snapshot: {}}), raw({schemaVersion: 1, snapshot: {}, extra: true}), raw({snapshot: {}}),
    raw({schemaVersion: 1, snapshot: null}), raw({schemaVersion: 1, snapshot: []}), raw([]), raw(null),
    Buffer.from('{"schemaVersion":1,"snapshot":{"x":1e999}}'), Buffer.from('{"schemaVersion":1,"snapshot":{"__proto__":{}}}')]) {
    assert.throws(() => decode(buffer), TypeError);
  }
});

test('拒绝特殊JSON值、循环、稀疏/额外属性和污染键', () => {
  const cycle = {}; cycle.x = cycle;
  const extra = [1]; extra.other = 1;
  class CustomArray extends Array {}
  for (const value of [undefined, NaN, Infinity, 1n, Symbol(), () => {}, new Date(), new Map(), /x/, new Uint8Array([1]),
    cycle, new Array(2), extra, new CustomArray(1), Object.create({inherited: 1})]) {
    assert.throws(() => encodeSyncSnapshot({x: value}), TypeError);
  }
  for (const value of [null, [], 1, 'x', undefined]) assert.throws(() => encodeSyncSnapshot(value), TypeError);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => encodeSyncSnapshot(JSON.parse(`{"nested":{"${key}":1}}`)), TypeError);
  }
  assert.equal({}.polluted, undefined);
});

test('参数错误和嵌套恶意输入不执行 getter/toJSON/Proxy traps', () => {
  let executed = 0;
  const evil = {};
  Object.defineProperty(evil, 'x', {enumerable: true, get() { executed++; return 1; }});
  assert.throws(() => encodeSyncSnapshot(evil), TypeError);
  assert.throws(() => encodeSyncSnapshot({x: evil}), TypeError);
  const metadata = {};
  Object.defineProperty(metadata, 'hash', {enumerable: true, get() { executed++; return 'a'.repeat(64); }});
  assert.throws(() => decodeSyncSnapshot(Buffer.from('{}'), metadata), TypeError);
  const toJSON = {toJSON() { executed++; return {}; }};
  assert.throws(() => encodeSyncSnapshot(toJSON), TypeError);
  const proxy = new Proxy({}, {getPrototypeOf() { executed++; return Object.prototype; }, ownKeys() { executed++; return []; }});
  assert.throws(() => encodeSyncSnapshot(proxy), TypeError);
  assert.throws(() => encodeSyncSnapshot({x: proxy}), TypeError);
  assert.throws(() => decodeSyncSnapshot(Buffer.from('{}'), proxy), TypeError);
  const hidden = {}; Object.defineProperty(hidden, 'x', {value: 1});
  assert.throws(() => encodeSyncSnapshot(hidden), TypeError);
  assert.equal(executed, 0);
});
