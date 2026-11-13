// 外部文件 / 文件夹拖入资产库。
//
// 入口挂在 document 的 capture 阶段：#search-panel 自己有个 drop 监听（以图搜图），
// 它会 stopPropagation，所以必须在它之前判断。单张图片拖到搜索栏仍放行给以图搜图，
// 其余（多文件、非图片、文件夹、拖到别处）一律走这里的导入面板；按住 Shift 可强制走导入。
//
// 入库后拿到 uid 列表，再按用户在面板里勾选的画板调 store.addItems —— 复用的就是
// 右键「加入画板」那套数据层，不另造一份画板状态。
import {icon} from './icon-set.js';
import {esc} from './html-esc.js';
import {searchBoards} from './board-store.js';
import {formatKind} from './format-registry.js';

const MAX_FILES = 1000;
const CONCURRENCY = 4;
// 拖整个文件夹时顺带进来的系统垃圾，直接跳过，不占名额也不报错。
const JUNK = /^(thumbs\.db|desktop\.ini|\.ds_store|\.localized)$/i;
const fmtBytes = value => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
};
const safeName = name => String(name || 'file').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\\/g, '/').split('/').pop() || 'file';
const isFilesDrag = dt => Array.from(dt?.types || []).includes('Files');

// 批量导入期间屏蔽「远端资产变更 → 全量刷新」：一次 100 个文件会连续广播，
// 每来一次就整库重绘的话面板会一直闪，导入结束我们自己刷一次就够了。
let importing = false;
export const isDropImporting = () => importing;

// 一长串文件名（upscaled_e4b3bc32-8da8-…jpeg）在面板里既读不出信息又挤成一坨，
// 批量导入时按「格式 + 个数 + 总大小」归并展示更清楚；文件名塞进 tooltip 备查。
function formatGroups(list) {
  const groups = new Map();
  for (const item of list) {
    const base = String(item.rel || '').split('/').pop();
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot + 1).toUpperCase() : '其他';
    let row = groups.get(ext);
    if (!row) {
      row = {ext, kind: formatKind(item.rel), count: 0, bytes: 0, samples: []};
      groups.set(ext, row);
    }
    row.count++;
    row.bytes += item.file.size || 0;
    if (row.samples.length < 5) row.samples.push(item.rel);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}

/** 单张图片落在搜索面板 = 以图搜图，别抢它的事件。 */
function keepForImageSearch(event, dt) {
  if (event.shiftKey) return false;
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('#search-panel')) return false;
  const items = Array.from(dt.items || []);
  return items.length === 1 && items[0].kind === 'file' && /^image\//.test(items[0].type || '');
}

// 关键：条目必须在 drop 事件同步阶段全部取出来。
// DataTransfer 只在事件派发期间有效，一进 await，items 就整体失效 —— 之前一次拖 100 个
// 文件只有第一个能读出来（后面的 webkitGetAsEntry() 全返回 null），文件夹同理。
function snapshot(dataTransfer) {
  const picked = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    let entry = null;
    try { entry = item.webkitGetAsEntry?.() || null; } catch { /* 合成事件 / 老内核 */ }
    if (entry) { picked.push(entry); continue; }
    let file = null;
    try { file = item.getAsFile?.() || null; } catch { /* 同上 */ }
    if (file) picked.push(file);
  }
  // 老浏览器没有 items/webkitGetAsEntry 时退回 files（文件夹会退化成第一个文件）。
  if (!picked.length) for (const file of Array.from(dataTransfer.files || [])) picked.push(file);
  return picked;
}

