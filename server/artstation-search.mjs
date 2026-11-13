// ArtStation search — every Marmoset Viewer project on the platform.
//
// The site's own search module (community/assets/368.*.js) posts
//   {query,page,per_page,sorting,pro_first,filters:[{field,method,value}],additional_fields}
// to /api/v2/search/projects.json. POST hangs behind the site's WAF from here, but the very same
// parameters work over GET, where `filters` is accepted as its JSON-string form.
//
// `asset_types = marmoset` is ArtStation's own "Marmoset Viewer" facet (100k+ projects), so a
// keyword search never has to page through non-3D results hunting for the few embeddable ones.
// The facet list itself comes from `/search/projects/filter_fields.json`, so category options
// stay current instead of being hard-coded here.
import {openPublic} from './public-http.mjs';
import {readStreamText,ARTSTATION_HASH,artstationUid} from './artstation-project.mjs';
import {coverUrl} from './artstation-cdn.mjs';
import {tagList} from './tag-list.mjs';

// Identity lives with the project module (the .mview pipeline needs the same id in its
// info.json for archive provenance checks); re-exported here so search callers keep one import.
export {artstationUid};
// Cover-URL rules (rendition + the square renditions' timestamp folder) live with the CDN paths;
// re-exported so normalizing a search row stays a one-import job for callers.
export {coverUrl};

export const ARTSTATION_SEARCH_ENDPOINT='https://www.artstation.com/api/v2/search/projects.json';
export const ARTSTATION_FILTERS_ENDPOINT='https://www.artstation.com/api/v2/search/projects/filter_fields.json';
export const ARTSTATION_PER_PAGE=48;
export const ARTSTATION_PER_PAGE_MAX=75;
export const ARTSTATION_MAX_PAGE=400;
// Sorting enum from the site's search module. A map (not a list) so only values the API
// understands can ever be sent, and labels stay with the values they belong to.
export const ARTSTATION_SORTS=Object.freeze({relevance:'relevance',popular:'likes',newest:'date',ranking:'rank'});
const SORT_LABELS=Object.freeze({relevance:'相关度',popular:'最多点赞',newest:'最新发布',ranking:'热门排行'});
/** 资产类型分面。`marmoset` 是本工作台唯一能转成 3D 的那一类；留空 = 不限类型（全站作品）。 */
export const ARTSTATION_ASSET_TYPE_DEFAULT='marmoset';
// 分面取值只做形状校验：真正的选项清单由 ArtStation 的 filter_fields.json 提供，不写死在代码里。
// 这条正则同时是注入边界——分页游标里的 asset_types 必须落在它允许的形状内。
const ASSET_TYPE_VALUE=/^[a-z0-9_]{1,32}$/;
const MAX_BODY=6*1024*1024;

export function artstationSortOptions(){
  return Object.keys(ARTSTATION_SORTS).map(value=>({value,label:SORT_LABELS[value]||value}));
}

export function artSearchParams(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('搜索参数格式无效');
  const q=input.q??'';
  if(typeof q!=='string'||q.length>200)throw Error('关键词请控制在 200 字以内');
  if(input.sort!==undefined&&!Object.hasOwn(ARTSTATION_SORTS,input.sort))throw Error('不支持的排序方式');
  const category=input.category===undefined||input.category===null?'':String(input.category);
  // 统一筛选树（模型模式）会把一个主题映射成多个 A 站分类，用逗号分隔传进来。
  if(category&&!/^\d{1,6}(,\d{1,6})*$/.test(category))throw Error('不支持的分类');
  if(input.picked!==undefined&&typeof input.picked!=='boolean')throw Error('精选筛选必须是布尔值');
  // 空串表示"全部作品"——这时不带 asset_types 分面，关键词会命中 2D 插画等无法转 3D 的作品。
  const assetType=input.assetType===undefined||input.assetType===null?ARTSTATION_ASSET_TYPE_DEFAULT:String(input.assetType);
  if(assetType&&!ASSET_TYPE_VALUE.test(assetType))throw Error('不支持的资产类型');
  // 浏览态（没关键词、没分类、排序与精选都停在默认、资产类型也是默认分面）= 用户什么都没要求：
  // 给「编辑精选 + 最新发布」，让默认列表跟着平台更新，而不是一份固定的历史榜单。
  // 判据一律看「值」而不是「字段有没有传」—— 前端每次都会把控件现值一并送来（排序 relevance、
  // 精选 false、类型 marmoset），按缺字段判的话浏览态永远不会生效。
  const browsing=!q.trim()&&!category
    &&(input.sort===undefined||input.sort==='relevance')
    &&(input.picked===undefined||input.picked===false)
    &&(!assetType||assetType===ARTSTATION_ASSET_TYPE_DEFAULT);
  // 浏览态要真的覆盖掉控件上的默认值（前端送来的 sort 是 'relevance'，那是真值，
  // 不能写 input.sort||… 否则浏览态永远排不到前面）。
  return {q:q.trim(),sort:browsing?'newest':input.sort||'relevance',category,picked:input.picked===true||browsing,assetType};
}

