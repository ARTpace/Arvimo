// ADR-02 前端翻译层：把「整块主状态的变化」翻译成按域的写入指令。
//
// 为什么需要它：saveLibrary() 仍然产出一份完整 blob（业务代码完全不用改），
// 但这份 blob 在 50 万资产时是 209MB —— 每打一个标签、每记一次搜索都把它整块发回服务端
// 是不可接受的。这一层在持久化边界上把变化拆开：
//   - 用户域（评分 / 备注 / 我的标签 / AI 标签 / 收藏）→ 集合语义 op，代价 ∝ 受影响行数；
//   - 会话域（搜索历史 / 下载任务 / 导出选项）→ 几 KB 的独立请求；
//   - 探测域（封面探测缓存）→ 独立小 key，可重建；
//   - 目录域（models / trashed）→ 低频，仍走整块写入，但只带纯目录字段。
//
// 纯函数：不碰 IO、不 import node 模块，浏览器与 Node 测试共用同一套规则。
// 任何看不懂的变化一律 fallback（退回整块写入）—— 宁可多传，绝不悄悄丢内容。
import {stable, MAX_MUTATION_OPS} from './state-mutations.js';

export const USER_STATE_KEY = 'sfx-library-user';
export const PROBE_STATE_KEY = 'sfx-library-probe';
export const SESSION_STATE_KEY = 'sfx-library-session';

const UID = /^[a-f0-9]{32}$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const strings = value => new Set(list(value).filter(tag => typeof tag === 'string' && tag));
const sameBody = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const clamp = n => Math.max(0, Math.min(5, Math.round(Number(n) || 0)));

const SESSION_FIELDS = Object.freeze(['history', 'tasks', 'options']);
const KNOWN_FIELDS = new Set([
  'version', 'models', 'trashed', 'aiTags', 'userTags', 'userMeta', 'favorites',
  'assetProbe', ...SESSION_FIELDS,
]);

/**
 * 标签映射的差集 → tag.add / tag.remove。
 * 返回 null 表示遇到脏数据（非法 uid / 非数组），调用方必须退回整块写入。
 */
function diffTagMap(before, after, source) {
  const from = object(before), to = object(after), ops = [];
  for (const uid of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (!UID.test(uid)) return null;
    if (Object.hasOwn(to, uid) && !Array.isArray(to[uid])) return null;
    const old = strings(from[uid]), next = strings(to[uid]);
    for (const tag of old) if (!next.has(tag)) ops.push({op: 'tag.remove', uid, source, value: tag});
    for (const tag of next) if (!old.has(tag)) ops.push({op: 'tag.add', uid, source, value: tag});
  }
  return ops;
}

/** 评分 / 备注映射 → asset.set。删除某个 uid 等于把它清回默认值。 */
function diffMetaMap(before, after) {
  const from = object(before), to = object(after), ops = [];
  for (const uid of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (!UID.test(uid)) return null;
    const old = object(from[uid]), next = object(to[uid]);
    if (Object.hasOwn(to, uid) && (!next || typeof next !== 'object' || Array.isArray(next))) return null;
    const rating = clamp(next.rating), note = typeof next.note === 'string' ? next.note.slice(0, 2000) : '';
    if (rating !== clamp(old.rating)) ops.push({op: 'asset.set', uid, field: 'rating', value: rating});
    if (note !== (typeof old.note === 'string' ? old.note : '')) ops.push({op: 'asset.set', uid, field: 'note', value: note});
  }
  return ops;
}

/** 收藏是 uid 集合：只发真正翻转的那些。 */
function diffFavorites(before, after) {
  const old = new Set(list(before).filter(uid => typeof uid === 'string' && UID.test(uid)));
  const next = new Set(list(after).filter(uid => typeof uid === 'string' && UID.test(uid)));
  if (list(after).some(uid => typeof uid !== 'string' || !UID.test(uid))) return null;
  const ops = [];
  for (const uid of old) if (!next.has(uid)) ops.push({op: 'asset.set', uid, field: 'favorite', value: false});
  for (const uid of next) if (!old.has(uid)) ops.push({op: 'asset.set', uid, field: 'favorite', value: true});
  return ops;
}

