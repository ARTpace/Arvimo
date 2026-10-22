/**
 * 侧栏筛选树。
 *
 * 原来的筛选是「小标签 + 下拉框」竖着一列：分类、排序、范围三个平级字段，19 个分类全藏在
 * 原生下拉里，不开菜单就不知道有什么。这里改成树：字段是根分支，分类下面按主题分 5 组，
 * 组里才是真正能点的分类项 —— 一眼看全，点两下就到。
 *
 * 唯一的硬约束是**业务代码只认那几个原生控件**（#online-category / #online-sort / #art-*）。
 * 所以控件一个不动地留在 DOM 里当「值容器」，只是被搬进一个 hidden 的盒子；树负责画、
 * 负责写值、负责在值被外部改掉时同步回来。读值、重置、历史回放那些代码一行都不用改。
 *
 * 三个同步点（和 picker.js 同一套思路）：
 *   1. 选项被整体重写（innerHTML / appendChild）→ MutationObserver；
 *   2. 代码直接写 value / checked（不触发事件）→ 拦下实例上的访问器；
 *   3. 用户点树的叶子 → 写回 value + 派发 change，走原来那条 onchange 通道。
 *
 * 「分类」这一类长清单怎么折，取决于字段带的是什么（见 filter-groups.js）：
 *   - `groups`：手工分组表（Sketchfab 的 5 大主题、ArtStation 的 6 个用途组），组头可折；
 *   - `fold`：长列表自动折叠（各平台自己的分类接口），前 N 个常驻、其余进「更多分类」；
 *   - 两者都没有：平铺成单层 —— 新平台不写任何配置也渲染得出东西。
 */
import {ARTSTATION_CATEGORY_GROUPS,MORE_GROUP,foldLongList} from './filter-groups.js';

// 19 个 Sketchfab 分类按主题归到 5 组。没被列到的分类会兜进「其他」，
// 以后官方加新分类也不会从树上凭空消失。
const GROUPS=[
 {id:'life',icon:'🐾',label:'生物',color:'#8fe0a8',values:['animals-pets','characters-creatures','nature-plants','people']},
 {id:'scene',icon:'🏛️',label:'场景',color:'#8fbbf0',values:['architecture','places-travel','furniture-home']},
 {id:'art',icon:'🎨',label:'人文',color:'#f0ab8a',values:['art-abstract','cultural-heritage-history','music','news-politics','fashion-style']},
 {id:'build',icon:'⚙️',label:'造物',color:'#c3a4f0',values:['cars-vehicles','electronics-gadgets','weapons-military','science-technology']},
 {id:'daily',icon:'🍰',label:'生活',color:'#eed892',values:['food-drink','sports-fitness']},
];
const OTHER={id:'more',icon:'✳',label:'其他',color:'#9fb0bf'};
const ACCENT='#c9f581';

