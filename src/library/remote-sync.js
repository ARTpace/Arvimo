// 协作：把别人的改动应用到本地状态（S3-c 前端）。
//
// 服务端广播「哪个 uid 变了」，这里负责把那个 uid 的最新评分 / 备注 / 标签 / 收藏
// 覆盖到本地状态上。**只覆盖服务端明确给出的字段**，别的一概不碰。
//
// 为什么不能直接覆盖整条模型：本地可能有用户还没提交的改动，整条覆盖会把它抹掉。
// 为什么只覆盖「用户可变部分」：名称、作者、封面这些是资产本体，不是协作产物。

const UID = /^[a-f0-9]{32}$/i;
const text = value => typeof value === 'string' ? value : '';

const sameTags = (a, b) => a.length === b.length && a.every((tag, index) => tag === b[index]);

/** 数组原样取出（详情项是对象，不能按字符串过滤）。 */
const items = value => (Array.isArray(value) ? value : []);
/** 字符串数组：过滤掉空串与非字符串。 */
const list = value => items(value).filter(item => typeof item === 'string' && item);

/**
 * 应用一批远端变更。
 *
 * @param {object} state 应用状态（就地修改 userMeta / userTags / aiTags / favorites）
 * @param {Array} details 服务端返回的 [{uid, rating, note, favorite, userTags, aiTags}]
 * @returns {{changed:number, uids:string[]}} 实际发生变化的 uid 列表
 */
export function applyRemoteDetails(state, details) {
  const changed = [];
  for (const item of items(details)) {
    const uid = text(item?.uid);
    if (!UID.test(uid)) continue;
    let touched = false;

    // 评分与备注：服务端给什么就是什么（对方是权威）。
    const rating = Math.max(0, Math.min(5, Math.round(Number(item.rating) || 0)));
    const note = text(item.note).slice(0, 2000);
    const current = state.userMeta?.[uid] || {rating: 0, note: ''};
    if (current.rating !== rating || current.note !== note) {
      state.userMeta = {...(state.userMeta || {}), [uid]: {rating, note}};
      touched = true;
    }

    // 我的标签 / AI 标签：整体替换（服务端给的是完整集合，集合语义下「没有」就是空）。
    const userTags = list(item.userTags);
    if (item.userTags !== undefined) {
      const currentTags = list(state.userTags?.[uid]);
      if (!sameTags(currentTags, userTags)) {
        state.userTags = {...(state.userTags || {})};
        if (userTags.length) state.userTags[uid] = userTags;
        else delete state.userTags[uid];
        touched = true;
      }
    }
    const aiTags = list(item.aiTags);
    if (item.aiTags !== undefined) {
      const currentTags = list(state.aiTags?.[uid]);
      if (!sameTags(currentTags, aiTags)) {
        state.aiTags = {...(state.aiTags || {})};
        if (aiTags.length) state.aiTags[uid] = aiTags;
        else delete state.aiTags[uid];
        touched = true;
      }
    }

    // 收藏：Set 的增删。
    if (item.favorite !== undefined && state.favorites) {
      const wanted = item.favorite === true;
      const has = state.favorites.has(uid);
      if (wanted !== has) {
        if (wanted) state.favorites.add(uid);
        else state.favorites.delete(uid);
        touched = true;
      }
    }

    if (touched) changed.push(uid);
  }
  return {changed: changed.length, uids: changed};
}