export function buildSearchUrl(params,page=1){
  const filters=[];
  if(params.assetType)filters.push({field:'asset_types',method:'include',value:[params.assetType]});
  if(params.category)filters.push({field:'category_ids',method:'include',value:params.category.split(',').map(Number)});
  if(params.picked)filters.push({field:'editor_pick',method:'equal',value:[true]});
  const u=new URL(ARTSTATION_SEARCH_ENDPOINT);
  u.searchParams.set('query',params.q);
  u.searchParams.set('page',String(Math.max(1,Math.min(ARTSTATION_MAX_PAGE,Number(page)||1))));
  u.searchParams.set('per_page',String(ARTSTATION_PER_PAGE));
  u.searchParams.set('sorting',ARTSTATION_SORTS[params.sort]||'relevance');
  u.searchParams.set('filters',JSON.stringify(filters));
  return u.href;
}

/** 允许出现在分页游标里的筛选条件：字段 → 唯一合法的方法。 */
const CURSOR_FILTERS=new Map([['asset_types','include'],['category_ids','include'],['editor_pick','equal']]);

/**
 * Pagination is a full API URL; replay only ours, and only filter shapes we understand.
 *
 * 不再强制保留 Marmoset 分面（搜索已支持全站作品），但每一项筛选都要能对上白名单——
 * 否则游标等于把 ArtStation 的查询语言原样透传给调用方。
 */
export function validateCursor(cursor){
  let u;
  try{u=new URL(String(cursor||''));}catch{throw Error('无效的搜索分页地址');}
  if(u.protocol!=='https:'||u.hostname!=='www.artstation.com'||u.pathname!==new URL(ARTSTATION_SEARCH_ENDPOINT).pathname)throw Error('无效的搜索分页地址');
  let filters;
  try{filters=JSON.parse(u.searchParams.get('filters')||'[]');}catch{throw Error('无效的搜索筛选条件');}
  if(!Array.isArray(filters))throw Error('无效的搜索筛选条件');
  for(const f of filters){
    const method=CURSOR_FILTERS.get(f?.field);
    if(!method||f.method!==method)throw Error('分页请求包含不支持的筛选条件');
    if(!Array.isArray(f.value)||!f.value.length||f.value.length>64)throw Error('无效的筛选取值');
    if(f.field==='asset_types'&&!f.value.every(v=>ASSET_TYPE_VALUE.test(String(v))))throw Error('无效的资产类型');
    if(f.field==='category_ids'&&!f.value.every(v=>/^\d{1,6}$/.test(String(v))))throw Error('无效的分类取值');
    if(f.field==='editor_pick'&&!f.value.every(v=>typeof v==='boolean'))throw Error('无效的精选取值');
  }
  const page=Number(u.searchParams.get('page')),perPage=Number(u.searchParams.get('per_page'));
  if(!Number.isInteger(page)||page<1||page>ARTSTATION_MAX_PAGE)throw Error('无效的搜索页码');
  if(!Number.isInteger(perPage)||perPage<1||perPage>ARTSTATION_PER_PAGE_MAX)throw Error('无效的分页大小');
  return u.href;
}

/** ArtStation 返回的标题/作者名是 HTML 转义过的（`Love,Deaths &amp; Robots`）。
 *  不解码的话，卡片和任务名里会一直挂着 `&amp;`——它已经是我们拿到的最终文本，
 *  不会再经过一层浏览器解析，所以必须在这里还原。 */