/**
 * 比较前后两份主状态，产出分域写入指令。
 *
 * 返回 {fallback:true} 时调用方必须整块重放；否则返回：
 *   ops          集合语义 op（用户域）
 *   session      会话域字段补丁（没有变化就是空对象）
 *   probe        探测域完整对象（null 表示没变化）
 *   catalog      纯目录 blob 字符串（null 表示目录没变）
 *   removes      从回收站彻底消失的 uid（合并语义下必须显式删）
 */
export function translateStateChange(before, after) {
  const b = object(before), a = object(after);
  if (b.version !== a.version) return {fallback: true, reason: '版本号变化'};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!KNOWN_FIELDS.has(key) && stable(b[key]) !== stable(a[key])) return {fallback: true, reason: '未知字段变化'};
  }

  const ops = [];
  for (const [field, source] of [['userTags', 'user'], ['aiTags', 'ai']]) {
    if (stable(b[field]) === stable(a[field])) continue;
    const part = diffTagMap(b[field], a[field], source);
    if (!part) return {fallback: true, reason: `${field} 数据不合法`};
    ops.push(...part);
  }
  if (stable(b.userMeta) !== stable(a.userMeta)) {
    const part = diffMetaMap(b.userMeta, a.userMeta);
    if (!part) return {fallback: true, reason: 'userMeta 数据不合法'};
    ops.push(...part);
  }
  if (stable(b.favorites) !== stable(a.favorites)) {
    const part = diffFavorites(b.favorites, a.favorites);
    if (!part) return {fallback: true, reason: 'favorites 数据不合法'};
    ops.push(...part);
  }
  if (ops.length > MAX_MUTATION_OPS) return {fallback: true, reason: '变更数量超限'};

  const session = {};
  for (const field of SESSION_FIELDS) {
    if (stable(b[field]) === stable(a[field])) continue;
    const value = a[field];
    if (field === 'options' ? (!value || typeof value !== 'object' || Array.isArray(value))
      : (!Array.isArray(value) || value.length > 200)) return {fallback: true, reason: `${field} 数据不合法`};
    session[field] = value;
  }

  const probeChanged = stable(b.assetProbe) !== stable(a.assetProbe);
  const probe = probeChanged ? object(a.assetProbe) : null;
  const catalogChanged = !sameBody(b.models, a.models) || !sameBody(b.trashed, a.trashed);
  const oldModels = list(b.models), nextModels = list(a.models);
  const oldTrashedArr = list(b.trashed), nextTrashedArr = list(a.trashed);
  // 合并语义下「blob 里少了某个 uid」不等于删除（前端只持有一页目录）。
  // 回收站是完整的本地数组，它里面消失的 uid 才是用户真的彻底删除了。
  const oldTrashed = new Set(oldTrashedArr.map(item => item?.uid).filter(uid => typeof uid === 'string' && UID.test(uid)));
  const nextTrashed = new Set(nextTrashedArr.map(item => item?.uid).filter(uid => typeof uid === 'string' && UID.test(uid)));

  // 阶段 5.4 / ADR-08：作废与恢复是「同一个 uid 在两个数组之间移动」，不是新增也不是删除。
  // 只认最规整的形状：所有 model 的 uid 合法、留下来没动的部分逐字节一致、没有彻底删除。
  // 任何混合改动（改名 / 排序 / 同时 purge / 脏 uid）一律退回整块，宁可多传不猜语义。
  const legalModel = item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.uid === 'string' && UID.test(item.uid);
  const allLegal = [...oldModels, ...nextModels, ...oldTrashedArr, ...nextTrashedArr].every(legalModel);
  const mapOf = arr => new Map(arr.map(item => [item.uid, item]));
  const oldModelMap = mapOf(oldModels), nextModelMap = mapOf(nextModels);
  // 「回收站里消失」不等于彻底删除：恢复的 uid 会重新出现在 models 里。
  // 旧逻辑把恢复也列进 removes，会误发 asset:remove 把刚恢复的资产删掉。
  const removes = [...oldTrashed].filter(uid => !nextTrashed.has(uid) && !nextModelMap.has(uid));
  const oldTrashMap = mapOf(oldTrashedArr), nextTrashMap = mapOf(nextTrashedArr);
  const trashUids = allLegal ? [...oldModelMap.keys()].filter(uid => !nextModelMap.has(uid) && nextTrashMap.has(uid)) : [];
  const restoreUids = allLegal ? [...oldTrashMap.keys()].filter(uid => !nextTrashMap.has(uid) && nextModelMap.has(uid)) : [];
  const moved = new Set([...trashUids, ...restoreUids]);
  const sameKeptModels = sameBody(oldModels.filter(item => !moved.has(item.uid)), nextModels.filter(item => !moved.has(item.uid)));
  const sameKeptTrashed = sameBody(oldTrashedArr.filter(item => !moved.has(item.uid)), nextTrashedArr.filter(item => !moved.has(item.uid)));
  const fitsOp = (uid, map) => JSON.stringify(map.get(uid)).length <= 512 * 1024;
  const moveOnly = catalogChanged && allLegal && moved.size > 0 && moved.size <= 200
    && removes.length === 0 && sameKeptModels && sameKeptTrashed
    && trashUids.every(uid => fitsOp(uid, nextTrashMap)) && restoreUids.every(uid => fitsOp(uid, nextModelMap));
  const trash = moveOnly ? trashUids.map(uid => ({op: 'asset:trash', uid, model: nextTrashMap.get(uid)})) : [];
  const restore = moveOnly ? restoreUids.map(uid => ({op: 'asset:restore', uid, model: nextModelMap.get(uid)})) : [];
  // 彻底删除：models 没动、trashed 只少了被 purge 的那几条，也不必回传整块目录。
  const purgeOnly = catalogChanged && allLegal && removes.length > 0 && removes.length <= 200
    && !moved.size && sameBody(oldModels, nextModels)
    && sameBody(nextTrashedArr, oldTrashedArr.filter(item => !removes.includes(item.uid)));

  // 阶段 5.2：纯新增目录（下载入库 / 收藏）改发 asset:add 增量，不回传整块目录。
  // 判定苛刻是有意的：旧 model 内容或顺序一变、回收站一动、uid 不合法，
  // 都老老实实整块写 —— 宁可多传，绝不把「改过的资产」误当新增而丢字段。
  const pureAppend = catalogChanged && removes.length === 0 && !moved.size && !purgeOnly
    && sameBody(b.trashed, a.trashed)
    && nextModels.length > oldModels.length
    && oldModels.every((model, index) => sameBody(model, nextModels[index]));
  const added = pureAppend ? nextModels.slice(oldModels.length) : [];
  const legal = added.length > 0 && added.length <= 200 && added.every(model =>
    model && typeof model.uid === 'string' && UID.test(model.uid)
    && !/[\u0000-\u001f]/.test(model.uid) && JSON.stringify(model).length <= 512 * 1024);
  const adds = legal ? added : [];
  // 目录域单独写时只带纯目录字段：用户/会话/探测各自有权威域，混进目录 blob 只会造成双份与漂移。
  const catalog = catalogChanged && !adds.length && !trash.length && !restore.length && !purgeOnly
    ? JSON.stringify({version: a.version, models: nextModels, trashed: nextTrashedArr})
    : null;

  return {fallback: false, ops, session, probe, catalog, removes, adds, trash, restore};
}
