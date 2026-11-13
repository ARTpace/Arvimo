// 阶段 4：把「差量 op」翻译成一次完整状态写入的服务端适配层。
//
// 纯计算、无 IO：读权威状态 / 写盘 / 同步索引都在 library-storage.mjs 的 mutate() 里，
// 这里只负责「校验 + 生成 transform」，因此可以脱离服务端单独单测。
// 差量协议本身来自 src/library/state-mutations.js，前后端共用一套规则。
import {applyMutations, mutationPayloadSize, MAX_MUTATION_BYTES} from '../src/library/state-mutations.js';
import {MAIN_STATE_KEY, STATE_KEYS} from './library-schema.mjs';

/** 请求本身该被拒绝（400），与「写盘失败」这类服务器故障（500）区分开。 */
export class MutationRejectedError extends Error {}

/**
 * 派生表（assets / tags / asset_tags / assets_fts）由哪些字段决定。
 *
 * 只有 history / tasks / options 与派生表**完全无关** —— 它们不参与任何一行派生数据的计算。
 * 而搜索历史是「每搜一次就变一次」的高频字段：50 万资产时整表重建要 242 秒，
 * 为了记一次搜索历史重建整库是不能接受的。
 * 其余字段（aiTags / userMeta / userTags / assetProbe / favorites）都会改派生行，必须重建。
 */
const DERIVED_FIELDS = new Set(['aiTags', 'userMeta', 'userTags', 'assetProbe', 'favorites']);

/**
 * 这批 op 会不会影响派生表？
 * true = 要重建；false = 只改权威原串即可（省掉整表重建）。
 */
export function opsAffectDerived(ops = []) {
  if (!Array.isArray(ops) || !ops.length) return true;
  return ops.some(op => DERIVED_FIELDS.has(op?.field));
}

/**
 * @param {{ops: Array, values?: Record<string,string>}} input 差量请求体
 * @returns {(values: Record<string,string>) => Record<string,string>} 交给 storage.mutate 的 transform
 *
 * 两条安全边界：
 *  1) 主 blob 永远由「服务端当前权威值 + ops」生成，客户端**不能**通过 values 直接塞整块主状态，
 *     否则差量通道就成了绕过校验的后门；
 *  2) 损坏 / 缺失的主状态必须明确报错让前端退回整块写入，绝不能拿 {} 当底稿把资产清空。
 */
export function mutationTransform(input = {}) {
  const ops = input?.ops;
  if (!Array.isArray(ops)) throw Error('缺少变更列表');
  if (mutationPayloadSize(ops) > MAX_MUTATION_BYTES) throw Error('变更内容过大，请改用整块写入');
  // 先在空底稿上干跑一次：非法字段/键/值在请求解析阶段就返回 400，
  // 不会等到写队列里才炸成 500（那时还得解释「到底写没写」）。
  applyMutations({}, ops);
  const extra = input?.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : {};
  for (const [key, value] of Object.entries(extra)) {
    if (!STATE_KEYS.includes(key) || key === MAIN_STATE_KEY || typeof value !== 'string') throw Error('附带状态格式无效');
  }
  return values => {
    const raw = values?.[MAIN_STATE_KEY];
    if (typeof raw !== 'string' || !raw.trim()) throw new MutationRejectedError('资产库主状态缺失，请改用整块写入');
    let current;
    try { current = JSON.parse(raw); } catch { throw new MutationRejectedError('资产库主状态损坏，拒绝增量写入'); }
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new MutationRejectedError('资产库主状态格式无效');
    const next = applyMutations(current, ops);
    return {...values, ...extra, [MAIN_STATE_KEY]: JSON.stringify(next)};
  };
}
