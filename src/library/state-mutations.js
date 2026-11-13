// 阶段 4：资产库「增量写入」协议（浏览器与 Node 共用的纯函数层）。
//
// 为什么放在 src/library：server 早就在复用这里的纯函数（catalog.mjs 用 search-options.js、
// platform-settings.mjs 用 platforms.js），前后端必须用**同一套** diff / apply 规则，
// 否则「前端算出的变更」与「服务端理解的变更」迟早分叉。本文件不碰 IO、不 import node 模块。
//
// 设计取舍：models / trashed 是数据主体，任何变化都退回整块 /api/library-state
// （导入、删除本来就要传数据，差量没有收益）。高频的评分、备注、我的标签、AI 标签、
// 收藏、历史、任务、选项则做「字段级 / 键级」差量：一次改一个评分只发几十字节。
// 键级差量还有个额外好处 —— 两个标签页同时给不同资产打分，各自的 op 只碰自己的 key，
// 不会像整块写入那样互相覆盖。
//
// 全程「绝对赋值」语义（不写 +1/-1 这类相对操作），所以重复应用幂等，也不需要版本号协商。

export const MAIN_STATE_KEY = 'sfx-library-v2';
export const MUTABLE_MAPS = Object.freeze(['aiTags', 'userMeta', 'userTags', 'assetProbe']);
export const MUTABLE_VALUES = Object.freeze(['favorites', 'history', 'tasks', 'options']);
/** 超过这两个阈值的变更直接回退整块写入：批量 AI 打标本来就该一次传完，别拆成几千个 op。 */
export const MAX_MUTATION_OPS = 800;
export const MAX_MUTATION_BYTES = 96 * 1024;

const UID = /^[a-f0-9]{32}$/i;
/** 本地资产包的 uid 是 local- 前缀（asset-meta.mjs 的 deriveUid），其它差量字段仍只认 32 位 hex。 */
const PROBE_UID = /^(?:local-)?[a-f0-9]{32}$/i;
const keyPattern = field => field === 'assetProbe' ? PROBE_UID : UID;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const finiteField = (value, min, max) => Number.isFinite(Number(value))
  && Number(value) >= min && Number(value) <= max;
/** 封面探测缓存：只收这几个小字段，挡住脏数据，也别让差量通道变成往主状态塞大对象的后门。 */
export function validateProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = ['v', 'hex', 'h', 's', 'l', 'width', 'height', 'duration', 'at'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (value.v !== 1) return false;
  if (!/^#[0-9a-f]{6}$/i.test(value.hex || '')) return false;
  if (!finiteField(value.h, 0, 360) || !finiteField(value.s, 0, 1) || !finiteField(value.l, 0, 1)) return false;
  if (!finiteField(value.width, 1, 100000) || !finiteField(value.height, 1, 100000)) return false;
  if (value.duration !== undefined && value.duration !== null && !finiteField(value.duration, 0, 86400)) return false;
  if (!finiteField(value.at, 0, Number.MAX_SAFE_INTEGER)) return false;
  try { return JSON.stringify(value).length <= 512; } catch { return false; }
}

/** 键顺序无关的序列化：避免「只是对象键顺序变了」被误判成用户改了数据。 */
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const same = (a, b) => stable(a) === stable(b);
/**
 * models / trashed 可能有上万条，稳定的递归序列化太慢。它们都由 saveLibrary 按固定字段顺序
 * 生成（服务端重放也保留原键顺序），直接原生 stringify 比较即可，既快又不会误判。
 */
const sameBody = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function toData(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const data = JSON.parse(value);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

/** 单个值能否安全写进 blob：既挡住脏数据，也挡住 JSON.stringify 会丢字段的 undefined / 函数。 */
export function validateMutationValue(field, value, key = null) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'function' || typeof value === 'symbol') return false;
  let encoded;
  try { encoded = JSON.stringify(value); } catch { return false; }
  if (typeof encoded !== 'string' || encoded.length > MAX_MUTATION_BYTES) return false;
  if (key !== null) {
    if (!keyPattern(field).test(key)) return false;
    if (field === 'assetProbe') return validateProbe(value);
    if (field === 'userMeta') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const rating = Number(value.rating);
      if (!Number.isFinite(rating) || rating < 0 || rating > 5) return false;
      return typeof value.note === 'string' && value.note.length <= 2000;
    }
    // aiTags / userTags：标签数组，元素限长，避免一个 op 塞进整本词典。
    return Array.isArray(value) && value.length <= 100
      && value.every(tag => typeof tag === 'string' && tag.length <= 200);
  }
  if (field === 'favorites') return Array.isArray(value) && value.length <= 20000 && value.every(uid => typeof uid === 'string' && UID.test(uid));
  if (field === 'history' || field === 'tasks') return Array.isArray(value) && value.length <= 200;
  if (field === 'options') return !Array.isArray(value) && typeof value === 'object';
  return false;
}

