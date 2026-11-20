// 阶段 4：高级检索的「服务端按页取数」通道（纯逻辑，无 DOM，可单独单测）。
//
// 阶段 2 的 /query 会把全部命中 uid 一次性传回浏览器；大库时那是上万个 32 字节字符串，
// 而且拿到之后还得靠本地 state.models 才能画卡片。这里改走 /api/library/assets：
//   - 每页只取 60 个 uid + 60 份完整 model，total 仍由服务端算好；
//   - 服务端页里本地没有的 model 以 _remoteOnly 临时补进 state.models（saveLibrary 会过滤），
//     于是 findModel / 右键菜单 / 详情面板全部照常工作，写入契约却一点没被污染；
//   - 「加载更多」由 library-paging.js 转发到 more()，累积 uid 后重绘，不重建整张网格。
export const PAGE_SIZE = 60;

/** 资产本体只补新增；标签分层同步服务端结果，让后台补标在刷新后可见。 */
export function mergeRemoteModels(state, items = []) {
  if (!Array.isArray(state.models)) state.models = [];
  const known = new Set(state.models.map(model => model?.uid));
  let added = 0;
  for (const item of items) {
    if (!item || typeof item.uid !== 'string') continue;
    for (const [kind, field] of [['ai', 'aiTags'], ['user', 'userTags']]) {
      if (!Array.isArray(item.tagKinds?.[kind])) continue;
      state[field] ??= {};
      const tags = item.tagKinds[kind].filter(tag => typeof tag === 'string' && tag);
      if (tags.length) state[field][item.uid] = [...tags];
      else delete state[field][item.uid];
    }
    if (known.has(item.uid)) continue;
    known.add(item.uid);
    state.models.push({...item, _remoteOnly: true});
    added++;
  }
  return added;
}

/**
 * @param {object} ctx
 * @param {(path:string, opt?:object) => Promise<object>} ctx.request 同源 API 请求函数
 * @param {object} ctx.state 应用状态（queryUids / queryOrder / remotePaging）
 * @param {(info:object) => void} ctx.onUpdate 取页成功后通知面板更新提示并重绘
 * @param {(error:Error) => void} ctx.onError 失败回调（老进程没有 /assets 时由面板降级）
 */
export function createPagedQuery({request, state, onUpdate, onError, size = PAGE_SIZE} = {}) {
  let query = null, uids = [], total = 0, busy = false, generation = 0;
  state.remotePaging = null;

  function publish(data, reset) {
    const hasMore = uids.length < total;
    state.queryUids = new Set(uids);
    // 服务端返回的 uid 本身就是排好序的（含合集手动顺序），前端不再二次排序。
    state.queryOrder = uids.slice();
    state.remotePaging = {loaded: uids.length, total, hasMore};
    // 5.6：服务端偶尔会「条件不可下推」而退回全表 JS 求值 —— 结果一样，代价差几个数量级。
    // 把原因一路带到 UI，别让用户只感觉到「这次筛选怎么这么慢」。
    onUpdate?.({uids: uids.slice(), total, loaded: uids.length, hasMore, reset, engine: data.engine,
      pushdown: data.pushdown !== false, reason: data.reason || ''});
  }

  const fetchPage = (input, offset) => {
    const {smartCollectionId, ...body} = input;
    return request(smartCollectionId ? '/smart-collections/resolve' : '/assets', {method:'POST', body:{...body,
      ...(smartCollectionId ? {id:smartCollectionId} : {}), uidScope:'page', limit:size, offset}});
  };

  async function first(input, {preserveWindow = false} = {}) {
    const target = preserveWindow && JSON.stringify(query) === JSON.stringify(input) ? Math.max(size,uids.length) : size;
    busy = true;
    const token = ++generation;
    try {
      let data, offset = 0;
      const next = [], items = [], seen = new Set();
      do {
        data = await fetchPage(input, offset);
        if (token !== generation) return; // 输入已经变了，丢弃过期响应
        const page = data.uids || [];
        for(const uid of page)if(!seen.has(uid)){seen.add(uid);next.push(uid);}
        items.push(...(data.items || []));
        offset += page.length;
        if(!page.length || offset >= (Number(data.total) || page.length))break;
      } while(offset < target);
      query = input;
      uids = next;
      total = Number(data.total) || uids.length;
      mergeRemoteModels(state, items);
      publish(data, true);
    } catch (error) {
      if (token === generation) onError?.(error);
    } finally { if (token === generation) busy = false; }
  }

  async function more() {
    if (busy || !query || !state.remotePaging?.hasMore) return;
    busy = true;
    const token = generation;
    const offset = uids.length;
    try {
      const data = await fetchPage(query, offset);
      if (token !== generation) return;
      const page = data.uids || [];
      // 合集顺序 / 随机排序可能因新资产插入而重复命中，去重避免卡片叠影。
      const seen = new Set(uids);
      for (const uid of page) if (!seen.has(uid)) { seen.add(uid); uids.push(uid); }
      total = Number(data.total) || total;
      mergeRemoteModels(state, data.items);
      publish(data, false);
      if (!page.length || uids.length >= total) state.remotePaging.hasMore = false;
    } catch (error) { if (token === generation) onError?.(error); }
    finally { if (token === generation) busy = false; }
  }

  return {
    first, more, refresh: input => first(input, {preserveWindow:true}),
    /** 清除筛选或换查询时调用；onRemoteMore 是常驻回调，不在这里注销。 */
    reset() { ++generation; busy = false; query = null; uids = []; total = 0; state.remotePaging = null; },
    get busy() { return busy; },
  };
}
