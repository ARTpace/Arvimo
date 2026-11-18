import {readOptions,selectedIndex,moveIndex,typeahead,isTypeaheadKey,isMenuKey} from './picker-model.js';
import {esc} from './html-esc.js';
import {icon} from './icon-set.js';

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
// 平台下拉在「全部 / 模型 / 图片」各模式下池子不同，按选项文字自适应会让宽度忽宽忽窄。
// 平台菜单统一固定宽度（仍受窗口宽度约束），其他下拉保持自适应。
const PLATFORM_MENU_WIDTH=460;

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
 // 2026-11-12 反馈：下拉菜单一律不要展开箭头，只留文字（+ 需要时由调用方自带的图标）。
 // 这里不再创建 .chevron 节点；app.css / search-motion.css 末尾另有 display:none 兜底，
 // 防止历史代码或外部注入的箭头漏网。
 trigger.append(caption);
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
 let nodes=[],painted=-1,placeFrame=0,naturalWidth=0;
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
  // 平台菜单的「置顶」：只有 select 标了 data-pinnable 才渲染图钉按钮。
  // 置顶态从原生 <option data-pinned> 读（app 侧排序后写入），排除项由 data-pin-exclude 指定
  // （通常是「全部平台」）。图钉是 option 内的独立按钮，点击派发 picker:pin 事件而非选中该项。
  const pinnable=()=>select.dataset.pinnable==='true';
  const pinExclude=()=>select.dataset.pinExclude||'';
  function pinButton(option){
   const native=select.options[option.index];
   if(!native||native.value===pinExclude())return '';
   const on=native.dataset.pinned==='true';
   // 注意：外层 option 本身就是 <button>，HTML 不允许 button 嵌套 button（浏览器会把内层甩出去、
   // 布局与点击全乱）。所以图钉用带 role 的 span，保留 [data-pin-stop] 供委托识别。
   return `<span role="button" class="picker-pin${on?' on':''}" data-pin-stop data-pin-value="${esc(option.value)}" tabindex="-1"
     title="${on?'取消置顶':'置顶此平台'}" aria-label="${on?'取消置顶':'置顶此平台'}">${icon('pin')}</span>`;
  }
  // 平台菜单的「账号登录」：data-loginable 才渲染，且只有登记过登录入口的平台（option 带
  // data-login）才出图标——免登录的站不该多一枚点不动的键。状态从 option 的 data-login 读：
  // ok＝cookie 仓里站点已确认登录（常亮主题绿 + 小圆点），have＝有 cookie 但站点没确认。
  const loginable=()=>select.dataset.loginable==='true';
  function loginButton(option){
   const native=select.options[option.index];
   if(!native||!native.dataset.login)return '';
   const state=native.dataset.login;
   const on=state==='ok';
   const label=on?'已登录，点击切换账号':(state==='have'?'有登录记录但未确认，点击重新登录':'登录此平台');
   return `<span role="button" class="picker-login${on?' on':''}${state==='have'?' have':''}" data-login-stop data-login-value="${esc(option.value)}" tabindex="-1"
     title="${label}" aria-label="${label}">${icon('user')}</span>`;
  }
 function renderMenu(){
  options=readOptions(select);
  menu.innerHTML=options.length?options.map((option,index)=>{
   const chosen=option.value===select.value;
   const actions=(pinnable()?pinButton(option):'')+(loginable()?loginButton(option):'');
   return `<button type="button" role="option" tabindex="-1" id="${id}-option-${index}" class="picker-option${chosen?' current':''}${pinnable()?' pinnable':''}${actions?' has-actions':''}" data-index="${index}" data-picker-option="${esc(option.value)}" aria-selected="${chosen}"><span class="picker-option-text">${esc(option.label)}${option.hint?`<small>${esc(option.hint)}</small>`:''}</span>${actions}</button>`;
  }).join(''):'<p class="picker-empty">暂无可选项</p>';
  nodes=[...menu.querySelectorAll('[data-index]')];painted=-1;
 }
 /** 菜单贴在按钮下面；下方放不下就翻到上面。宽度取「按钮宽度」与「最长选项」的较大者。 */
 function place(){
  const box=trigger.getBoundingClientRect();
  if(!box.width||!box.height||box.bottom<=0||box.top>=window.innerHeight){close();return;}
  const below=Math.max(0,window.innerHeight-box.bottom-10),above=Math.max(0,box.top-10);
  const dropUp=below<Math.min(menu.scrollHeight,400)&&above>below;
  // 平台菜单固定宽度，保证各模式（全部 / 模型 / 图片）下拉宽度一致；其他下拉仍按内容自适应。
  const width=pinnable()
   ? Math.min(PLATFORM_MENU_WIDTH,window.innerWidth-16)
   : Math.min(Math.max(box.width,naturalWidth),window.innerWidth-16);
  const left=Math.max(8,Math.min(box.left,window.innerWidth-width-8));
  menu.style.width=`${width}px`;
  menu.style.left=`${left}px`;
  menu.style.maxHeight=`${Math.min(400,Math.max(0,(dropUp?above:below)-7))}px`;
  menu.dataset.side=dropUp?'up':'down';
  menu.style.top=`${dropUp?box.top-7:box.bottom+7}px`;
  menu.style.transform=dropUp?'translateY(-100%)':'none';
 }
 const schedulePlace=()=>{if(open&&!placeFrame)placeFrame=requestAnimationFrame(()=>{placeFrame=0;if(open)place();});};
 function paint({scroll=true}={}){
  nodes[painted]?.classList.remove('highlight');nodes[highlight]?.classList.add('highlight');painted=highlight;
  const active=nodes[highlight];
  if(!active){trigger.removeAttribute('aria-activedescendant');return;}
  trigger.setAttribute('aria-activedescendant',active.id);
  if(!scroll)return;
  // 自己算滚动量，而不是 scrollIntoView：后者会顺带滚动祖先（乃至整页），
  // 而「页面滚了」在下面是要把菜单重新定位的，菜单自己滚自己不该触发这件事。
  const top=active.offsetTop,bottom=top+active.offsetHeight;
  if(top<menu.scrollTop)menu.scrollTop=top;
  else if(bottom>menu.scrollTop+menu.clientHeight){
   const target=bottom-menu.clientHeight;
   // 让可视区顶部落在某一项的边界上，避免把上一项腰斩成半截文字。
   // 平台菜单副标题长、行高不一致，半截项看起来就像整个面板和按钮错位。
   // 只有当对齐后当前项仍完整可见时才吸附；否则退回原始滚动量保证选中项可见。
   let snapped=0;
   for(const node of nodes){const nt=node.offsetTop;if(nt<=target)snapped=nt;}
   menu.scrollTop=snapped+menu.clientHeight>=bottom?Math.max(0,snapped):Math.max(0,target);
  }
 }
 function show(){
  if(!options.length)return;
  // 平台下拉与搜索框的「最近检索」浮层都贴在搜索卡片下方同一个位置，先后打开就会互相压住。
  // 这里广播一声，让浮层自己收起：点平台时本来也不该同时看到历史。
  document.dispatchEvent(new CustomEvent('picker:open',{detail:{id}}));
  renderMenu();open=true;menu.hidden=false;trigger.setAttribute('aria-expanded','true');
  menu.style.width='max-content';naturalWidth=menu.offsetWidth;
  highlight=selectedIndex(options);place();paint();
 }
 function close({focus=false}={}){
  if(!open)return;
  open=false;menu.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.removeAttribute('aria-activedescendant');
  cancelAnimationFrame(placeFrame);placeFrame=0;clearTimeout(bufferTimer);buffer='';bufferTimer=0;
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
 menu.addEventListener('click',event=>{
  // 图钉点击：不关闭、不选中平台，派发事件让业务层改置顶状态后整表重绘。
  if(event.target.closest?.('[data-pin-stop]')){
   const value=event.target.closest('[data-pin-stop]').dataset.pinValue;
   select.dispatchEvent(new CustomEvent('picker:pin',{detail:{value},bubbles:true}));
   return;
  }
  // 登录图标点击：同理不选中平台，交给业务层开后台浏览器登录窗口，登完重绘登录标识。
  if(event.target.closest?.('[data-login-stop]')){
   const value=event.target.closest('[data-login-stop]').dataset.loginValue;
   select.dispatchEvent(new CustomEvent('picker:login',{detail:{value},bubbles:true}));
   return;
  }
  const node=event.target.closest('[data-index]');if(node)commit(Number(node.dataset.index));
 });
 menu.addEventListener('pointermove',event=>{
  const node=event.target.closest('[data-index]');
  if(node&&Number(node.dataset.index)!==highlight){highlight=Number(node.dataset.index);paint({scroll:false});}
 });
 document.addEventListener('pointerdown',event=>{if(open&&!inside(event.target))close();},true);
 // 页面滚动时把菜单重新贴回按钮下面；菜单自己的滚动（高亮项自动滚入视野）不算。
 document.addEventListener('picker:open',event=>{if(event.detail?.id!==id)close();});
 window.addEventListener('scroll',event=>{if(open&&!menu.contains(event.target))schedulePlace();},{capture:true,passive:true});
 window.addEventListener('resize',schedulePlace);
 new ResizeObserver(schedulePlace).observe(trigger);
 const observer=new MutationObserver(()=>{sync();if(open)show();});
 observer.observe(select,{childList:true,subtree:true});
 sync();
 return {element:wrap,menu,refresh:sync,open:show,close};
}

/** 把一个范围内的原生 select 全部升级；新增的下拉只要写进这个范围就自动生效。 */
export const enhanceSelects=selector=>[...document.querySelectorAll(selector)].map(enhanceSelect).filter(Boolean);