/** 递归展开文件夹，保留相对目录层级；单个文件读失败不拖累整批。 */
async function collect(dataTransfer, onProgress) {
  const picked = snapshot(dataTransfer);
  const out = [];
  let skipped = 0;
  let unreadable = 0;
  const push = (file, rel) => {
    if (out.length >= MAX_FILES) { skipped++; return; }
    out.push({file, rel});
    if (out.length % 25 === 0) onProgress?.(out.length);
  };
  const readable = name => !JUNK.test(name) && !name.startsWith('.');

  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      push(file, prefix + safeName(entry.name));
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    const dirPrefix = prefix + safeName(entry.name) + '/';
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) {
        if (!readable(child.name)) continue;
        try { await walk(child, dirPrefix); } catch { unreadable++; }
      }
    }
  }

  for (const item of picked) {
    if (item?.isFile || item?.isDirectory) {
      try { await walk(item, ''); } catch { unreadable++; }
    } else if (item?.size >= 0 && item?.name) {
      if (readable(item.name)) push(item, safeName(item.name));
    }
  }
  onProgress?.(out.length);
  return {files: out, skipped, unreadable, truncated: skipped};
}

export function setupDropImport({toast, visitor, store, onImported, document: doc = globalThis.document} = {}) {
  if (visitor || !doc?.body || !store) return;
  const say = text => toast?.(text);

  // 拖入时的全屏提示：pointer-events:none，不抢画布 / 搜索栏的命中测试。
  const overlay = doc.createElement('div');
  overlay.className = 'av-drop-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="av-drop-overlay-card">${icon('download')}<strong>松手导入到资产库</strong><span class="av-drop-overlay-hint">文件 / 文件夹都会入库，随后可选择加入画板</span></div>`;
  doc.body.appendChild(overlay);

  const dialog = doc.createElement('dialog');
  dialog.className = 'bd-dialog av-drop-dialog';
  dialog.setAttribute('aria-label', '导入到资产库');
  dialog.innerHTML = `
    <div class="bd-head"><span class="bd-head-ic">${icon('download')}</span>
      <strong>导入到资产库</strong><span class="bd-engine">拖入的文件会复制到资产库数据目录</span>
      <button type="button" class="icon-button" data-act="close" aria-label="关闭">${icon('close')}</button></div>
    <div class="av-drop-summary" role="status"></div>
    <div class="av-drop-files"></div>
    <div class="av-drop-bar" hidden><i></i></div>
    <label class="av-drop-board-toggle"><input type="checkbox" class="av-drop-use-board"> 同时加入画板</label>
    <div class="av-drop-boards" hidden>
      <div class="bd-picker-search"><label>${icon('search')}<input type="search" class="av-drop-search" placeholder="搜索画板" aria-label="搜索画板"></label>
        <button type="button" class="icon-button" data-act="new" title="新建画板" aria-label="新建画板">${icon('plus')}</button></div>
      <div class="bd-new" hidden><input type="text" class="av-drop-new-name" maxlength="60" placeholder="画板名称" aria-label="画板名称">
        <button type="button" class="primary" data-act="create">创建</button></div>
      <div class="bd-picker-list" role="listbox" aria-multiselectable="true"></div>
    </div>
    <div class="av-drop-status" role="status"></div>
    <div class="bd-foot"><span class="av-drop-note">不勾画板也会导入，只是不归类</span>
      <button type="button" class="secondary" data-act="close">取消</button>
      <button type="button" class="primary" data-act="apply">导入</button></div>`;
  doc.body.appendChild(dialog);

  const summary = dialog.querySelector('.av-drop-summary');
  const fileList = dialog.querySelector('.av-drop-files');
  const useBoard = dialog.querySelector('.av-drop-use-board');
  const boardsBox = dialog.querySelector('.av-drop-boards');
  const boardList = dialog.querySelector('.bd-picker-list');
  const search = dialog.querySelector('.av-drop-search');
  const newBox = dialog.querySelector('.bd-new');
  const newName = dialog.querySelector('.av-drop-new-name');
  const status = dialog.querySelector('.av-drop-status');
  const bar = dialog.querySelector('.av-drop-bar');
  const barFill = bar.querySelector('i');
  const applyButton = dialog.querySelector('[data-act="apply"]');

  let pending = [];
  let chosen = new Set();
  let busy = false;

  function renderBoards() {
    const rows = searchBoards(store.flat(), search.value);
    boardList.innerHTML = rows.length ? rows.map(row => `<button type="button" class="bd-row${chosen.has(row.id) ? ' on' : ''}"
      data-id="${esc(row.id)}" role="option" aria-selected="${chosen.has(row.id)}" style="--indent:${row.depth}"
      title="${esc(row.path.join(' / '))}"><i class="bd-dot" style="--dot:${esc(row.color || '#6d8cff')}"></i>
      <span class="bd-row-name">${esc(row.name)}</span><small>${row.assetCount}</small>
      <i class="bd-check">${chosen.has(row.id) ? icon('check') : ''}</i></button>`).join('')
      : `<div class="bd-empty">${icon('layers')}<span>还没有画板，点 + 新建一个</span></div>`;
  }

  async function open(list, meta = {}) {
    if (busy) return;
    pending = list;
    chosen = new Set();
    useBoard.checked = false;
    boardsBox.hidden = true;
    newBox.hidden = true;
    newName.value = '';
    search.value = '';
    status.textContent = '';
    bar.hidden = true;
    barFill.style.width = '0%';
    const total = list.reduce((sum, item) => sum + (item.file.size || 0), 0);
    const groups = formatGroups(list);
    const notes = [];
    if (meta.truncated) notes.push(`超出单次上限 ${MAX_FILES} 个，先导入前 ${list.length} 个`);
    if (meta.unreadable) notes.push(`${meta.unreadable} 个读不出来已跳过`);
    summary.textContent = `${list.length} 个文件${groups.length > 1 ? ` · ${groups.length} 种格式` : ''} · 共 ${fmtBytes(total)}${notes.length ? `（${notes.join('，')}）` : ''}`;
    const shown = groups.slice(0, 8);
    fileList.innerHTML = shown.map(row => `<div class="av-drop-file av-drop-group" title="${esc(row.samples.join('\n'))}">
      <i class="av-drop-badge" data-kind="${esc(row.kind || 'other')}">${esc(row.ext)}</i>
      <span class="av-drop-group-count">${row.count} 个</span>
      <small>${fmtBytes(row.bytes)}</small></div>`).join('')
      + (groups.length > shown.length ? `<div class="av-drop-file av-drop-more">…还有 ${groups.length - shown.length} 种格式</div>` : '');
    applyButton.textContent = `导入 ${list.length} 个`;
    dialog.showModal?.();
    try { await store.refresh?.(); } catch { /* 画板接口暂时不可用时仍允许不归类导入 */ }
    renderBoards();
  }

  async function run() {
    if (busy || !pending.length) return;
    const boardIds = useBoard.checked ? [...chosen] : [];
    if (useBoard.checked && !boardIds.length) { say('先选一个画板，或取消勾选「同时加入画板」'); return; }
    busy = true;
    importing = true;
    applyButton.disabled = true;
    const uids = [];
    let failed = 0;
    let lastError = '';
    let done = 0;
    let skipped = 0;
    const queue = pending.slice();
    bar.hidden = false;
    barFill.style.width = '0%';
    status.textContent = `正在导入 0/${pending.length}…`;
    const step = () => {
      done++;
      barFill.style.width = `${Math.round((done / pending.length) * 100)}%`;
      status.textContent = queue.length
        ? `正在导入 ${done}/${pending.length}：${queue[0].rel}`
        : `已完成 ${done}/${pending.length}`;
    };
    // 每个请求自己流式落盘，服务端串行入库；并发 4 路只为把网络与哈希时间叠起来，
    // 一次 100 个文件不用排队等 100 个来回。
    const upload = async item => {
      const response = await fetch('/api/library/drop-import', {
        method: 'POST',
        headers: {'x-sfx-local': '1', 'Content-Type': 'application/octet-stream', 'x-av-drop-name': encodeURIComponent(item.rel)},
        body: item.file,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true || !data.uid) throw Error(data.error || `HTTP ${response.status}`);
      if (data.status === 'skipped') skipped++;
      uids.push(data.uid);
    };
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        try { await upload(item); }
        catch (error) { failed++; lastError = `${item.rel}：${error.message}`; }
        step();
      }
    };
    await Promise.all(Array.from({length: Math.min(CONCURRENCY, pending.length)}, worker));
    if (boardIds.length && uids.length) {
      status.textContent = `正在把 ${uids.length} 个资产加入 ${boardIds.length} 个画板…`;
      for (const id of boardIds) {
        try { await store.addItems(id, uids); }
        catch (error) { say(`加入画板失败：${error.message}`); }
      }
    }
    try { await onImported?.(); } catch {}
    busy = false;
    importing = false;
    applyButton.disabled = false;
    status.textContent = '';
    bar.hidden = true;
    dialog.close();
    const dup = skipped;
    say(`已导入 ${uids.length} 个文件${boardIds.length && uids.length ? `，加入 ${boardIds.length} 个画板` : ''}${dup > 0 ? `，${dup} 个重复已跳过` : ''}${failed ? `，失败 ${failed} 个${lastError ? `（${lastError}）` : ''}` : ''}`);
  }

  dialog.addEventListener('click', async event => {
    const action = event.target.closest?.('[data-act]')?.dataset.act;
    if (action === 'close') { if (!busy) dialog.close(); return; }
    if (action === 'apply') return run();
    if (busy) return;
    if (action === 'new') { newBox.hidden = false; newName.focus(); return; }
    if (action === 'create') {
      const name = newName.value.trim();
      if (!name) { say('请输入画板名称'); return; }
      try {
        const id = await store.create({name, parentId: null});
        chosen.add(id);
        newName.value = ''; newBox.hidden = true;
        renderBoards();
      } catch (error) { say(error?.message || '新建画板失败'); }
      return;
    }
    const row = event.target.closest?.('.bd-row');
    if (row) {
      const id = row.dataset.id;
      if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
      renderBoards();
    }
  });
  search.addEventListener('input', renderBoards);
  newName.addEventListener('keydown', event => { if (event.key === 'Enter') dialog.querySelector('[data-act="create"]').click(); });
  useBoard.addEventListener('change', () => { boardsBox.hidden = !useBoard.checked; if (useBoard.checked) renderBoards(); });

  let hideTimer = 0;
  doc.addEventListener('dragover', event => {
    const dt = event.dataTransfer;
    if (!isFilesDrag(dt) || keepForImageSearch(event, dt)) return;
    event.preventDefault();
    if (dt) dt.dropEffect = 'copy';
    overlay.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { overlay.hidden = true; }, 180);
  }, true);
  doc.addEventListener('drop', event => {
    const dt = event.dataTransfer;
    if (!isFilesDrag(dt) || keepForImageSearch(event, dt)) return;
    event.preventDefault();
    event.stopPropagation();     // 挡住 #search-panel 的以图搜图 drop
    clearTimeout(hideTimer);
    // 展开文件夹可能几百毫秒，期间把浮层当进度条用，免得界面像卡死。
    const hint = overlay.querySelector('.av-drop-overlay-hint');
    const collecting = n => {
      overlay.hidden = false;
      hint.textContent = n ? `正在读取 ${n} 个文件…` : '正在读取文件…';
    };
    collecting(0);
    collect(dt, n => collecting(n))
      .then(result => {
        overlay.hidden = true;
        hint.textContent = '文件 / 文件夹都会入库，随后可选择加入画板';
        if (!result.files.length) { say(result.unreadable ? '这些文件读不出来，换个位置再试' : '没有可导入的文件'); return; }
        open(result.files, result);
      })
      .catch(error => { overlay.hidden = true; hint.textContent = '文件 / 文件夹都会入库，随后可选择加入画板'; say(error.message); });
  }, true);
  doc.addEventListener('dragend', () => { overlay.hidden = true; clearTimeout(hideTimer); }, true);

  return {open};
}
