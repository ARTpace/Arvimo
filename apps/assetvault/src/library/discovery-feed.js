import {PICTURE_FIRST_PAGE} from './picture-page.js';
// Starting a discovery request: one feed page, one keyword across every feed, one pasted link.
//
// The three entry points differ only in where the request comes from — a "load more" click, the
// search box, or a pasted URL — and all three end in the same place: a feed is fetched, merged and
// the grid is redrawn. Keeping them together is what stops "search" and "load more" from drifting
// on warnings, cancellation or what counts as having results.

import {feedEndpoint,feedLabel,routeLink,isPictureSite,platformById,pictureSiteSearchable,pictureSiteHome} from './platforms.js';
import {createSearchTranslation} from './search-translation.js';
import {fetchSearchPage,splitSearchTerms} from './multi-search.js';

// 图站两级解析的返回栈：作者主页（画板墙）→ 某块画板（图片）。
// 放在模块级而不是 state 里：它是纯界面导航痕迹，不该被持久化，也不参与卡片签名。
let boardTrail=[];

// 当前这一轮图站解析的序号：后台重抓可能比用户的手快（切平台、切页面都算），
// 回来时若已经不是同一轮，就只把结果写进缓存，不许它改写眼前的画面。
let pictureToken=0;

// 图站结果缓存。解析一次动辄几秒到几十秒（Pinterest 要开无头浏览器、花瓣要翻好几页），
// 切页面 / 切平台 / 刷新浏览器都不该重跑一遍 —— 和模型检索那套 resultCache 同一个思路，
// 区别只在于图站结果要跨刷新存活，所以额外落一份 localStorage（刷新后先铺缓存，再谈要不要重抓）。
const PICTURE_CACHE_MS=10*60*1000;
const PICTURE_CACHE_MAX=16;
const PICTURE_STORE='assetvault-picture-cache-v1';
/** key → {platform,url,data,usedAt}；Map 的插入顺序即最近使用顺序。 */
const pictureCache=new Map();
try{
 const stored=JSON.parse(localStorage.getItem(PICTURE_STORE)||'[]');
 if(Array.isArray(stored))for(const entry of stored){
  if(!entry?.key||!entry?.data)continue;
  pictureCache.set(entry.key,{platform:String(entry.platform||''),url:String(entry.url||''),data:entry.data,usedAt:Number(entry.usedAt)||0});
 }
}catch{}
const pictureKey=(platform,url)=>`${platform}|${url}`;
let pictureStoreTimer=0;
function savePictureCache(platform,url,data){
 const key=pictureKey(platform,url);
 data={...data,fetchedAt:data.fetchedAt||pictureCache.get(key)?.data.fetchedAt||pictureCache.get(key)?.usedAt||Date.now()};
 pictureCache.delete(key);
 pictureCache.set(key,{platform,url,data,usedAt:Date.now()});
 while(pictureCache.size>PICTURE_CACHE_MAX)pictureCache.delete(pictureCache.keys().next().value);
 clearTimeout(pictureStoreTimer);
 // 写盘压一下：连续切平台时不必每次都序列化几万个字符。
 pictureStoreTimer=setTimeout(flushPictureCache,500);
}
function flushPictureCache(){
 clearTimeout(pictureStoreTimer);pictureStoreTimer=0;
  try{localStorage.setItem(PICTURE_STORE,JSON.stringify([...pictureCache.entries()].slice(-4).map(([key,entry])=>{
    const items=(entry.data.items||[]).slice(0,240),clipped=items.length<(entry.data.items||[]).length;
    return {key,...entry,data:{...entry.data,items,limit:Math.min(Number(entry.data.limit)||items.length,240),truncated:entry.data.truncated||clipped,scrollTop:clipped?0:entry.data.scrollTop}};
   })));}
  catch{/* 超配额就当没有持久化，内存缓存仍然生效 */}
}
/** Keep continuation and scroll in the existing bounded cache, never serialize live controllers. */
export function rememberPictureSnapshot(ps){
 if(!ps||(!(ps.items||[]).length&&!(ps.boards||[]).length))return;
 const {controller,moreController,busy,loadingMore,error,status,lastError,retryAt,...data}=ps;
 savePictureCache(ps.platform,ps.url,{...data,busy:false,error:false,status:''});
}
export function cancelPictureRequests(state){
 pictureToken++;
 const ps=state.pictureSite;
 if(!ps)return;
 ps.controller?.abort();ps.moreController?.abort();
 ps.controller=null;ps.moreController=null;ps.loadingMore=false;ps.busy=false;
 if(typeof document!=='undefined')ps.scrollTop=document.getElementById('app-scroll')?.scrollTop||0;
 rememberPictureSnapshot(ps);
}
function restorePictureScroll(ps,state){
 if(!ps?.scrollTop||typeof requestAnimationFrame==='undefined')return;
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  if(state.pictureSite!==ps||state.route!=='discover')return;
  document.getElementById('app-scroll')?.scrollTo({top:ps.scrollTop,behavior:'instant'});
 }));
}
/** 这一屏到底变了没有：只比对会影响画面的字段，避免后台重抓回来把同一批图重绘一遍。 */
const pictureSignature=data=>JSON.stringify([data?.mode,data?.items||[],data?.boards||[],data?.title,data?.author,data?.cover,data?.albums||[],data?.user||null]);
const pictureCacheAge=entry=>Date.now()-(entry?.data.fetchedAt||entry?.usedAt||0);
/** 首帧用：把上次那一屏直接从缓存取出来铺进去，不发任何请求。
 *  刷新页面时结果本来就在 localStorage 里，没道理先空一屏、再等异步把图补回来 ——
 *  那样虽然数据是缓存命中，用户看到的仍然是「图片又加载了一次」。 */
