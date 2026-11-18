import {showActionCard} from './action-card.js';
// 智能画板规则编辑器：与工具栏共享筛选抽屉，独立草稿。
import {createBoardRuleFilters} from './board-rule-filters.js';
import {parseSearchExpression} from '../../server/search-expression.mjs';
import {buildFormatFilter} from './format-filter-selection.js';
import {normalizeRanges} from './numeric-filter.js';
const text = value => String(value ?? '');
export function createBoardRule({esc, icon, toast, store, controls, onSaved, document: doc = globalThis.document} = {}) {
  const dialog = doc.createElement('dialog');
  dialog.className = 'bd-dialog bd-rule-dialog';
  dialog.setAttribute('aria-label','智能画板规则');
  dialog.innerHTML = `<div class="bd-head"><span class="bd-head-ic">${icon('zap')}</span><strong class="bd-rule-title">智能画板</strong><span class="bd-rule-engine">按规则自动重算</span><button type="button" class="icon-button" data-act="close" aria-label="关闭">${icon('close')}</button></div>
    <div class="bd-rule-body"><label class="bd-field"><span>画板名称</span><input type="text" class="bd-rule-name" maxlength="80" autocomplete="off" placeholder="例如：暖色石材质感"></label>
    <div class="bd-rule-filters fd-pop"></div><small>独立编辑，不改变工具栏。目录和文件在线状态不能保存为智能规则。</small><p class="bd-rule-hint"></p></div>
    <div class="bd-foot"><span class="bd-rule-status" role="status" aria-live="polite"></span><button type="button" class="secondary" data-act="cancel">取消</button><button type="button" class="primary bd-rule-save" data-act="save">${icon('save')}<span>保存</span></button></div>`;
  doc.body.appendChild(dialog);
  const $ = selector => dialog.querySelector(selector), nameInput = $('.bd-rule-name'), saveButton = $('.bd-rule-save');
  let boardId = '', saving = false, draft = {};
  function hasConditions() {
    const f = draft.filters || {}, search = parseSearchExpression(text(draft.q).slice(0,500));
    const rating = f.rating, min = Array.isArray(rating) ? rating[0] : typeof rating === 'object' ? rating?.min : rating;
    const max = Array.isArray(rating) ? rating[1] : typeof rating === 'object' ? rating?.max : 5;
    const favoriteMode = ['any','yes','no'].includes(f.favoriteMode) ? f.favoriteMode : f.favorite === true ? 'yes' : 'any';
    return search.clauses.length > 0 || search.groups?.some(group=>group.length)
      || ['trashed','all'].includes(f.state) || Number(min) > 0 || Number(max ?? 5) < 5 || favoriteMode !== 'any'
      || f.downloadable === true || buildFormatFilter(f.formats ?? [], f.excludeFormats === true).active
      || normalizeRanges(f.ranges).length > 0 || (Array.isArray(f.ratings) && f.ratings.some(n=>Number(n)>=0 && Number(n)<=5))
      || ['tags','excludeTags','platforms','kinds','categories','uids','colors'].some(key=>Array.isArray(f[key]) && f[key].some(value=>text(value).trim()));
  }
  function refresh() {
    const ready = !!hasConditions(); saveButton.disabled = saving || !ready;
    $('.bd-rule-hint').textContent = ready ? '保存后按新规则重新收集，不会删除资产。' : '添加一项收集条件；只修改排序不算条件。';
    $('.bd-rule-status').textContent = ready ? '规则已就绪' : '';
  }
  const editor = createBoardRuleFilters({host:$('.bd-rule-filters'),esc,toast,document:doc,
    models:()=>controls?.getModels?.() || [],onChange:rule=>{if (!saving) {draft=rule;refresh();}}});
  async function save() {
    if (saving) return;
    if (!hasConditions()) return toast?.('请添加至少一项收集条件');
    const rule = JSON.parse(JSON.stringify(draft)), board = boardId ? store?.byId?.(boardId) : null;
    const name = text(nameInput.value).trim() || board?.name || '';
    if (!name) {toast?.('给这个智能画板起个名字');nameInput.focus();return;}
    saving = true; saveButton.disabled = true; $('.bd-rule-filters').inert = true;
    try {
      const payload = {name,q:rule.q || '',filters:rule.filters || {},sort:rule.sort || 'recent',sortOrder:rule.sortOrder || 'asc',seed:rule.seed ?? ''};
      const id = await store.saveSmart(boardId ? {...payload,id:boardId} : payload);
      toast?.(boardId ? `规则已更新，画板「${name}」重新计算完成` : `已创建智能画板「${name}」`);
      dialog.close(); onSaved?.(id,{created:!boardId});
    } catch(error) {toast?.(error?.message || '保存智能画板失败');}
    finally {saving=false;$('.bd-rule-filters').inert=false;refresh();}
  }
  dialog.addEventListener('click',event=>{
    const action=event.target.closest?.('[data-act]')?.dataset.act;
    if (action==='close' || action==='cancel') {if (!saving) dialog.close();return;}
    if (action==='save') return save();
  });
  nameInput.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();save();}});
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  function open(id) {
    if(saving)return; boardId=text(id);
    const board=boardId ? store?.byId?.(boardId) : null;
    $('.bd-rule-title').textContent=board ? `智能画板「${board.name}」` : '新建智能画板';
    nameInput.value=board?.name || ''; saveButton.querySelector('span').textContent=board ? '保存规则' : '创建智能画板';
    editor.load(board ? board.rule || {} : controls?.currentRule?.() || {});showActionCard(dialog);
  }
  return {dialog,open,openNew:()=>open(''),refresh:()=>{if(dialog.open)refresh();}};
}
