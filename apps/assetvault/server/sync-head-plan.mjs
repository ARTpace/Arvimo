/**
 * 未接线的 v2 head 提交计划器，仅校验内存输入并构造条件请求元数据。
 * 不执行 I/O、网络或 CAS，不依赖时间戳裁胜；调用方仍须真实执行条件提交。
 */
import {types} from 'node:util';

const HASH = /^[a-f0-9]{64}(?![\s\S])/;
// RFC entity-tag：强 quoted opaque-tag，不接受弱标签、列表、空白修剪或控制字符。
const STRONG_ETAG = /^"[\x21\x23-\x7e\x80-\xff]*"(?![\s\S])/;
const invalid = message => { throw new TypeError(`同步 head 计划无效：${message}`); };

function exactData(value, fields, label) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) invalid(`${label} 必须是 plain JSON 对象`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} 原型不合法`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) invalid(`${label} 字段不匹配`);
  const result = Object.create(null);
  for (const key of fields) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid(`${label} 不接受访问器或隐藏属性`);
    result[key] = descriptor.value;
  }
  return result;
}

const hash = value => typeof value === 'string' && HASH.test(value);

export function planSyncHeadCommit(input) {
  const {previous, rawEtag, snapshotHash, commitId} = exactData(input,
    ['previous', 'rawEtag', 'snapshotHash', 'commitId'], 'input');
  if (!hash(snapshotHash) || !hash(commitId)) invalid('snapshotHash / commitId 必须是小写 64 位十六进制');
  if (previous === null) {
    if (rawEtag !== null) invalid('首次提交 rawEtag 必须为 null');
    return {
      head: {schemaVersion: 1, generation: 1, commitId, parentCommit: null, snapshotHash},
      condition: {ifNoneMatch: '*'},
    };
  }
  const old = exactData(previous,
    ['schemaVersion', 'generation', 'commitId', 'parentCommit', 'snapshotHash'], 'previous');
  if (old.schemaVersion !== 1 || !Number.isSafeInteger(old.generation) || old.generation < 1 ||
      !hash(old.commitId) || !hash(old.snapshotHash) || !(old.parentCommit === null || hash(old.parentCommit))) {
    invalid('previous schema 或字段值不合法');
  }
  if (typeof rawEtag !== 'string' || !STRONG_ETAG.test(rawEtag)) invalid('更新必须提供原样强 quoted ETag');
  if (old.generation === Number.MAX_SAFE_INTEGER) invalid('generation 溢出');
  if (commitId === old.commitId) invalid('新旧 commitId 不可相同');
  return {
    head: {schemaVersion: 1, generation: old.generation + 1, commitId, parentCommit: old.commitId, snapshotHash},
    condition: {ifMatch: rawEtag},
  };
}
