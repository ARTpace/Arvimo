// 「目录」面板：把磁盘上扫出来的本地资产按「包相对根的第一段路径」聚成文件夹。
//
// 这一维只对本地区间有意义（在线平台没有文件夹这一层），所以它不进查询 payload：
// dock 把选中的目录摊到共享 state.folders 上，由 app.js 的 extraCards() 消费。
// 面板只做聚合与排序，不认业务；候选一律来自 ctx.packages()（扫描结果）。
import {folderOf, ROOT_FOLDER_KEY} from './filter-dimensions.js';
import {iconChip, syncChips, emptyState} from './filter-panel-common.js';
import {icon} from './icon-set.js';

/** 扫描结果 → [{key,count}]，数量多的排前面，同数量按名称。 */
export function folderRows(packages = []) {
  const counts = new Map();
  for (const pkg of packages) {
    const key = folderOf(pkg?.rel);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({key, count}))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'zh'));
}

export function foldersPanel(host, ctx) {
  const {esc, store, packages} = ctx;
  const render = () => {
    const rows = folderRows(packages?.() || []);
    if (!rows.length) {
      host.innerHTML = emptyState('还没有扫出文件夹，先在命令条点扫描', 'folder', esc);
      return;
    }
    host.innerHTML = `<div class="fv-group">
      <span class="fv-group-label" title="按资产包所在的文件夹收窄 · Shift 多选 · 再点一下取消">目录</span>
      <div class="fv-chips fv-folders" role="group" aria-label="目录">
        ${rows.map(row => iconChip({
          value: row.key,
          icon: row.key === ROOT_FOLDER_KEY ? 'file' : 'folder',
          label: row.key,
          title: `${row.key} · ${row.count} 个资产`,
          cls: 'fv-folder',
          esc,
        })).join('')}
      </div>
    </div>
    <p class="fv-note">${icon('folder')}<span>只影响磁盘上扫出来的资产；在线平台的卡片没有文件夹层级。</span></p>`;
    syncChips(host, store.get().folders);
  };

  host.addEventListener('click', event => {
    const chip = event.target.closest?.('.fv-chip[data-value]');
    if (!chip) return;
    const key = chip.dataset.value;
    const selected = new Set(store.get().folders);
    if (event.shiftKey) {
      if (selected.has(key)) selected.delete(key); else selected.add(key);
    } else if (selected.size === 1 && selected.has(key)) {
      selected.clear();
    } else {
      selected.clear();
      selected.add(key);
    }
    store.set({folders: [...selected].slice(0, 100)});
  });

  render();
  return {refresh: render};
}
