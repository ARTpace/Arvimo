/**
 * 未接线的 v2 不可变快照 codec，仅处理本地内存中的元数据。
 * 外包固定 {schemaVersion:1,snapshot}，上限为完整封装 UTF-8 的 8 MiB。
 * 对象键确定性排序、数组保留顺序；hash 是编码字节的 SHA-256 小写十六进制。
 * 不执行 getter/toJSON，不接 v1、网络、磁盘、CAS 或同步提交。
 */
import {createHash} from 'node:crypto';
import {types} from 'node:util';

const MAX_BYTES = 8 * 1024 * 1024;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalid = message => { throw new TypeError(`同步快照无效：${message}`); };

// 先检查描述符，再取其 data value，绝不访问输入属性；拒绝 Proxy 避免执行其 trap。
function copyJson(value, ancestors = new Set(), depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (typeof value !== 'object' || value === null || types.isProxy(value)) invalid('仅接受严格 JSON');
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)) invalid('特殊对象');
  if (ancestors.has(value) || depth > 100) invalid('循环引用或嵌套过深');
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    for (const key of keys) {
      if (typeof key !== 'string' || forbidden.has(key)) invalid('不安全属性键');
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || (!descriptor.enumerable && !(array && key === 'length'))) invalid('访问器或隐藏属性');
    }
    if (array) {
      const length = descriptors.length.value;
      if (keys.length !== length + 1) invalid('稀疏数组或额外属性');
      const result = [];
      for (let i = 0; i < length; i++) {
        if (!Object.hasOwn(descriptors, String(i))) invalid('稀疏数组');
        result.push(copyJson(descriptors[String(i)].value, ancestors, depth + 1));
      }
      return result;
    }
    const result = {};
    for (const key of keys.sort()) result[key] = copyJson(descriptors[key].value, ancestors, depth + 1);
    return result;
  } finally { ancestors.delete(value); }
}

export function encodeSyncSnapshot(snapshot) {
  if (!plain(snapshot)) invalid('snapshot 根必须是 plain JSON 对象');
  const object = {schemaVersion: 1, snapshot: copyJson(snapshot)};
  const text = JSON.stringify(object);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) invalid('超过 8 MiB UTF-8 上限');
  const buffer = Buffer.from(text, 'utf8');
  return {hash: digest(buffer), bytes, buffer};
}

export function decodeSyncSnapshot(buffer, metadata) {
  if (types.isProxy(buffer) || !Buffer.isBuffer(buffer)) invalid('输入必须是 Buffer');
  if (!plain(metadata)) invalid('完整性元信息必须是 plain 对象');
  const meta = copyJson(metadata);
  if (Object.keys(meta).length !== 2 || !Object.hasOwn(meta, 'hash') || !Object.hasOwn(meta, 'bytes') ||
      typeof meta.hash !== 'string' || !/^[a-f0-9]{64}$/.test(meta.hash) ||
      !Number.isSafeInteger(meta.bytes) || meta.bytes < 0 || meta.bytes > MAX_BYTES) invalid('hash 或 bytes 不合法');
  if (buffer.length > MAX_BYTES || buffer.length !== meta.bytes) invalid('字节数不匹配或超过上限');
  if (digest(buffer) !== meta.hash) invalid('SHA-256 不匹配');
  let object;
  try {
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(buffer);
    object = JSON.parse(text);
  } catch { invalid('UTF-8 或 JSON 损坏'); }
  if (!plain(object)) invalid('封装必须是对象');
  const validated = copyJson(object);
  if (Object.keys(validated).length !== 2 || validated.schemaVersion !== 1 ||
      !Object.hasOwn(validated, 'snapshot') || !plain(validated.snapshot)) invalid('未知 schema 或封装字段');
  return validated.snapshot;
}
