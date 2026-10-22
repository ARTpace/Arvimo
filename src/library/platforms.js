// Platform registry for the unified discovery search.
//
// One search box serves every platform. Everything that differs per platform — the picker label,
// the input placeholder, the suggestion words, which result feeds answer, and which filter row it
// owns — lives here, so app.js never grows an if/else chain when a platform is added.

export const ALL='all';

// Result-feed registry. A platform only names feeds; anything that has to *do* something per feed
// (which endpoint it hits, what it is called in the status line, that its skeleton exists in state)
// is looked up here instead of being an if/else somewhere in app.js.
export const FEEDS=['search','art','web','polyhaven','ambientcg','polypizza','kenney','freestylized'];
export const FEED_LABELS={search:'Sketchfab',art:'ArtStation',web:'链接解析',polyhaven:'Poly Haven',ambientcg:'ambientCG',polypizza:'Poly Pizza',kenney:'Kenney',freestylized:'FreeStylized'};
export const FEED_ENDPOINTS={search:'/api/search',art:'/api/artstation/search',web:'/api/scan',polyhaven:'/api/polyhaven/search',ambientcg:'/api/ambientcg/search',polypizza:'/api/polypizza/search',kenney:'/api/kenney/search',freestylized:'/api/freestylized/search'};
export const feedEndpoint=mode=>FEED_ENDPOINTS[mode]||FEED_ENDPOINTS.web;
export const feedLabel=mode=>FEED_LABELS[mode]||mode;

// What the subtitle calls a platform that has not answered yet. Per-platform copy lives with the
// platform instead of being a ternary inside the view.
export const ORIGIN_COPY={
 sketchfab:'Sketchfab 的公开资产',
 artstation:'ArtStation 的 Marmoset Viewer 公开作品',
 polyhaven:'Poly Haven 的 CC0 资产',
 ambientcg:'ambientCG 的 CC0 材质、环境与模型',
 polypizza:'Poly Pizza 的公开模型',
 kenney:'Kenney 的 CC0 资源包',
 freestylized:'FreeStylized 的风格化模型、天空盒和材质',
};

export const PLATFORMS=[
 {
  id:ALL,
  label:'全部平台',
  hint:'按统一题材同时检索各站能对上的资产',
  feeds:['search','art','polyhaven','ambientcg','polypizza','kenney','freestylized'],
  placeholder:'搜索关键词或粘贴链接，例如 character、robot、props',
  suggestions:[['character','角色'],['robot','机器人'],['props','道具'],['weapon','武器'],['architecture','建筑']],
  // 全部平台只有一棵统一树：两平台共用一套分类 / 排序 / 范围，组头一键筛整组、叶子标注覆盖面。
  filters:['filters-merged'],
  note:'选中题材后，树下会写出这一轮会去哪些站。对不上的站不搜。',
 },
 {
  id:'sketchfab',
  label:'Sketchfab',
  hint:'官方公开模型库 · 支持动画与筛选',
  feeds:['search'],
  placeholder:'搜索 Sketchfab，或粘贴模型 / 作者 / 合集链接',
  suggestions:[['robot','机器人'],['car','汽车'],['architecture','建筑'],['sci fi','科幻'],['furniture','家具']],
  filters:'filters-sketchfab',
 },
 {
  id:'artstation',
  label:'ArtStation',
  hint:'Marmoset 3D 场景，或全部作品作参考图',
  feeds:['art'],
  placeholder:'搜索 ArtStation 作品，或粘贴作品链接',
  suggestions:[['character','角色'],['props','道具'],['weapon','武器'],['game asset','游戏资产'],['concept art','概念设计']],
  filters:'filters-artstation',
 },
 {
  id:'polyhaven',
  label:'Poly Haven',
  hint:'CC0 永久免费 · 模型 + 贴图 + 环境光',
  feeds:['polyhaven'],
  placeholder:'搜索 Poly Haven 的 CC0 模型、材质或 HDRI',
  suggestions:[['chair','椅子'],['rock','岩石'],['wood','木纹'],['brick','砖'],['concrete','混凝土']],
  filters:'filters-polyhaven',
 },
 {
  id:'ambientcg',
  label:'ambientCG',
  hint:'CC0 材质、环境、Substance、模型与地形',
  feeds:['ambientcg'],
  placeholder:'搜索 ambientCG 资产，例如 sky、brick、apple',
  suggestions:[['sand','沙地'],['brick','砖墙'],['wood','木纹'],['metal','金属'],['concrete','混凝土']],
  filters:'filters-ambientcg',
 },
 {
  id:'polypizza',
  label:'Poly Pizza',
  hint:'公开 glTF 模型 · 可筛 CC0',
  feeds:['polypizza'],
  placeholder:'搜索 Poly Pizza，例如 chair、tree、car',
  suggestions:[['chair','椅子'],['tree','树'],['car','汽车'],['character','角色'],['rock','岩石']],
  filters:'filters-polypizza',
 },
 {
  id:'kenney',
  label:'Kenney',
  hint:'CC0 游戏资源包 · 按系列筛选',
  feeds:['kenney'],
  placeholder:'搜索 Kenney 资源包，例如 city、platformer',
  suggestions:[['city','城市'],['platformer','平台跳跃'],['space','太空'],['furniture','家具'],['racing','赛车']],
  filters:'filters-kenney',
 },
 {
  id:'freestylized',
  label:'FreeStylized',
  hint:'风格化模型、天空盒、材质和资源包',
  feeds:['freestylized'],
  placeholder:'搜索 FreeStylized，例如 crate、sky、wood',
  suggestions:[['crate','木箱'],['sky','天空'],['wood','木纹'],['weapon','武器'],['medieval','中世纪']],
  filters:'filters-freestylized',
 },
];

