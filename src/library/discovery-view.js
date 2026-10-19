// 发现页的视图模型：把「当前平台有几个结果流」这件事收成一个只读投影与一组文案。
//
// 背景：一个搜索框要同时服务 Sketchfab、ArtStation 和链接解析。app.js 只该管状态与事件，
// 于是「多源怎么合并」「状态行怎么说」「分页按钮叫什么」这些规则全部收在这里，
// 它们不需要 DOM 也不需要网络，可以直接单元测试。

import {FEED_LABELS,feedLabel,ORIGIN_COPY,platformById} from './platforms.js';

export const SOURCE_LABELS=FEED_LABELS;
export const DEFAULT_STATUS='关键词直接搜索，不需要先复制官网网址。';

/** 交错合并：否则第一个平台的长列表会把另一个平台整个压到看不见。 */
export function interleave(lists){
 const out=[],depth=Math.max(0,...lists.map(list=>list.length));
 for(let i=0;i<depth;i++)for(const list of lists)if(list[i])out.push(list[i]);
 return out;
}

/**
 * 把若干结果流投影成一个 feed 形状的对象，供网格/状态行/分页共用。
 * 单源时原样透传（保留 request/cursor 等字段），多源时只保留能合并的部分。
 */
export function combine({sources,feeds}){
 const list=sources.map(mode=>feeds[mode]);
 if(list.length===1)return {...list[0],sources};
 return {
  sources,rows:interleave(list.map(feed=>feed.rows)),request:null,
  pages:Math.max(0,...list.map(feed=>feed.pages)),
  next:list.some(feed=>feed.next||feed.pending.length),pending:list.flatMap(feed=>feed.pending),
  busy:list.some(feed=>feed.busy),error:list.every(feed=>feed.error),
  warnings:[...new Set(list.flatMap(feed=>feed.warnings))].slice(0,24),status:'',
  controller:{abort:()=>list.forEach(feed=>feed.controller?.abort())},
 };
}

/** 多平台时逐源报进度，否则第二个平台的失败会被第一个平台的「已加载」盖住。 */
export function statusText({sources,feeds}){
 if(sources.length===1)return feeds[sources[0]].status||DEFAULT_STATUS;
 return sources.map(mode=>`${SOURCE_LABELS[mode]}：${feeds[mode].busy?'检索中…':feeds[mode].status||'待检索'}`).join(' · ');
}

/** 副标题要说清「现在是哪几个平台、各拿到多少」，否则全平台搜索会像只有一个来源。 */
export function subtitleText({source,platform,feeds,count,pages,request,categories}){
 if(source==='link')return count?`从这个链接解析出 ${count} 个资产 · 不会自动下载，点卡片上的「下载」开始`:'正在解析链接中的资产…';
 if(platform==='all'){
  const parts=Object.keys(feeds).filter(mode=>feeds[mode].request||feeds[mode].rows.length).map(mode=>`${SOURCE_LABELS[mode]} ${feeds[mode].rows.length} 个`);
  return parts.length?`已加载 ${parts.join(' · ')} · 第 ${pages} 页 · 未自动入库`:`同时检索全部平台的公开资产 · 收藏或加入后才存入模型库`;
 }
 if(!request)return `来自 ${ORIGIN_COPY[platform]||feedLabel(platformById(platform).feeds[0])} · 收藏或加入后才存入模型库`;
 const category=request.category?` · ${categories.find(([key])=>key===request.category)?.[1]||''}`:'';
 return `已加载 ${count} 个${platform==='artstation'?' Marmoset 作品':'公开模型'} · 第 ${pages} 页${category} · 未自动入库`;
}

export const pageInfoNote=({source,platform})=>source==='link'?'链接解析结果':platform==='artstation'?'ArtStation 公开接口结果':platform==='all'?'两个平台合计，不是任一平台的总数':'数量不是平台总数';
export const loadMoreLabel=({source,platform})=>source==='link'?'解析下一页':platform==='artstation'?'加载更多 Marmoset 作品':platform==='all'?'加载更多（两个平台）':'加载更多资产';

/**
 * 一次结果流请求失败时，状态行该说什么。
 *
 * 本地服务端回 404 只有一种含义：正在跑的那个进程比前端旧，还没有这条接口——前端已经认识
 * 这个平台，进程却停在上一版。此时把服务端原文（「不存在的页面或接口」）照抄给用户，既漏了
 * 内部实现，又没给出路：用户不知道这句话意味着该去做什么。所以这里保证每一句都能照做。
 */
export function feedErrorMessage({mode,status,error}){
 if(status===404)return `后台服务还是旧版本，没有「${feedLabel(mode)}」的检索接口；重新打开 AssetVault 更新后台服务后即可使用。`;
 return error||`检索失败 HTTP ${status}`;
}

/** 标题那句话：这次是「谁在回答」。链接解析结果不属于任何平台流，单独说。 */
export function describeRequest({source,platform,feeds,categories,describeArt}){
 // 链接解析结果要说清那到底是什么：粘作者页拿到的是「作者 · xxx 的模型」，
 // 粘单个模型页只有一个。服务端已经在 source 里给了这个说法，直接透出。
 if(source==='link'){
  const origin=feeds?.web?.origin;
  return origin?origin:'链接解析结果';
 }
 if(platform==='artstation')return describeArt(feeds.art.request);
 const request=feeds[platformById(platform).feeds[0]]?.request;
 // 浏览态（没有关键词）拿到的是平台的「最新精选」：默认榜单每天都在更新，所以标题不再说
 // 「热门资产」——那是旧行为（固定的历史点赞榜），现在说"精选"才对得上眼前这批卡片。
 if(platform==='all')return request?.q?`“${request.q}” 的跨平台结果`:'最新精选';
 if(!request)return '发现好模型';
 const category=categories.find(([key])=>key===request.category)?.[1];
 return request.q?`“${request.q}” 的搜索结果`:request.category?`${category}资产`:request.staffpicked?'精选资产':'发现好模型';
}
