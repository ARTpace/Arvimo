// 格式筛选面板：状态（逗号字符串 + 排除布尔）与 UI 分两层，UI 只是状态的编辑器。
//
// 复刻 Serpent 的分组筛选（MIT），但呈现改成「图标 tab 切组 + 后缀 chip + 排除图标」：
// 一次只显示一组，点选即累加，不再铺满 116 个药丸，也不再用复选框与说明段落。
// 纯函数都在 format-filter-selection.js；这里只碰 DOM 与存储，便于单测注入假 storage。
import {
  formatFilterGroups, formatRegistry, formatOf, FORMAT_UNKNOWN_TOKEN, FORMAT_TEXT_TOKEN,
} from './format-registry.js';
import {
  compactFormatFilterTokens, toggleFormatToken, toggleFormatGroup,
  formatGroupSelectionState, formatTokensHas, buildFormatFilter,
  matchesFormatFilter, describeFormatFilter,
} from './format-filter-selection.js';
import {FORMAT_GROUP_VISUALS} from './filter-visuals.js';
import {icon} from './icon-set.js';
import {iconButton} from './filter-panel-common.js';

export const FORMAT_FILTER_STORAGE_KEY = 'sfx-format-filter-v1';

function safeStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }
}

/** 唯一状态源：panels / 本地网格 / 智能合集规则都从同一个实例取值。 */
export function createFormatFilterState({storage = safeStorage(), key = FORMAT_FILTER_STORAGE_KEY, onChange = null} = {}) {
  let value = '';
  let exclude = false;
  try {
    const saved = JSON.parse(storage?.getItem(key) || 'null');
    if (saved && typeof saved.value === 'string') value = saved.value.slice(0, 2000);
    exclude = saved?.exclude === true;
  } catch { /* 坏存档不该让面板打不开 */ }

  const persist = () => {
    try { storage?.setItem(key, JSON.stringify({version: 1, value, exclude})); } catch { /* 隐私模式下写不了，内存态照常用 */ }
  };
  const emit = () => onChange?.({value, exclude});

  return {
    get value() { return value; },
    get exclude() { return exclude; },
    tokens() { return compactFormatFilterTokens(value); },
    isEmpty() { return compactFormatFilterTokens(value).length === 0; },
    filter() { return {formats: compactFormatFilterTokens(value), excludeFormats: exclude}; },
    /** 给 filters / 本地网格用的匹配器；active=false 时恒为 true。 */
    matcher() { return buildFormatFilter(value, exclude); },
    matches(exts) { return matchesFormatFilter(exts, this.matcher()); },
    setValue(next, notify = true) {
      value = String(next ?? '').slice(0, 2000);
      persist();
      if (notify) emit();
    },
    setExclude(next, notify = true) {
      exclude = next === true;
      persist();
      if (notify) emit();
    },
    clear(notify = true) {
      value = '';
      exclude = false;
      persist();
      if (notify) emit();
    },
  };
}

/**
 * 把面板渲染进 host。返回 {refresh} 供「清除筛选」同步 UI。
 * onChange 在任意变更后触发（调用方自行 debounce，避免每个 chip 点击都打一次接口）。
 */
