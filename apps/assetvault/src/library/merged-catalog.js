/**
 * 全部平台的题材表。叶子是我们自己的短名，不是各站原始分类的拼接。
 * s / as 仍是 Sketchfab slug 与 ArtStation id，给现有检索参数用。
 * 其余站写在各自字段里：没有该字段的站，选中这个叶子时不发检索。
 */
export const UNIFIED_CATEGORIES=[
 {value:'terrain',label:'地形与地面',s:['nature-plants'],as:['45','5'],polyhaven:{type:'textures',categories:['terrain','ground','sand']},ambientcg:true,freestylized:{type:'textures'},pizza:true,q:'terrain ground'},
 {value:'rock',label:'岩石',s:['nature-plants'],as:[],polyhaven:{type:'textures',categories:['rock','stone']},ambientcg:true,freestylized:{type:'textures'},q:'rock stone'},
 {value:'plants',label:'植被',s:['nature-plants'],as:[],polyhaven:{type:'models',categories:['plants']},ambientcg:true,freestylized:{type:'models'},pizza:true,q:'plant tree grass'},
 {value:'sky',label:'天空与水',s:['nature-plants'],as:[],polyhaven:{type:'hdris',categories:['skies','natural light']},ambientcg:true,freestylized:{type:'skybox'},q:'sky water'},
 {value:'animals',label:'动物',s:['animals-pets'],as:['37'],pizza:true,q:'animal'},
 {value:'architecture',label:'建筑',s:['architecture'],as:['13','30'],polyhaven:{type:'models',categories:['buildings']},freestylized:{type:'models'},pizza:true,q:'building architecture'},
 {value:'furniture',label:'室内与家具',s:['furniture-home'],as:['21'],polyhaven:{type:'models',categories:['furniture']},freestylized:{type:'models'},pizza:true,q:'furniture interior'},
 {value:'city',label:'城市',s:['places-travel'],as:['45'],polyhaven:{type:'models',q:'urban'},freestylized:{type:'models'},kenney:true,pizza:true,q:'city urban'},
 {value:'walls',label:'墙面砖石铺地',s:['architecture'],as:[],polyhaven:{type:'textures',categories:['brick','concrete','plaster','tiles']},ambientcg:true,freestylized:{type:'textures'},q:'brick concrete tile plaster'},
 {value:'people',label:'人物',s:['people'],as:['53','65'],pizza:true,q:'person character'},
 {value:'creatures',label:'生物与怪物',s:['characters-creatures'],as:['66','65','19','36'],pizza:true,q:'creature monster'},
 {value:'weapons',label:'武器与军事',s:['weapons-military'],as:['22','33'],polyhaven:{type:'models',q:'weapon'},freestylized:{type:'models'},pizza:true,q:'weapon military'},
 {value:'vehicles',label:'载具',s:['cars-vehicles'],as:['69','11'],freestylized:{type:'models'},pizza:true,q:'vehicle car'},
 {value:'tools',label:'工具与电子',s:['electronics-gadgets'],as:['18','47'],polyhaven:{type:'models',q:'tool electronics'},pizza:true,q:'tool electronics'},
 {value:'wood-metal',label:'木材与金属',s:[],as:[],polyhaven:{type:'textures',categories:['wood','metal']},ambientcg:true,freestylized:{type:'textures'},q:'wood metal'},
 {value:'history-scifi',label:'历史与科幻',s:['cultural-heritage-history','science-technology'],as:['6','51'],freestylized:{type:'models'},pizza:true,q:'medieval scifi'},
];

export const UNIFIED_GROUPS=[
 {id:'nature',icon:'globe',label:'自然',color:'#8fe0a8',values:['terrain','rock','plants','sky','animals']},
 {id:'scene',icon:'grid',label:'场景',color:'#8fbbf0',values:['architecture','furniture','city','walls']},
 {id:'character',icon:'user',label:'角色',color:'#f0ab8a',values:['people','creatures']},
 {id:'build',icon:'settings',label:'造物',color:'#c3a4f0',values:['weapons','vehicles','tools','wood-metal']},
 {id:'culture',icon:'image',label:'人文',color:'#eed892',values:['history-scifi']},
];

