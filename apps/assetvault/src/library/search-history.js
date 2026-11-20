// 检索词组浮层：挂在搜索框下方，点进搜索框才出现。
//
// 这里同时收着四类词组：最近检索的关键词、解析过的链接、今日主题、当前词的相近词。
// 分组元数据在 term-groups.js（顺序 / 标题 / 图标 / 配色 / 过滤规则），数据由 app.js 的
// sources() 注入 —— 渲染层不认识「主题」或「历史」的业务，只按契约画分区。
//
// 浮层挂到 body 上（position:fixed）：搜索卡片是 overflow:hidden，留在里面会被裁掉，
// 这与 picker.js 里自绘下拉的处理一致。
import {PLATFORMS} from './platforms.js';
import {esc} from './html-esc.js';
import {buildTermSections} from './term-groups.js';

// 浮层是一行铺多个的胶囊（chip）布局，所以既能显示更多条，也要铺得下 —— 装不下靠换行，
// 不再让每条记录独占一整行。历史本身最多存 12 条，这里就按上限给。
const LIMIT=12;
// 分列排版要铺得开：两列各留 300px 左右，窄屏再由 place() 夹回视口宽度。
const MIN_WIDTH=380;
const PREFERRED_WIDTH=720;
const MAX_WIDTH=900;
const MAX_HEIGHT=520;

const platformLabel=id=>PLATFORMS.find(platform=>platform.id===id)?.label||(id==='web'?'网页解析':String(id||''));