export const DEFAULT_PLATFORM=ALL;
export const platformById=id=>PLATFORMS.find(platform=>platform.id===id)||PLATFORMS[0];

/**
 * 卡片上给「来源」用的名字。
 *
 * Sketchfab 的结果不带 `platform` 字段（catalog.mjs 归一化时就不设，历史数据形状如此），
 * 所以缺省即 Sketchfab —— 这个约定以前散落在各处的三元表达式里，其中一处兜底写成了字面量
 * 'Sketchfab'，于是 Poly Haven 的资产（既没有面数也没有点赞数）也顶着 Sketchfab 的名字。
 * 需要「这个来源叫什么」时一律问这里，不认识的平台给中性叫法，绝不冒充别家。
 */
export const platformLabel=id=>PLATFORMS.find(platform=>platform.id===(id||'sketchfab'))?.label||'3D 资产';

/**
 * A *model* download enqueue should carry which `kind`, given the picked models. Returns `null`
 * for a mixed-platform batch so the caller can ask the user to split it — the backend routes by
 * `kind`, and would otherwise mislabel a Poly Haven asset as Sketchfab (its uid is an md5 of the
 * asset id, not a Sketchfab id, so the Sketchfab runner could never find it). One place decides
 * this; adding a platform touches only the branch table above plus this single function.
 */
export const jobKindOf=models=>{
  const set=new Set(models.map(m=>m.platform||'sketchfab').filter(Boolean));
  if(set.has('polyhaven')&&set.size===1)return 'polyhaven';
  if(set.has('polypizza')&&set.size===1)return 'polypizza';
  if(set.has('kenney')&&set.size===1)return 'kenney';
  if(set.has('freestylized')&&set.size===1)return 'freestylized';
  if(set.has('ambientcg')&&set.size===1)return 'ambientcg';
  if(set.has('artstation')&&set.size===1)return 'artstation';
  if(set.size===1)return 'sketchfab';
  return null;
};

const host=(name,suffix)=>name===suffix||name.endsWith(`.${suffix}`);

/**
 * Where a pasted link belongs. Anything unmatched falls through to the generic page reader, which
 * lives on the server and never rejects a URL outright — so a new site only needs a rule here when
 * it wants a *different* handling than "scan the page for model links".
 */
export const LINK_ROUTES=[
 {id:'artstation',platform:'artstation',label:'ArtStation 作品页',test:url=>host(url.hostname,'artstation.com')&&/^\/artwork\//i.test(url.pathname)},
 // 作者页单独分类：用户粘 "https://sketchfab.com/用户名" 想要的是「这个作者的全部模型」，
 // 它在 scanPage 里已经能解析（/v3/models?user=xxx），但笼统叫「Sketchfab 页面」时
 // 结果区只写「链接解析结果」，用户看不出来自己拿到的到底是合集、作者页还是单个模型。
 {id:'sketchfab-user',platform:'web',label:'Sketchfab 作者',test:url=>{
   if(!host(url.hostname,'sketchfab.com'))return false;
   const seg=url.pathname.split('/').filter(Boolean);
   if(seg.length<1||seg.length>2)return false;
   if(['models','collections','features','about','plans','feed','search','3d-models','settings','notifications'].includes(seg[0]))return false;
   return true;
 }},
 {id:'sketchfab',platform:'web',label:'Sketchfab 页面',test:url=>host(url.hostname,'sketchfab.com')},
];

export function routeLink(raw){
 const value=String(raw??'').trim();
 if(!value)return {id:'empty',platform:'web',label:'',url:value,error:'请先粘贴一个链接'};
 let parsed;
 try{parsed=new URL(value);}catch{return {id:'invalid',platform:'web',label:'无法识别',url:value,error:'这不是完整网址，请粘贴含 https:// 的链接'};}
 if(parsed.protocol!=='http:'&&parsed.protocol!=='https:')return {id:'invalid',platform:'web',label:'不支持的协议',url:value,error:'只支持 http / https 链接'};
 const hit=LINK_ROUTES.find(route=>route.test(parsed));
 return hit?{id:hit.id,platform:hit.platform,label:hit.label,url:value}:{id:'web',platform:'web',label:'普通网页',url:value};
}
