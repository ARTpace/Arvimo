// Platform registry for the unified discovery search.
//
// One search box serves every platform. Everything that differs per platform — the picker label,
// the input placeholder, the suggestion words, which result feeds answer, and which filter row it
// owns — lives here, so app.js never grows an if/else chain when a platform is added.

export const ALL='all';

// Result-feed registry. A platform only names feeds; anything that has to *do* something per feed
// (which endpoint it hits, what it is called in the status line, that its skeleton exists in state)
// is looked up here instead of being an if/else somewhere in app.js.
export const FEEDS=['search','art','web','polyhaven','ambientcg','polypizza','kenney','freestylized','polyfork'];
export const FEED_LABELS={search:'Sketchfab',art:'ArtStation',web:'链接解析',polyhaven:'Poly Haven',ambientcg:'ambientCG',polypizza:'Poly Pizza',kenney:'Kenney',freestylized:'FreeStylized',polyfork:'Polyfork'};
export const FEED_ENDPOINTS={search:'/api/search',art:'/api/artstation/search',web:'/api/scan',polyhaven:'/api/polyhaven/search',ambientcg:'/api/ambientcg/search',polypizza:'/api/polypizza/search',kenney:'/api/kenney/search',freestylized:'/api/freestylized/search',polyfork:'/api/polyfork/search'};
export const feedEndpoint=mode=>FEED_ENDPOINTS[mode]||FEED_ENDPOINTS.web;
export const feedLabel=mode=>FEED_LABELS[mode]||mode;

