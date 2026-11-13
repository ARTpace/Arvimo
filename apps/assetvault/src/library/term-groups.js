// 检索浮层的「词组分类」契约。
//
// 原来「今日主题 / 相近词」是搜索卡片里一条常驻胶囊带，「最近检索」是另一个浮层，
// 三处词组各画各的。现在合到同一个浮层里，靠这张表按**来源类型**分区：
// 顺序、标题、图标、配色、是否参与输入过滤都只在这里定义，渲染层不写 if-else 长龙。
// 新增一类词组 = 表里加一行 + 在 app.js 的 sources() 里给一份数据。
export const TERM_GROUPS=Object.freeze([
 Object.freeze({id:'recent',label:'最近检索',icon:'history',hint:'搜过的关键词',tone:'slate',filterable:true,hideWhenEmpty:false,empty:'还没有检索记录 · 搜过的关键词会留在这里'}),
 Object.freeze({id:'links',label:'链接解析',icon:'link',hint:'解析过的页面与画板',tone:'blue',filterable:true,hideWhenEmpty:true}),
 Object.freeze({id:'daily',label:'今日主题',icon:'sparkle',hint:'每天换一批灵感词',tone:'green',filterable:false,hideWhenEmpty:true}),
 Object.freeze({id:'related',label:'相近词',icon:'shuffle',hint:'由当前检索词扩展',tone:'violet',filterable:false,hideWhenEmpty:false,empty:'提交搜索后会在这里推荐相近词'}),
]);

export const TERM_GROUP_IDS=TERM_GROUPS.map(group=>group.id);

/** 一条词组能不能被输入框里的字收窄：标题、提示文案都算命中。 */
const matches=(item,lower)=>!lower||String(item.label||'').toLowerCase().includes(lower)||String(item.title||'').toLowerCase().includes(lower);

/**
 * 组装浮层的分区视图。纯函数，不碰 DOM —— 测试可以直接喂数据。
 *
 * @param {object} input
 *   history     - 已规整的历史行 [{group:'recent'|'links',label,title,icon,entry}]
 *   daily       - 今日主题 [{term,label,today,badge,title}]
 *   related     - 相近词 [{term,label,title}]
 *   relatedNote - 相近词组的空态 / 加载中 / 失败文案（优先于默认文案）
 *   term        - 输入框当前文字，只收窄标记 filterable 的组
 *   limit       - 每组最多几条（与历史本身的上限一致）
 * @returns {Array<{id,label,icon,hint,tone,items,empty}>} 空组按 hideWhenEmpty 决定是否保留
 */
export function buildTermSections({history=[],daily=[],related=[],relatedNote='',term='',limit=12}={}){
 const lower=String(term||'').trim().toLowerCase();
 const buckets={recent:[],links:[],daily:[],related:[]};
 for(const row of Array.isArray(history)?history:[]){
  const group=buckets[row?.group]?row.group:'links';
  buckets[group].push(row);
 }
 buckets.daily=Array.isArray(daily)?daily:[];
 buckets.related=Array.isArray(related)?related:[];
 return TERM_GROUPS.map(group=>{
  let items=buckets[group.id]||[];
  if(group.filterable&&lower)items=items.filter(item=>matches(item,lower));
  items=items.slice(0,Math.max(0,limit));
  let empty='';
  if(!items.length){
   if(group.id==='related')empty=String(relatedNote||'').trim()||group.empty||'';
   else if(group.id==='recent'&&lower)empty=`没有匹配“${term.trim()}”的检索记录`;
   else empty=group.empty||'';
  }
  if(group.hideWhenEmpty&&!items.length)return null;
  const {id,label,icon,hint,tone}=group;
  return {id,label,icon,hint,tone,items,empty};
 }).filter(Boolean);
}