export function restorePictureSnapshot(platform){
 const entry=lastPictureEntry(platform);
 const data=entry?.data;
 if(!data||(!(data.items||[]).length&&!(data.boards||[]).length))return null;
 return {platform,url:entry.url,source:entry.url,...data,busy:false,error:false,status:''};
}
/** 上次看过的那个图站页面：刷新页面 / 切回该站时优先恢复它，而不是重新拉首页推荐。 */
function lastPictureEntry(platform){
 let best=null;
 for(const entry of pictureCache.values())if(entry.platform===platform&&(!best||entry.usedAt>=best.usedAt))best=entry;
 return best;
}

// 搜索条件属于整个发现页；清除时也必须让隐藏平台及在途响应失效。
export function resetDiscoveryFeeds(state){
 cancelPictureRequests(state);
 boardTrail=[];
 for(const f of Object.values(state.feeds)){
  f.controller?.abort();f.token++;f.controller=null;f.busy=false;
  f.rows=[];f.request=null;f.next=null;f.pending=[];f.pages=0;
  f.status='';f.error=false;f.aborted=false;f.warnings=[];f.translation='';f.origin='';
  f.visited.clear();
 }
 state.source='search';state.selected.clear();state.pictureSite=null;
}

export function createDiscoveryFeed(ctx){
 const resultCache=new Map();
 const idleRefreshMs=10*60*1000;
 const cacheKey=(mode,request)=>JSON.stringify([mode,Object.entries(request).sort(([a],[b])=>a.localeCompare(b))]);
 function saveResult(mode,f){
  if(!f.request||f.error||f.aborted)return;
  const key=cacheKey(mode,f.request);
  const {controller,busy,token,...snapshot}=f;
  resultCache.delete(key);
  resultCache.set(key,{snapshot:{...snapshot,visited:new Set(f.visited)},usedAt:Date.now()});
  if(resultCache.size>32)resultCache.delete(resultCache.keys().next().value);
 }
 const translate=createSearchTranslation();
 const {$,toast,state,persist,renderGrid,mergeModels,describeArt,activeModes,showsFeed,searchHistoryUI,resolveArtworkLink,routeTo,readRequest,clearSearchTimer,feedError,markQueryActive,adoptPlatform}=ctx;
 /** 最近检索：同一条记录只留最新一份，写完立刻持久化并刷新浮层。 */
 function remember(entry){
  const key=JSON.stringify(entry);
  state.history=[entry,...state.history.filter(h=>JSON.stringify(h)!==key)].slice(0,12);
  persist();searchHistoryUI()?.refresh();
 }
 /** 链接解析的记录靠 URL 复现，所以 name 只是提示，认不出名字就留空。 */
 const rememberLink=(url,name)=>remember({kind:'web',platform:'web',url,name});
async function requestFeed(mode,request,{more=false,all=false,record=false,reuse=false}={}){
  if(ctx.feedEnabled&&!ctx.feedEnabled(mode))return;
  const f=state.feeds[mode];if(more&&(f.busy||!(f.next||f.pending.length)||f.rows.length>=1000))return;
  // readRequest 返回 null 表示「这一路本轮不该发检索」（选中的分类 A 站没有对应映射，见 app.js 的 R4）。
  // 原因已经由读值那边写进状态行了，这里静默收下：既不伪造一次请求，也不覆盖掉那句提示。
  if(!request)return;
  if(reuse&&!more){
   const cached=resultCache.get(cacheKey(mode,request));
   if(cached&&Date.now()-cached.usedAt<idleRefreshMs){
    f.controller?.abort();
    Object.assign(f,cached.snapshot,{visited:new Set(cached.snapshot.visited),busy:false,controller:null,token:f.token+1});
    cached.usedAt=Date.now();
    if(showsFeed(mode))renderGrid();
    return;
   }
  }
  const originalRequest={...request};let translatedQuery=false;
  f.controller?.abort();const controller=new AbortController(),token=++f.token;f.controller=controller;f.busy=true;f.error=false;f.aborted=false;
  if(!more)state.selected.clear();let pagesThisRun=0;const perPage=mode==='art'?48:24;
  // 「每次加载多少条」不是改平台接口的每页大小（那是各平台写死的 24/48），而是
  // 「一轮翻多少页」：拉到够 N 条就停。滚动加载与「加载更多」共用这一段，
  // 所以下拉一改，两种入口的节奏一起变，不会出现按钮与滚动行为不一致。
  const batchPages=Math.max(1,Math.ceil((Number(state.pageSize)||perPage)/perPage));
  const pageLimit=all?Math.max(1,Math.floor(state.options.scanLimit/perPage)):batchPages;
 try{
  if(!more){
   f.translation='';
   if(splitSearchTerms(request.q).length<=1&&/\p{Script=Han}/u.test(request.q||'')){
    // 中文关键词：翻译与扩词合并成一次 AI 调用（expand:true），不再串行等两次推理。
    f.translation='正在翻译中文关键词…';if(showsFeed(mode))renderGrid();
    const result=await translate(request.q,{expand:true});
    controller.signal.throwIfAborted();if(token!==f.token)return;
    f.translation=result.translated?`“${result.query}” → ${result.english}`:result.reason;
    if(result.translated){
     translatedQuery=true;
     request={...request,q:[...new Set([originalRequest.q,result.english,...(result.expansions||[])].map(term=>String(term).trim()).filter(Boolean))].slice(0,8).join(', ')};
    }
    if(result.translated&&result.expansions?.length){
     f.translation+=` ＋ ${result.expansions.join(' / ')}`;
    }
   }
  }
  do{
   controller.signal.throwIfAborted();f.status=mode==='search'?`正在搜索${request.q?` “${request.q}”`: '公开资产'}…`:mode==='art'?`正在检索${describeArt(request)}…`:mode==='web'?'正在解析网页中的模型…':`正在检索${feedLabel(mode)}${request.q?` “${request.q}”`:''}…`;if(showsFeed(mode))renderGrid();
   const payload=more?(f.pending.length?{ids:f.pending}:{cursor:f.next}):request;
   const marker=JSON.stringify(payload);if(more&&f.visited.has(marker)){f.next=null;f.pending=[];throw Error('平台返回重复分页地址，已停止重复检索。');}
   const response=await fetchSearchPage(feedEndpoint(mode),payload,{signal:controller.signal,translate:translatedQuery?undefined:translate});
   const data=response.data;if(!response.ok)throw Error(feedError({mode,status:response.status,error:data.error}));controller.signal.throwIfAborted();if(token!==f.token)return;
   if(!more){f.rows=[];f.pages=0;f.warnings=[];f.visited.clear();f.request={...originalRequest};if(mode==='web')state.source='link';f.origin='';}
   f.visited.add(marker);f.rows=mergeModels(f.rows,data.models).slice(0,1000);f.pages++;pagesThisRun++;f.next=data.next||null;f.pending=data.pending||[];
   f.warnings=[...new Set([...f.warnings,...(data.warnings||[])])].slice(0,24);
   // 历史只记「能复现那次检索」的入口，并且要同时满足 record 为真、框里确实有关键词：
   //  record 只有手动提交才打开；分类 / 排序 / 复选 / 标签点选虽然也会走到这里，但那是筛选动作。
   //  关键词为空 = 浏览热门，也不记 —— 否则一条空记录会占着一个名额，浮层里还看不出是哪次检索。
   if(!more&&mode==='search'&&record&&String(originalRequest.q||'').trim()){remember({kind:'search',platform:'sketchfab',params:{...originalRequest}});}
   if(!more&&mode==='web')rememberLink(request.url,data.source);
   // 服务端会说明这批结果到底是什么（单个模型 / Sketchfab 合集 / 作者 · xxx）。
   // 记住它，结果区标题才能说清，而不是一律写「链接解析结果」。
   if(typeof data.source==='string'&&data.source)f.origin=data.source;
   f.status=`已加载 ${f.rows.length} 个${mode==='art'?' ArtStation 结果':'模型'} · ${f.pages} 页${!(f.next||f.pending.length)?' · 当前接口结果已结束':''}`;more=true;
   if(f.rows.length>=1000){f.status+=' · 本次结果已达 1000 个上限，请缩小搜索范围';break;}
   if(pagesThisRun>=pageLimit||!(f.next||f.pending.length))break;
   await new Promise(r=>setTimeout(r,350));
  }while(!controller.signal.aborted);
  if(all&&pagesThisRun>=pageLimit&&(f.next||f.pending.length))f.status+=' · 已到连续检索上限，可手动继续';
 }catch(e){if(token!==f.token)return;f.error=!controller.signal.aborted;f.aborted=controller.signal.aborted;f.status=controller.signal.aborted?'已停止检索，已获取的结果保留。':`${e.message}${f.rows.length?'；上一次成功结果已保留。':''}`;}
 finally{if(token===f.token){f.busy=false;f.controller=null;saveResult(mode,f);persist();if(showsFeed(mode))renderGrid();}}
}
/** 发起一次检索。record 只管「要不要写进最近检索」，默认 false ——
 *  分类 / 排序变更、历史回放、标签点选、页面初始化都会调这里，它们都不该往历史里塞记录。 */
function startSearch({record=false}={}){
 searchHistoryUI()?.close();   // 检索已经发起，最近检索浮层同时收起（用回车提交时它不会自己消失）
 clearSearchTimer();
 ctx.markQueryActive();        // 记住「框里现在是有内容的」，删字时才认得出这是一次清空
 const raw=$('#asset-query').value.trim();
 resetDiscoveryFeeds(state);
 if(/^https?:\/\//i.test(routeLink(raw).url))return submitLink(raw);
 // 图站里能搜的那几家（Pinterest / 花瓣…）：非 URL 输入直接当关键词解析，不进 3D 平台检索。
 if(isPictureSite(state.platform)&&pictureSiteSearchable(state.platform)&&!/^https?:\/\//i.test(raw)){
  // 搜索框是空的：展示站点首页，不要拿空地址去解析（否则就是「需要 platform 与 url」）。
  if(!raw){
   const home=pictureSiteHome(state.platform);
   if(home)return showPictureSite(home,state.platform,{refresh:true,keepQuery:true,home:true});
  }
  const terms=splitSearchTerms(state.expandedQuery||raw).slice(0,4);
  if(terms.length<=1)return showPictureSite(raw,state.platform,{refresh:true});
  return showPictureQueries(terms,state.platform);
 }
 state.source='search';
 if(!activeModes().length){
  // 链接解析（文本 / 视频）：LINK_PLATFORM.feeds 是空的，能做的只有粘链接，不能拿「平台已关闭」糊弄。
  if(platformById(state.platform).link){
   toast('把视频页 / 文档页或直链地址粘到搜索框，回车即可解析');
   renderGrid();return;
  }
  // 图站没有关键词检索流，框里打词是搜不出东西的；这里直接告诉用户该怎么用，而不是报「所有平台已关闭」。
  toast(isPictureSite(state.platform)?(platformById(state.platform).keywordNotice||`${platformById(state.platform).label} 按链接解析：把作品页 / 标签页地址粘到搜索框回车即可`):'所有平台已关闭，请在设置 → 平台模块中开启');
  renderGrid();return;
 }
 return Promise.all(activeModes().map(mode=>requestFeed(mode,readRequest(mode),{record})));
}
/** 一个链接 = 一张卡片，绝不自动下载。
 *  ArtStation 作品页只对应一个作品，所以不走 /api/scan，直接把识别结果放进链接结果流；
 *  网页与 Sketchfab 作者/合集页能解析出一堆模型，仍然走扫描那条路。两条路的终点一样：
 *  结果区出现卡片，要不要下载由主人点卡片上的下载键决定。 */
async function showResolvedModel(url){
 const f=state.feeds.web;
 f.controller?.abort();
 const controller=new AbortController(),token=++f.token;f.controller=controller;f.busy=true;f.error=false;f.aborted=false;
 f.rows=[];f.pages=0;f.warnings=[];f.next=null;f.pending=[];f.visited.clear();
 f.request={url};state.selected.clear();
 f.status='正在解析链接中的资产…';renderGrid();
 try{
  const model=await resolveArtworkLink(url);
  controller.signal.throwIfAborted();
  if(token!==f.token)return;
  f.rows=mergeModels([],model?[model]:[]);f.pages=1;
  f.status=`已从链接解析出 ${f.rows.length} 个资产 · 未自动下载，点卡片上的「下载」开始`;
  rememberLink(url,f.rows[0]?.name);
 }catch(e){
  if(token!==f.token)return;
  f.error=!controller.signal.aborted;f.aborted=controller.signal.aborted;
  f.status=controller.signal.aborted?'已停止解析。':`${e.message}`;
 }finally{
  if(token===f.token){f.busy=false;f.controller=null;renderGrid();}
 }
}
/** Civitai 模型页：粘链接直接解析成一张可下载的模型卡，不下载原文件。 */
async function showCivitaiModel(url){
 const f=state.feeds.web;
 f.controller?.abort();
 const controller=new AbortController(),token=++f.token;f.controller=controller;f.busy=true;f.error=false;f.aborted=false;
 f.rows=[];f.pages=0;f.warnings=[];f.next=null;f.pending=[];f.visited.clear();
 f.request={url};state.selected.clear();
 f.status='正在解析 Civitai 模型…';renderGrid();
 try{
  const response=await fetchSearchPage('/api/civitai/resolve',{url},{signal:controller.signal});
  controller.signal.throwIfAborted();
  if(token!==f.token)return;
  if(!response.ok)throw Error(response.data?.error||'模型链接解析失败');
  const card=response.data.card;
  f.rows=mergeModels([],card?[card]:[]);f.pages=1;
  f.status=`已解析 ${f.rows.length} 个模型版本 · 未自动下载，点卡片上的「下载」开始`;
  rememberLink(url,f.rows[0]?.name);
 }catch(e){
  if(token!==f.token)return;
  f.error=!controller.signal.aborted;f.aborted=controller.signal.aborted;
  f.status=controller.signal.aborted?'已停止解析。':`${e.message}`;
 }finally{
  if(token===f.token){f.busy=false;f.controller=null;renderGrid();}
 }
}
function submitLink(raw=$('#asset-query').value){
 const target=routeLink(raw);
 cancelPictureRequests(state);
 state.pictureSite=null;
 boardTrail=[];                                  // 新的顶层链接：丢弃上一轮的画板导航栈
 // Civitai 模型链接走模型下载管线；图片 / 视频站链接仍走下面的图站解析。
 if(/^https?:\/\/(?:www\.)?civitai\.com\/models\//i.test(String(raw))){
  $('#asset-query').value=String(raw).trim();
  if(state.route!=='discover')routeTo('discover');
  adoptPlatform?.('civitai');
  state.source='link';
  return showCivitaiModel(String(raw).trim());
 }
 // 图站（素材下载器整合）：粘贴 Pixiv 等图站链接 → 解析整站图片 → 画廊瀑布流 → 下载进图片库。
 // 粘链接是明确动作，绕过缓存重新抓一次（切平台 / 回页面才吃缓存）。
 if(isPictureSite(target.platform))return showPictureSite(target.url,target.platform,{refresh:true});
 if(ctx.feedEnabled&&!ctx.feedEnabled(target.platform==='artstation'?'art':'web')){toast('该平台已关闭，请在设置 → 平台模块中开启');return;}
 if(target.error){toast(target.error);return;}
 $('#asset-query').value=target.url;
 if(state.route!=='discover')routeTo('discover');
 // 普通网页与 Sketchfab 的页面解析同一条通道，显示上归 Sketchfab；ArtStation 就是它自己。
 adoptPlatform?.(target.platform==='web'?'sketchfab':target.platform);
 state.source='link';
 if(target.platform==='artstation')return showResolvedModel(target.url);
 return requestFeed('web',{url:target.url});
}
/** 图站链接解析：拉取整站图片清单，填进 state.pictureSite，交给 library-view 的画廊渲染。
 *  复用搜索框（#asset-query）与链接路由（routeLink），结果通过既有图片下载管线进本地图片库。
 *  两级解析：作者主页 → mode:'boards'（画板墙）；点某块画板 → mode:'images'（它的图片）。
 *  `fromBoards` 让图片层显示「返回画板」入口，`opts.keepQuery` 避免点画板时把搜索框改成画板地址。 */
async function showPictureSite(raw,platform,opts={}){
 const isUrl=/^https?:\/\//i.test(raw);
 // 链接走 routeLink 复核；关键词（非 URL）直接当搜索词，不经链接路由（否则会被判成「无效网址」）。
 let targetUrl=raw;
 if(isUrl){
  const target=routeLink(raw);
  if(target.platform!==platform)return submitLink(raw);
  targetUrl=target.url;
  if(!opts.keepQuery)$('#asset-query').value=target.url;
 }
 if(state.route!=='discover')routeTo('discover');
 // 左侧下拉跟着拨到这个图站：解析走的就是它，界面上的平台不该还停在别处
 //（「最近检索」重放链接时不会触发输入事件，这里兜住）。
 adoptPlatform?.(platform);
 state.source='link';
 cancelPictureRequests(state);
 const token=++pictureToken;
 const base={platform,url:targetUrl,source:targetUrl,fromBoards:!!opts.fromBoards};
 // 缓存优先：切页面 / 切平台 / 刷新浏览器回来时先把上次那屏直接铺上，一帧都不等。
 // 只有「用户主动重搜粘链接」（opts.refresh）或缓存过期（10 分钟）才回源；过期也是先铺再静默更新。
 const cached=pictureCache.get(pictureKey(platform,targetUrl));
 if(cached){
  const age=pictureCacheAge(cached);
  cached.usedAt=Date.now();
  pictureCache.delete(pictureKey(platform,targetUrl));pictureCache.set(pictureKey(platform,targetUrl),cached);
  state.pictureSite={...base,...cached.data,busy:false,error:false,status:''};
  renderGrid();
  restorePictureScroll(state.pictureSite,state);
  const personal=platform==='xiaohongshu'&&/\/user\/(?:likes|following)(?:[/?#]|$)/.test(targetUrl);
  if(!opts.refresh&&age<PICTURE_CACHE_MS&&(!personal||cached.data.personalPaging===1))return;
 }else{
  state.pictureSite={...base,items:[],boards:[],mode:'images',title:'',author:'',cover:null,busy:true,error:false,status:opts.home?`正在加载 ${platformById(platform).label} 的推荐图…`:(isUrl?'正在解析图站链接…':`正在搜索 ${platformById(platform).label}…`)};
  renderGrid();
 }
 const controller=new AbortController();
 state.pictureSite.controller=controller;
 const resolveLimit=Math.min(5000,Math.max(PICTURE_FIRST_PAGE,Number(cached?.data.limit)||0,cached?.data.items?.length||0,cached?.data.boards?.length||0));
 try{
  // limit：只取前若干张做预览（图站整站动辄上千张，全量解析会让一次点击等很久）；下载仍是整站全量。
  // 刷新已有结果时覆盖已浏览窗口，避免把续页内容缩回首批 24 张。
  // 画板列表这一层不受 limit 影响（画板数量本来就少），服务端按 mode:'boards' 返回。
  const personal=platform==='xiaohongshu'&&/\/user\/(?:likes|following)(?:[/?#]|$)/.test(targetUrl);
  const resolveUrl=`/api/picture-site/resolve?platform=${encodeURIComponent(platform)}&limit=${resolveLimit}&url=${encodeURIComponent(targetUrl)}${personal?'&refresh=1':''}`;
  const resolveOpts={headers:{'x-sfx-local':'1'},signal:controller.signal};
  let res;
  try{res=await fetch(resolveUrl,resolveOpts);}
  catch(netErr){
   if(controller.signal.aborted)throw netErr;
   // dev 模式后端热重载会短暂断开监听，fetch 在这个窗口抛 Failed to fetch（toast 会显示
   // 「网络请求失败，请检查网络、代理及后台服务」）。等一下重试一次，撞上重启窗口也能自愈；
   // HTTP 4xx/5xx 不走这里（fetch 不抛），仍由下面的 res.ok 判断，避免把真实错误重复请求两遍。
   await new Promise(r=>setTimeout(r,700));
   controller.signal.throwIfAborted();
   res=await fetch(resolveUrl,resolveOpts);
  }
  const data=await res.json();
  if(!res.ok)throw new Error(data.error||'解析失败');
  const payload={mode:data.mode==='boards'?'boards':'images',items:data.items||[],boards:data.boards||[],albums:data.albums||[],user:data.user||null,title:data.title||'',author:data.author||'',cover:data.cover||null,truncated:!!data.truncated,total:Number(data.total)||0,warning:data.warning||'',personalPaging:data.personalPaging||0,order:data.order||'',collectionCollectDetect:data.collectionCollectDetect||'',collectionHomeUrl:data.collectionHomeUrl||'',collectionCollectUrl:data.collectionCollectUrl||'',collectionLabel:data.collectionLabel||'',limit:resolveLimit,scrollTop:cached?.data.scrollTop||0,fetchedAt:Date.now()};
  // fromBoards 一起存：刷新后从这块画板恢复时，「← 返回画板」不能丢。
  if(controller.signal.aborted)return;
  savePictureCache(platform,targetUrl,{...payload,fromBoards:!!opts.fromBoards});
  // 这一轮已经过期（用户切了平台 / 换了页面）：结果只进缓存，画面交给后来那轮。
  if(token!==pictureToken||state.route!=='discover'||state.pictureSite?.controller!==controller)return;
  // 后台重抓回来的还是同一批图：画面别动，整屏重绘会让图片闪一下。
  if(cached&&pictureSignature(cached.data)===pictureSignature(payload)){Object.assign(state.pictureSite,payload);ctx.refreshPictureStatus?.();return;}
  state.pictureSite={...base,...payload,busy:false,error:false,status:''};
  // 作者主页不是「一次检索」，别把作者页塞进最近检索；纯关键词搜索也不记 ——
  // 最近检索的条目重放时当链接走 routeLink，塞个关键词进去只会被判成「无效网址」。
  if(data.mode!=='boards'&&isUrl&&!opts.home)rememberLink(targetUrl,data.title||data.author);
  renderGrid();
  restorePictureScroll(state.pictureSite,state);
 }catch(e){
  if(token!==pictureToken||controller.signal.aborted||state.route!=='discover'||state.pictureSite?.controller!==controller)return;
  // 手上已有缓存就别让一次失败把画面清空（站方临时拦截 / 网络抽风），继续显示上次结果。
  if(cached&&(cached.data.items?.length||cached.data.boards?.length)){toast?.(`重新抓取失败，继续显示上次结果：${e.message}`);return;}
  state.pictureSite={...base,items:[],boards:[],mode:'images',title:'',author:'',cover:null,busy:false,error:true,status:e.message};
  renderGrid();
 }finally{
  if(token===pictureToken&&state.pictureSite?.controller===controller){state.pictureSite.controller=null;ctx.refreshPictureStatus?.();}
 }
}
/** 原句和拆出来的词各搜一次，结果合到同一屏。原句永远是第一项。 */
async function showPictureQueries(terms,platform){
 const stamp=pictureToken;
 await showPictureSite(terms[0],platform,{refresh:true,keepQuery:true});
 if(stamp!==pictureToken||state.pictureSite?.error||state.pictureSite?.mode==='boards')return;
 const seen=new Set((state.pictureSite.items||[]).map(item=>item.url||item.id||item.src));
 for(const term of terms.slice(1)){
  if(stamp!==pictureToken)return;
  try{
   const res=await fetch(`/api/picture-site/resolve?platform=${encodeURIComponent(platform)}&limit=${PICTURE_FIRST_PAGE}&url=${encodeURIComponent(term)}`,{headers:{'x-sfx-local':'1'}});
   const data=await res.json();
   if(!res.ok||stamp!==pictureToken||data.mode==='boards')continue;
   for(const item of data.items||[]){
    const key=item.url||item.id||item.src;
    if(!key||seen.has(key))continue;
    seen.add(key);
    state.pictureSite.items.push(item);
   }
  }catch{if(stamp!==pictureToken)return;}
 }
 if(stamp!==pictureToken)return;
 state.pictureSite.title=terms.join(' · ');
 renderGrid();
}
/** 切到图站平台时预载首页推荐：结果区直接出图，而不是一大块「请粘贴链接」的说明。
 *  取不到（站点拦截 / 需要登录）就退回收拾好的说明卡，不把「解析失败」留在那儿吓人。
 *  不做的事：不写最近检索（那不是一次用户检索）、不改搜索框内容、不自动下载。 */
async function openPictureHome(platform){
 const last=lastPictureEntry(platform);
 // 启动时已经把这一屏从缓存铺好了（restorePictureSnapshot），而且它还新鲜：
 // 再走一遍解析流程只会让 renderGrid 重画一次 —— 数据没变，用户看到的却是「图又加载了一遍」。
 const current=state.pictureSite;
 if(current&&current.platform===platform&&!current.error&&(current.items||[]).length&&last&&pictureCacheAge(last)<PICTURE_CACHE_MS)return true;
 // 上次看过的那一屏优先：刷新页面 / 切回这个站时直接回到原处，而不是从首页推荐重新抓一遍。
 const home=last?.url||pictureSiteHome(platform);
 if(!home)return false;
 if(state.route!=='discover')routeTo('discover');
 await showPictureSite(home,platform,{keepQuery:true,home:true});
 if(state.pictureSite?.error&&state.pictureSite.platform===platform){
  state.pictureSite=null;
  renderGrid();
  toast?.(`${platformById(platform).label} 的首页推荐取不到，把作品页链接粘到搜索框试试`);
 }
 return true;
}
/** 从画板墙点进某块画板：记住上一层，图片层才有「返回画板」。 */
async function openPictureBoard(board){
 const current=state.pictureSite;
 if(current&&current.mode==='boards')boardTrail.push({...current});
 const url=board&&board.url?board.url:`https://huaban.com/boards/${board&&board.id?board.id:''}`;
 return showPictureSite(url,(current&&current.platform)||'huaban',{fromBoards:true,keepQuery:true});
}
/** 点作者名/头像：把作者主页交给同一套解析 —— 花瓣出画板墙、Pixiv 出该画师作品流、
 *  Civitai 出该用户图库。服务端给的 authorUrl 本身就是能被 resolve 的页面地址，
 *  所以这里不需要为每个站点写分支判断。 */
async function openPictureAuthor(url,platform){
 if(!url)return false;
 const target=platform||state.pictureSite?.platform||state.platform;
 const input=$('#asset-query');
 if(input)input.value=url;
 adoptPlatform?.(target);
 return showPictureSite(url,target,{keepQuery:true});
}
/** 返回画板墙：不发请求，直接把上一层放回去。 */
function backToPictureBoards(){
 const prev=boardTrail.pop();
 if(!prev)return false;
 cancelPictureRequests(state);
 state.pictureSite={...prev,fromBoards:false};
 renderGrid();
 return true;
}
/** 登录窗口关掉之后，原地重跑刚才那一次图站解析 —— 关键词、作品页、画板页都能接着看。
 *  状态里本来就存着那一屏的来源（platform + url），所以用户不需要再输一遍；
 *  没搜过（刚切到这个站、还没动作）就退回站点首页推荐，首页也没有的站返回 false，
 *  由调用方提示「登录完成，输入关键词即可」。 */
async function reloadPictureSite(){
 const ps=state.pictureSite;
 const platform=ps?.platform||(isPictureSite(state.platform)?state.platform:'');
 if(!platform)return false;
 const typed=String($('#asset-query')?.value||'').trim();
 const raw=ps?.url||typed||pictureSiteHome(platform);
 if(!raw)return false;
 await showPictureSite(raw,platform,{refresh:true,keepQuery:true,fromBoards:!!ps?.fromBoards});
 return true;
}
 async function openPictureUrl(url,platform=state.platform){
  if(state.route!=='discover')routeTo('discover');
  return showPictureSite(url,platform,{keepQuery:true,refresh:true});
 }
 return {requestFeed,startSearch,submitLink,openPictureBoard,openPictureAuthor,backToPictureBoards,openPictureHome,reloadPictureSite,openPictureUrl,
  restorePictureScroll:()=>restorePictureScroll(state.pictureSite,state),
  savePictureSession:()=>{if(state.route==='discover')cancelPictureRequests(state);flushPictureCache();}};
}
