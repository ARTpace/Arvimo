// 平台置顶（2026-11-18）：只存储「哪些平台 id 被置顶」，不改平台注册表本身。
// 纯数据层，不碰 DOM，可在 Node 里直接单测；存储失败时退化成内存空列表，不影响浏览。
const KEY = 'assetvault-platform-pins-v1';

const fallbackStore = () => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }
};

/** 读置顶列表：只收字符串 id，去重；任何异常都当作没置顶。 */
export function readPins(storage) {
  const store = storage || fallbackStore();
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return [...new Set(list.filter(id => typeof id === 'string' && id))];
  } catch { return []; }
}

/** 写置顶列表：写不进去（隐私模式 / 配额满）就静默失败，本次会话仍按内存列表工作。 */
export function writePins(list, storage) {
  const store = storage || fallbackStore();
  if (!store) return;
  try { store.setItem(KEY, JSON.stringify([...new Set(list)])); } catch {}
}

/** 置顶 / 取消置顶：已存在则移除（取消），否则追加到末尾（最新置顶排最后）。 */
export function togglePin(list, id) {
  if (!id || typeof id !== 'string') return [...list];
  return list.includes(id) ? list.filter(item => item !== id) : [...list, id];
}

/**
 * 按置顶列表给平台池排序：firstId（通常是「全部平台」）永远第一、不参与置顶；
 * currentId（当前选中的平台）紧随其后，让用户打开菜单第一眼就看见自己在用的平台；
 * 其余置顶项按 pins 中的先后排前，未置顶项保持原相对顺序（依赖 ES2019+ 稳定排序）。
 * currentId 为空 / 等于 firstId 时退化为纯置顶排序。纯函数，不改动入参。
 */
export function sortByPins(items, pins, firstId, currentId) {
  const rank = id => {
    const index = pins.indexOf(id);
    return index < 0 ? pins.length : index;
  };
  const pinnedCurrent = currentId && currentId !== firstId;
  return [...items].sort((a, b) => {
    if (a.id === firstId) return -1;
    if (b.id === firstId) return 1;
    if (pinnedCurrent && a.id === currentId) return -1;
    if (pinnedCurrent && b.id === currentId) return 1;
    return rank(a.id) - rank(b.id);
  });
}
