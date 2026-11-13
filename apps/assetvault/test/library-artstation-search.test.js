import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTSTATION_PER_PAGE,ARTSTATION_PER_PAGE_MAX,ARTSTATION_MAX_PAGE,ARTSTATION_SORTS,
  artSearchParams,buildSearchUrl,validateCursor,artstationUid,
  isSearchableProject,normalizeArtstationProject,artstationSortOptions,
  artstationSearch,artstationFilterOptions,resetArtstationFilterCache,decodeEntities,
} from '../server/artstation-search.mjs';

const cover='https://cdna.artstation.com/p/assets/covers/images/011/655/236/smaller_square/artvostok-stumb.jpg?1530700342';
const item=(hash,extra={})=>({id:1,hash_id:hash,url:`https://www.artstation.com/artwork/${hash}`,smaller_square_cover_url:cover,hide_as_adult:false,is_adult_content:false,title:'Cyber Dealer',icons:{marmoset:true},user:{id:602014,username:'artvostok',full_name:'ARTVOSTOK STUDIO'},...extra});
function jsonOpen(payload,{status=200}={}){
  const calls=[];
  const open=async(url,opts)=>{calls.push({url,opts});return {status,headers:{},stream:(async function*(){yield Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload),'utf8');})()};};
  return {open,calls};
}

test('artstation-search: parameter validation',()=>{
  // 浏览态（什么都没传）= 编辑精选 + 最新发布，让默认列表跟着平台更新（见 library-daily-featured.test.js）。
  assert.deepEqual(artSearchParams({}),{q:'',sort:'newest',category:'',picked:true,assetType:'marmoset'});
  assert.deepEqual(artSearchParams({q:'  robot  ',sort:'popular',category:'21',picked:true}),{q:'robot',sort:'popular',category:'21',picked:true,assetType:'marmoset'});
  assert.equal(artSearchParams({category:21}).category,'21');
  assert.equal(artSearchParams({assetType:''}).assetType,'','空串表示不限资产类型（全站作品）');
  assert.equal(artSearchParams({assetType:'image'}).assetType,'image');
  assert.throws(()=>artSearchParams({q:'x'.repeat(201)}),/200 字/);
  assert.throws(()=>artSearchParams({sort:'views'}),/排序/);
  assert.throws(()=>artSearchParams({category:'props'}),/分类/);
  assert.throws(()=>artSearchParams({picked:'yes'}),/布尔/);
  assert.throws(()=>artSearchParams({assetType:'marmoset OR 1=1'}),/资产类型/);
  assert.throws(()=>artSearchParams({assetType:'x'.repeat(33)}),/资产类型/);
  assert.throws(()=>artSearchParams([]),/格式/);
});

test('artstation-search: request keeps the server-side Marmoset facet',()=>{
  const u=new URL(buildSearchUrl(artSearchParams({q:'shield'}),1));
  assert.equal(u.origin+u.pathname,'https://www.artstation.com/api/v2/search/projects.json');
  assert.equal(u.searchParams.get('query'),'shield');
  assert.equal(u.searchParams.get('page'),'1');
  assert.equal(u.searchParams.get('per_page'),String(ARTSTATION_PER_PAGE));
  assert.equal(u.searchParams.get('sorting'),'relevance');
  assert.deepEqual(JSON.parse(u.searchParams.get('filters')),[{field:'asset_types',method:'include',value:['marmoset']}]);
});

