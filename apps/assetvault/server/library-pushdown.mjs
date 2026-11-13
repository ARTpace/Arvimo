// 查询下推的执行壳：拿到编译好的 plan，向内核要「当前页的行 + 总数 + uid 列表」。
//
// 为什么单独一层：library-api 的职责是路由，query-sql 的职责是编译，两者都不该关心
// 「怎么样把 DB 行变成卡片」。这一层只做投影与契约收敛，所以能脱离 HTTP 单测。
import {normalizeRows, toCard} from './library-query.mjs';
import {toFullModel} from './library-page.mjs';

/**
 * uid 列表的返回上限。原契约是「返回全部命中 uid」，前端拿它注入本地筛选；
 * 百万级时这个契约必然失效（几 MB 的响应），所以这里给一个硬上限并如实标记截断。
 * 5000 这个值来自现有库规模（5540 条）—— 它保证老用户体验零变化。
 */
export const UID_RETURN_CAP = 5000;

/**
 * @param conn  内核连接（library-db）
 * @param plan  query-sql.mjs 编译出的计划
 * @param page  true = items 给完整 model（/api/library/assets），false = 卡片（/query）
 * @param uidScope 'all' 返回命中 uid 列表（受上限约束），'page' 只回当前页
 */
export function runPushdown(conn, plan, {page = false, uidScope = 'all'} = {}) {
  const {assetRows, tagRows, total} = conn.queryPage(plan);
  // 与全量路径共用 normalizeRows：种类、格式、probe 的派生规则只有一份，两条路不会漂移。
  const rows = normalizeRows(assetRows, tagRows);
  const project = page ? toFullModel : toCard;
  const items = rows.map(project);
  const pageUids = rows.map(row => row.uid);

  let uids = pageUids;
  let uidsComplete = true;
  if (uidScope === 'all') {
    if (total <= pageUids.length) uids = pageUids;
    else if (total <= UID_RETURN_CAP) uids = conn.queryUids(plan, UID_RETURN_CAP);
    // 超上限：只回当前页，并明确告诉调用方「这不是全集」，别让前端拿它当筛选依据。
    else uidsComplete = false;
  }

  return {total, limit: plan.limit, offset: plan.offset, items, uids, uidsComplete, path: 'pushdown'};
}