export function renderFormatFilter({host, filter, esc = value => String(value), onChange = () => {}}) {
  if (!host || !filter) return {refresh() {}};
  const groups = formatFilterGroups(formatRegistry);
  const chip = ext => ext === FORMAT_TEXT_TOKEN ? '文本' : ext;
  // 本库自有格式已按语义归位，靠 origin 标记追溯：右上角小点 + tooltip，不另起一组。
  const chipMeta = ext => {
    const origin = formatOf(ext)?.origin || 'ref';
    return {origin, title: origin === 'local' ? `本库扩展 · .${ext}` : `.${ext}`};
  };
  const tab = (id, label, name, cls = '') => `<button type="button" class="fv-tab ${cls}"
    data-group="${esc(id)}" data-state="none" title="${esc(label)}" role="tab" aria-selected="false">
    ${icon(name)}<span>${esc(label)}</span></button>`;

  host.classList.add('avq-format');
  host.innerHTML = `<div class="fv-tabs" role="tablist">
      ${groups.map(group => tab(group.id, FORMAT_GROUP_VISUALS[group.id]?.label || group.label,
        FORMAT_GROUP_VISUALS[group.id]?.icon || 'file')).join('')}
      ${tab('other', '其他', 'hash', 'fmt-other-check')}</div>
    <div class="fv-mode-row">
      ${iconButton({icon: 'keyboard', cls: 'fmt-custom-toggle', title: '手动输入后缀（逗号分隔）', esc})}
      ${iconButton({icon: 'ban', cls: 'fmt-exclude-check', title: '排除所选格式', esc})}
      <span class="fmt-summary" role="status"></span></div>
    <div class="fmt-custom" hidden><input type="search" class="fmt-input" autocomplete="off" spellcheck="false"
      maxlength="2000" placeholder="png, jpg, mp4" aria-label="自定义格式，逗号分隔"></div>
    <div class="fmt-groups">
      ${groups.map((group, index) => `
        <div class="fmt-group" data-group="${esc(group.id)}"${index ? ' hidden' : ''}>
          <div class="fv-group-bar"><span class="fv-group-label">${esc(group.label)}</span>
            <button type="button" class="fv-btn fmt-group-check" data-group="${esc(group.id)}"
              title="全选 / 取消这一组">${icon('check')}</button></div>
          <div class="fmt-chips" role="group" aria-label="${esc(group.label)}">
            ${group.exts.map(ext => {
              const meta = chipMeta(ext);
              return `<button type="button" class="fmt-chip" data-ext="${esc(ext)}"
                data-origin="${meta.origin}" title="${esc(meta.title)}"
                aria-pressed="false">${esc(chip(ext))}</button>`;
            }).join('')}
          </div></div>`).join('')}
    </div>`;

  const input = host.querySelector('.fmt-input');
  const excludeBox = host.querySelector('.fmt-exclude-check');
  const summary = host.querySelector('.fmt-summary');
  const chips = [...host.querySelectorAll('.fmt-chip')];
  const checks = [...host.querySelectorAll('.fmt-group-check')];
  const tabs = [...host.querySelectorAll('.fv-tab[data-group]')];
  let shown = groups[0]?.id || '';

  const groupExts = id => groups.find(group => group.id === id)?.exts || [];
  const showGroup = id => {
    shown = id;
    for (const node of host.querySelectorAll('.fmt-group')) node.hidden = node.dataset.group !== id;
    for (const button of tabs) button.setAttribute('aria-selected', String(button.dataset.group === id));
  };

  function refresh({syncInput = true} = {}) {
    if (syncInput && input.value !== filter.value) input.value = filter.value;
    const tokens = filter.tokens();
    for (const button of chips) {
      const active = formatTokensHas(filter.value, button.dataset.ext);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    for (const box of checks) {
      const state = formatGroupSelectionState(filter.value, groupExts(box.dataset.group));
      box.dataset.state = state;
      box.classList.toggle('is-on', state === 'all');
    }
    for (const button of tabs) {
      const state = button.dataset.group === 'other'
        ? (formatTokensHas(filter.value, FORMAT_UNKNOWN_TOKEN) ? 'all' : 'none')
        : formatGroupSelectionState(filter.value, groupExts(button.dataset.group));
      button.dataset.state = state;
    }
    excludeBox.disabled = tokens.length === 0;
    excludeBox.classList.toggle('is-on', filter.exclude);
    excludeBox.setAttribute('aria-pressed', String(filter.exclude));
    summary.textContent = tokens.length ? `${tokens.length} 项` : '';
    summary.title = describeFormatFilter(tokens, filter.exclude);
  }

  const changed = options => { refresh(options); onChange(); };

  input.addEventListener('input', () => { filter.setValue(input.value, false); changed({syncInput: false}); });
  host.addEventListener('click', event => {
    const customToggle = event.target.closest?.('.fmt-custom-toggle');
    if (customToggle) {
      const row = host.querySelector('.fmt-custom');
      row.hidden = !row.hidden;
      if (!row.hidden) input.focus();
      return;
    }
    if (event.target.closest?.('.fmt-exclude-check')) { filter.setExclude(!filter.exclude, false); changed(); return; }
    if (event.target.closest?.('.fmt-other-check')) {
      filter.setValue(toggleFormatGroup(filter.value, [FORMAT_UNKNOWN_TOKEN]), false); changed(); return;
    }
    const groupButton = event.target.closest?.('.fmt-group-check');
    if (groupButton) { filter.setValue(toggleFormatGroup(filter.value, groupExts(groupButton.dataset.group)), false); changed(); return; }
    const tabButton = event.target.closest?.('.fv-tab[data-group]');
    if (tabButton) { if (tabButton.dataset.group !== 'other') showGroup(tabButton.dataset.group); return; }
    const button = event.target.closest?.('.fmt-chip');
    if (button) { filter.setValue(toggleFormatToken(filter.value, button.dataset.ext, true), false); changed(); }
  });

  refresh();
  return {refresh};
}
