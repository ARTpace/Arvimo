// 资产检查：库内「目录 ↔ 记录」一致性。
//
// 2026-11-18 起不再是独立弹窗：并入「工具检测」（原「资源占用」面板）作为下半块，
// 由 resource-usage.js 挂载。这里只负责渲染一块 <section> 与它自己的取数/修复。
//
// 判据与修复动作全在服务端（server/library-audit.mjs），前端不自己重复算一遍——
// 两处规则各写一套，最后一定对不上。
//
// 能修的两类（都可恢复：进回收站，不删磁盘文件）：
//   1. 归属锚点：记录缺 payload.packageDir → 补上，扫描侧不用再靠前缀推断；
//   2. 重复记录：同一包目录被多条记录占着 → 留最完整的一条，其余进回收站。
// 只报告的两类：
//   3. 路径失效：包目录 / 主文件真的不在了，留不留由主人决定；
//   4. 未登记包：目录里有身份却没记录，可能是刚拷进来还没登记的正常目录。
import {icon} from './icon-set.js';

const STAT = [
  { key: 'anchors', label: '归属锚点缺失', hint: '记录里没写包目录，扫描侧只能靠前缀推断' },
  { key: 'duplicates', label: '重复记录', hint: '同一个包目录被几条记录占着' },
  { key: 'dangling', label: '路径失效', hint: '记录指向的目录或文件已经不在了' },
  { key: 'pending', label: '未登记包', hint: '目录里有身份信息，资产库里没有记录' },
  { key: 'noThumb', label: '没有缩略图', hint: '卡片会显示占位图' },
];

const short = (value, max = 52) => {
  const text = String(value || '');
  return text.length > max ? `…${text.slice(-max)}` : text;
};

/**
 * 把「资产检查」这块挂到 host（一个空 <section>）里。
 * 取数在首次挂载时立刻跑一次；之后每次面板打开调用 reload()。
 */
export function createAssetAudit({
  host,
  esc = value => String(value),
  notify = () => {},
  fmtNumber = value => String(value),
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  if (!host) return null;
  let report = null;
  let busy = false;
  let error = '';

  const row = (title, sub, tail) => `<li class="aa-row">
      <span class="aa-name" title="${esc(title)}">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      ${tail ? `<span class="aa-tail">${esc(tail)}</span>` : ''}
    </li>`;

  function section(key, title, hint, items, { repairKind = '', empty = '没有发现。' } = {}) {
    const count = report?.counts?.[key] || 0;
    if (!count) return '';
    return `<section class="aa-section">
      <div class="aa-section-head">
        <h3>${esc(title)}<small>${fmtNumber(count)} 项</small></h3>
        ${repairKind ? `<button type="button" class="text-button aa-fix" data-kind="${repairKind}"${busy ? ' disabled' : ''}>修复</button>` : '<span class="aa-readonly">仅报告</span>'}
      </div>
      <p class="aa-section-hint">${esc(hint)}</p>
      ${items?.length ? `<ul class="aa-list">${items}</ul>` : `<p class="aa-empty">${esc(empty)}</p>`}
    </section>`;
  }

  function render() {
    const counts = report?.counts || {};
    const stats = STAT.map(item => `<div class="aa-stat${counts[item.key] ? ' has-issue' : ''}" title="${esc(item.hint)}">
        <strong>${fmtNumber(counts[item.key] ?? 0)}</strong><span>${esc(item.label)}</span>
      </div>`).join('');

    const anchors = (report?.anchors || []).slice(0, 20).map(item => row(item.name, short(item.dir, 60), item.platform || '')).join('');
    const duplicates = (report?.duplicates || []).slice(0, 10).map(group => row(
      group.keep?.name || group.dir,
      `保留 ${short(group.keep?.name || '', 24)} · 移除 ${group.drops.length} 条`,
      short(group.dir, 40),
    )).join('');
    const dangling = (report?.dangling || []).slice(0, 20).map(item => row(item.name, short(item.target, 56) || '（路径为空）', item.what || '')).join('');
    const pending = (report?.pending || []).slice(0, 20).map(item => row(item.rel, item.uid ? `uid ${String(item.uid).slice(0, 8)}` : '无 uid', '')).join('');

    host.innerHTML = `<div class="tc-block-head"><h2>${icon('scan')}资产检查</h2>
        <button type="button" class="aa-reload" data-aa-reload>重新检查</button></div>
      ${error ? `<p class="aa-error">${icon('help')}<span>${esc(error)}</span></p>` : ''}
      <p class="aa-hint">${icon('help')}<span>检查的是「资产记录」和「磁盘目录」有没有对上。修复只会补字段或把多余记录移进回收站，不改动磁盘上的素材。</span></p>
      ${!report ? '<p class="aa-loading">正在检查…</p>' : `
      <div class="aa-stats">${stats}</div>
      <p class="aa-total">共 <strong>${fmtNumber(counts.assets || 0)}</strong> 条资产在库</p>
      ${section('anchors', '归属锚点缺失', '这些记录只有主文件路径，包目录靠推断。补上之后，就算主文件改名也不会再出现「同一资产两张卡」。', anchors, { repairKind: 'anchors' })}
      ${section('duplicates', '重复记录', '同一个包目录被几条记录占着。修复会保留最完整的一条（有缩略图、主文件还在），其余移进回收站。', duplicates, { repairKind: 'duplicates' })}
      ${section('dangling', '路径失效', '记录指向的目录或文件已经不在了。可能是被手工移动/删除，也可能是迁移时没搬全；留着还是清掉由你决定。', dangling)}
      ${section('pending', '未登记包', '目录里有包内身份（info.json / uid），资产库里却查不到记录。刚拷进来还没登记的目录也会出现在这里。', pending)}
      <p class="aa-foot">${icon('help')}<span>修复是可恢复的：移进回收站的记录随时能还原，磁盘上的素材不会被删。</span></p>`}`;

    if (busy) host.querySelectorAll('.aa-fix').forEach(button => { button.disabled = true; });
  }

  async function load() {
    error = '';
    report = null;
    render();
    try {
      const response = await fetchImpl('/api/library/audit', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `服务返回 ${response.status}`);
      report = data;
    } catch (cause) {
      error = `检查失败：${cause.message}`;
    }
    render();
  }

  async function repair(kinds) {
    if (busy) return;
    busy = true;
    render();
    try {
      const response = await fetchImpl('/api/library/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kinds }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `服务返回 ${response.status}`);
      report = data.report || report;
      busy = false;
      error = '';
      render();
      notify(data.applied ? `已修复 ${data.applied} 项` : '没有需要修的项目');
    } catch (cause) {
      busy = false;
      error = `修复失败：${cause.message}`;
      render();
    }
  }

  host.onclick = event => {
    if (event.target.closest?.('[data-aa-reload]')) { load().catch(() => {}); return; }
    const fix = event.target.closest?.('.aa-fix');
    if (!fix) return;
    repair([fix.dataset.kind]).catch(() => {});
  };

  render();
  load().catch(() => {});
  return { reload: () => load().catch(() => {}) };
}
