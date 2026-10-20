// Starting a discovery request: one feed page, one keyword across every feed, one pasted link.
//
// The three entry points differ only in where the request comes from — a "load more" click, the
// search box, or a pasted URL — and all three end in the same place: a feed is fetched, merged and
// the grid is redrawn. Keeping them together is what stops "search" and "load more" from drifting
// on warnings, cancellation or what counts as having results.

import {feedEndpoint,feedLabel,routeLink} from './platforms.js';
import {createSearchTranslation} from './search-translation.js';
import {fetchSearchPage,splitSearchTerms} from './multi-search.js';

// 搜索条件属于整个发现页；清除时也必须让隐藏平台及在途响应失效。
export function resetDiscoveryFeeds(state){
 for(const f of Object.values(state.feeds)){
  f.controller?.abort();f.token++;f.controller=null;f.busy=false;
  f.rows=[];f.request=null;f.next=null;f.pending=[];f.pages=0;
  f.status='';f.error=false;f.aborted=false;f.warnings=[];f.translation='';f.origin='';
  f.visited.clear();
 }
 state.source='search';state.selected.clear();
}

export function createDiscoveryFeed(ctx){
 const translate=createSearchTranslation();
 const {$,toast,state,persist,renderGrid,mergeModels,describeArt,activeModes,showsFeed,searchHistoryUI,resolveArtworkLink,routeTo,readRequest,clearSearchTimer,feedError,markQueryActive}=ctx;
 /** 最近检索：同一条记录只留最新一份，写完立刻持久化并刷新浮层。 */
 function remember(entry){
  const key=JSON.stringify(entry);
  state.history=[entry,...state.history.filter(h=>JSON.stringify(h)!==key)].slice(0,12);
  persist();searchHistoryUI()?.refresh();
 }
 /** 链接解析的记录靠 URL 复现，所以 name 只是提示，认不出名字就留空。 */
 const rememberLink=(url,name)=>remember({kind:'web',platform:'web',url,name});
async function requestFeed(mode,request,{more=false,all=false,record=false}={}){
  const f=state.feeds[mode];if(more&&(f.busy||!(f.next||f.pending.length)||f.rows.length>=1000))return;
  // readRequest 返回 null 表示「这一路本轮不该发检索」（选中的分类 A 站没有对应映射，见 app.js 的 R4）。
  // 原因已经由读值那边写进状态行了，这里静默收下：既不伪造一次请求，也不覆盖掉那句提示。
  if(!request)return;
  const originalRequest={...request};
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
    if(result.translated)request={...request,q:result.english};
    if(result.translated&&result.expansions?.length){
     request={...request,q:`${request.q} ${result.expansions.join(' ')}`.trim()};
     f.translation+=` ＋ ${result.expansions.join(' / ')}`;
    }
   }
  }
  do{
   controller.signal.throwIfAborted();f.status=mode==='search'?`正在搜索${request.q?` “${request.q}”`: '公开资产'}…`:mode==='art'?`正在检索${describeArt(request)}…`:mode==='web'?'正在解析网页中的模型…':`正在检索${feedLabel(mode)}${request.q?` “${request.q}”`:''}…`;if(showsFeed(mode))renderGrid();
   const payload=more?(f.pending.length?{ids:f.pending}:{cursor:f.next}):request;
   const marker=JSON.stringify(payload);if(more&&f.visited.has(marker)){f.next=null;f.pending=[];throw Error('平台返回重复分页地址，已停止重复检索。');}
   const response=await fetchSearchPage(feedEndpoint(mode),payload,{signal:controller.signal,translate});
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
 finally{if(token===f.token){f.busy=false;f.controller=null;persist();if(showsFeed(mode))renderGrid();}}
}
/** 发起一次检索。record 只管「要不要写进最近检索」，默认 false ——
 *  分类 / 排序变更、历史回放、标签点选、页面初始化都会调这里，它们都不该往历史里塞记录。 */
function startSearch({record=false}={}){
 searchHistoryUI()?.close();   // 检索已经发起，最近检索浮层同时收起（用回车提交时它不会自己消失）
 clearSearchTimer();
 ctx.markQueryActive();        // 记住「框里现在是有内容的」，删字时才认得出这是一次清空
 const raw=$('#asset-query').value.trim();
 resetDiscoveryFeeds(state);
 if(/^https?:\/\//i.test(raw))return submitLink(raw);
 state.source='search';
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
function submitLink(raw=$('#asset-query').value){
 const target=routeLink(raw);
 if(target.error){toast(target.error);return;}
 $('#asset-query').value=target.url;
 if(state.route!=='discover')routeTo('discover');
 state.source='link';
 if(target.platform==='artstation')return showResolvedModel(target.url);
 return requestFeed('web',{url:target.url});
}
 return {requestFeed,startSearch,submitLink};
}