const SITE_NAME={sketchfab:'Sketchfab',art:'ArtStation',polyhaven:'Poly Haven',ambientcg:'ambientCG',freestylized:'FreeStylized',polypizza:'Poly Pizza',kenney:'Kenney'};
const TYPE_NAME={models:'模型',textures:'材质',hdris:'HDRI',skybox:'天空盒'};

const groupLeaves=groupId=>{
 const group=UNIFIED_GROUPS.find(item=>item.id===groupId);
 return group?UNIFIED_CATEGORIES.filter(item=>group.values.includes(item.value)):[];
};
const leavesOf=({group='',leaf=''}={})=>{
 const id=groupIdOfSketchfabValue(group);
 if(id)return groupLeaves(id);
 const hit=UNIFIED_CATEGORIES.find(item=>item.value===String(leaf||'').trim());
 return hit?[hit]:[];
};

export const mergedCategory=value=>{
 const hit=UNIFIED_CATEGORIES.find(item=>item.value===value);
 return hit?(hit.as||[]).join(','):'';
};
export const groupSketchfabCategories=groupId=>{
 const out=[];
 for(const item of groupLeaves(groupId))for(const slug of item.s||[])if(!out.includes(slug))out.push(slug);
 return out;
};
export const mergedGroupCategory=groupId=>{
 const out=[];
 for(const item of groupLeaves(groupId))for(const id of item.as||[])if(!out.includes(id))out.push(id);
 return out.join(',');
};
export const groupSketchfabValue=groupId=>groupSketchfabCategories(groupId).join(',');
export const groupIdOfSketchfabValue=key=>{
 const raw=String(key??'').trim();
 if(!raw)return '';
 if(UNIFIED_GROUPS.some(group=>group.id===raw))return raw;
 const hit=UNIFIED_GROUPS.find(group=>groupSketchfabValue(group.id)===raw);
 return hit?hit.id:'';
};
const artstationUnion=csv=>[...new Set(String(csv??'').split(',').flatMap(token=>mergedCategory(token.trim()).split(',')).filter(Boolean))].join(',');

export const mergedSelection=({group='',leaf=''}={})=>{
 const raw=String(group??'').trim();
 const id=raw?groupIdOfSketchfabValue(raw):'';
 const category=raw?(id?groupSketchfabValue(id):raw):'';
 const leafItem=!category?UNIFIED_CATEGORIES.find(item=>item.value===String(leaf??'').trim()):null;
 const sketchfab=category||(leafItem?(leafItem.s||[]).join(','):'');
 const artCategory=id?mergedGroupCategory(id):leafItem?(leafItem.as||[]).join(','):'';
 // 组容器里存的是 Sketchfab slug 串。叶子的统一 id 不进 Sketchfab 参数。
 const selected=!!(raw||String(leaf??'').trim());
 return {category:sketchfab,artCategory,artSkipped:selected&&!artCategory};
};

export const toggleGroupValue=(current,groupId)=>{
 const value=groupSketchfabValue(groupId);
 if(!value)return '';
 const key=String(current??'').trim();
 return key===value||key===String(groupId||'').trim()?'':value;
};
export const leafCoverage=value=>mergedCategory(value)?'both':'s';
export const coverageBadge=value=>value==='both'
 ?{icon:'grid',label:'有 ArtStation 对应',short:''}
 :{icon:'close',label:'ArtStation 没有对应',short:''};
export const groupChipText=groupId=>{
 const group=UNIFIED_GROUPS.find(item=>item.id===groupId);
 return group?group.label:'';
};
export const artstationCategory=({group='',leaf=''}={})=>{
 const picked=mergedSelection({group,leaf});
 return picked.artSkipped?null:picked.artCategory;
};