test('artstation-search: the asset-type facet is optional, and rows say whether they can become 3D',async()=>{
  // 去掉分面 = 全站检索：关键词会命中 2D 插画这类没有 Marmoset 场景、无法转 GLB 的作品。
  const noFacet=new URL(buildSearchUrl(artSearchParams({q:'shield',assetType:''}),1));
  assert.deepEqual(JSON.parse(noFacet.searchParams.get('filters')),[]);
  const pano=new URL(buildSearchUrl(artSearchParams({assetType:'pano'}),1));
  assert.deepEqual(JSON.parse(pano.searchParams.get('filters')),[{field:'asset_types',method:'include',value:['pano']}]);

  // 归一化如实标注"能不能转 3D"：卡片靠它区分可转模型与纯参考图。
  assert.equal(normalizeArtstationProject(item('lEVE8J')).hasMarmoset,true);
  assert.equal(normalizeArtstationProject(item('lEVE8J',{icons:{image:true}})).hasMarmoset,false);
  assert.equal(normalizeArtstationProject(item('lEVE8J',{icons:undefined})).hasMarmoset,false);

  // 来源标签跟着实际分面走——"全站搜索"不能显示成 Marmoset。
  const mixed=await artstationSearch({q:'shield',assetType:''},{open:jsonOpen({total_count:2,data:[item('lEVE8J'),item('xY9zA',{icons:{image:true}})]}).open});
  assert.equal(mixed.source,'ArtStation · 全部作品');
  assert.equal(mixed.assetType,'');
  assert.match(mixed.warnings.join(' '),/1 个作品没有内嵌 Marmoset 场景/);

  const only=await artstationSearch({q:'shield'},{open:jsonOpen({total_count:1,data:[item('lEVE8J')]}).open});
  assert.equal(only.source,'ArtStation · Marmoset Viewer');
  assert.doesNotMatch(only.warnings.join(' '),/没有内嵌 Marmoset/);
});

test('artstation-search: sort, category and picked map onto API values',()=>{
  const filters=params=>JSON.parse(new URL(buildSearchUrl(artSearchParams(params),3)).searchParams.get('filters'));
  assert.equal(new URL(buildSearchUrl(artSearchParams({sort:'popular'}),1)).searchParams.get('sorting'),'likes');
  assert.equal(new URL(buildSearchUrl(artSearchParams({sort:'newest'}),1)).searchParams.get('sorting'),'date');
  assert.equal(new URL(buildSearchUrl(artSearchParams({sort:'ranking'}),1)).searchParams.get('sorting'),'rank');
  assert.deepEqual(filters({category:'21'}).at(-1),{field:'category_ids',method:'include',value:[21]});
  assert.deepEqual(filters({category:'66,65,19'}).at(-1),{field:'category_ids',method:'include',value:[66,65,19]},'统一筛选树会传逗号分隔的多个分类');
  assert.throws(()=>artSearchParams({category:'66,'}),/分类/);
  assert.throws(()=>artSearchParams({category:'66,,65'}),/分类/);
  assert.deepEqual(filters({picked:true}).at(-1),{field:'editor_pick',method:'equal',value:[true]});
  assert.equal(new URL(buildSearchUrl(artSearchParams({}),3)).searchParams.get('page'),'3');
  assert.equal(new URL(buildSearchUrl(artSearchParams({}),9999)).searchParams.get('page'),String(ARTSTATION_MAX_PAGE));
  assert.equal(ARTSTATION_SORTS.relevance,'relevance');
  assert.deepEqual(artstationSortOptions().map(o=>o.value),['relevance','popular','newest','ranking']);
});

