// 标签筛选「最近使用」（移植自 Serpent src/renderer/tag-filter-recency.ts，MIT）。
// 全局持久化、失效名称在构建候选时自然过滤掉，所以不需要清理任务。
export const TAG_RECENCY_KEY = 'sfx-tag-filter-recency-v1';
export const TAG_RECENCY_LIMIT = 8;

export function withTagUsed(list, name) {
  const tag = String(name || '').trim();
  if (!tag) return Array.isArray(list) ? [...list] : [];
  const key = tag.toLocaleLowerCase();
  const rest = (Array.isArray(list) ? list : []).map(String)
    .filter(item => item.trim() && item.toLocaleLowerCase() !== key);
  return [tag, ...rest].slice(0, TAG_RECENCY_LIMIT);
}

export function loadTagRecency(storage, key = TAG_RECENCY_KEY) {
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    return (Array.isArray(saved?.names) ? saved.names : []).map(String).slice(0, TAG_RECENCY_LIMIT);
  } catch { return []; }
}

export function saveTagRecency(storage, names, key = TAG_RECENCY_KEY) {
  try { storage?.setItem(key, JSON.stringify({version: 1, names: [...names].slice(0, TAG_RECENCY_LIMIT)})); }
  catch { /* 只读存储照常用内存态 */ }
}

/** 默认段：最近使用优先，再补全部标签；失效名称自动跳过。 */
export function recencySections(recentNames, allNames, limit = 6) {
  const known = new Set(allNames.map(name => name.toLocaleLowerCase()));
  const recent = recentNames.filter(name => known.has(name.toLocaleLowerCase())).slice(0, limit);
  const recentKeys = new Set(recent.map(name => name.toLocaleLowerCase()));
  return {recent, all: allNames.filter(name => !recentKeys.has(name.toLocaleLowerCase()))};
}
