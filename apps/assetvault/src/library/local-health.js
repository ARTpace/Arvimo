// 本地库体检：占用排行 / 疑似重复 / 空包。
//
// 纯计算 + 一个自建 dialog（不改 index.html）。删除动作由调用方注入 —— 复用 app.js 里
// 已经走通的 deleteLibraryAsset（同一条 /api/library/delete：删磁盘目录 + 摘索引 + 清缓存），
// 这里只管把「删哪个包」递出去，不自己碰文件系统。
import {icon} from './icon-set.js';

/** 包名归一化：去扩展名、去尾部 hash / 副本后缀，用于识别「同一份素材的两次下载」。 */
export function normalizeAssetName(value) {
  return String(value || '')
    .replace(/\\/g, '/').split('/').pop()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[-_\s]*(?:copy|副本)(?:\s*\(\d+\))?$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/(?:[-_][0-9a-f]{6,})+$/i, '')
    .replace(/[\s_\-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 一句话体检报告：体积、包数、文件数、最大三件、重复组、空包。 */
export function healthReport(packages = [], { topLimit = 8 } = {}) {
  const list = (Array.isArray(packages) ? packages : []).filter(Boolean);
  const totalBytes = list.reduce((sum, pkg) => sum + (Number(pkg.bytes) || 0), 0);
  const totalFiles = list.reduce((sum, pkg) => sum + (Number(pkg.fileCount) || 0), 0);
  const biggest = [...list].sort((a, b) => (Number(b.bytes) || 0) - (Number(a.bytes) || 0)).slice(0, topLimit);

  const groups = new Map();
  for (const pkg of list) {
    const name = normalizeAssetName(pkg.title || pkg.rel || pkg.name);
    if (!name) continue;
    const bytes = Number(pkg.bytes) || 0;
    // 同名 + 同大小才算「同一份」；同名不同大小多半是不同版本，误删代价太高，不列进来。
    const key = `${name}|${bytes}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pkg);
  }
  const duplicates = [...groups.values()]
    .filter(group => group.length > 1)
    .sort((a, b) => (Number(b[0].bytes) || 0) - (Number(a[0].bytes) || 0))
    .slice(0, 20);

  const empty = list.filter(pkg => !(Number(pkg.fileCount) > 0));
  const wastedBytes = duplicates.reduce((sum, group) => sum
    + group.slice(1).reduce((inner, pkg) => inner + (Number(pkg.bytes) || 0), 0), 0);

  return { totalBytes, totalFiles, count: list.length, biggest, duplicates, empty, wastedBytes };
}

const shortPath = (pkg, limit = 44) => {
  const rel = String(pkg.rel || pkg.name || '');
  return rel.length > limit ? `…${rel.slice(-limit)}` : rel;
};

function rowHtml(pkg, { esc, fmtBytes, icon: iconOf }) {
  return `<li class="lh-row" data-root="${esc(pkg.root || '')}" data-rel="${esc(pkg.rel || '')}">
    <span class="lh-ic">${iconOf(pkg.category === 'images' ? 'image' : pkg.category === 'textures' ? 'palette' : 'cube')}</span>
    <span class="lh-name" title="${esc(`${pkg.root}\\${pkg.rel}`)}">${esc(pkg.title || pkg.name || pkg.rel)}
      <small>${esc(shortPath(pkg))}</small></span>
    <span class="lh-size">${esc(fmtBytes(Number(pkg.bytes) || 0))}</span>
    <button type="button" class="lh-del" data-del title="删除这个资产（磁盘目录一起删）">${icon('trash')}</button>
  </li>`;
}

/** 打开体检面板；每次打开都按当前扫描结果重算，不做缓存。 */
export function openLocalHealth({
  packages = [], fmtBytes = value => `${value}`, esc = value => String(value), onDelete = null,
  doc = typeof document !== 'undefined' ? document : null, confirmFn = null,
} = {}) {
  if (!doc) return null;
  const report = healthReport(packages);

  let dialog = doc.querySelector('#local-health-dialog');
  if (!dialog) {
    dialog = doc.createElement('dialog');
    dialog.id = 'local-health-dialog';
    dialog.className = 'local-health-dialog';
    doc.body.append(dialog);
  }
  dialog.innerHTML = `<div class="dialog-header"><span>${icon('shield')}本地库体检</span>
      <button type="button" class="lh-close" title="关闭" aria-label="关闭">${icon('close')}</button></div>
    <div class="dialog-body lh-body">
      <div class="lh-stats">
        <div><strong>${esc(fmtBytes(report.totalBytes))}</strong><span>磁盘占用</span></div>
        <div><strong>${report.count}</strong><span>资产包</span></div>
        <div><strong>${report.totalFiles}</strong><span>文件</span></div>
      </div>
      ${report.wastedBytes > 0 ? `<p class="lh-hint">${icon('help')}<span>疑似重复里有约 ${esc(fmtBytes(report.wastedBytes))} 是重复占用的空间。</span></p>` : ''}

      <section class="lh-section"><h3>占用最大</h3>
        ${report.biggest.length ? `<ul class="lh-list">${report.biggest.map(pkg => rowHtml(pkg, { esc, fmtBytes, icon }))
          .join('')}</ul>` : '<p class="lh-empty">还没有扫描出资产包。</p>'}
      </section>

      <section class="lh-section"><h3>疑似重复<small>${report.duplicates.length ? `${report.duplicates.length} 组` : ''}</small></h3>
        ${report.duplicates.length ? report.duplicates.map(group => `<div class="lh-dupe">
            <p class="lh-dupe-title">${esc(group[0].title || group[0].rel)}<small>${group.length} 份 · 同名同大小</small></p>
            <ul class="lh-list">${group.map(pkg => rowHtml(pkg, { esc, fmtBytes, icon })).join('')}</ul>
          </div>`).join('') : '<p class="lh-empty">没发现同名同大小的重复包。</p>'}
      </section>

      ${report.empty.length ? `<section class="lh-section"><h3>空包<small>${report.empty.length} 个</small></h3>
        <ul class="lh-list">${report.empty.slice(0, 10).map(pkg => rowHtml(pkg, { esc, fmtBytes, icon })).join('')}</ul>
      </section>` : ''}
      <p class="lh-foot">${icon('help')}<span>删除会连同磁盘目录一起移除，不可撤销；只删你确定不要的那一份。</span></p>
    </div>`;
  // 事件只绑一次：innerHTML 每次打开都会重建，但 dialog 本体不换，重复绑会叠加。
  if (!dialog.dataset.bound) {
    dialog.dataset.bound = '1';
    dialog.addEventListener('click', async event => {
      if (event.target.closest?.('.lh-close')) { dialog.close(); return; }
      const button = event.target.closest?.('.lh-del');
      if (!button || !onDelete) return;
      const row = button.closest('.lh-row');
      if (!row) return;
      const ask = confirmFn || (text => globalThis.confirm?.(text));
      if (!ask(`删除「${row.dataset.rel}」？磁盘上的目录会一起删掉，不可撤销。`)) return;
      button.disabled = true;
      await onDelete({ root: row.dataset.root, rel: row.dataset.rel, thumbnail: '' });
      dialog.close();
    });
  }
  if (!dialog.open) dialog.showModal();
  return report;
}
