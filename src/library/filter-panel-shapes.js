// 形状面板：比例图形（零文字）+ 分辨率滑条 + 资产类型图标 chip + 排除图标。
// 协议仍是 ranges:[{field,min,max}]，与 numeric-filter.js / 服务端查询层完全一致。
import {ASPECT_RATIO_PRESETS, rangeFromPreset} from './numeric-filter.js';
import {ORIENTATION_VISUALS, KIND_VISUALS, RESOLUTION_STOPS,
  sliderToResolutionRange, resolutionToSlider} from './filter-visuals.js';
import {
  iconButton, iconChip, sliderRow, setSlider, bindSlider, syncChips,
  probeStatusHtml, updateProbeStatus, bindProbeControls,
} from './filter-panel-common.js';

const SHAPE_CHIPS = [
  ...ORIENTATION_VISUALS.map(item => ({...item, range: {field: item.field, min: item.min, max: item.max}})),
  ...ASPECT_RATIO_PRESETS.map(item => ({id: `aspect:${item.id}`, label: item.label,
    ratio: item.ratio, range: rangeFromPreset(item)})),
];

const ratioButton = (item, esc) => `<button type="button" class="fv-ratio" data-value="${esc(item.id)}"
  title="${esc(item.label)}" aria-pressed="false" style="--r:${item.ratio}"><i></i></button>`;

export function kindsPanel(host, ctx) {
  const {esc, store} = ctx;
  const kinds = Object.entries(KIND_VISUALS).map(([value, item]) => ({value, ...item}));

  host.innerHTML = `<div class="fv-group">
      <span class="fv-group-label" title="方向与宽高比（点图形累加，再点取消）">比例</span>
      <div class="fv-ratios">${SHAPE_CHIPS.map(item => ratioButton(item, esc)).join('')}</div></div>
    <div class="fv-group"><span class="fv-group-label" title="封面长边像素">分辨率</span>
      ${sliderRow({id: 'resolution', icon: 'image', min: 0, max: RESOLUTION_STOPS.length - 1, step: 1,
        value: 0, display: '不限', title: '封面长边：不限 / ≤1K / 2K / ≥4K', esc})}</div>
    <div class="fv-group"><span class="fv-group-label" title="资产类型">类型${ctx.tagsActive?.() ? '（标签筛选期间不生效）' : ''}</span>
      <div class="fv-chips">${kinds.map(item => iconChip({...item, esc})).join('')}</div></div>
    <div class="fv-mode-row">${iconButton({icon: 'ban', cls: 'fv-exclude-ranges', title: '排除这些尺寸 / 比例', esc})}</div>
    ${probeStatusHtml()}`;

  const rangeOf = id => SHAPE_CHIPS.find(item => item.id === id)?.range;
  const setResolution = value => {
    const rest = store.get().ranges.filter(item => item.field !== 'longEdge' && !String(item.id || '').startsWith('resolution:'));
    const range = sliderToResolutionRange(value);
    store.set({ranges: range ? [...rest, range] : rest});
  };

  function refresh() {
    const state = store.get();
    // 类型 chip 的唯一真值在旧 #local-kind（单选，前端过滤）：不再和 store.kinds 各存一份。
    syncChips(host, state.ranges.map(item => item.id), '.fv-ratio[data-value]');
    const current = ctx.localKind?.() || '';
    for (const chip of host.querySelectorAll('.fv-chip[data-value]')) {
      const on = chip.dataset.value === current;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', String(on));
    }
    const stop = RESOLUTION_STOPS.find(item => item.value === resolutionToSlider(state.ranges));
    setSlider(host, stop?.value ?? 0, {display: stop?.label || '不限'});
    const exclude = host.querySelector('.fv-exclude-ranges');
    exclude?.classList.toggle('is-on', state.excludeRanges);
    exclude?.setAttribute('aria-pressed', String(state.excludeRanges));
    updateProbeStatus(host, ctx);
  }

  host.addEventListener('click', event => {
    if (event.target.closest?.('.fv-exclude-ranges')) {
      store.set({excludeRanges: !store.get().excludeRanges});
      return;
    }
    const ratio = event.target.closest?.('.fv-ratio[data-value]');
    if (ratio) {
      const range = rangeOf(ratio.dataset.value);
      if (range) store.setRange({id: ratio.dataset.value, field: range.field, min: range.min, max: range.max}, true);
      return;
    }
    const chip = event.target.closest?.('.fv-chip[data-value]');
    if (chip) ctx.setLocalKind?.(chip.dataset.value);
  });

  bindSlider(host, setResolution, {
    format: value => RESOLUTION_STOPS.find(item => item.value === value)?.label || '不限',
  });
  bindProbeControls(host, ctx);
  refresh();
  return {refresh};
}