const SPECS=[
 {row:'#filters-sketchfab',plate:{emoji:'🧊',label:'Sketchfab',tone:'#9fd0a0'},reset:'#reset-search-filters',fields:[
  {key:'category',label:'分类',icon:'list',open:true,groups:GROUPS,control:'#online-category'},
  {key:'sort',label:'排序',icon:'sort',control:'#online-sort'},
  {key:'scope',label:'范围',icon:'check',checks:[
   {label:'可下载',selector:'#online-downloadable'},
   {label:'有动画',selector:'#online-animated'},
   {label:'精选',selector:'#online-staffpicked'},
  ]},
 ]},
 {row:'#filters-artstation',plate:{emoji:'🖼️',label:'ArtStation',tone:'#e8a6b8'},reset:'#art-reset-filters',fields:[
  // A 站官方有 59 个分类，平铺出来是一列看不到头的清单；按用途归到 6 组（filter-groups.js），
  // 组默认折着，只有当前选中的那一组会自动展开。分组只看显示文案，请求参数仍是官方数字 id。
  {key:'category',label:'分类',icon:'list',groups:ARTSTATION_CATEGORY_GROUPS,control:'#art-category'},
  {key:'type',label:'类型',icon:'cube',control:'#art-type'},
  {key:'artist',label:'艺术家',icon:'user',content:['#art-artist'],actions:['#art-artist-projects','#art-artist-likes']},
  {key:'sort',label:'排序',icon:'sort',control:'#art-sort'},
  {key:'scope',label:'范围',icon:'check',checks:[{label:'精选',selector:'#art-picked'}]},
 ]},
 // 下面四个平台的分类清单来自各自接口：词表长、彼此不通、还混着 collection 之类的合集前缀，
 // 没有可依赖的手工分组表，所以声明 fold —— 清单本身按官方热度排序，超过阈值就折起来。
 {row:'#filters-polyhaven',plate:{emoji:'🏛️',label:'Poly Haven',tone:'#9ec6e8'},fields:[
  {key:'type',label:'类型',icon:'cube',control:'#polyhaven-type'},
  {key:'category',label:'分类',icon:'list',fold:true,control:'#polyhaven-category'},
 ]},
 {row:'#filters-ambientcg',plate:{emoji:'🪨',label:'ambientCG',tone:'#c3b49a'},fields:[
  {key:'type',label:'类型',icon:'cube',control:'#ambientcg-type'},
  {key:'category',label:'分类',icon:'list',open:true,fold:true,control:'#ambientcg-category'},
 ]},
 {row:'#filters-freestylized',plate:{emoji:'🎨',label:'FreeStylized',tone:'#d7b4e8'},fields:[
  {key:'type',label:'类型',icon:'cube',control:'#freestylized-type'},
  {key:'category',label:'分类',icon:'list',fold:true,control:'#freestylized-category'},
 ]},
 {row:'#filters-kenney',plate:{emoji:'🎮',label:'Kenney',tone:'#a8d8b0'},fields:[
  {key:'category',label:'类型',icon:'cube',fold:true,control:'#kenney-category'},
  {key:'series',label:'系列',icon:'list',fold:true,control:'#kenney-series'},
 ]},
 {row:'#filters-polypizza',plate:{emoji:'🍕',label:'Poly Pizza',tone:'#e8b48c'},fields:[
  {key:'license',label:'许可',icon:'check',checks:[{label:'仅 CC0',selector:'#polypizza-cc0'}]},
 ]},
];

const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};
const optionList=select=>[...select.options];

/** 拦下实例上的 value / checked，让「代码直接赋值」也能被看见（原生赋值不派发事件）。 */
function watch(instance,key,onChange){
 const proto=instance instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLSelectElement.prototype;
 const accessor=Object.getOwnPropertyDescriptor(proto,key);
 Object.defineProperty(instance,key,{
  configurable:true,
  get(){return accessor.get.call(instance);},
  set(next){accessor.set.call(instance,next);onChange();},
 });
}

export function createFilterTrees({$,icon}){
 const panels=[];
 for(const spec of SPECS){
  const host=$(spec.row);
  if(host)panels.push(buildPanel({$,icon,host,spec}));
 }
 let narrow=false;
 return {
  /** 选项被外部重写、或值被外部改掉之后重新对齐一次。 */
  refresh(){for(const panel of panels)panel.refresh();},
  /** 窄屏收成 65px 图标条放不下树，整棵折起来只留分支标题。 */
  setNarrow(next){
   if(next===narrow)return;
   narrow=next;
   for(const panel of panels)panel.setNarrow(next);
  },
 };
}

