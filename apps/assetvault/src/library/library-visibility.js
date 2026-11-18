// 资产库的画板/资产显示范围；进入画板时始终显示其成员。
import {icon} from './icon-set.js';
// 范围筛选下拉在不同 DOM 实现里 value 可能是只读的（测试用的 linkedom 就是这样），
// 用 option.selected 同步，真实浏览器与测试都稳。
function syncFeatureSelect(doc,value){
 const select=doc.querySelector('#local-feature');if(!select)return;
 const options=[...(select.querySelectorAll('option')||[])];
 const match=options.find(option=>option.value===value||option.getAttribute('value')===value);
 if(match&&'selected' in match)match.selected=true;
 try{select.value=value;}catch{}
}
export function createLibraryVisibility({doc=document,state,activeBoard=()=>false,onChange=()=>{},onTrash=()=>{}}){
 let host,trashBtn;
 const modes=[['all','全部','grid'],['boards','仅画板','layers'],['assets','仅资产','image']];
 const mode=()=>modes.some(([key])=>key===state.options.libraryCards)?state.options.libraryCards:'all';
 const inTrash=()=>state.filter==='trash';
 function apply(){
  // 回收站是独立筛选：进入时按「全部」显示网格，否则「仅画板」会把回收站卡片藏掉。
  const shown=inTrash()?'all':mode();
  doc.body.dataset.libraryCards=shown;
  doc.body.dataset.boardOpen=String(!!activeBoard());
  host?.querySelectorAll('button[data-library-cards]').forEach(button=>{const selected=!inTrash()&&button.dataset.libraryCards===mode();button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));});
  if(trashBtn){const active=inTrash();trashBtn.classList.toggle('active',active);trashBtn.setAttribute('aria-pressed',String(active));trashBtn.title=active?'回收站（当前）：再点一次返回全部资产':'回收站：查看已移入的资产，再点一次返回';}
 }
 function setMode(key){
  if(!modes.some(([value])=>value===key))return;
  // 回收站是独立筛选：在回收站里点「全部/仅画板/仅资产」任一按钮都视为退出回收站。
  // 否则 state.filter 仍是 trash，主网格继续只渲染回收站内容 —— 看着就是「点了没反应」。
  if(inTrash()){
   state.filter='all';
   syncFeatureSelect(doc,'all');
  }
  state.options.libraryCards=key;apply();onChange(key);
 }
 function setup(){
  const toolbar=doc.querySelector('#local-toolbar');if(!toolbar)return;
  host=doc.createElement('div');host.className='library-card-modes';host.setAttribute('role','group');host.setAttribute('aria-label','显示内容');
  for(const [key,label,glyph] of modes){const button=doc.createElement('button');button.type='button';button.innerHTML=icon(glyph);button.title=label;button.setAttribute('aria-label',label);button.dataset.libraryCards=key;button.addEventListener('click',()=>setMode(key));host.append(button);}
  // 回收站：与「全部/仅画板/仅资产」同组，图标按钮；真正的行为交给 app.js（改 state.filter 并同步下拉）。
  trashBtn=doc.createElement('button');trashBtn.type='button';trashBtn.className='trash-mode';trashBtn.setAttribute('aria-label','回收站');trashBtn.innerHTML=icon('trash');trashBtn.addEventListener('click',()=>onTrash());host.append(trashBtn);
  toolbar.append(host);apply();
 }
 return {setup,apply,setMode,mode};
}
