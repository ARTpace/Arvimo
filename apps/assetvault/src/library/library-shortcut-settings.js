import {LIBRARY_BINDINGS,libraryBindingKeys,shortcutKey} from './library-shortcuts.js';
import {esc} from './html-esc.js';

export function createLibraryShortcutSettings({getBindings,setBindings,doc=document}){
 const card=doc.createElement('section');card.className='settings-card shortcut-settings';
 let recording='',query='';
 const format=key=>key.replaceAll('ArrowLeft','←').replaceAll('ArrowRight','→').replaceAll('ArrowUp','↑').replaceAll('ArrowDown','↓').replace('Escape','Esc');
 function paint(message=''){
  card.innerHTML=`<div class="shortcut-tools"><input class="shortcut-search" type="search" placeholder="搜索快捷键" aria-label="搜索快捷键" value="${esc(query)}"><button type="button" data-shortcut-defaults>全部恢复默认</button></div><span class="shortcut-message" role="status" ${message?'':'hidden'}>${esc(message)}</span><div class="shortcut-list"><div class="shortcut-row shortcut-heading"><span>命令</span><span>按键绑定</span><span>操作</span></div>${LIBRARY_BINDINGS.map(([id,label])=>`<div class="shortcut-row" data-shortcut-entry><span>${label}</span><button type="button" class="shortcut-key" data-shortcut-record="${id}" aria-label="修改${label}" aria-pressed="${recording===id}">${recording===id?'按下快捷键…':esc(libraryBindingKeys(id,getBindings()).map(format).join(' / ')||'未设置')}</button><button type="button" class="shortcut-reset" data-shortcut-reset="${id}" title="恢复默认" aria-label="重置${label}">↺</button></div>`).join('')}<div class="shortcut-empty" hidden>未找到快捷键</div></div>`;
  filter();
 }
 function filter(){let visible=0;card.querySelectorAll('[data-shortcut-entry]').forEach(row=>{row.hidden=!row.textContent.toLowerCase().includes(query.trim().toLowerCase());if(!row.hidden)visible++;});card.querySelector('.shortcut-empty').hidden=visible>0;}
 card.addEventListener('input',event=>{if(event.target.matches('.shortcut-search')){query=event.target.value;filter();}});
 card.addEventListener('click',event=>{
  const record=event.target.closest('[data-shortcut-record]');
  if(record){recording=record.dataset.shortcutRecord;paint();card.querySelector(`[data-shortcut-record="${recording}"]`)?.focus();return;}
  const reset=event.target.closest('[data-shortcut-reset]');
  if(reset){const next={...getBindings()};delete next[reset.dataset.shortcutReset];setBindings(next);recording='';paint();}
  if(event.target.closest('[data-shortcut-defaults]')){setBindings({});recording='';paint();}
 });
 // Recording is scoped to its focused button; switching pages cannot leave a global recorder behind.
 card.addEventListener('keydown',event=>{
  if(!recording||!event.target.closest('[data-shortcut-record]'))return;
  event.preventDefault();event.stopPropagation();
  if(event.isComposing||event.repeat)return;
  if(event.key==='Escape'){recording='';paint();return;}
  const key=shortcutKey(event);if(!key)return;
  const conflict=LIBRARY_BINDINGS.find(([id])=>id!==recording&&libraryBindingKeys(id,getBindings()).includes(key));
  if(conflict){recording='';paint(`已用于“${conflict[1]}”`);return;}
  setBindings({...getBindings(),[recording]:[key]});recording='';paint();
 });
 paint();return card;
}