function sameType(items,key){
 const types=[...new Set(items.map(item=>item[key]?.type).filter(Boolean))];
 return types.length===1?types[0]:'';
}
function words(items){
 const out=[];
 for(const item of items)for(const word of String(item.q||'').split(/\s+/))if(word&&!out.includes(word))out.push(word);
 return out.join(' ');
}
/** 选中叶子或整组后，每个站这一轮怎么查。null 表示该站跳过。没选分类时返回 null，调用方保持各站默认请求。 */
export function feedPlan({group='',leaf=''}={}){
 const items=leavesOf({group,leaf});
 if(!items.length)return null;
 const q=words(items);
 const polyType=sameType(items,'polyhaven');
 const polyItems=items.filter(item=>item.polyhaven);
 const poly=polyType?{
  type:polyType,
  category:[...new Set(polyItems.flatMap(item=>item.polyhaven.categories||[]))].join(','),
  q:[...new Set(polyItems.flatMap(item=>String(item.polyhaven.q||'').split(/\s+/)))].filter(Boolean).join(' '),
 }:null;
 const freeType=sameType(items,'freestylized');
 const free=freeType?{type:freeType,q}:null;
 const sketchfab=[...new Set(items.flatMap(item=>item.s||[]))].join(',');
 const art=[...new Set(items.flatMap(item=>item.as||[]))].join(',');
 const plan={
  sketchfab:sketchfab?{category:sketchfab}:null,
  art:art?{category:art}:null,
  polyhaven:poly,
  ambientcg:items.some(item=>item.ambientcg)?{q}:null,
  freestylized:free,
  polypizza:items.some(item=>item.pizza)?{q}:null,
  kenney:items.some(item=>item.kenney)?{q}:null,
 };
 const via=[];
 const push=(site,name)=>{if(name)via.push({site,name});};
 if(plan.sketchfab)push('Sketchfab',items.flatMap(item=>item.s||[]).filter((slug,i,all)=>all.indexOf(slug)===i).join('、'));
 if(plan.art)push('ArtStation','已映射的作品分类');
 if(plan.polyhaven)push('Poly Haven',[TYPE_NAME[plan.polyhaven.type]||plan.polyhaven.type,plan.polyhaven.category||plan.polyhaven.q].filter(Boolean).join(' · '));
 if(plan.ambientcg)push('ambientCG',q);
 if(plan.freestylized)push('FreeStylized',[TYPE_NAME[plan.freestylized.type]||plan.freestylized.type,q].filter(Boolean).join(' · '));
 if(plan.polypizza)push('Poly Pizza',q);
 if(plan.kenney)push('Kenney',q);
 plan.via=via;
 plan.sites=via.map(row=>row.site);
 return plan;
}
export function joinQuery(base,extra){
 const words=[...new Set(`${base||''} ${extra||''}`.toLowerCase().split(/\s+/).filter(Boolean))];
 return words.join(' ').slice(0,200);
}
export const FEED_SITE=SITE_NAME;

export const UNIFIED_SORTS=[
 {value:'relevance',label:'相关度'},
 {value:'newest',label:'最新发布'},
 {value:'popular',label:'最多点赞',as:'popular'},
 {value:'views',label:'最多浏览',as:'ranking'},
 {value:'name',label:'名称'},
];
/** 全部平台的范围按资产类型收，不复用 Sketchfab 的「可下载 / 有动画 / 精选」。空选 = 不限类型。 */
export const ASSET_KINDS=[
 {id:'models',label:'模型',feeds:['search','art','polypizza','ambientcg','simready'],ambientcg:'3d-model,terrain',polyhaven:'models',freestylized:'models'},
 {id:'textures',label:'材质',feeds:['ambientcg'],ambientcg:'material,substance',polyhaven:'textures',freestylized:'textures'},
 {id:'hdris',label:'HDRI',feeds:['ambientcg'],ambientcg:'hdri,hdri-element',polyhaven:'hdris',freestylized:'skybox'},
 {id:'packs',label:'资源包',feeds:['kenney'],polyhaven:'',freestylized:'packs'},
];
export function kindAllows(kinds,mode,type){
 const picked=Array.isArray(kinds)?kinds.filter(Boolean):[];
 if(!picked.length)return true;
 const rows=ASSET_KINDS.filter(item=>picked.includes(item.id));
 if(mode==='polyhaven')return rows.some(item=>item.polyhaven&&item.polyhaven===(type||'models'));
 if(mode==='freestylized')return rows.some(item=>item.freestylized===type);
 return rows.some(item=>item.feeds.includes(mode));
}
/** 没选题材时，范围里恰好一种 Poly Haven / FreeStylized 类型才锁定；多种就留给调用方跳过。 */
export function kindType(kinds,field){
 const picked=ASSET_KINDS.filter(item=>(kinds||[]).includes(item.id)&&item[field]);
 const types=[...new Set(picked.map(item=>item[field]))];
 if(field==='ambientcg')return types.join(',');
 return types.length===1?types[0]:'';
}
