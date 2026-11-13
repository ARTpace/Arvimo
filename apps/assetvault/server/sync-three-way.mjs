/**
 * 未启用的 v2 record planner；不接 v1、存储、网络、版本或 CAS。
 * 调用方必须提供同一记录的三个 plain JSON 对象，不接受缺失记录或 null
 * 来暗示删除。记录删除仅用 deleted:true，恢复用 deleted:false。
 * 数组是原子字段，顺序有意义；这里没有集合 add/remove 操作日志合并。
 * 时间戳只是普通字段，不参与胜负裁决。输入不修改，输出完全脱离输入引用。
 *
 * 返回 {record, conflicts}。字段冲突只保留该字段的 base；生命周期冲突
 * 保留整条 base。冲突快照用 {present, value?} 区分缺失与所有 JSON 空值。
 * 本 planner 不代表已实现双端同步或可安全提交，调用方仍须处理所有 conflicts。
 */
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const owns = (object, key) => Object.hasOwn(object, key);
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// 同时校验、复制、规范化对象键顺序，拒绝 JSON.stringify 会静默丢失的值。
function jsonCopy(value, ancestors = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (typeof value !== 'object' || value === null ||
      (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value))) {
    throw new TypeError('同步记录只接受严格 plain JSON 值');
  }
  if (ancestors.has(value) || depth > 100) throw new TypeError('同步记录循环引用或嵌套过深');
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== 'string' || forbidden.has(key)) throw new TypeError('同步记录包含不安全的属性键');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!owns(descriptor, 'value') || (!descriptor.enumerable && !(Array.isArray(value) && key === 'length'))) {
        throw new TypeError('同步记录不能包含访问器或隐藏属性');
      }
    }
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1 || !Array.from({length: value.length}, (_, i) => owns(value, String(i))).every(Boolean)) {
        throw new TypeError('同步记录数组不能稀疏或携带额外属性');
      }
      return value.map(item => jsonCopy(item, ancestors, depth + 1));
    }
    const result = {};
    for (const key of keys.sort()) result[key] = jsonCopy(value[key], ancestors, depth + 1);
    return result;
  } finally { ancestors.delete(value); }
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const snapshot = (record, field) => owns(record, field)
  ? {present: true, value: jsonCopy(record[field])} : {present: false};
const sameField = (a, b, key) => owns(a, key) === owns(b, key) && (!owns(a, key) || equal(a[key], b[key]));

export function mergeSyncRecord({base, local, remote} = {}) {
  for (const record of [base, local, remote]) {
    if (!plain(record) || Array.isArray(record)) throw new TypeError('base/local/remote 必须是完整 JSON 对象；删除须显式 deleted');
  }
  const b = jsonCopy(base), l = jsonCopy(local), r = jsonCopy(remote);
  for (const record of [b, l, r]) {
    if (owns(record, 'deleted') && typeof record.deleted !== 'boolean') throw new TypeError('deleted 必须是布尔值');
  }
  // 删除与另一端编辑、恢复与另一端墓碑编辑均不可被逐字段拼成一条记录。
  if (!equal(l, b) && !equal(r, b) && !equal(l, r) &&
      l.deleted !== r.deleted && (l.deleted === true || r.deleted === true)) {
    return {record: jsonCopy(b), conflicts: [{scope: 'record', reason: 'delete_vs_edit',
      base: {present: true, value: jsonCopy(b)}, local: {present: true, value: jsonCopy(l)},
      remote: {present: true, value: jsonCopy(r)}}]};
  }
  const record = {}, conflicts = [];
  const keys = [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].sort();
  for (const field of keys) {
    let selected;
    if (sameField(l, r, field)) selected = l;
    else if (sameField(b, l, field)) selected = r;
    else if (sameField(b, r, field)) selected = l;
    else {
      selected = b;
      conflicts.push({scope: 'field', field, base: snapshot(b, field), local: snapshot(l, field), remote: snapshot(r, field)});
    }
    if (owns(selected, field)) record[field] = jsonCopy(selected[field]);
  }
  return {record, conflicts};
}
