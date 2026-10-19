/**
 * 「全部平台」的统一筛选树：两个平台的分类合并成一棵。
 *
 * 全部平台下两个平台一起被检索，再摆两棵各自为政的树等于让用户筛两遍。这里把分类合到
 * 一棵树上：骨架沿用 Sketchfab 的 18 个官方分类（本来就有中文标签），每个叶子带一份
 * ArtStation category_ids 映射——点「角色与生物」，S 站按 characters-creatures 查，
 * A 站按 66,65,19,36（角色建模/设计、生物、解剖）查。A 站没有对应分类的叶子（音乐、
 * 运动这类）也不静默：叶子上带 ⊘ 覆盖面标记，选中它（或它所在的整组）A 站那一路本轮
 * 就不发检索，树里同时写明原因。
 *
 * 值流只有一个方向是权威的：树上只写 Sketchfab 那套原生控件（#online-*），
 * A 站的分类在 readRequest('art') 里按映射派生，退出「全部平台」什么都不用还原。
 * 外部改值（历史回放 / 重置）通过拦 value / checked 访问器同步回树；
 * 排序与「精选」勾选顺手镜像到 A 站控件，让两边请求用同一套条件。
 * 「ArtStation 专属」分支里的类型 / 艺术家是同一批原生节点搬进来的（不是复制），
 * refresh / release 负责在统一树与平台树之间往返，切回单平台五个字段一个不少。
 */
import {ALL} from './platforms.js';

// 分类目录与派生函数住在 merged-catalog.js（纯函数，单测直接钉它）；这里 import 自用，
// 并原样再导出一次——app.js 与单测的 import 路径不用改。
import {
 UNIFIED_CATEGORIES,UNIFIED_GROUPS,mergedCategory,groupSketchfabCategories,groupSketchfabValue,groupIdOfSketchfabValue,mergedGroupCategory,mergedSelection,toggleGroupValue,groupChipText,artstationCategory,feedPlan,joinQuery,UNIFIED_SORTS,ASSET_KINDS,kindAllows,kindType,
} from './merged-catalog.js';
export {
 UNIFIED_CATEGORIES,UNIFIED_GROUPS,mergedCategory,groupSketchfabCategories,groupSketchfabValue,groupIdOfSketchfabValue,mergedGroupCategory,mergedSelection,toggleGroupValue,groupChipText,artstationCategory,feedPlan,joinQuery,UNIFIED_SORTS,ASSET_KINDS,kindAllows,kindType,
} from './merged-catalog.js';

const ACCENT='#c9f581';
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};

/** 拦下实例上的 value / checked，让「代码直接赋值」（历史回放、重置）也能被看见。 */
function watch(instance,key,onChange){
 const proto=instance instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLSelectElement.prototype;
 const accessor=Object.getOwnPropertyDescriptor(proto,key);
 Object.defineProperty(instance,key,{configurable:true,
  get(){return accessor.get.call(instance);},
  set(next){accessor.set.call(instance,next);onChange();}});
}

