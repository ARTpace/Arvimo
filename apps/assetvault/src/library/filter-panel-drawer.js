// 工具栏与规则编辑器共享的抽屉壳；事件由调用方唯一绑定，无全局监听。
import {icon} from './icon-set.js';
import {FILTER_DIMENSIONS, ALL_DIMENSIONS, dimensionActive} from './filter-dimensions.js';
import {PANEL_TIPS, PANEL_VISUALS} from './filter-visuals.js';
import {iconButton} from './filter-panel-common.js';
import {activeFilterChips} from './filter-state.js';
import {renderFilterPanel} from './filter-panels.js';
export function createFilterPanelDrawer({host, ctx, dimensions = FILTER_DIMENSIONS, closable = true}) {
  const {esc} = ctx;
  let id = '', panel;
  function refresh(snapshot) {
    for (const button of host.querySelectorAll('.fd-rail-btn')) {
      button.classList.toggle('is-current', button.dataset.id === id);
      button.classList.toggle('is-set', dimensionActive(button.dataset.id, snapshot));
      button.setAttribute('aria-selected', String(button.dataset.id === id));
    }
    const chips = activeFilterChips(snapshot), active = host.querySelector('.fd-active');
    if (active) {
      active.hidden = !chips.length;
      active.innerHTML = chips.map(item => `<button type="button" class="fd-active-chip" data-dim="${esc(item.id)}" title="${esc(`${item.label}：${item.detail || ''} · 点击移除`)}" style="--fv-tone:${esc(PANEL_VISUALS[item.id]?.tone || '#C9F581')}">${icon(PANEL_VISUALS[item.id]?.icon || 'filter')}<span>${esc(item.label)}</span><i>×</i></button>`).join('') + (chips.length ? `<button type="button" class="fd-clear-all" title="清除全部">${icon('trash')}</button>` : '');
    }
    const badge = host.querySelector('.fd-pop-badge');
    if (badge) badge.hidden = !id || !dimensionActive(id, snapshot);
    panel?.refresh();
  }
  function open(next) {
    const dim = ALL_DIMENSIONS.find(item => item.id === next);
    if (!dim) return;
    id = next; host.dataset.id = id; host.hidden = false;
    host.innerHTML = `<div class="fd-drawer"><div class="fd-rail" role="tablist" aria-label="筛选维度">${dimensions.map(row => `<button type="button" class="fd-rail-btn" data-id="${esc(row.id)}" role="tab" title="${esc(PANEL_TIPS[row.id] || row.hint)}" aria-label="${esc(row.label)}" aria-selected="false">${icon(row.icon)}</button>`).join('')}</div><div class="fd-drawer-main"><div class="fd-pop-head"><span class="fd-pop-ic">${icon(dim.icon)}</span><strong>${esc(dim.label)}</strong><span class="fd-pop-badge" hidden></span><span class="fv-tip" title="${esc(PANEL_TIPS[id] || dim.hint)}">${icon('help')}</span>${iconButton({icon:'trash',cls:'fd-pop-reset',title:'清除本维度',esc})}${closable ? iconButton({icon:'close',cls:'fd-pop-close',title:'关闭面板',esc}) : ''}</div><div class="fd-active" hidden></div><div class="fd-pop-body"></div></div></div>`;
    panel = renderFilterPanel(id, host.querySelector('.fd-pop-body'), ctx);
    return panel;
  }
  return {open, refresh, get id() { return id; }};
}
