// 阶段 5.1：目录域定点写入 op 的校验层（ADR-05）。
//
// 纯计算、无 IO，定位与 library-mutations.mjs 的 mutationTransform 相同：
// 非法请求在解析阶段就返回 400，不会等到写队列里炸成 500（那时还得解释「到底写没写」）。
// 差量协议刻意与 state-mutations.js 的整块协议分开：整块通道要留到 5.5 才拆，
// 老前端一个字都不用改。
export const MAX_ASSET_OPS = 200;
export const MAX_MODEL_BYTES = 512 * 1024;
export const ASSET_OP_KINDS = Object.freeze(['asset:add', 'asset:patch', 'asset:remove', 'asset:trash', 'asset:restore']);

/** 回收站状态只走 asset:trash / asset:restore；patch 不许偷偷改 state / trashedAt 造成半截状态。 */
const BLOCKED_PATCH_KEYS = new Set([
  'uid', 'state', 'trashedAt', '__proto__', 'constructor', 'prototype',
]);

export class AssetOpRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssetOpRejected';
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteSize = value => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

function normalizePatch(patch) {
  if (!isObject(patch)) throw new AssetOpRejected('asset:patch 需要 patch 对象');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (BLOCKED_PATCH_KEYS.has(key)) throw new AssetOpRejected(`patch 不允许改 ${key}（回收站迁移见 5.4）`);
    if (value === undefined) continue;
    const scalar = value === null || ['string', 'number', 'boolean'].includes(typeof value);
    const stringList = Array.isArray(value) && value.every(item => typeof item === 'string');
    if (!scalar && !stringList) throw new AssetOpRejected(`patch.${key} 只能是标量或字符串数组`);
    out[key] = value;
  }
  if (!Object.keys(out).length) throw new AssetOpRejected('patch 不能为空');
  if (byteSize(out) > MAX_MODEL_BYTES) throw new AssetOpRejected(`patch 超过 ${MAX_MODEL_BYTES} 字节`);
  return out;
}

/**
 * @param {{ops?: Array, op?: string, uid?: string, model?: object, patch?: object, rev?: number}} input
 * @returns {Array<{op:string,uid:string,rev?:number,model?:object,patch?:object}>} 规范化 op
 *
 * 兼容单条简写（直接把 op 放在请求体顶层），便于 MCP / curl 手工调用。
 */
export function normalizeAssetOps(input = {}) {
  const raw = Array.isArray(input?.ops) ? input.ops : (input?.op ? [input] : null);
  if (!raw) throw new AssetOpRejected('缺少变更列表');
  if (!raw.length) throw new AssetOpRejected('变更列表为空');
  if (raw.length > MAX_ASSET_OPS) throw new AssetOpRejected(`一次最多 ${MAX_ASSET_OPS} 条变更`);
  return raw.map((item, index) => {
    const at = `ops[${index}]`;
    const op = String(item?.op || '');
    if (!ASSET_OP_KINDS.includes(op)) throw new AssetOpRejected(`${at}.op 只支持 ${ASSET_OP_KINDS.join(' / ')}`);
    const uid = typeof item.uid === 'string' ? item.uid.trim() : '';
    if (!uid || uid.length > 120 || /[\u0000-\u001f]/.test(uid)) throw new AssetOpRejected(`${at}.uid 无效`);
    const out = {op, uid};
    if (item.rev !== undefined && item.rev !== null) {
      const rev = Number(item.rev);
      if (!Number.isInteger(rev) || rev < 0) throw new AssetOpRejected(`${at}.rev 必须是非负整数`);
      out.rev = rev;
    }
    if (op === 'asset:add' || op === 'asset:trash' || op === 'asset:restore') {
      if (op === 'asset:add' && !isObject(item.model)) throw new AssetOpRejected(`${at} 缺少 model`);
      // 回收站移动的 model 可选：不传就由服务端从 DB payload 还原，按页前端也能只发 uid。
      if (item.model !== undefined) {
        if (!isObject(item.model)) throw new AssetOpRejected(`${at}.model 必须是对象`);
        if (byteSize(item.model) > MAX_MODEL_BYTES) throw new AssetOpRejected(`${at}.model 超过 ${MAX_MODEL_BYTES} 字节`);
        // uid 以 op 为准：幂等键只有一份，model 里写错了也不会写出第二条幽灵资产。
        out.model = {...item.model, uid};
      }
    } else if (op === 'asset:patch') {
      out.patch = normalizePatch(item.patch);
    }
    return out;
  });
}
