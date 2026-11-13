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

const MAX_FILES = 200;
const fmtBytes = value => {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
};
const safeName = name => String(name || 'file').replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/\\/g, '/').split('/').pop() || 'file';
const isFilesDrag = dt => Array.from(dt?.types || []).includes('Files');

/** 单张图片落在搜索面板 = 以图搜图，别抢它的事件。 */
function keepForImageSearch(event, dt) {
  if (event.shiftKey) return false;
  const target = event.target;
  if (!(target instanceof Element) || !target.closest('#search-panel')) return false;
  const items = Array.from(dt.items || []);
  return items.length === 1 && items[0].kind === 'file' && /^image\//.test(items[0].type || '');
}

/** DataTransferItem.webkitGetAsEntry() 递归展开文件夹，保留相对目录层级。 */
async function collect(dataTransfer) {
  const out = [];
  const push = (file, rel) => {
    if (out.length >= MAX_FILES) throw Error(`一次最多拖入 ${MAX_FILES} 个文件，请分批`);
    out.push({file, rel});
  };
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      push(file, prefix + safeName(entry.name));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch = [];
      do {
        batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        for (const child of batch) await walk(child, prefix + safeName(entry.name) + '/');
      } while (batch.length);
    }
  }
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind !== 'file') continue;
    let entry = null;
    try { entry = item.webkitGetAsEntry?.(); } catch { /* 合成事件 / 老内核不给 entry，退回 getAsFile */ }
    if (entry) await walk(entry, '');
    else {
      const file = item.getAsFile();
      if (file) push(file, safeName(file.name));
    }
  }
  // 老浏览器没有 items/webkitGetAsEntry 时退回 files（文件夹会退化成第一个文件）。
  if (!out.length) for (const file of Array.from(dataTransfer.files || [])) push(file, safeName(file.name));
  return out;
}

export function setupDropImport({toast, visitor, store, onImported, document: doc = globalThis.document} = {}) {
  if (visitor || !doc?.body || !store) return;
  const say = text => toast?.(text);

  // 拖入时的全屏提示：pointer-events:none，不抢画布 / 搜索栏的命中测试。
  const overlay = doc.createElement('div');
  overlay.className = 'av-drop-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="av-drop-overlay-card">${icon('download')}<strong>松手导入到资产库</strong><span>文件 / 文件夹都会入库，随后可选择加入画板</span></div>`;
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

  async function open(list) {
    if (busy) return;
    pending = list;
    chosen = new Set();
    useBoard.checked = false;
    boardsBox.hidden = true;
    newBox.hidden = true;
    newName.value = '';
    search.value = '';
    status.textContent = '';
    const total = list.reduce((sum, item) => sum + (item.file.size || 0), 0);
    summary.textContent = `${list.length} 个文件 · 共 ${fmtBytes(total)}`;
    fileList.innerHTML = list.slice(0, 8).map(item => `<div class="av-drop-file"><span title="${esc(item.rel)}">${esc(item.rel)}</span><small>${fmtBytes(item.file.size)}</small></div>`).join('')
      + (list.length > 8 ? `<div class="av-drop-file av-drop-more">…还有 ${list.length - 8} 个文件</div>` : '');
    applyButton.textContent = `导入 ${list.length} 个`;
    try { await store.refresh?.(); } catch { /* 画板接口暂时不可用时仍允许不归类导入 */ }
    renderBoards();
    dialog.showModal?.();
  }

  async function run() {
    if (busy || !pending.length) return;
    const boardIds = useBoard.checked ? [...chosen] : [];
    if (useBoard.checked && !boardIds.length) { say('先选一个画板，或取消勾选「同时加入画板」'); return; }
    busy = true;
    applyButton.disabled = true;
    const uids = [];
    let failed = 0;
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      status.textContent = `正在导入 ${i + 1}/${pending.length}：${item.rel}`;
      try {
        const response = await fetch('/api/library/drop-import', {
          method: 'POST',
          headers: {'x-sfx-local': '1', 'Content-Type': 'application/octet-stream', 'x-av-drop-name': encodeURIComponent(item.rel)},
          body: item.file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true || !data.uid) throw Error(data.error || `HTTP ${response.status}`);
        uids.push(data.uid);
      } catch (error) { failed++; status.textContent = `第 ${i + 1} 个失败：${error.message}`; }
    }
    if (boardIds.length && uids.length) {
      status.textContent = `正在把 ${uids.length} 个资产加入 ${boardIds.length} 个画板…`;
      for (const id of boardIds) {
        try { await store.addItems(id, uids); }
        catch (error) { say(`加入画板失败：${error.message}`); }
      }
    }
    try { await onImported?.(); } catch {}
    busy = false;
    applyButton.disabled = false;
    status.textContent = '';
    dialog.close();
    say(`已导入 ${uids.length} 个文件${boardIds.length && uids.length ? `，加入 ${boardIds.length} 个画板` : ''}${failed ? `，失败 ${failed} 个` : ''}`);
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
    overlay.hidden = true;
    clearTimeout(hideTimer);
    collect(dt).then(list => { if (list.length) open(list); }).catch(error => say(error.message));
  }, true);
  doc.addEventListener('dragend', () => { overlay.hidden = true; clearTimeout(hideTimer); }, true);

  return {open};
}