// 图站（素材下载器整合）注册表：只存「粘贴链接能命中谁」。每加一个艺术/设计类图站，
// 在这里加一条 + 在 server/picture-sites.mjs 的 PICTURE_SITES 加同 id 的 resolve 实现即可，
// 前端不再出现 if/else 长链。URL 解析、下载队列、本地图片库全部复用既有链路。
export const PICTURE_SITES=Object.freeze({
  pixiv:{id:'pixiv',label:'Pixiv',tag:'二次元插画',group:'插画 · 动漫',hosts:['pixiv.net','www.pixiv.net'],example:'https://www.pixiv.net/artworks/151233234',hint:'作品页或画师主页（users/xxx），整站作品全抓'},
  safebooru:{id:'safebooru',label:'Safebooru',tag:'动漫图库',group:'插画 · 动漫',hosts:['safebooru.org','www.safebooru.org','cdn.safebooru.org'],example:'https://safebooru.org/index.php?page=post&s=list&tags=landscape',search:true,hint:'输入标签搜索（空格分隔多个标签），或粘标签列表页；单次最多 1000 张'},
  yandere:{id:'yandere',label:'Yande.re',tag:'动漫壁纸',group:'插画 · 动漫',hosts:['yande.re','www.yande.re','files.yande.re','assets.yande.re'],example:'https://yande.re/post?tags=touhou',search:true,hint:'输入标签搜索，或粘标签页；部分网络会被站方 WAF 拦截'},
  konachan:{id:'konachan',label:'Konachan',tag:'动漫壁纸',group:'插画 · 动漫',hosts:['konachan.net','www.konachan.net','konachan.com'],example:'https://konachan.net/post?tags=landscape',search:true,hint:'输入标签搜索；请走 konachan.net（.com 有 Cloudflare 挑战）'},
  wallhaven:{id:'wallhaven',label:'Wallhaven',tag:'高清壁纸',group:'壁纸',hosts:['wallhaven.cc','www.wallhaven.cc','w.wallhaven.cc'],example:'https://wallhaven.cc/search?q=nature',search:true,hint:'输入关键词搜索（支持 city night 多词），或粘搜索页 / 标签页'},
  civitai:{id:'civitai',label:'Civitai',tag:'AI 绘图',group:'AI 图库',hosts:['civitai.com','www.civitai.com','image.civitai.com'],example:'https://civitai.com/',hint:'公开图库接口，最多 1000 张'},
  zcool:{id:'zcool',label:'站酷 ZCOOL',tag:'国内设计',group:'设计灵感',hosts:['zcool.com.cn','www.zcool.com.cn'],example:'https://www.zcool.com.cn/u/ZNjMyMjY0MDg=',hint:'粘作品页（/work/…）、创作者主页（/u/…）或频道页（/discover/…），会自动带出作者，点作者名看他的作品'},
  designspiration:{id:'designspiration',label:'Designspiration',tag:'设计灵感',group:'设计灵感',hosts:['designspiration.com','www.designspiration.com'],example:'https://www.designspiration.com/',hint:'缩略图自动升级到 736px'},
  huaban:{id:'huaban',label:'花瓣 Huaban',tag:'灵感采集',group:'设计灵感',hosts:['huaban.com','www.huaban.com'],example:'https://huaban.com/boards/102664553',search:true,hint:'直接输入关键词搜索，或粘作者主页（/user/用户名）看全部画板、画板页（/boards/数字）'},
  pinterest:{id:'pinterest',label:'Pinterest',tag:'灵感画板',group:'设计灵感',hosts:['pinterest.com','www.pinterest.com','pin.it'],example:'https://www.pinterest.com/search/pins/?q=nature',search:true,hint:'粘画板 / 作者 / 搜索页 / 直链，或直接输入关键词搜索'},
  pexels:{id:'pexels',label:'Pexels',tag:'免费摄影',group:'摄影图库',hosts:['pexels.com','www.pexels.com','images.pexels.com'],example:'https://www.pexels.com/photo/4161958/',search:true,hint:'直接输入关键词搜索，或粘摄影师主页（/@名字-数字）、单张作品页'},
  flickr:{id:'flickr',label:'Flickr',tag:'摄影社区',group:'摄影图库',hosts:['flickr.com','www.flickr.com','live.staticflickr.com','flic.kr'],example:'https://www.flickr.com/photos/nasa/',search:true,hint:'直接输入关键词搜索，或粘摄影师主页 / 相册页 / 单张作品页'},
  '500px':{id:'500px',label:'500px',tag:'高端摄影',group:'摄影图库',hosts:['500px.com','www.500px.com'],example:'https://500px.com/kellan',hint:'粘摄影师主页（500px.com/用户名）或作品页（/photo/编号）；关键词搜索站点没开放'},
  // 后续艺术/设计类图站按同构签名在此追加（ArtStation 已走 IMAGE_SOURCES，不重复登记）
});
/** 图站分组顺序与一句话简介；组名写在每条 PICTURE_SITES 的 group 上，这里只定展示次序，避免两处清单打架。 */
export const PICTURE_GROUP_ORDER=['插画 · 动漫','壁纸','摄影图库','AI 图库','设计灵感','其他'];
const PICTURE_GROUP_NOTES={
 '插画 · 动漫':'二次元插画、角色图集与同人作品',
 '壁纸':'高清 / 4K 壁纸与摄影背景',
 '摄影图库':'专业摄影社区与免版权高清图库',
 'AI 图库':'AI 生图作品与模型出图，可直接当参考',
 '设计灵感':'平面、UI 与作品集类灵感采集',
};
/** 按 group 派生分组清单（空组自动丢弃），设置页与任何列表都读它，不再手写第二份。 */
export const PICTURE_SITE_GROUPS=PICTURE_GROUP_ORDER
  .map(name=>({name,note:PICTURE_GROUP_NOTES[name]||'',sites:Object.values(PICTURE_SITES).filter(site=>(site.group||'其他')===name)}))
  .filter(group=>group.sites.length);