export function createSearchHistory({$,icon,state,persist,toast,onPick,onTerm,sources=()=>({})}){
 const input=$('#asset-query');
 // 锚点是输入框那一段（.global-search），不是整块 .search-field：后者把左边的平台下拉也圈进去了，
 // 于是点平台下拉时会被当成「点在搜索框里」，浮层不关、原地压住刚弹出的平台菜单。
 const anchor=input.closest('.global-search')||input.closest('.search-field')||input;
 const box=document.createElement('div');
 box.className='history-pop';box.id='history-pop';box.hidden=true;
 box.setAttribute('role','listbox');box.setAttribute('aria-label','检索词组');
 document.body.append(box);
 input.setAttribute('aria-controls','history-pop');input.setAttribute('aria-expanded','false');
 let open=false,rows=[],highlight=-1,edited=false,placeFrame=0;
 const schedulePlace=()=>{if(open&&!placeFrame)placeFrame=requestAnimationFrame(()=>{placeFrame=0;if(open)place();});};

 // 分类 / 排序的中文标签就是搜索卡片里那两个下拉的选项文字，直接从下拉里读，
 // 不在这一份 UI 里再抄一版映射——改选项文案时不会漏掉这里。
 const optionLabel=(selector,value)=>{const select=$(selector);const hit=select&&[...select.options].find(option=>option.value===value);return hit?hit.textContent.trim():String(value??'');};
 const hostOf=raw=>{try{return new URL(raw).hostname.replace(/^www\./,'');}catch{return String(raw||'');}};
 const title=h=>h.kind==='search'?(h.params?.q||'热门资产'):(h.name||h.url||'');
 const note=h=>h.kind==='search'
  ?[platformLabel(h.platform),optionLabel('#online-category',h.params?.category||''),optionLabel('#online-sort',h.params?.sort||'relevance')].filter(Boolean).join(' · ')
  :`粘贴链接解析 · ${hostOf(h.url)}`;
 // 每条只出一个词：平台 / 分类 / 排序这些细节压进 title 提示，不再占一整行副标题。
 const label=entry=>[title(entry),note(entry)].filter(Boolean).join(' · ');

 /** 历史行规整成契约里的形状；关键词为空的「浏览热门」副产物在这里再兜一层。 */
 function historyRows(){
  return (Array.isArray(state.history)?state.history:[]).filter(entry=>entry.kind!=='search'||String(entry.params?.q||'').trim()!=='').map(entry=>({
   group:entry.kind==='search'?'recent':'links',
   label:title(entry),title:label(entry),icon:entry.kind==='search'?'search':'link',
   entry,badge:'',today:false,term:'',
  }));
 }
 /** animate 只在「刚打开」时为真：打字过滤时每敲一下都重绘，再播入场动画会闪。 */
 function render(animate=false){
  // 打开时先给全量：点一下搜索框就是想看词组，不该被框里残留的上次关键词挡掉
  // （否则「点搜索框看历史」会只剩一条，看着像坏了）。用户开始改字，才按输入收窄历史。
  const term=edited?input.value.trim():'';
  const data=sources()||{};
  const history=historyRows();
  const sections=buildTermSections({
   history,
   daily:Array.isArray(data.daily)?data.daily:[],
   related:Array.isArray(data.related)?data.related:[],
   relatedNote:data.relatedNote||'',
   term,limit:LIMIT,
  });
  // 键盘导航跨分组连续：把各组的胶囊摊平成一个索引序列。
  rows=sections.flatMap(section=>section.items.map(item=>({...item,tone:section.tone,section:section.id})));
  if(highlight>=rows.length)highlight=rows.length-1;
  let cursor=0;
  // 列数交给数据：4 组两列刚好，3 组也两列（左 2 右 1），只剩 1 组时退回单列。
  const cols=Math.min(2,sections.length);
  // 清除键不单独占一行：只在「最近检索」组标题右侧露脸，没有记录时连按钮都不出现。
  const clear=history.length?'<button type="button" class="text-button term-clear" data-history-clear title="清除检索记录">清除</button>':'';
  const groups=sections.map((section,order)=>{
   const chips=section.items.map(item=>{
    const index=cursor++;
    return `<button type="button" role="option" id="history-option-${index}" class="history-item term-chip${item.today?' today':''}" data-history="${index}" aria-selected="${index===highlight}" title="${esc(item.title||item.label)}">${icon(item.icon||section.icon)}<strong>${esc(item.label)}</strong>${item.badge?`<span class="term-badge">${esc(item.badge)}</span>`:''}</button>`;
   }).join('');
   const body=chips?`<div class="history-list">${chips}</div>`:`<p class="term-empty" role="status">${esc(section.empty)}</p>`;
   const tail=section.id==='recent'&&clear?clear:`<span class="term-section-hint">${esc(section.hint)}</span>`;
   return `<section class="term-section${animate?' term-anim':''}" style="--i:${order}" data-tone="${esc(section.tone)}" role="group" aria-label="${esc(section.label)}"><div class="term-section-head">${icon(section.icon)}<span>${esc(section.label)}</span>${tail}</div>${body}</section>`;
  }).join('');
  // 没有面板级标题和底部说明：浮层本身已经贴着搜索框，多两行只会把词组往下挤。
  box.innerHTML=`<div class="term-groups" data-cols="${cols}">${groups}</div>`;
  paintHighlight();
 }
 function paintHighlight(){
  box.querySelectorAll('[data-history]').forEach((node,index)=>{node.classList.toggle('highlight',index===highlight);node.setAttribute('aria-selected',String(index===highlight));});
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
 /** 贴在搜索框正下方；下方放不下就翻到上面。宽度跟着搜索框走，最多 680px。 */
 function place(){
  const rect=anchor.getBoundingClientRect();
  if(!rect.width||!rect.height||rect.bottom<=0||rect.top>=window.innerHeight){close();return;}
  // 锚点是输入框那一段，比整块搜索卡片窄；分列排版要更宽，所以先抬到 720 再夹视口。
  const width=Math.min(MAX_WIDTH,Math.max(MIN_WIDTH,PREFERRED_WIDTH,rect.width),window.innerWidth-24);
  box.style.width=`${width}px`;
  const island=input.closest('[data-search-layout=island]');
  const slot=island?.querySelector('.search-island-slot')?.getBoundingClientRect();
  const left=slot?slot.left+(slot.width-width)/2:rect.left;
  box.style.left=`${Math.max(12,Math.min(left,window.innerWidth-width-12))}px`;
  const islandTabs=island?.querySelector('#content-kind-tabs');
  const bottom=Math.max(rect.bottom,islandTabs?.getBoundingClientRect().bottom||0);
  const below=window.innerHeight-bottom-10,above=rect.top-10;
  const dropUp=below<Math.min(box.offsetHeight,200)&&above>below;
  box.style.maxHeight=`${Math.max(0,Math.min(MAX_HEIGHT,(dropUp?above:below)-8))}px`;
  box.dataset.side=dropUp?'up':'down';
  box.style.top=`${dropUp?rect.top-8:bottom+8}px`;
  box.style.transform=dropUp?'translateY(-100%)':'none';
 }
 function show(){
  if(state.route!=='discover')return;
  open=true;box.hidden=false;input.setAttribute('aria-expanded','true');render(true);place();
 }
 function close(){
  if(!open)return;
  open=false;box.hidden=true;highlight=-1;
  cancelAnimationFrame(placeFrame);placeFrame=0;
  input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');
 }
 /** 选中一条：先收起浮层再交给 app.js 重放，顺序反了会被重放的检索再顶起来。 */
 function pick(index){
  const item=rows[index];if(!item)return;
  close();
  if(item.entry)onPick(item.entry);
  else if(item.term)onTerm(item.term);
 }
 function setup(){
  // 每次重新聚焦 / 重新点开都先把「改过字」这件事忘掉，恢复成全量列表。
  input.addEventListener('focus',()=>{edited=false;show();});
  input.addEventListener('click',()=>{if(!open){edited=false;show();}});
  input.addEventListener('input',()=>{if(!open)return;edited=true;highlight=-1;render();place();});
  // 打字时上下键在所有分组的胶囊里走，回车选中；没选中任何一条时回车照常提交搜索。
  input.addEventListener('keydown',event=>{
   if(event.key==='Escape'){if(open){event.preventDefault();close();}return;}
   if(!open)return;
   if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    if(!rows.length)return;
    event.preventDefault();
    highlight=event.key==='ArrowDown'?Math.min(rows.length-1,highlight+1):Math.max(0,highlight-1);
    paintHighlight();
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
  window.addEventListener('scroll',event=>{if(open&&!box.contains(event.target))schedulePlace();},{capture:true,passive:true});
  window.addEventListener('resize',schedulePlace);
  new ResizeObserver(schedulePlace).observe(anchor);
 }
 return {setup,close,refresh:()=>{if(open){render();place();}},isOpen:()=>open};
}
