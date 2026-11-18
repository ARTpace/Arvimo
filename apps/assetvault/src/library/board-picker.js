import {showActionCard} from './action-card.js';
import {withRemovalMotion} from './removal-motion.js';
// 画板选择器：卡片右键 / 批量栏共用。视觉沿用「少文字 + 图标 + 颜色」，类名一律 bd-*。
// 自建 dialog，不改 index.html；确认后只调 store.addItems / removeItems，不碰渲染链。
import {searchBoards} from './board-store.js';

export function createBoardPicker({esc, icon, toast, store, onRemoved, document: doc = globalThis.document} = {}) {
  if (!store || !doc) throw Error('画板选择器缺少依赖');
  const dialog = doc.createElement('dialog');
  dialog.className = 'bd-dialog bd-picker';
  dialog.setAttribute('aria-label', '选择画板');
  dialog.innerHTML = `
    <div class="bd-head"><span class="bd-head-ic">${icon('layers')}</span>
      <strong class="bd-title">选择画板</strong><span class="bd-count" role="status"></span>
      <button type="button" class="icon-button" data-act="close" aria-label="关闭">${icon('close')}</button></div>
    <div class="bd-picker-search"><label>${icon('search')}<input type="search" class="bd-search" placeholder="搜索画板" aria-label="搜索画板"></label>
      <button type="button" class="icon-button" data-act="new" title="新建画板" aria-label="新建画板">${icon('plus')}</button></div>
    <div class="bd-new" hidden><input type="text" class="bd-new-name" maxlength="60" placeholder="画板名称" aria-label="画板名称">
      <select class="bd-new-parent" aria-label="上级画板"><option value="">顶层画板</option></select>
      <button type="button" class="primary" data-act="create">创建</button></div>
    <div class="bd-picker-list" role="listbox" aria-multiselectable="true"></div>
    <div class="bd-foot"><span class="bd-selected-note"></span>
      <button type="button" class="primary" data-act="apply">加入</button></div>`;
  doc.body.appendChild(dialog);

  const list = dialog.querySelector('.bd-picker-list');
  const search = dialog.querySelector('.bd-search');
  const newBox = dialog.querySelector('.bd-new');
  const newName = dialog.querySelector('.bd-new-name');
  const newParent = dialog.querySelector('.bd-new-parent');

  /** 上级画板下拉：树已经在 store.flat() 里扁平化好了，这里只负责缩进显示，不重算层级。 */
  function fillParents() {
    const current = newParent.value;
    const rows = store.flat();
    newParent.innerHTML = '<option value="">顶层画板</option>' + rows.map(row =>
      `<option value="${esc(row.id)}">${esc('　'.repeat(row.depth) + row.name)}</option>`).join('');
    if ([...newParent.options].some(option => option.value === current)) newParent.value = current;
  }
  let uids = [];
  let mode = 'add';
  let chosen = new Set();
  let resolve = null;

  const finish = value => { const done = resolve; resolve = null; dialog.close(); done?.(value); };

  function render() {
    fillParents();
    const rows = searchBoards(store.flat(), search.value);
    if (!rows.length) {
      list.innerHTML = `<div class="bd-empty">${icon('layers')}<span>还没有画板，点 + 新建一个</span></div>`;
    } else {
      list.innerHTML = rows.map(row => `<button type="button" class="bd-row${chosen.has(row.id) ? ' on' : ''}"
        data-id="${esc(row.id)}" role="option" aria-selected="${chosen.has(row.id)}" style="--indent:${row.depth}"
        title="${esc(row.path.join(' / '))}"><i class="bd-dot" style="--dot:${esc(row.color || '#6d8cff')}"></i>
        <span class="bd-row-name">${esc(row.name)}</span><small>${row.assetCount}</small>
        <i class="bd-check">${chosen.has(row.id) ? icon('check') : ''}</i></button>`).join('');
    }
    dialog.querySelector('.bd-count').textContent = `${store.list().length} 个画板`;
    dialog.querySelector('.bd-selected-note').textContent = chosen.size ? `已选 ${chosen.size} 个` : '';
    dialog.querySelector('[data-act="apply"]').textContent = mode === 'remove' ? '移出' : '加入';
  }

  async function apply() {
    if (!chosen.size) { toast('先选一个画板'); return; }
    const ids = [...chosen];
    try {
      for (const id of ids) await (mode === 'remove' ? store.removeItems(id, uids) : store.addItems(id, uids));
      toast(`${mode === 'remove' ? '已移出' : '已加入'} ${ids.length} 个画板`);
      finish(true);
    } catch (error) { toast(error?.message || '画板操作失败'); }
  }

  dialog.addEventListener('click', async event => {
    const action = event.target.closest?.('[data-act]')?.dataset.act;
    if (action === 'close') return finish(false);
    if (action === 'apply') return apply();
    if (action === 'new') { newBox.hidden = false; newName.focus(); return; }
    if (action === 'create') {
      const name = newName.value.trim();
      if (!name) { toast('请输入画板名称'); return; }
      try {
        const id = await store.create({name, parentId: newParent.value || null});
        chosen.add(id);
        newName.value = '';
        newBox.hidden = true;
        render();
      } catch (error) { toast(error?.message || '新建失败'); }
      return;
    }
    const row = event.target.closest?.('.bd-row');
    if (row) {
      const id = row.dataset.id;
      if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
      render();
    }
  });
  search.addEventListener('input', render);
  newName.addEventListener('keydown', event => { if (event.key === 'Enter') dialog.querySelector('[data-act="create"]').click(); });
  dialog.addEventListener('close', () => { if (resolve) finish(false); });

  return {
    open(nextUids = [], options = {}) {
      if (options.mode === 'remove' && store.activeId) {
        const id = store.activeId;
        const members = [...new Set((Array.isArray(nextUids) ? nextUids : []).filter(Boolean))];
        if (!members.length) return Promise.resolve(false);
        const selected = new Set(members);
        const cards = [...doc.querySelectorAll('#grid [data-uid]')].filter(node => selected.has(node.dataset.uid));
        return withRemovalMotion(cards, async () => {
          await store.removeItems(id, members);
          await onRemoved?.(id);
        })
          .then(() => { toast('已移出当前画板'); return true; })
          .catch(error => { toast(error?.message || '移出画板失败'); return false; });
      }
      uids = [...new Set((Array.isArray(nextUids) ? nextUids : []).filter(Boolean))];
      mode = options.mode === 'remove' ? 'remove' : 'add';
      chosen = new Set();
      search.value = '';
      newBox.hidden = true;
      dialog.querySelector('.bd-title').textContent = mode === 'remove' ? '移出画板' : '加入画板';
      render();
      showActionCard(dialog);
      return new Promise(done => { resolve = done; });
    },
    close: () => finish(false),
    get dialog() { return dialog; },
  };
}