/** 由 PICTURE_SITES 自动派生链接路由，避免手写 host 列表与注册表脱节。支持子域名（如站酷 username.zcool.com.cn）。 */
export const PICTURE_LINK_ROUTES=Object.values(PICTURE_SITES).map(s=>({id:s.id,platform:s.id,label:s.label,test:url=>{const h=url.hostname.toLowerCase();return s.hosts.some(x=>h===x||h.endsWith('.'+x));}}));
/** 给定链接返回命中的图站 id，否则 null（交给通用网页解析）。 */
export const pictureSiteFromUrl=url=>{
  try{const host=new URL(String(url)).hostname.toLowerCase();const hit=Object.values(PICTURE_SITES).find(s=>s.hosts.includes(host));return hit?hit.id:null;}catch{return null;}
};
export const isPictureSite=id=>Boolean(PICTURE_SITES[id]);
/** 图站下载任务的稳定 uid：必须是 32 位十六进制（服务端 uidPattern 校验）。 */
export function pictureSiteJobUid(platform,url){
  let h1=0x12345678,h2=0x9abcdef0;const s=`${platform}:${url}`;
  for(let i=0;i<s.length;i++){h1=Math.imul(h1^s.charCodeAt(i),2654435761)>>>0;h2=(h2+((h1>>>13)^i))>>>0;}
  let hex=(h1>>>0).toString(16).padStart(8,'0')+(h2>>>0).toString(16).padStart(8,'0');
  for(let i=0;i<16;i++){h1=Math.imul(h1^(h1>>>7),2246822519)>>>0;hex+=(h1&0xf).toString(16);h1>>>=4;}
  return hex.slice(0,32);
}

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
 polyfork:'Polyfork 的程序化低模（参数可调，商用免署名）',
};

export const PLATFORMS=[
 {
  id:ALL,
  label:'全部平台',
  hint:'按统一题材同时检索各站能对上的资产',
  feeds:['search','art','polyhaven','ambientcg','polypizza','kenney','freestylized','polyfork'],
  placeholder:'搜索关键词或粘贴链接，例如 character、robot、props',
  suggestions:[['character','角色'],['robot','机器人'],['props','道具'],['weapon','武器'],['architecture','建筑']],
  // 全部平台只有一棵统一树：两平台共用一套分类 / 排序 / 范围，组头一键筛整组、叶子标注覆盖面。
  filters:['filters-merged'],
  note:'选中题材后，树下会写出这一轮会去哪些站。对不上的站不搜。',
 },
 {
  id:'sketchfab',
  description:'创作者分享的 3D 模型库，适合寻找角色、道具、建筑与动画资源。',
  label:'Sketchfab',
  hint:'官方公开模型库 · 支持动画与筛选',
  feeds:['search'],
  placeholder:'搜索 Sketchfab，或粘贴模型 / 作者 / 合集链接',
  suggestions:[['robot','机器人'],['car','汽车'],['architecture','建筑'],['sci fi','科幻'],['furniture','家具']],
  filters:'filters-sketchfab',
 },
 {
  id:'artstation',
  description:'艺术家作品与设计参考，支持浏览作品图片及 Marmoset 3D 场景。',
  label:'ArtStation',
  hint:'Marmoset 3D 场景，或全部作品作参考图',
  feeds:['art'],
  placeholder:'搜索 ArtStation 作品，或粘贴作品链接',
  suggestions:[['character','角色'],['props','道具'],['weapon','武器'],['game asset','游戏资产'],['concept art','概念设计']],
  filters:'filters-artstation',
 },
 {
  id:'polyhaven',
  description:'CC0 模型、PBR 材质与 HDRI 环境光，适合写实场景制作。',
  label:'Poly Haven',
  hint:'CC0 永久免费 · 模型 + 贴图 + 环境光',
  feeds:['polyhaven'],
  placeholder:'搜索 Poly Haven 的 CC0 模型、材质或 HDRI',
  suggestions:[['chair','椅子'],['rock','岩石'],['wood','木纹'],['brick','砖'],['concrete','混凝土']],
  filters:'filters-polyhaven',
 },
 {
  id:'ambientcg',
  description:'以 CC0 材质为主的资源库，涵盖环境、模型、地形及 Substance 资源。',
  label:'ambientCG',
  hint:'CC0 材质、环境、Substance、模型与地形',
  feeds:['ambientcg'],
  placeholder:'搜索 ambientCG 资产，例如 sky、brick、apple',
  suggestions:[['sand','沙地'],['brick','砖墙'],['wood','木纹'],['metal','金属'],['concrete','混凝土']],
  filters:'filters-ambientcg',
 },
 {
  id:'polypizza',
  description:'轻量低多边形 3D 模型，适合游戏原型与场景搭建，可按许可筛选。',
  label:'Poly Pizza',
  hint:'公开 glTF 模型 · 可筛 CC0',
  feeds:['polypizza'],
  placeholder:'搜索 Poly Pizza，例如 chair、tree、car',
  suggestions:[['chair','椅子'],['tree','树'],['car','汽车'],['character','角色'],['rock','岩石']],
  filters:'filters-polypizza',
 },
 {
  id:'kenney',
  description:'CC0 游戏资源包，按主题与系列收集模型，适合快速搭建游戏原型。',
  label:'Kenney',
  hint:'CC0 游戏资源包 · 按系列筛选',
  feeds:['kenney'],
  placeholder:'搜索 Kenney 资源包，例如 city、platformer',
  suggestions:[['city','城市'],['platformer','平台跳跃'],['space','太空'],['furniture','家具'],['racing','赛车']],
  filters:'filters-kenney',
 },
 {
  id:'freestylized',
  description:'风格化模型、材质、天空盒与资源包，适合卡通场景及游戏制作。',
  label:'FreeStylized',
  hint:'风格化模型、天空盒、材质和资源包',
  feeds:['freestylized'],
  placeholder:'搜索 FreeStylized，例如 crate、sky、wood',
  suggestions:[['crate','木箱'],['sky','天空'],['wood','木纹'],['weapon','武器'],['medieval','中世纪']],
  filters:'filters-freestylized',
 },
 {
  id:'polyfork',
  description:'程序化低模库：每个资产由参数生成，可调配色与比例；低模全站免费，商用免署名。',
  label:'Polyfork',
  hint:'程序化低模 · 全站免费 · 直出 GLB / FBX',
  feeds:['polyfork'],
  placeholder:'搜索 Polyfork，例如 windmill、crate、character',
  suggestions:[['windmill','风车'],['crate','木箱'],['character','角色'],['tree','树'],['house','房屋']],
  filters:'filters-polyfork',
 },
];

