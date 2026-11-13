// 颜色面板：纯色色卡（点选即累加）+ 相似度滑条 + 排除图标 + 一行探测进度。
// 色卡协议与匹配算法在 color-filter.js（MIT），这里只渲染与写回 store。
import {
  COLOR_PRESETS, COLOR_PREFS_KEY, MAX_CUSTOM_FILTER_COLORS,
  loadColorPreferences, saveColorPreferences, withCustomColorAdded, withCustomColorRemoved,
} from './color-filter.js';
import {icon} from './icon-set.js';
import {
  iconButton, sliderRow, setSlider, bindSlider,
  probeStatusHtml, updateProbeStatus, bindProbeControls,
} from './filter-panel-common.js';

const swatchStyle = hex => `--swatch:${hex};--fv-tone:${hex}`;

export function colorPanel(host, ctx) {
  const {esc, store, storage} = ctx;
  let prefs = loadColorPreferences(storage, COLOR_PREFS_KEY);
  const similarity = () => store.get().colorSimilarity;

  host.innerHTML = `<div class="fv-swatches" role="listbox" aria-label="颜色预设"></div>
    <input type="color" class="fv-color-picker" value="#3B82F6" aria-label="自定义颜色" hidden>
    ${sliderRow({id: 'similarity', icon: 'sliders', min: 0, max: 100, step: 1,
      value: similarity(), display: `${similarity()}%`, title: '相似度容差：越小越严格', esc})}
    <div class="fv-mode-row">
      ${iconButton({icon: 'ban', cls: 'fv-exclude-colors', title: '排除这些颜色', esc})}
      <span class="fv-count" role="status"></span>
    </div>
    ${probeStatusHtml()}`;

  const commitPrefs = next => { prefs = saveColorPreferences(storage, next, COLOR_PREFS_KEY); renderSwatches(); refresh(); };

  function renderSwatches() {
    const selected = store.get().colors;
    const items = [
      ...COLOR_PRESETS.map(item => ({value: item.id, hex: item.hex, title: `${item.label} ${item.hex}`})),
      ...prefs.customColors.map(hex => ({value: hex, hex, title: `自定义 ${hex}`, custom: true})),
    ];
    host.querySelector('.fv-swatches').innerHTML = items.map(item => {
      const active = selected.includes(item.value);
      return `<button type="button" class="fd-swatch${active ? ' is-on' : ''}" role="option"
        data-value="${esc(item.value)}" title="${esc(item.title)}" aria-selected="${active}"
        style="${esc(swatchStyle(item.hex))}"><span class="fv-check">${icon('check')}</span>
        ${item.custom ? `<span class="fd-swatch-x" data-remove-color="${esc(item.value)}" title="移除">×</span>` : ''}</button>`;
    }).join('') + `<button type="button" class="fd-swatch fd-swatch-add" title="添加自定义色">${icon('plus')}</button>`;
    host.querySelector('.fv-count').textContent = `${prefs.customColors.length}/${MAX_CUSTOM_FILTER_COLORS}`;
  }

  function refresh() {
    const state = store.get();
    for (const button of host.querySelectorAll('.fd-swatch[data-value]')) {
      const active = state.colors.includes(button.dataset.value);
      button.classList.toggle('is-on', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    setSlider(host, state.colorSimilarity, {display: `${state.colorSimilarity}%`});
    host.querySelector('.fv-exclude-colors')?.classList.toggle('is-on', state.excludeColors);
    host.querySelector('.fv-exclude-colors')?.setAttribute('aria-pressed', String(state.excludeColors));
    updateProbeStatus(host, ctx);
  }

  host.addEventListener('click', event => {
    const remove = event.target.closest?.('[data-remove-color]');
    if (remove) {
      const hex = remove.dataset.removeColor;
      commitPrefs(withCustomColorRemoved(prefs, hex));
      store.set({colors: store.get().colors.filter(item => item !== hex)});
      return;
    }
    if (event.target.closest?.('.fd-swatch-add')) { host.querySelector('.fv-color-picker').click(); return; }
    const button = event.target.closest?.('.fd-swatch[data-value]');
    if (button) { store.toggle('colors', button.dataset.value, true); return; }
    if (event.target.closest?.('.fv-exclude-colors')) {
      store.set({excludeColors: !store.get().excludeColors});
    }
  });

  host.querySelector('.fv-color-picker').addEventListener('input', event => {
    const hex = event.target.value;
    if (prefs.customColors.length >= MAX_CUSTOM_FILTER_COLORS) return;
    commitPrefs(withCustomColorAdded(prefs, hex));
    store.set({colors: [...new Set([...store.get().colors, hex])]});
  });

  bindSlider(host, value => {
    store.set({colorSimilarity: value});
    prefs = saveColorPreferences(storage, {...prefs, similarity: value}, COLOR_PREFS_KEY);
  }, {format: value => `${value}%`});
  bindProbeControls(host, ctx);
  renderSwatches();
  refresh();
  return {refresh};
}