function buildPanel({$,icon,host,spec}){
 const fields=spec.fields.map(field=>({
  key:field.key,
  label:field.label,
  icon:field.icon,
  open:!!field.open,
  groups:field.groups||null,
  fold:!!field.fold,
  control:field.control?$(field.control):null,
  checks:(field.checks||[]).map(item=>({label:item.label,node:$(item.selector)})).filter(item=>item.node),
  content:(field.content||[]).map(selector=>$(selector)).filter(Boolean),
  actions:(field.actions||[]).map(selector=>$(selector)).filter(Boolean),
 })).filter(field=>field.control||field.checks.length||field.content.length);
 if(!fields.length)return {refresh(){},setNarrow(){}};

 const reset=spec.reset?$(spec.reset):null;
 // 先把原标记整片丢掉（旧外壳不再需要），控件的引用还在手上。
 host.textContent='';
 const keep=el('div','ftree-src');keep.hidden=true;
 const tree=el('div','ftree');
 tree.setAttribute('aria-label','筛选');
 if(spec.plate){                                    // 全部平台下两棵树并排出现，先报一遍自己是谁
  const plate=el('div','ftree-plate');plate.style.setProperty('--tone',spec.plate.tone||'');
  plate.append(el('span','ftree-plate-emoji',spec.plate.emoji),el('span','ftree-plate-name',spec.plate.label));
  tree.append(plate);
 }
 const views=fields.map(field=>buildField({field,icon,keep}));
 for(const view of views)tree.append(view.section);
 if(reset){
  reset.className='filter-reset-icon';reset.innerHTML=icon('rotate');
  reset.title='重置筛选';reset.setAttribute('aria-label','重置筛选');
  const category=views.find(view=>view.field.key==='category')||views[0];
  const head=category.section.querySelector('.ftree-branch');
  const row=el('div','filter-category-row');category.section.prepend(row);row.append(head,reset);
 }
 host.append(tree,keep);

 const once=new WeakSet();
 const onAnyChange=()=>refresh();
 for(const field of fields){
  if(field.control&&!once.has(field.control)){
   once.add(field.control);
   // 选项被整体重写时重画分组；写 value 时只重画选中态。
   new MutationObserver(()=>refresh()).observe(field.control,{childList:true,subtree:true});
   watch(field.control,'value',onAnyChange);
   field.control.addEventListener('change',onAnyChange);
  }
  for(const item of field.checks){
   if(once.has(item.node))continue;
   once.add(item.node);
   watch(item.node,'checked',onAnyChange);
   item.node.addEventListener('change',onAnyChange);
  }
 }

 let lastNarrow=false;
 function refresh(){for(const view of views)view.sync();}
 function setNarrow(next){
  if(next===lastNarrow)return;
  lastNarrow=next;
  for(const view of views)view.setNarrow(next);
 }
 refresh();
 for(const view of views)view.setOpen(view.field.open);
 return {refresh,setNarrow};
}

/**
 * 一个字段 = 一个根分支。三种形态各走各的渲染，但都是「隐藏的原生控件 + 树上的显示层」。
 */
