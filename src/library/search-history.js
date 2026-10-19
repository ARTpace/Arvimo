// 最近检索：原先钉在左侧栏占着一整块常驻位置，多数时候是空的（或只有一条），
// 还和导航抢纵向空间。现在改成挂在搜索框下方的浮层——点进搜索框才出现，
// 边打字边按关键词收窄，方向键选、回车即回到那一次检索，清除入口一并搬进浮层。
//
// 浮层挂到 body 上（position:fixed）：搜索卡片是 overflow:hidden，留在里面会被裁掉，
// 这与 picker.js 里自绘下拉的处理一致。
import {PLATFORMS} from './platforms.js';
import {esc} from './html-esc.js';

// 浮层是一行铺多个的胶囊（chip）布局，所以既能显示更多条，也要铺得下 —— 装不下靠换行，
// 不再让每条记录独占一整行。历史本身最多存 12 条，这里就按上限给。
const LIMIT=12;
const MIN_WIDTH=360;
const MAX_WIDTH=680;

const platformLabel=id=>PLATFORMS.find(platform=>platform.id===id)?.label||(id==='web'?'网页解析':String(id||''));

export function createSearchHistory({$,icon,state,persist,toast,onPick}){
 const input=$('#asset-query');
 // 锚点是输入框那一段（.global-search），不是整块 .search-field：后者把左边的平台下拉也圈进去了，
 // 于是点平台下拉时会被当成「点在搜索框里」，浮层不关、原地压住刚弹出的平台菜单。
 const anchor=input.closest('.global-search')||input.closest('.search-field')||input;
 const box=document.createElement('div');
 box.className='history-pop';box.id='history-pop';box.hidden=true;
 box.setAttribute('role','listbox');box.setAttribute('aria-label','最近检索');
 document.body.append(box);
 input.setAttribute('aria-controls','history-pop');input.setAttribute('aria-expanded','false');
 let open=false,rows=[],highlight=-1,edited=false;

 // 分类 / 排序的中文标签就是搜索卡片里那两个下拉的选项文字，直接从下拉里读，
 // 不在这一份 UI 里再抄一版映射——改选项文案时不会漏掉这里。
 const optionLabel=(selector,value)=>{const select=$(selector);const hit=select&&[...select.options].find(option=>option.value===value);return hit?hit.textContent.trim():String(value??'');};
 const hostOf=raw=>{try{return new URL(raw).hostname.replace(/^www\./,'');}catch{return String(raw||'');}};
 const title=h=>h.kind==='search'?(h.params?.q||'热门资产'):(h.name||h.url||'');
 const note=h=>h.kind==='search'
  ?[platformLabel(h.platform),optionLabel('#online-category',h.params?.category||''),optionLabel('#online-sort',h.params?.sort||'relevance')].filter(Boolean).join(' · ')
  :`粘贴链接解析 · ${hostOf(h.url)}`;

 function render(){
  // 打开时先给全量：点一下搜索框就是想看历史，不该被框里残留的上次关键词挡掉
  // （否则「点搜索框看历史」会只剩一条，看着像坏了）。用户开始改字，才按输入收窄。
  const term=edited?input.value.trim():'';
  const lower=term.toLowerCase();
  // 只列「带检索词」的记录：关键词为空的那一条代表「浏览热门」，是分类 / 排序那些筛选动作的
  // 副产物，留在浮层里看起来就是一堆重样的空条目。数据层也会滤掉，这里再兜一层。
  const all=(Array.isArray(state.history)?state.history:[]).filter(entry=>entry.kind!=='search'||String(entry.params?.q||'').trim()!=='');
  rows=all.filter(entry=>!lower||title(entry).toLowerCase().includes(lower)||String(entry.url||'').toLowerCase().includes(lower)).slice(0,LIMIT);
  if(highlight>=rows.length)highlight=rows.length-1;
  // 每条只出一个词：平台 / 分类 / 排序这些细节压进 title 提示，不再占一整行副标题，
  // 这样一行能并排铺下好几条记录。
  const label=entry=>[title(entry),note(entry)].filter(Boolean).join(' · ');
  const items=rows.map((entry,index)=>`<button type="button" role="option" id="history-option-${index}" class="history-item${index===highlight?' highlight':''}" data-history="${index}" aria-selected="${index===highlight}" title="${esc(label(entry))}">${icon(entry.kind==='search'?'search':'link')}<strong>${esc(title(entry))}</strong></button>`).join('');
  box.innerHTML=`<div class="history-head"><span>${icon('clock')}最近检索</span>${all.length?'<button type="button" class="text-button" data-history-clear>清除</button>':''}</div>`
   +(items?`<div class="history-list">${items}</div>`
     :`<p class="history-empty">${all.length?`没有匹配“${esc(term)}”的检索记录`:'还没有检索记录 · 搜过的关键词、解析过的链接会留在这里'}</p>`)
   +'<p class="history-foot">记录只保存在这台电脑的浏览器里</p>';
  const active=box.querySelector('.history-item.highlight');
  // 自己算滚动量而不是 scrollIntoView：后者会顺带滚动祖先，这个浮层是吸在搜索框上的，
  // 页面跟着滚一下就会错位。
  if(active){
   const top=active.offsetTop,bottom=top+active.offsetHeight;
   if(top<box.scrollTop)box.scrollTop=top;
   else if(bottom>box.scrollTop+box.clientHeight)box.scrollTop=bottom-box.clientHeight;
   input.setAttribute('aria-activedescendant',active.id);
  }else input.removeAttribute('aria-activedescendant');
 }
 /** 贴在搜索框正下方；下方放不下就翻到上面。宽度跟着搜索框走，最多 560px。 */
 function place(){
  const rect=anchor.getBoundingClientRect();
  if(!rect.width||!rect.height){close();return;}
  // 锚点是输入框那一段，比整块搜索卡片窄，给个下限免得一行铺不下几个胶囊。
  const width=Math.min(MAX_WIDTH,Math.max(MIN_WIDTH,rect.width),window.innerWidth-24);
  box.style.width=`${width}px`;
  box.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-width-12))}px`;
  const below=window.innerHeight-rect.bottom-10,above=rect.top-10;
  const dropUp=below<Math.min(box.offsetHeight,200)&&above>below;
  box.style.top=`${dropUp?rect.top-8:rect.bottom+8}px`;
  box.style.transform=dropUp?'translateY(-100%)':'none';
 }
 function show(){
  open=true;box.hidden=false;input.setAttribute('aria-expanded','true');render();place();
 }
 function close(){
  if(!open)return;
  open=false;box.hidden=true;highlight=-1;
  input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');
 }
 /** 选中一条：先收起浮层再交给 app.js 重放那一次检索，顺序反了会被重放的检索再顶起来。 */
 function pick(index){
  const entry=rows[index];if(!entry)return;
  close();
  onPick(entry);
 }
 function setup(){
  // 每次重新聚焦 / 重新点开都先把「改过字」这件事忘掉，恢复成全量列表。
  input.addEventListener('focus',()=>{edited=false;show();});
  input.addEventListener('click',()=>{if(!open){edited=false;show();}});
  input.addEventListener('input',()=>{if(!open)return;edited=true;highlight=-1;render();place();});
  // 打字时上下键在记录里走，回车选中；没选中任何一条时回车照常提交搜索。
  input.addEventListener('keydown',event=>{
   if(event.key==='Escape'){if(open){event.preventDefault();close();}return;}
   if(!open)return;
   if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    if(!rows.length)return;
    event.preventDefault();
    highlight=event.key==='ArrowDown'?Math.min(rows.length-1,highlight+1):Math.max(0,highlight-1);
    render();place();
    return;
   }
   if(event.key==='Enter'&&highlight>=0){event.preventDefault();pick(highlight);}
  });
  box.addEventListener('click',event=>{
   // 清完把焦点送回搜索框：清空动作本身不该把用户的手从键盘上赶走（Esc 也要还能用）。
   if(event.target.closest('[data-history-clear]')){state.history=[];persist();highlight=-1;input.focus();render();place();toast('已清除检索记录');return;}
   const node=event.target.closest('[data-history]');
   if(node)pick(Number(node.dataset.history));
  });
  // 点浮层以外任何地方收起；点搜索框自己不动，交给 click 处理，避免刚展开就被关掉。
  document.addEventListener('pointerdown',event=>{if(open&&!box.contains(event.target)&&!anchor.contains(event.target))close();},true);
  // 平台下拉弹开时先收起浮层：两者都贴在搜索卡片下沿的同一处，同时开着必然互相压住。
  document.addEventListener('picker:open',()=>close());
  window.addEventListener('scroll',event=>{if(open&&!box.contains(event.target))place();},true);
  window.addEventListener('resize',()=>{if(open)place();});
 }
 return {setup,close,refresh:()=>{if(open){render();place();}},isOpen:()=>open};
}
