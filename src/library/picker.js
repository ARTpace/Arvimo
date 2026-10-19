import {readOptions,selectedIndex,moveIndex,typeahead,isTypeaheadKey,isMenuKey} from './picker-model.js';
import {esc} from './html-esc.js';

// 自绘下拉：原生 <select> 的弹出层是操作系统画的，样式表碰不到，所以深色界面里总会弹出
// 一块浅色系统菜单。这里的做法是**保留 select 本身作为唯一数据源**（`.value`、`options`、
// `onchange` 全部照旧可用），只在它旁边画一个统一风格的按钮 + listbox。
// 于是业务代码一行都不用改：谁给 select 赋值、谁监听 change，都感觉不到这次替换。
//
// 三个同步点：
//   1. 选项被整体重写（innerHTML / appendChild）→ MutationObserver；
//   2. 代码直接写 select.value（不触发事件）→ 拦下实例上的 value 访问器；
//   3. 用户点选 → 写回 value + 派发 change，走原来的 onchange 通道。
//
// 菜单挂到 body 上（position:fixed）：搜索框和搜索卡片都是 overflow:hidden，留在原地会被裁掉。
const TYPEAHEAD_RESET=700;

function swapLabelHost(select){
 const host=select.parentElement;
 if(host?.tagName!=='LABEL')return;
 // <label> 会把点击转发给里面的控件，那会重新弹出系统菜单；换成等价的普通容器。
 const box=document.createElement('div');
 for(const attr of [...host.attributes])box.setAttribute(attr.name,attr.value);
 host.replaceWith(box);box.append(select);
}