test('artstation-search: pagination cursors are restricted to our own filtered search',()=>{
  const good=buildSearchUrl(artSearchParams({q:'robot'}),2);
  assert.equal(validateCursor(good),good);

  // 游标必须仍指向 ArtStation 自己的搜索接口
  assert.throws(()=>validateCursor('https://evil.example.com/api/v2/search/projects.json?page=2&per_page=48'),/分页地址/);
  assert.throws(()=>validateCursor('https://www.artstation.com/projects/abc.json'),/分页地址/);

  // 筛选白名单取代了原先"必须保留 Marmoset 分面"的限制：字段 × method 只认已知组合，
  // 改任何一个都拒——原来那条 replace('include','equal') 的篡改仍然被挡住。
  assert.throws(()=>validateCursor(buildSearchUrl(artSearchParams({}),2).replace('include','equal')),/筛选条件/);

  const cursorWith=(filters,extra={})=>{
    const u=new URL('https://www.artstation.com/api/v2/search/projects.json');
    u.searchParams.set('page',String(extra.page??2));
    u.searchParams.set('per_page',String(extra.perPage??ARTSTATION_PER_PAGE));
    u.searchParams.set('filters',JSON.stringify(filters));
    return u.href;
  };
  const assetTypeFilter=value=>({field:'asset_types',method:'include',value});
  assert.throws(()=>validateCursor(cursorWith([{field:'user_ids',method:'include',value:[1]}])),/筛选条件/);
  assert.throws(()=>validateCursor(cursorWith([{field:'asset_types',method:'equal',value:['marmoset']}])),/筛选条件/);
  assert.throws(()=>validateCursor(cursorWith([assetTypeFilter(['MARMOSET!'])])),/资产类型/);
  assert.throws(()=>validateCursor(cursorWith([assetTypeFilter([])])),/筛选取值/);
  assert.throws(()=>validateCursor(cursorWith([{field:'category_ids',method:'include',value:['props']}])),/分类取值/);
  assert.throws(()=>validateCursor(cursorWith([{field:'editor_pick',method:'equal',value:['yes']}])),/精选取值/);

  // 放开后的正向用例：换个合法资产类型、或不限类型（全站作品），游标照样能回放。
  for(const params of [{assetType:'pano'},{assetType:''},{assetType:'marmoset',category:'21',picked:true}]){
    const url=buildSearchUrl(artSearchParams(params),2);
    assert.equal(validateCursor(url),url);
  }

  assert.throws(()=>validateCursor(cursorWith([assetTypeFilter(['marmoset'])],{page:0})),/页码/);
  assert.throws(()=>validateCursor(`https://www.artstation.com/api/v2/search/projects.json?page=2&per_page=${ARTSTATION_PER_PAGE_MAX+1}&filters=${encodeURIComponent(JSON.stringify([{field:'asset_types',method:'include',value:['marmoset']}]))}`),/分页大小/);
  assert.throws(()=>validateCursor(null),/分页地址/);
});

test('artstation-search: identity is a stable 32-hex id the library already understands',()=>{
  const uid=artstationUid('lEVE8J');
  assert.match(uid,/^[a-f0-9]{32}$/);
  assert.equal(uid,artstationUid('lEVE8J'));
  assert.notEqual(uid,artstationUid('lEVE8K'));
  assert.equal(artstationUid('a'),null);
  assert.equal(artstationUid('bad hash'),null);
  assert.equal(artstationUid(undefined),null);
});

test('artstation-search: normalization drops unusable rows',()=>{
  const model=normalizeArtstationProject(item('lEVE8J'));
  assert.equal(model.platform,'artstation');
  assert.equal(model.artId,'lEVE8J');
  assert.equal(model.uid,artstationUid('lEVE8J'));
  assert.equal(model.name,'Cyber Dealer');
  assert.equal(model.author,'ARTVOSTOK STUDIO');
  assert.equal(model.artworkUrl,'https://www.artstation.com/artwork/lEVE8J');
  assert.equal(model.thumbnail,cover.replace('/smaller_square/','/medium/'));
  // The nested shape (`…/236/20181004021932/smaller_square/…`) must survive normalization too:
  // search rows are the path the grid actually renders. Rules live in library-artstation-cdn.test.js.
  const nested=normalizeArtstationProject(item('lEVE8J',{smaller_square_cover_url:cover.replace('/236/','/236/20181004021932/')}));
  assert.equal(nested.thumbnail,cover.replace('/smaller_square/','/medium/'));
  assert.equal(model.downloadable,false);
  assert.equal(normalizeArtstationProject(item('lEVE8J',{is_adult_content:true})),null);
  assert.equal(normalizeArtstationProject(item('lEVE8J',{hide_as_adult:true})),null);
  assert.equal(normalizeArtstationProject(item('no')),null);
  assert.equal(normalizeArtstationProject({}),null);
  assert.equal(normalizeArtstationProject(null),null);
  assert.equal(isSearchableProject(item('lEVE8J')),true);
  const fallback=normalizeArtstationProject(item('lEVE8J',{title:'  ',user:{username:'anon'}}));
  assert.equal(fallback.name,'ArtStation 作品 lEVE8J');
  assert.equal(fallback.author,'anon');
  // 接口给的是 HTML 转义后的文本，落到卡片与任务名之前必须还原，否则用户会一直看到 &amp;
  const escaped=normalizeArtstationProject(item('lEVE8J',{title:'Love,Deaths &amp; Robots',user:{username:'x',full_name:'A &amp; B'}}));
  assert.equal(escaped.name,'Love,Deaths & Robots');
  assert.equal(escaped.author,'A & B');
});

