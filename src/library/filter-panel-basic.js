// 评分 / 收藏 / 格式 / 排序四个面板：全部图标化，参数只走滑条。
// 格式面板复用 format-filter.js，排序值域仍来自 filter-dimensions.js 的 SORT_CHIPS。
// 收藏面板额外承载「范围」（全部 / 收藏 / 回收站），格式面板额外承载「文件状态」——
// 这两组原来各占一个下拉，整合后归到语义最近的面板里，入口少一半。
import {renderFormatFilter} from './format-filter.js';
import {SORT_CHIPS, LOCAL_SCOPE_CHIPS, LOCAL_STATUS_CHIPS} from './filter-dimensions.js';
import {SORT_VISUALS, FAVORITE_VISUALS, RATING_SLIDER_MAX,
  ratingsToSlider, sliderToRatings, ratingSliderLabel} from './filter-visuals.js';
import {icon} from './icon-set.js';
import {iconButton, iconChip, sliderRow, setSlider, bindSlider, syncChips} from './filter-panel-common.js';

export function ratingPanel(host, ctx) {
  const {esc, store, controls} = ctx;
  const initial = ratingsToSlider(store.get().ratings);
  host.innerHTML = `<div class="fv-stars" role="group" aria-label="最低星级">
      ${Array.from({length: 5}, (_, i) => `<button type="button" class="fv-star" data-value="${i + 1}"
        title="${i + 1} 星及以上" aria-label="${i + 1} 星及以上">${icon('star')}</button>`).join('')}</div>
    ${sliderRow({id: 'rating', icon: 'star', min: 0, max: RATING_SLIDER_MAX, step: 1,
      value: initial, display: ratingSliderLabel(initial), title: '最低星级（末端 = 只看未评分）', esc})}
    <div class="fv-mode-row">
      ${iconButton({icon: 'ban', cls: 'fv-exclude-rating', title: '排除所选星级', esc})}
      ${iconButton({icon: 'minus', cls: 'fv-unrated', title: '只看未评分', esc})}
    </div>`;

  const apply = value => {
    controls.rating.value = ''; // 精确评分与「不低于」两套语义互斥
    store.set({ratings: sliderToRatings(value)});
  };
  const refresh = () => {
    const state = store.get();
    const value = ratingsToSlider(state.ratings);
    setSlider(host, value, {display: ratingSliderLabel(value)});
    for (const star of host.querySelectorAll('.fv-star'))
      star.classList.toggle('is-on', Number(star.dataset.value) <= value && value < 6);
    const exclude = host.querySelector('.fv-exclude-rating');
    exclude.classList.toggle('is-on', state.excludeRating);
    exclude.setAttribute('aria-pressed', String(state.excludeRating));
    const unrated = host.querySelector('.fv-unrated');
    unrated.classList.toggle('is-on', value === 6);
    unrated.setAttribute('aria-pressed', String(value === 6));
  };

  host.addEventListener('click', event => {
    const star = event.target.closest?.('.fv-star[data-value]');
    if (star) { apply(star.dataset.value); return; }
    if (event.target.closest?.('.fv-unrated')) { apply(store.get().ratings.includes('0') ? 0 : 6); return; }
    if (event.target.closest?.('.fv-exclude-rating')) store.set({excludeRating: !store.get().excludeRating});
  });
  bindSlider(host, apply, {format: value => ratingSliderLabel(value)});
  refresh();
  return {refresh};
}

export function favoritePanel(host, ctx) {
  const {esc, store, controls, localScope, setLocalScope} = ctx;
  const items = Object.entries(FAVORITE_VISUALS).map(([value, item]) => ({value, ...item}));
  host.innerHTML = `<div class="fv-chips fv-favorites" role="group" aria-label="收藏状态">
      ${items.map(item => iconChip({...item, esc})).join('')}</div>
    <div class="fv-group"><span class="fv-group-label" title="本地资产范围：全部 / 只看收藏 / 回收站">范围</span>
      <div class="fv-chips fv-scope" role="group" aria-label="资产范围">
        ${LOCAL_SCOPE_CHIPS.map(item => iconChip({...item, esc})).join('')}</div></div>`;
  const refresh = () => {
    syncChips(host, [store.get().favoriteMode], '.fv-favorites .fv-chip[data-value]');
    syncChips(host, [localScope?.() || 'all'], '.fv-scope .fv-chip[data-value]');
  };
  host.addEventListener('click', event => {
    const chip = event.target.closest?.('.fv-chip[data-value]');
    if (!chip) return;
    if (chip.closest('.fv-scope')) { setLocalScope?.(chip.dataset.value); refresh(); return; }
    controls.favorite.checked = chip.dataset.value === 'yes';
    store.set({favoriteMode: chip.dataset.value});
  });
  refresh();
  return {refresh};
}

export function formatPanel(host, ctx) {
  const {controls, esc, localStatus, setLocalStatus} = ctx;
  const ui = renderFormatFilter({host, filter: controls.formatFilter, esc, onChange: ctx.onFormatChange});
  controls.setDockFormatUI?.(ui);
  // 文件状态跟着格式走：都是「磁盘上这个文件长什么样」，合成一个面板比并排两个下拉清楚。
  const row = document.createElement('div');
  row.className = 'fv-group fv-local-status';
  if (ctx.ruleEditing) row.hidden = true;
  row.innerHTML = `<span class="fv-group-label" title="本地文件状态（需下载服务连接）">文件</span>
    <div class="fv-chips" role="group" aria-label="本地文件状态">
      ${LOCAL_STATUS_CHIPS.map(item => iconChip({...item, esc})).join('')}</div>`;
  host.append(row);
  const refreshStatus = () => syncChips(row, [localStatus?.() || ''], '.fv-chip[data-value]');
  row.addEventListener('click', event => {
    const chip = event.target.closest?.('.fv-chip[data-value]');
    if (!chip) return;
    setLocalStatus?.(chip.dataset.value);
    refreshStatus();
  });
  refreshStatus();
  return {refresh: (...args) => { ui.refresh?.(...args); refreshStatus(); }};
}

export function sortPanel(host, {esc, store}) {
  const items = SORT_CHIPS.map(item => ({value: item.value, ...SORT_VISUALS[item.value],
    title: item.label, tone: '#C9F581'}));
  host.innerHTML = `<div class="fv-chips fv-sorts">${items.map(item => iconChip({...item, esc})).join('')}</div>
    <div class="fv-mode-row">
      ${iconButton({icon: 'chevron-up', cls: 'fv-sort-dir', title: '切换升 / 降序', esc})}
      ${iconButton({icon: 'shuffle', cls: 'fd-reseed', title: '重新随机洗牌', esc})}
    </div>`;
  const refresh = () => {
    const state = store.get();
    syncChips(host, [state.sort]);
    const dir = host.querySelector('.fv-sort-dir');
    dir.classList.toggle('is-on', state.sortOrder === 'desc');
    dir.setAttribute('aria-pressed', String(state.sortOrder === 'desc'));
  };
  host.addEventListener('click', event => {
    if (event.target.closest?.('.fv-sort-dir')) { store.set({sortOrder: store.get().sortOrder === 'desc' ? 'asc' : 'desc'}); return; }
    if (event.target.closest?.('.fd-reseed')) { store.set({sort: 'random', seed: String(Date.now())}); return; }
    const chip = event.target.closest?.('.fv-chip[data-value]');
    if (chip) store.set({sort: chip.dataset.value, ...(chip.dataset.value === 'random' ? {seed: String(Date.now())} : {})});
  });
  refresh();
  return {refresh};
}