/** 设置页卡片第二行的短标签（比 description 短，一行放得下）。 */
export const PLATFORM_TAG={
 sketchfab:'3D 模型库',
 artstation:'3D 场景 + 作品图',
 polyhaven:'CC0 材质 / HDRI',
 ambientcg:'CC0 材质库',
 polypizza:'低多边形模型',
 kenney:'3D + 2D 素材',
 freestylized:'风格化资源',
 polyfork:'程序化低模',
};
/**
 * 每个平台能给出的内容：model = 可下载 / 转 3D 的资产，image = 图片。
 * 「模型 / 图片」两个模式键靠它决定下拉里该列谁 —— 图片模式下模型平台整条不出现，
 * 模型模式下图站也不出现。ArtStation / Poly Haven / ambientCG / Kenney 两边都算。
 */
export const PLATFORM_KINDS={
 sketchfab:['model'],
 artstation:['model','image'],
 polyhaven:['model','image'],
 ambientcg:['model','image'],
 polypizza:['model'],
 kenney:['model','image'],
 freestylized:['model'],
 polyfork:['model'],
};
export const platformKinds=id=>PLATFORM_KINDS[id]||['model'];
/** 平台官网：设置页每张卡片的「官网」跳转目标，与 PLATFORMS 的 id 一一对应。 */
export const PLATFORM_HOME={
 sketchfab:'https://sketchfab.com',
 artstation:'https://www.artstation.com',
 polyhaven:'https://polyhaven.com',
 ambientcg:'https://ambientcg.com',
 polypizza:'https://poly.pizza',
 kenney:'https://kenney.nl',
 freestylized:'https://freestylized.com',
 polyfork:'https://polyfork.dev',
};
/**
 * 「既能出 3D 又能出图」的平台：3D 分组里已经有一张卡，图站区再列一张镜像卡（tag 换成图片视角），
 * 让找参考图的人不用先判断「这个平台算不算图站」。两处共用同一个 platform id，切换任意一边立即同步。
 * Civitai 暂不反向列进 3D 分组 —— AV 目前只有它的图片通道、没有模型下载，列进去会是个点不动的卡。
 */