test('artstation-search: html entities in titles and names are decoded',()=>{
  assert.equal(decodeEntities('&lt;a&gt; &#39;q&#39; &amp; &#x27;x&#x27;'),"<a> 'q' & 'x'");
  assert.equal(decodeEntities('a &nbsp;b'),'a  b');
  assert.equal(decodeEntities('100% plain'),'100% plain');
  assert.equal(decodeEntities('&unknownentity; 5'),'&unknownentity; 5','认不出的实体原样保留');
  assert.equal(decodeEntities(undefined),'');
  assert.equal(decodeEntities(null),'');
  assert.equal(decodeEntities('&#x1F600;'),'😀','十进制/十六进制码点都要支持');
});

test('artstation-search: search returns normalized models and a replayable next page',async()=>{
  const {open,calls}=jsonOpen({total_count:695,data:[item('lEVE8J'),item('no'),item('aB3dE',{is_adult_content:true})]});
  const r=await artstationSearch({q:'robot'},{open});
  assert.equal(calls.length,1);
  assert.equal(calls[0].opts.artstation,true);
  assert.equal(r.source,'ArtStation · Marmoset Viewer');
  assert.equal(r.received,3);
  assert.equal(r.models.length,1);
  assert.equal(r.total,695);
  assert.equal(r.page,1);
  assert.match(r.warnings.join(' '),/2 个作品/);
  assert.equal(r.pending.length,0);
  assert.ok(r.next);
  assert.equal(new URL(r.next).searchParams.get('page'),'2');

  const second=await artstationSearch({cursor:r.next},{open});
  assert.equal(calls.length,2);
  assert.equal(calls[1].url,r.next);
  assert.equal(second.page,2);

  const last=await artstationSearch({cursor:buildSearchUrl(artSearchParams({}),Math.ceil(695/ARTSTATION_PER_PAGE))},{open});
  assert.equal(last.next,null);
});

test('artstation-search: remote failures and bad payloads are reported, not swallowed',async()=>{
  await assert.rejects(artstationSearch({q:''},{open:async()=>({status:403,headers:{},stream:(async function*(){})()})}),/HTTP 403/);
  await assert.rejects(artstationSearch({q:''},{open:jsonOpen('<html>not json</html>').open}),/有效 JSON/);
  const empty=await artstationSearch({q:''},{open:jsonOpen({total_count:0,data:[]}).open});
  assert.deepEqual(empty.models,[]);
  assert.equal(empty.next,null);
});

test('artstation-search: filter fields come from ArtStation and are cached',async()=>{
  resetArtstationFilterCache();
  const fields=[{name:'category_ids',type:'select_multiple',select_options:[{id:21,name:'Props'},{id:'bad',name:'Nope'},{id:11,name:''}]},{name:'asset_types',select_options:[{id:'marmoset',name:'Marmoset Viewer'},{id:'pano',name:'360 Panos'}]}];
  const {open,calls}=jsonOpen(fields);
  const options=await artstationFilterOptions({open,now:1000});
  assert.deepEqual(options.categories,[{value:'21',label:'Props'}]);
  assert.deepEqual(options.assetTypes,[{value:'marmoset',label:'Marmoset Viewer'},{value:'pano',label:'360 Panos'}]);
  assert.equal(options.sorts.length,4);
  const cached=await artstationFilterOptions({open,now:2000});
  assert.equal(calls.length,1);
  assert.equal(cached,options);
  await artstationFilterOptions({open,now:2000,refresh:true});
  assert.equal(calls.length,2);
  assert.equal(calls[0].opts.artstation,true);
  resetArtstationFilterCache();
  await assert.rejects(artstationFilterOptions({open:async()=>({status:500,headers:{},stream:(async function*(){})()})}),/HTTP 500/);
});