export function enhanceSelect(select){
 if(!select||select.dataset.picker)return null;
 const id=select.id||`picker-${Math.random().toString(36).slice(2,8)}`;
 select.id=id;select.dataset.picker='on';select.classList.add('picker-source');select.setAttribute('tabindex','-1');
 const title=(select.getAttribute('aria-label')||'').trim();
 const trigger=document.createElement('button');
 trigger.type='button';trigger.className='picker-trigger';trigger.id=`${id}-trigger`;
 trigger.setAttribute('role','combobox');trigger.setAttribute('aria-haspopup','listbox');
 trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',`${id}-listbox`);
 if(title)trigger.setAttribute('aria-label',title);
 const caption=document.createElement('span');caption.className='picker-caption';
 const chevron=document.createElement('i');chevron.className='chevron';chevron.dataset.icon='arrow-down';
 trigger.append(caption,chevron);
 const menu=document.createElement('div');
 menu.className='picker-menu';menu.id=`${id}-listbox`;menu.setAttribute('role','listbox');menu.hidden=true;
 menu.dataset.pickerMenu=id;
 if(title)menu.setAttribute('aria-label',title);
 const wrap=document.createElement('div');wrap.className='picker';wrap.dataset.picker=id;
 swapLabelHost(select);
 select.after(wrap);wrap.append(trigger,select);
 document.body.append(menu);
 const accessor=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
 Object.defineProperty(select,'value',{
  configurable:true,
  get(){return accessor.get.call(select);},
  set(next){accessor.set.call(select,next);sync();},
 });
 const itemNodes=()=>[...menu.querySelectorAll('[data-index]')];
 const inside=node=>wrap.contains(node)||menu.contains(node);
 let options=[],open=false,highlight=-1,buffer='',bufferTimer=0;

 /** 选项变化、value 变化都汇到这里：按钮上的文字永远等于「select 现在选的是什么」。 */
 function sync(){
  options=readOptions(select);
  const current=options.find(option=>option.value===select.value)||options[0];
  caption.textContent=current?current.label:'';
  trigger.disabled=!options.length;
  trigger.title=current?.hint||current?.label||'';
 }
 function renderMenu(){
  options=readOptions(select);
  menu.innerHTML=options.length?options.map((option,index)=>{
   const chosen=option.value===select.value;
   return `<button type="button" role="option" tabindex="-1" id="${id}-option-${index}" class="picker-option${chosen?' current':''}" data-index="${index}" data-picker-option="${esc(option.value)}" aria-selected="${chosen}">${esc(option.label)}${option.hint?`<small>${esc(option.hint)}</small>`:''}</button>`;
  }).join(''):'<p class="picker-empty">暂无可选项</p>';
 }
 /** 菜单贴在按钮下面；下方放不下就翻到上面。宽度取「按钮宽度」与「最长选项」的较大者。 */
 function place(){
  const box=trigger.getBoundingClientRect(),height=menu.offsetHeight;
  const below=window.innerHeight-box.bottom-10,above=box.top-10;
  const dropUp=below<Math.min(height,190)&&above>below;
  const left=Math.max(8,Math.min(box.left,window.innerWidth-box.width-8));
  const room=window.innerWidth-left-12;
  menu.style.width='max-content';                 // 先量出「不换行时的自然宽度」，再回到自适应
  const natural=menu.offsetWidth;
  menu.style.width='auto';
  menu.style.left=`${left}px`;
  menu.style.maxWidth=`${room}px`;
  menu.style.minWidth=`${Math.max(box.width,Math.min(natural,room))}px`;
  menu.style.top=`${dropUp?box.top-7:box.bottom+7}px`;
  menu.style.transform=dropUp?'translateY(-100%)':'none';
 }
 function paint(){
  itemNodes().forEach((node,index)=>node.classList.toggle('highlight',index===highlight));
  const active=itemNodes()[highlight];
  if(!active){trigger.removeAttribute('aria-activedescendant');return;}
  trigger.setAttribute('aria-activedescendant',active.id);
  // 自己算滚动量，而不是 scrollIntoView：后者会顺带滚动祖先（乃至整页），
  // 而「页面滚了」在下面是要把菜单重新定位的，菜单自己滚自己不该触发这件事。
  const top=active.offsetTop,bottom=top+active.offsetHeight;
  if(top<menu.scrollTop)menu.scrollTop=top;
  else if(bottom>menu.scrollTop+menu.clientHeight)menu.scrollTop=bottom-menu.clientHeight;
 }
 function show(){
  if(!options.length)return;
  // 平台下拉与搜索框的「最近检索」浮层都贴在搜索卡片下方同一个位置，先后打开就会互相压住。
  // 这里广播一声，让浮层自己收起：点平台时本来也不该同时看到历史。
  document.dispatchEvent(new CustomEvent('picker:open'));
  renderMenu();open=true;menu.hidden=false;trigger.setAttribute('aria-expanded','true');
  highlight=selectedIndex(options);place();paint();
 }
 function close({focus=false}={}){
  if(!open)return;
  open=false;menu.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-activedescendant');
  if(focus)trigger.focus();
 }
 function commit(index){
  const chosen=options[index];
  close({focus:true});
  if(!chosen||select.value===chosen.value)return;
  select.value=chosen.value;                       // 写入即触发上面的 setter → sync()
  select.dispatchEvent(new Event('change',{bubbles:true}));
 }
 trigger.addEventListener('click',()=>open?close({focus:true}):show());
 trigger.addEventListener('keydown',event=>{
  const {key}=event;
  if(key==='Escape'){if(open){event.preventDefault();close({focus:true});}return;}
  if(key==='Tab'){close();return;}
  if(key==='Enter'||key===' '){event.preventDefault();open?commit(highlight):show();return;}
  if(event.ctrlKey||event.metaKey||event.altKey)return;
  if(isMenuKey(key)){event.preventDefault();if(!open)show();else{highlight=moveIndex(highlight,key,options.length);paint();}return;}
  if(!isTypeaheadKey(key))return;
  event.preventDefault();
  if(!open)show();
  buffer=bufferTimer?buffer+key:key;
  clearTimeout(bufferTimer);bufferTimer=setTimeout(()=>{buffer='';},TYPEAHEAD_RESET);
  highlight=typeahead(options,buffer,highlight);paint();
 });
 menu.addEventListener('click',event=>{const node=event.target.closest('[data-index]');if(node)commit(Number(node.dataset.index));});
 menu.addEventListener('pointermove',event=>{
  const node=event.target.closest('[data-index]');
  if(node&&Number(node.dataset.index)!==highlight){highlight=Number(node.dataset.index);paint();}
 });
 document.addEventListener('pointerdown',event=>{if(open&&!inside(event.target))close();},true);
 // 页面滚动时把菜单重新贴回按钮下面；菜单自己的滚动（高亮项自动滚入视野）不算。
 window.addEventListener('scroll',event=>{if(open&&!menu.contains(event.target))place();},true);
 window.addEventListener('resize',()=>{if(open)place();});
 const observer=new MutationObserver(()=>{sync();if(open)show();});
 observer.observe(select,{childList:true,subtree:true});
 sync();
 return {element:wrap,menu,refresh:sync,open:show,close};
}

/** 把一个范围内的原生 select 全部升级；新增的下拉只要写进这个范围就自动生效。 */
export const enhanceSelects=selector=>[...document.querySelectorAll(selector)].map(enhanceSelect).filter(Boolean);