const HTML_ENTITIES=Object.freeze({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',mdash:'—',ndash:'–',rsquo:'’',lsquo:'‘'});
export function decodeEntities(text){
  return String(text??'').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(match,name)=>{
    const key=name.toLowerCase();
    if(Object.hasOwn(HTML_ENTITIES,key))return HTML_ENTITIES[key];
    if(key.startsWith('#')){
      const code=key.startsWith('#x')?parseInt(key.slice(2),16):Number(key.slice(1));
      if(Number.isFinite(code)&&code>0&&code<=0x10ffff)return String.fromCodePoint(code);
    }
    return match;
  });
}

/** Adult-flagged projects and rows without a usable hash are not exportable, so skip them. */
export function isSearchableProject(project){
  return !!project&&typeof project==='object'&&project.is_adult_content!==true&&project.hide_as_adult!==true&&ARTSTATION_HASH.test(String(project.hash_id||'').trim());
}

export function normalizeArtstationProject(project){
  if(!isSearchableProject(project))return null;
  const hash=String(project.hash_id).trim();
  const artworkUrl=`https://www.artstation.com/artwork/${hash}`;
  return {
    uid:artstationUid(hash),platform:'artstation',artId:hash,
    name:decodeEntities(String(project.title||'').trim()).slice(0,240)||`ArtStation 作品 ${hash}`,
    author:decodeEntities(String(project.user?.full_name||project.user?.username||'未知作者')).slice(0,100),
    username:String(project.user?.username||''),
    thumbnail:coverUrl(project.smaller_square_cover_url),
    url:artworkUrl,artworkUrl,
    vertices:null,faces:null,likes:0,views:0,animations:0,
    // 只有内嵌 Marmoset Viewer 的作品能转成 GLB；搜索放开到全站之后，卡片必须能分辨
    // 「可转 3D」和「只是图片」，否则用户会以为点下载就能拿到模型。
    hasMarmoset:project.icons?.marmoset===true,
    downloadable:false,license:'ArtStation 作品 · 需确认授权',
    categories:[],tags:tagList(project.tags),publishedAt:null,
  };
}

function nextPageUrl(url,page){
  const next=new URL(url);
  next.searchParams.set('page',String(page+1));
  return next.href;
}

/** Keyword/category search limited to Marmoset Viewer projects. `{cursor}` continues paging. */
export async function artstationSearch(input,{signal,open=openPublic}={}){
  const url=input?.cursor?validateCursor(input.cursor):buildSearchUrl(artSearchParams(input),1);
  signal?.throwIfAborted();
  const r=await open(url,{artstation:true,signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`ArtStation 搜索返回 HTTP ${r.status}`);}
  let payload;
  try{payload=JSON.parse(await readStreamText(r,MAX_BODY));}
  catch{throw Error('ArtStation 搜索返回的不是有效 JSON');}
  const items=Array.isArray(payload?.data)?payload.data:[];
  const models=items.map(normalizeArtstationProject).filter(Boolean);
  const skipped=items.length-models.length;
  const u=new URL(url);
  const page=Number(u.searchParams.get('page'))||1;
  const perPage=Number(u.searchParams.get('per_page'))||ARTSTATION_PER_PAGE;
  const total=Number(payload?.total_count)||0;
  const reachable=Math.min(total,ARTSTATION_MAX_PAGE*perPage);
  // 这一页实际带的是哪个资产类型分面——来源标签要如实反映，否则"搜全站"却写着 Marmoset 会误导。
  const requestedAssetType=(()=>{
    try{
      const f=JSON.parse(u.searchParams.get('filters')||'[]');
      return String(f.find(x=>x?.field==='asset_types')?.value?.[0]||'');
    }catch{return ARTSTATION_ASSET_TYPE_DEFAULT;}
  })();
  const warnings=[];
  if(skipped)warnings.push(`本页 ${skipped} 个作品标记为成人内容或缺少作品标识，已跳过。`);
  const imageOnly=models.reduce((n,m)=>n+(m.hasMarmoset?0:1),0);
  if(imageOnly)warnings.push(`本页 ${imageOnly} 个作品没有内嵌 Marmoset 场景，下载得到的是作品图片而不是 3D 模型。`);
  return {
    models,received:items.length,total,page,perPage,
    next:models.length&&page*perPage<reachable?nextPageUrl(url,page):null,
    pending:[],
    source:requestedAssetType==='marmoset'?'ArtStation · Marmoset Viewer'
      :requestedAssetType?`ArtStation · ${requestedAssetType}`
      :'ArtStation · 全部作品',
    assetType:requestedAssetType,warnings,
  };
}

let optionsCache=null;
export function resetArtstationFilterCache(){optionsCache=null;}

/** Category options for the search UI, cached: ArtStation owns the list, we only relay it. */
export async function artstationFilterOptions({signal,open=openPublic,refresh=false,ttl=6*60*60*1000,now=Date.now()}={}){
  if(!refresh&&optionsCache&&now-optionsCache.at<ttl)return optionsCache.value;
  const r=await open(ARTSTATION_FILTERS_ENDPOINT,{artstation:true,signal,timeout:30000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`ArtStation 筛选字段返回 HTTP ${r.status}`);}
  let fields;
  try{fields=JSON.parse(await readStreamText(r,2*1024*1024));}
  catch{throw Error('ArtStation 筛选字段不是有效 JSON');}
  const list=Array.isArray(fields)?fields:[];
  const option=name=>(list.find(f=>f?.name===name)?.select_options||[]);
  const value={
    categories:option('category_ids').map(o=>({value:String(o.id),label:String(o.name)})).filter(o=>/^\d{1,6}$/.test(o.value)&&o.label),
    sorts:artstationSortOptions(),
    // 资产类型分面：UI 用它填充下拉（另外自带一个空值的"全部作品"选项）。
    assetTypes:option('asset_types').map(o=>({value:String(o.id),label:String(o.name)})).filter(o=>ASSET_TYPE_VALUE.test(o.value)&&o.label),
  };
  optionsCache={at:now,value};
  return value;
}