/**
 * 比较两份主状态，产出可在服务端重放的 op 列表。
 * 返回 null = 不可差量（调用方必须退回整块写入）；返回 {ops, unchanged, data} = 可差量，
 * data 是已解析的 after，前端可以缓存它，下一次只解析一份而不是两份。
 */
export function diffMainState(before, after) {
  const b = toData(before), a = toData(after);
  if (!b || !a) return null;
  // 数据主体 / 版本号 / 未知字段有变化就整块写：宁可多传，绝不悄悄丢内容。
  if (b.version !== a.version || !sameBody(b.models, a.models) || !sameBody(b.trashed, a.trashed)) return null;
  const known = new Set([...MUTABLE_MAPS, ...MUTABLE_VALUES, 'version', 'models', 'trashed']);
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (!known.has(key) && !same(b[key], a[key])) return null;
  }
  const ops = [];
  for (const field of MUTABLE_MAPS) {
    const from = object(b[field]), to = object(a[field]);
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      if (same(from[key], to[key])) continue;
      const exists = Object.hasOwn(to, key);
      if (exists && !validateMutationValue(field, to[key], key)) return null;
      ops.push(exists ? {op: 'set', field, key, value: to[key]} : {op: 'delete', field, key});
    }
  }
  for (const field of MUTABLE_VALUES) {
    if (same(b[field], a[field])) continue;
    if (!validateMutationValue(field, a[field])) return null;
    ops.push({op: 'set', field, value: a[field]});
  }
  if (ops.length > MAX_MUTATION_OPS) return null;
  try { if (JSON.stringify(ops).length > MAX_MUTATION_BYTES) return null; } catch { return null; }
  return {ops, unchanged: ops.length === 0, data: a};
}

/**
 * 在服务端当前权威状态上重放 op。纯函数：不改入参、抛错即代表请求非法（调用方回 400）。
 * 与 diffMainState 共用 validateMutationValue，前后端对「什么算合法变更」不会有两种看法。
 */
export function applyMutations(data, ops) {
  const base = toData(data);
  if (!base) throw Error('资产库主状态格式无效');
  if (!Array.isArray(ops)) throw Error('变更列表格式无效');
  if (ops.length > MAX_MUTATION_OPS) throw Error('变更数量超限，请改用整块写入');
  const next = {...base};
  for (const op of ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw Error('变更项格式无效');
    const {field, key, op: kind} = op;
    if (MUTABLE_MAPS.includes(field)) {
      if (typeof key !== 'string' || !keyPattern(field).test(key)) throw Error('变更键必须是 32 位资产 uid');
      const map = {...object(next[field])};
      if (kind === 'delete') delete map[key];
      else if (kind === 'set' && validateMutationValue(field, op.value, key)) map[key] = op.value;
      else throw Error(`字段 ${field} 的变更值无效`);
      next[field] = map;
    } else if (MUTABLE_VALUES.includes(field)) {
      if (kind !== 'set' || !validateMutationValue(field, op.value)) throw Error(`字段 ${field} 的变更值无效`);
      next[field] = op.value;
    } else throw Error(`不支持的变更字段：${String(field)}`);
  }
  return next;
}

/** 前端判定「这批 ops 值得走差量通道」时用，服务端 readBody 也照同一上限拒收。 */
export function mutationPayloadSize(ops) {
  try { return JSON.stringify(ops).length; } catch { return Infinity; }
}
