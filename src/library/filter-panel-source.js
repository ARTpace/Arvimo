// 「来源 / 分类」面板：后端 normalizeFilters() 早就支持 filters.platforms / categories，
// 缺的只是前端入口。候选从当前 state.models 统计（按出现频次），冷门值允许手输。
// 只写 store，筛选经 filtersToPayload() 进 extraFilters，不碰查询实现。
import {sourceRows, SOURCE_GROUPS} from './filter-dimensions.js';
import {iconChip, syncChips} from './filter-panel-common.js';
import {icon} from './icon-set.js';

export function sourcePanel(host, ctx) {
  const {esc, store, state} = ctx;
  const models = () => (Array.isArray(state?.models) ? state.models : []);

  const render = () => {
    const filters = store.get();
    host.innerHTML = SOURCE_GROUPS.map(group => {
      const rows = sourceRows(models(), group.modelField);
      const selected = filters[group.field] || [];
      // 已选中但不在前 24 个候选里的值也要留在面板上，否则取消不掉。
      const chips = [
        ...rows.map(row => ({key: row.key, count: row.count})),
        ...selected.filter(key => !rows.some(row => row.key === key)).map(key => ({key, count: 0})),
      ];
      return `<div class="fv-group" data-source="${esc(group.field)}">
        <span class="fv-group-label" title="${esc(group.label)} · 点选过滤 · Shift 多选 · 再点一下取消">${esc(group.label)}</span>
        <div class="fv-chips fv-source" role="group" aria-label="${esc(group.label)}">
          ${chips.length ? chips.map(row => iconChip({
            value: row.key, icon: group.icon, label: row.key,
            title: row.count ? `${row.key} · ${row.count} 个资产` : row.key, esc,
          })).join('') : `<p class="fv-note">库里还没有带${esc(group.label)}的资产，可在下方手动输入</p>`}
        </div></div>`;
    }).join('') + `<div class="fv-source-add">
      <select class="fv-source-field" aria-label="添加到哪个维度">
        ${SOURCE_GROUPS.map(group => `<option value="${esc(group.field)}">${esc(group.label)}</option>`).join('')}
      </select>
      <input type="text" class="fv-source-input" maxlength="80" placeholder="手动输入值" aria-label="手动输入筛选值">
      <button type="button" class="fv-btn" data-act="source-add" title="加入筛选" aria-label="加入筛选">${icon('plus')}添加</button>
    </div>
    <p class="fv-note">${icon('help')}<span>值来自库里已有的元数据；点选即过滤，再点一下取消，Shift 可多选。</span></p>`;
    for (const group of SOURCE_GROUPS) {
      const box = host.querySelector(`[data-source="${group.field}"]`);
      syncChips(box, store.get()[group.field]);
    }
  };

  host.addEventListener('click', event => {
    const add = event.target.closest?.('[data-act="source-add"]');
    if (add) {
      const field = host.querySelector('.fv-source-field')?.value || SOURCE_GROUPS[0].field;
      const input = host.querySelector('.fv-source-input');
      const value = String(input?.value || '').trim();
      if (!value) return;
      const current = store.get()[field] || [];
      if (!current.includes(value)) store.set({[field]: [...current, value].slice(0, 100)});
      if (input) input.value = '';
      return;
    }
    const chip = event.target.closest?.('.fv-chip[data-value]');
    const group = chip?.closest?.('[data-source]');
    if (!group) return;
    store.toggle(group.dataset.source, chip.dataset.value, event.shiftKey);
  });

  render();
  return {refresh: render};
}