export const PLATFORM_IMAGE_CAPS=[
 {id:'artstation',tag:'作品图 · 参考图'},
 {id:'polyhaven',tag:'PBR 材质 · HDRI'},
 {id:'ambientcg',tag:'PBR 材质'},
 {id:'kenney',tag:'2D 素材 · 精灵图'},
];

export const DEFAULT_PLATFORM=ALL;
/** 这个图站能不能直接吃关键词（而不是只能粘链接）。
 *  服务端 PICTURE_SITES 上同名 `search:true` 是权威：能搜的站，resolver 必须接受非 URL 输入。 */
export const pictureSiteSearchable=id=>Boolean(PICTURE_SITES[id]?.search);
/** 需要登录态（或过一次人机验证）才放行的站点：这些站显示「登录」按钮。
 *  登录窗口里登录 / 验证完，cookie 自动入库；之后解析走纯 HTTP，不再每次开浏览器。 */
export const PICTURE_LOGIN_SITES=new Set(['zcool','huaban','pinterest','pixiv','civitai','flickr','500px','pexels','designspiration','artstation']);
export const pictureSiteLoginable=id=>PICTURE_LOGIN_SITES.has(String(id||''));

/** 图站作为「平台」时的形状：能否搜索决定占位符与说明行 —— 能搜的站让用户直接打词，
 *  不能搜的站明确告诉他「把页面地址粘进来」，避免在框里打词却一句提示都没有。 */
export const picturePlatformById=id=>{
 const site=PICTURE_SITES[id];
 if(!site)return null;
 return {
  id:site.id,label:site.label,description:site.hint,
  hint:`${site.label} · ${site.search?'关键词搜索 / 粘贴链接':'粘贴链接解析'}`,
  feeds:[],filters:[],suggestions:[],picture:true,search:Boolean(site.search),
  note:site.search
   ?'搜索：直接输入关键词回车；也可以粘作品页 / 作者主页 / 画板页地址。'
   :'按链接解析：把作品页 / 标签页地址粘到搜索框，回车即可。',
  placeholder:site.search
   ?`输入关键词搜索 ${site.label}${site.example?`，或粘贴链接，例如 ${site.example}`:''}`
   :`粘贴 ${site.label} 的作品页 / 标签页链接${site.example?`，例如 ${site.example}`:''}`,
 };
};
/** 图片模式逐站浏览，不提供跨站整合的「全部平台」选项。 */
export const platformsForMode=mode=>{
 const list=PLATFORMS.filter(item=>item.id===ALL?mode!=='image':!mode||platformKinds(item.id).includes(mode));
 if(mode==='image')for(const site of Object.values(PICTURE_SITES))list.push(picturePlatformById(site.id));
 return list;
};
export const platformById=id=>PLATFORMS.find(platform=>platform.id===id)||picturePlatformById(id)||PLATFORMS[0];

/**
 * 卡片上给「来源」用的名字。
 *
 * Sketchfab 的结果不带 `platform` 字段（catalog.mjs 归一化时就不设，历史数据形状如此），
 * 所以缺省即 Sketchfab —— 这个约定以前散落在各处的三元表达式里，其中一处兜底写成了字面量
 * 'Sketchfab'，于是 Poly Haven 的资产（既没有面数也没有点赞数）也顶着 Sketchfab 的名字。
 * 需要「这个来源叫什么」时一律问这里，不认识的平台给中性叫法，绝不冒充别家。
 */
export const platformLabel=id=>PLATFORMS.find(platform=>platform.id===(id||'sketchfab'))?.label||PICTURE_SITES[id]?.label||'3D 资产';

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
  if(set.has('polyfork')&&set.size===1)return 'polyfork';
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
 ...PICTURE_LINK_ROUTES,
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

// 链接解析最终发现 Sketchfab 模型，归入同一个模块。
export const platformForFeed=mode=>({search:'sketchfab',web:'sketchfab',art:'artstation'}[mode]||mode);
export const platformModules=()=>PLATFORMS.filter(item=>item.id!==ALL);
export const enabledPlatform=(settings,id)=>settings[id]!==false;