function buildField({field,icon,keep}){
 const section=el('section','ftree-sec');
 section.dataset.key=field.key;
 const head=el('button','ftree-branch');head.type='button';
 head.setAttribute('aria-expanded','false');
 const caret=el('span','ftree-caret');caret.innerHTML=icon('chevron');
 const chip=el('span','ftree-chip');
 head.append(caret,svgBox(icon,field.icon),el('span','ftree-name',field.label),chip);
 const body=el('div','ftree-body');
 const kids=el('div','ftree-kids');
 body.append(kids);
 section.append(head,body);

 const state={open:!!field.open,wideOpen:null,last:null,signature:''};
 const setOpen=open=>{state.open=open;section.classList.toggle('open',open);head.setAttribute('aria-expanded',String(open));};
 head.addEventListener('click',()=>setOpen(!state.open));

 let sync=()=>{};

 if(field.control){
  keep.append(field.control);
  field.control.classList.add('ftree-native');
  const choose=value=>{
   if(field.control.value===value)return;
   field.control.value=value;              // 写入即触发上面的 setter
   field.control.dispatchEvent(new Event('change',{bubbles:true}));
   sync();
  };
  const makeLeaf=(option,tone)=>{
   const node=el('button','ftree-leaf');node.type='button';
   node.dataset.value=option.value;
   node.title=option.label;
   if(tone)node.style.setProperty('--tone',tone);
   node.append(el('i','ftree-dot'),el('span','ftree-leaf-label',option.label),el('i','ftree-spark','✦'));
   node.addEventListener('click',()=>choose(option.value));
   return node;
  };
  const makeGroup=(group,items)=>{
   const wrap=el('div','ftree-group');
   wrap.dataset.group=group.id;
   wrap.style.setProperty('--tone',group.color);
   const groupHead=el('button','ftree-group-head');groupHead.type='button';
   groupHead.setAttribute('aria-expanded','false');
   const groupCaret=el('span','ftree-caret');groupCaret.innerHTML=icon('chevron');
   groupHead.append(groupCaret,el('span','ftree-emoji',group.icon),el('span','ftree-name',group.label),el('span','ftree-count',String(items.length)));
   const groupBody=el('div','ftree-body');
   const groupKids=el('div','ftree-kids');
   for(const option of items)groupKids.append(makeLeaf(option,group.color));
   groupBody.append(groupKids);
   wrap.append(groupHead,groupBody);
   groupHead.addEventListener('click',()=>setGroupOpen(wrap,!wrap.classList.contains('open')));
   return wrap;
  };
  /** 把命中某组判据的项按原顺序摘出来；剩下的留给后面的组与兜底。 */
  const take=(pool,hit)=>{
   const out=[];
   for(let i=0;i<pool.length;i++)if(hit(pool[i]))out.push(pool.splice(i--,1)[0]);
   return out;
  };
  /** 分组判据：带 match 谓词的按谓词命中（ArtStation 按官方分类名），老式的按 option.value 命中。 */
  const groupMatch=(group,option)=>group.match?group.match(option):(group.values||[]).includes(option.value);
  /**
   * 有分组表就按组画；没有分组表但声明了 fold 的（各平台自己的分类清单）按热度折成长短两截；
   * 两者都没有就平铺 —— 新平台不写任何配置也渲染得出东西。
   */
  const build=()=>{
   kids.textContent='';
   state.last=null;                         // 结构重建了，选中项的组重新自动展开一次
   const rest=[...optionList(field.control)];
   const rootIndex=rest.findIndex(option=>option.value==='');
   if(rootIndex>=0)kids.append(makeLeaf(rest.splice(rootIndex,1)[0],ACCENT));
   if(field.groups){
    for(const group of field.groups){
     const items=take(rest,option=>groupMatch(group,option));
     if(items.length)kids.append(makeGroup(group,items));
    }
    if(rest.length)kids.append(makeGroup(OTHER,rest));   // 官方加的新分类不会从树上凭空消失
    return;
   }
   if(!field.fold){for(const option of rest)kids.append(makeLeaf(option));return;}
   const [front,tail]=foldLongList(rest);
   for(const option of front)kids.append(makeLeaf(option));
   if(tail.length)kids.append(makeGroup(MORE_GROUP,tail));
  };
  sync=()=>{
   const signature=optionList(field.control).map(option=>option.value).join('');
   if(signature!==state.signature){state.signature=signature;build();}
   const value=field.control.value;
   let activeGroup=null;
   for(const node of kids.querySelectorAll('.ftree-leaf')){
    const on=node.dataset.value===value;
    node.classList.toggle('active',on);
    node.setAttribute('aria-pressed',String(on));
    if(on)activeGroup=node.closest('.ftree-group');
   }
   for(const group of kids.querySelectorAll('.ftree-group')){
    const on=group===activeGroup;
    group.classList.toggle('has-active',on);
    // 只有在「选中的东西真的换了」时才自动展开，免得用户手动折上去的组又被弹开。
    if(on&&state.last!==value)setGroupOpen(group,true);
   }
   state.last=value;
   const current=optionList(field.control).find(option=>option.value===value);
   chip.textContent=current?current.label:'选不了';
  };
 }else if(field.content.length){
  const row=el('div','ftree-row');
  for(const node of field.content){
   node.classList.add('ftree-native');
   row.append(node);
  }
  if(field.actions.length){
   const actions=el('div','ftree-actions');
   for(const node of field.actions){node.classList.add('ftree-native');actions.append(node);}
   row.append(actions);
  }
  kids.append(row);
  const input=field.content.find(node=>node.tagName==='INPUT');
  sync=()=>{chip.textContent=input&&input.value.trim()?input.value.trim():'不限';};
  if(input)input.addEventListener('input',sync);
 }else{
  for(const item of field.checks){
   item.node.classList.add('ftree-native');
   const row=el('label','ftree-check');
   const box=el('span','ftree-box');box.innerHTML=icon('check');
   row.append(item.node,box,el('span','ftree-leaf-label',item.label));
   kids.append(row);
  }
  sync=()=>{
   const picked=field.checks.filter(item=>item.node.checked).length;
   chip.textContent=picked?`已选 ${picked}`:'不限';
  };
 }
 sync();
 return {field,section,sync,setOpen,setNarrow(next){
  if(next){state.wideOpen=state.open;setOpen(false);}
  else setOpen(state.wideOpen==null?field.open:state.wideOpen);
 }};
}

function setGroupOpen(group,open){
 group.classList.toggle('open',open);
 const head=group.querySelector('.ftree-group-head');
 if(head)head.setAttribute('aria-expanded',String(open));
}

function svgBox(icon,name){
 const box=el('span','ftree-ic');
 box.innerHTML=icon(name);
 return box;
}
