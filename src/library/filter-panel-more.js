// 更多面板：检索式 + 数值范围滑条 + 合集图标行 + 三个图标动作。
// 检索语法、范围说明全部进 tooltip，不再占面板正文。
import {NUMERIC_FIELDS, NUMERIC_FIELD_LABELS, rangeDetail} from './numeric-filter.js';
import {icon} from './icon-set.js';
import {
  iconButton, segmented, sliderRow, setSlider, bindSlider, triggerInput, emptyState,
} from './filter-panel-common.js';

/** 每个数值字段的滑条刻度：改刻度只改这张表，不动渲染逻辑。 */
export const RANGE_SCALES = Object.freeze({
  aspect: {min: 0.3, max: 3, step: 0.05, unit: ''},
  longEdge: {min: 0, max: 8000, step: 100, unit: 'px'},
  width: {min: 0, max: 8000, step: 100, unit: 'px'},
  height: {min: 0, max: 8000, step: 100, unit: 'px'},
  duration: {min: 0, max: 300, step: 5, unit: 's'},
});

export function morePanel(host, ctx) {
  const {esc, store, controls, toast} = ctx;
  let bound = 'min';
  const scale = () => RANGE_SCALES[host.querySelector('.fv-range-field').value] || RANGE_SCALES.aspect;

  host.innerHTML = `<div class="fv-search-row"><span class="fv-search-ic">${icon('search')}</span>
      <input type="search" class="fd-q" maxlength="500" autocomplete="off" placeholder="tag:石头 -author:demo | 石桥"
        aria-label="检索式">${iconButton({icon: 'help', cls: 'fv-syntax-tip',
        title: '空格=同时满足 · |=任一 · -词=排除 · "短语"=精确 · tag:/color:/width: 限定字段', esc})}</div>
    <div class="fv-group"><span class="fv-group-label" title="数值范围（与形状面板共用）">范围</span>
      <div class="fv-range-row"><select class="fv-range-field" aria-label="数值字段">
        ${NUMERIC_FIELDS.map(field => `<option value="${esc(field)}">${esc(NUMERIC_FIELD_LABELS[field])}</option>`).join('')}</select>
        ${segmented([
          {value: 'min', icon: 'chevron-up', title: '≥ 不小于'},
          {value: 'max', icon: 'chevron', title: '≤ 不大于'},
        ], bound, {esc})}
        ${iconButton({icon: 'plus', cls: 'fd-range-add', title: '添加当前范围', esc})}</div>
      ${sliderRow({id: 'range', icon: 'sliders', min: 0.3, max: 3, step: 0.05, value: 1,
        display: '1', title: '拖动设定阈值', esc})}
      <div class="fd-range-list"></div></div>
    <div class="fv-group"><span class="fv-group-label" title="合集 / 智能合集">合集</span>
      <div class="fd-collections" role="list"></div>
      <div class="fv-mode-row">
        ${iconButton({icon: 'plus', cls: 'fd-collection-new', title: '新建合集', esc})}
        ${iconButton({icon: 'sparkle2', cls: 'fd-collection-smart', title: '存为智能画板（把当前筛选变成规则）', esc})}
        ${iconButton({icon: 'layers', cls: 'fd-collection-add', title: '把当前结果加入合集', esc})}
        ${iconButton({icon: 'rotate', cls: 'fd-collection-reorder', title: '按当前顺序重排合集', esc})}
        ${iconButton({icon: 'trash', cls: 'fd-clear-all-panel', title: '清除全部筛选', esc})}
        ${iconButton({icon: 'shield', cls: 'fd-local-health', title: '本地库体检：占用排行 / 疑似重复 / 空包', esc})}
      </div></div>`;

  const q = host.querySelector('.fd-q');
  const syncQ = () => { if (q.value !== controls.q.value) q.value = controls.q.value; };
  q.addEventListener('input', () => { controls.q.value = q.value; triggerInput(controls.q); });

  const formatValue = value => {
    const conf = scale();
    return `${Number(value).toFixed(conf.step < 1 ? 2 : 0).replace(/\.00$/, '')}${conf.unit}`;
  };

  function renderCollections() {
    if (ctx.ruleEditing) return;
    const list = controls.listCollections?.() || [];
    host.querySelector('.fd-collections').innerHTML = list.length
      ? list.map(item => `<div class="fd-collection${controls.getActiveCollection?.() === item.id ? ' is-active' : ''}" role="listitem">
          <button type="button" class="fd-collection-pick" data-id="${esc(item.id)}"
            title="${esc(item.name)}">${icon(item.smart ? 'sparkle2' : 'layers')}<span>${esc(item.name)}</span>
            <small>${item.smart ? '自动' : item.assetCount ?? 0}</small></button></div>`).join('')
      : emptyState('还没有合集', 'layers', esc);
  }

  function renderRanges() {
    const list = store.get().ranges.filter(item => String(item.id || '').startsWith('custom:'));
    host.querySelector('.fd-range-list').innerHTML = list.length
      ? list.map(range => `<span class="fd-range-tag">${esc(rangeDetail(range))}
          <button type="button" class="fd-range-remove" data-id="${esc(range.id)}" aria-label="移除范围">×</button></span>`).join('')
      : '';
  }

  const refresh = () => { syncQ(); renderRanges(); };

  if (ctx.ruleEditing) {
    const section = host.querySelector('.fd-collections')?.parentElement;
    if (section) section.remove();
  }

  host.addEventListener('click', async event => {
    const seg = event.target.closest?.('.fv-seg[data-value]');
    if (seg) { bound = seg.dataset.value; return; }
    if (event.target.closest?.('.fd-range-add')) {
      const field = host.querySelector('.fv-range-field').value;
      const value = Number(host.querySelector('.fv-slider-input').value);
      const range = {id: `custom:${field}:${bound}:${value}`, field,
        min: bound === 'min' ? value : null, max: bound === 'max' ? value : null};
      store.set({ranges: [...store.get().ranges.filter(item => item.id !== range.id), range]});
      toast?.(`已添加 ${rangeDetail(range)}`);
      return;
    }
    const remove = event.target.closest?.('.fd-range-remove');
    if (remove) { store.set({ranges: store.get().ranges.filter(item => item.id !== remove.dataset.id)}); return; }
    const pick = event.target.closest?.('.fd-collection-pick');
    if (pick) {
      ctx.onCollectionPick?.(pick.dataset.id);
      await controls.applyCollection?.(pick.dataset.id);
      renderCollections();
      return;
    }
    if (event.target.closest?.('.fd-collection-new')) { await controls.createBoard?.(); await controls.refreshCollections?.(); renderCollections(); return; }
    if (event.target.closest?.('.fd-collection-smart')) { ctx.onSmartBoardNew?.(); return; }
    if (event.target.closest?.('.fd-collection-add')) { await controls.addToCollection?.(); await controls.refreshCollections?.(); renderCollections(); return; }
    if (event.target.closest?.('.fd-collection-reorder')) { await controls.reorderCollection?.(); await controls.refreshCollections?.(); renderCollections(); return; }
    if (event.target.closest?.('.fd-clear-all-panel')) controls.clear?.();
    // 体检是独立 dialog（数据量大、动作是删除），面板只负责喊一声。
    if (event.target.closest?.('.fd-local-health')) window.dispatchEvent(new CustomEvent('assetvault:local-health'));
  });

  host.querySelector('.fv-range-field').addEventListener('change', () => {
    const conf = scale();
    const input = host.querySelector('.fv-slider-input');
    input.min = conf.min; input.max = conf.max; input.step = conf.step;
    const value = Math.min(Math.max(Number(input.value), conf.min), conf.max);
    setSlider(host, value, {display: formatValue(value)});
  });
  bindSlider(host, () => {}, {format: formatValue});
  Promise.resolve(controls.refreshCollections?.()).then(renderCollections).catch(() => renderCollections());
  refresh();
  return {refresh};
}