export function createMergedFilters({$,icon,state,onReset,onSearch}){
 const host=$('#filters-merged');
 if(!host)return null;
 host.textContent='';
 const tree=el('div','ftree');
 tree.setAttribute('aria-label','统一筛选');
 const plate=el('div','ftree-plate');plate.style.setProperty('--tone','#c9f581');
 plate.append(el('span','ftree-plate-emoji','✨'),el('span','ftree-plate-name','统一筛选'));
 tree.append(plate);

 const categorySelect=$('#online-category');
 const sortSelect=$('#online-sort');
 const artSort=$('#art-sort');

 /* 排序镜像：「全部平台」下统一排序就是两边唯一的排序控件（A 站自己的那棵已经收起来了），
    统一排序变了 A 站控件悄悄跟上，不派发事件，避免 artstation.start 多跑一路。
    A 站没有的排序（比如它没有「最新发布」）回落到相关度，别把空值塞进请求。 */
 const mirrorSort=()=>{
  if(state.platform!==ALL||!sortSelect||!artSort)return;
  const item=UNIFIED_SORTS.find(entry=>entry.value===sortSelect.value);
  let next=item?(item.as||item.value):'relevance';
  if(next==='name')next='relevance';
  if(artSort.options&&!Array.from(artSort.options).some(option=>option.value===next))next='relevance';
  if(artSort.value!==next)artSort.value=next;
 };

 const makeSection=(key,label,iconName,open)=>{
  const section=el('section','ftree-sec');section.dataset.key=key;
  const head=el('button','ftree-branch');head.type='button';head.setAttribute('aria-expanded','false');
  const caret=el('span','ftree-caret');caret.innerHTML=icon('chevron');
  const ic=el('span','ftree-ic');ic.innerHTML=icon(iconName);
  const chip=el('span','ftree-chip');
  head.append(caret,ic,el('span','ftree-name',label),chip);
  const body=el('div','ftree-body');const kids=el('div','ftree-kids');body.append(kids);
  section.append(head,body);
  const box={section,head,kids,chip,open:!!open,wideOpen:null};
  head.addEventListener('click',()=>setOpen(box,!box.open));
  return box;
 };
 const setOpen=(box,open)=>{box.open=open;box.section.classList.toggle('open',open);box.head.setAttribute('aria-expanded',String(open));};

 const makeLeaf=(label,value,color,onPick)=>{
  const node=el('button','ftree-leaf');node.type='button';node.dataset.value=value;node.title=label;
  if(color)node.style.setProperty('--tone',color);
  node.append(el('i','ftree-dot'),el('span','ftree-leaf-label',label),el('i','ftree-spark','✦'));
  node.addEventListener('click',onPick);
  return node;
 };
 const setGroupOpen=(group,open)=>{group.classList.toggle('open',open);const head=group.querySelector('.ftree-group-head');if(head)head.setAttribute('aria-expanded',String(open));};
 const mapNote=el('p','ftree-own-hint');
 const mapToggle=el('button','text-button');mapToggle.type='button';mapToggle.textContent='对照';mapToggle.hidden=true;
 const mapDetail=el('p','ftree-own-hint');mapDetail.hidden=true;
 mapToggle.addEventListener('click',()=>{mapDetail.hidden=!mapDetail.hidden;});

 /* ---- 分类：根叶子 + 5 组主题 ----
    组头同时是一键筛选的按钮：点一下 = 选中整组（S 站写整组 slug 串、A 站写组内映射并集），
    再点一下 = 取消回「全部分类」。展开 / 收起挪到左边那颗小箭头上——「想看看组里有什么」
    这个动作不该顺手把筛选条件也一起改掉。 */
 const catBox=makeSection('category','分类','list',true);
 const groupSelect=$('#online-category-group');       // R1：整组多值只写这个容器
 const pickCategory=value=>{
  // R1 的语义互斥：选了叶子，整组串就得清掉，否则 readCategory 还是先读组容器。
  if(groupSelect&&groupSelect.value)groupSelect.value='';
  if(categorySelect.value!==value){
   categorySelect.value=value;                        // 写入即触发上面拦下的 setter → sync
   categorySelect.dispatchEvent(new Event('change',{bubbles:true}));   // 走 app.js 的 onchange → 重搜两个源
  }else sync();
 };
 const currentGroup=()=>String((groupSelect&&groupSelect.value)||'').trim();
 const pickGroup=id=>{
  if(!groupSelect||!groupChipText(id))return;
  const next=toggleGroupValue(currentGroup(),id);      // 值 = 组内 slug 逗号串（R1）
  if(next&&categorySelect.value)categorySelect.value='';  // 互斥的另一半：整组选中，单值叶子清空
  if(groupSelect.value===next){sync();return;}
  groupSelect.value=next;
  groupSelect.dispatchEvent(new Event('change',{bubbles:true}));        // app.js 的 onchange → 两个源一起重搜
 };
 // 「全部分类」要把两个容器一起清掉：选了整组之后叶子容器本来就是空的，只清组容器就会漏。
 catBox.kids.append(makeLeaf('全部分类','',ACCENT,()=>{
  if(currentGroup()){
   groupSelect.value='';
   groupSelect.dispatchEvent(new Event('change',{bubbles:true}));
   return;
  }
  pickCategory('');
 }));
 for(const group of UNIFIED_GROUPS){
  const items=UNIFIED_CATEGORIES.filter(item=>group.values.includes(item.value));
  if(!items.length)continue;
  const wrap=el('div','ftree-group');wrap.dataset.group=group.id;wrap.style.setProperty('--tone',group.color);
  const groupHead=el('button','ftree-group-head');groupHead.type='button';groupHead.setAttribute('aria-expanded','false');
  groupHead.title=`一键筛选「${group.label}」整组（${items.length} 类），再点一次取消`;
  const toggle=el('span','ftree-caret');toggle.innerHTML=icon('chevron');
  toggle.addEventListener('click',event=>{event.stopPropagation();setGroupOpen(wrap,!wrap.classList.contains('open'));});
  groupHead.append(toggle,el('span','ftree-emoji',group.icon),el('span','ftree-name',group.label),
   el('span','ftree-count',String(items.length)));
  const groupBody=el('div','ftree-body');const groupKids=el('div','ftree-kids');
  for(const item of items)groupKids.append(makeLeaf(item.label,item.value,group.color,()=>pickCategory(item.value)));
  groupBody.append(groupKids);wrap.append(groupHead,groupBody);
  groupHead.addEventListener('click',()=>pickGroup(group.id));
  catBox.kids.append(wrap);
 }
 catBox.kids.append(mapNote,mapToggle,mapDetail);
 const kinds=()=>{const value=$('#unified-kind')?.value;return value?[value]:[];};
 const clearKinds=()=>{const node=$('#unified-kind');if(node)node.value='';};

 for(const box of [catBox])tree.append(box.section);
 const foot=el('div','ftree-foot');
 const reset=el('button','text-button side-reset ftree-reset');reset.type='button';reset.textContent='↻ 重置筛选';
 reset.addEventListener('click',()=>onReset&&onReset());
 foot.append(reset);tree.append(foot);

 host.append(tree);

 /* ---- 同步：选中态、组展开、chip ---- */
 let last=null;
 const sync=()=>{
  const catValue=categorySelect?categorySelect.value:'';
  const groupValue=currentGroup();
  let activeGroup=null;
  for(const node of catBox.kids.querySelectorAll('.ftree-leaf')){
   const on=node.dataset.value===catValue;
   node.classList.toggle('active',on);node.setAttribute('aria-pressed',String(on));
   if(on)activeGroup=node.closest('.ftree-group');
  }
  for(const group of catBox.kids.querySelectorAll('.ftree-group')){
   // 组头一键筛的选中态：容器里的值就是这一组的 slug 串（不是组 id），对上才亮。
   const picked=groupSketchfabValue(group.dataset.group)===groupValue;
   group.classList.toggle('picked',picked);
   const on=group===activeGroup;
   group.classList.toggle('has-active',on);
   // 只有「选中的东西真的换了」才自动展开，免得手动折上去的组又被弹开。
   if((on||picked)&&last!==`${catValue}|${groupValue}`)setGroupOpen(group,true);
  }
  const leafItem=UNIFIED_CATEGORIES.find(item=>item.value===catValue);
  const chipGroup=groupValue?groupIdOfSketchfabValue(groupValue):'';
  catBox.chip.textContent=groupValue?(groupChipText(chipGroup)||groupValue):(leafItem?leafItem.label:(catValue||'全部分类'));
  const plan=feedPlan({group:groupValue,leaf:catValue});
  mapNote.textContent=plan?`本轮检索：${plan.sites.join('、')}`:'';
  mapToggle.hidden=!plan;
  mapDetail.textContent=plan?plan.via.map(row=>`${row.site}：${row.name}`).join('\n'):'';
  if(!plan)mapDetail.hidden=true;
  last=`${catValue}|${groupValue}`;
 };

 // 组容器也要盯：组头一键筛只写它，不盯的话选中态 / chip 要等下一次别的改动才跟上。
 for(const node of [categorySelect,groupSelect])if(node){watch(node,'value',()=>sync());node.addEventListener('change',()=>sync());}
 if(sortSelect){
  watch(sortSelect,'value',()=>{mirrorSort();sync();});
  sortSelect.addEventListener('change',()=>{mirrorSort();sync();});
 }

 sync();
 // 初始展开状态落盘：makeSection 只记了状态，.open 类要在这里真正挂上去。
 for(const box of [catBox])setOpen(box,box.open);
 const refresh=()=>sync();
 const release=()=>{};
 return {refresh,release,kinds,clearKinds,setNarrow(next){
  for(const box of [catBox]){
   if(next){box.wideOpen=box.open;setOpen(box,false);}
   else setOpen(box,box.wideOpen==null?box.open:box.wideOpen);
  }
 }};
}
