/**
 * 「后端给一份分类清单 → 填进 <select>」这件事，四个平台侧栏各写过一遍。
 *
 * 每份都是同样的十几行：拉接口、取 categories、保留用户已选中的那一项（还在清单里才保留）、
 * 带上资源计数、失败时提示「仍可按关键词搜索」。差异只有接口前缀和空选项的文字，
 * 不需要各写一套。这里只提供两个动作，控件联动（type 变了要重载）仍住在各自模块里，
 * 因为那才是它们真正的区别。
 */

/** 拉一份本地接口数据。非 2xx 直接抛，让调用方决定提示文案。 */
export async function localJson(url) {
  const response = await fetch(url, { cache: 'no-store', headers: { 'X-SFX-Local': '1' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data.error || `接口请求失败 HTTP ${response.status}`);
  return data || {};
}

/** 只要分类清单时的快捷方式。 */
export async function fetchCategories(url) {
  const data = await localJson(url);
  return Array.isArray(data.categories) ? data.categories : [];
}

/**
 * 用清单填一个 <select>。
 * 「保留当前选择」是关键：用户选了分类再切平台/重载时，不该被弹回「全部」。
 */
export function fillOptions($, id, rows, blank, esc) {
  const el = $(id);
  if (!el) return;
  const keep = el.dataset.keep || el.value;
  el.innerHTML = `<option value="">${blank}</option>`
    + (rows || []).map(row => `<option value="${esc(row.value)}">${esc(row.label)}${row.count ? ` · ${row.count}` : ''}</option>`).join('');
  el.value = [...el.options].some(option => option.value === keep) ? keep : '';
  delete el.dataset.keep;
}
