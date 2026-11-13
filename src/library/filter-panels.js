// 面板注册表：一个维度一个渲染函数，各面板拆到独立文件，单文件都守住 ≤300 行。
//
// 纪律：面板只读写 ctx.store 与 ctx.controls 暴露的既有缝，不碰查询 / 分页实现；
// 没数据支撑的控件一律不摆样子 —— 颜色 / 形状面板都带封面采集进度与扫描入口。
import {colorPanel} from './filter-panel-colors.js';
import {tagsPanel} from './filter-panel-tags.js';
import {kindsPanel} from './filter-panel-shapes.js';
import {morePanel} from './filter-panel-more.js';
import {ratingPanel, favoritePanel, formatPanel, sortPanel} from './filter-panel-basic.js';
import {foldersPanel} from './filter-panel-folders.js';
import {sourcePanel} from './filter-panel-source.js';

// 兼容旧调用点：标签候选以前从这里导出，现在实现搬到了 filter-panel-tags.js。
export {tagCandidates, tagCounts} from './filter-panel-tags.js';

const PANELS = Object.freeze({
  color: colorPanel,
  tags: tagsPanel,
  kinds: kindsPanel,
  rating: ratingPanel,
  favorite: favoritePanel,
  format: formatPanel,
  folders: foldersPanel,
  source: sourcePanel,
  more: morePanel,
  sort: sortPanel,
});

/** 展开面板的统一入口；未知 id 返回空面板而不是抛错（配置缝允许增减维度）。 */
export function renderFilterPanel(id, host, ctx) {
  if (!host) return {refresh() {}};
  const render = PANELS[id];
  if (!render) { host.innerHTML = ''; return {refresh() {}}; }
  return render(host, ctx);
}

export const PANEL_IDS = Object.freeze(Object.keys(PANELS));
