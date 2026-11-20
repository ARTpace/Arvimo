import {watchPage} from './browser-session.mjs';
import {readPublic,validateUrl} from './public-http.mjs';

const LABELS={douyin:'抖音',kuaishou:'快手',bilibili:'哔哩哔哩',weibo:'微博视频'};
export function videoSearchUrl(platform,keyword){
 const q=encodeURIComponent(keyword);
 if(platform==='douyin')return `https://www.douyin.com/search/${q}?type=video`;
 if(platform==='kuaishou')return `https://www.kuaishou.com/search/video?searchKey=${q}`;
 if(platform==='bilibili')return `https://search.bilibili.com/all?keyword=${q}`;
 if(platform==='weibo')return `https://s.weibo.com/video?q=${q}`;
 throw Error('不支持的视频搜索平台');
}
const text=value=>String(value||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim().slice(0,1000);
const safe=value=>{try{const u=validateUrl(String(value||'').replace(/^\/\//,'https://'));return u.href;}catch{return '';}};
const firstUrl=v=>typeof v==='string'?v:v?.url_list?.[0]||v?.urls?.[0]||v?.url||'';
export function videoResult(platform,value){
 let pageUrl=safe(value.pageUrl);if(!pageUrl)return null;
 const u=new URL(pageUrl),rules={douyin:[/(^|\.)douyin\.com$/,/^\/(?:video|note)\/\d{16,20}/],kuaishou:[/(^|\.)kuaishou\.com$/,/^\/short-video\/[\w-]{4,100}/],bilibili:[/(^|\.)bilibili\.com$/,/^\/video\/BV[\w]+/],weibo:[/(^|\.)weibo\.com$/,/^\/tv\/show\/\d+:\d+/]};
 const rule=rules[platform];if(!rule||!rule[0].test(u.hostname)||!rule[1].test(u.pathname))return null;
 u.search='';u.hash='';pageUrl=u.href;
 return {key:`${platform}:${u.pathname}`,type:'video',url:'',pageUrl,title:text(value.title)||LABELS[platform]+'视频',author:text(value.author),thumb:safe(value.thumb),duration:Number(value.duration)||0};
}
/** Normalize source API responses; bounded traversal covers wrappers without executing page data. */
export function parseVideoSearch(platform,payload){
 const queue=[payload],items=[],seen=new Set();
 for(let i=0;i<queue.length&&i<12000;i++){
  const node=queue[i];if(!node||typeof node!=='object')continue;
  let value=null;
  if(platform==='bilibili'&&node.bvid&&node.title)value={pageUrl:`https://www.bilibili.com/video/${node.bvid}`,title:node.title,author:node.author||node.owner?.name,thumb:node.pic||node.cover,duration:node.duration};
  if(platform==='douyin'&&node.aweme_id&&(node.video||node.images))value={pageUrl:`https://www.douyin.com/${node.images?.length?'note':'video'}/${node.aweme_id}`,title:node.desc,author:node.author?.nickname,thumb:firstUrl(node.video?.cover)||firstUrl(node.images?.[0]),duration:Number(node.video?.duration||0)/1000};
  if(platform==='kuaishou'&&node.photo?.id)value={pageUrl:`https://www.kuaishou.com/short-video/${node.photo.id}`,title:node.photo.caption,author:node.author?.name||node.user?.name||node.photo.userName,thumb:node.photo.coverUrl||firstUrl(node.photo.coverUrls),duration:node.photo.duration};
  if(platform==='weibo'&&node.page_info){const p=node.page_info,id=p.object_id||p.media_info?.object_id;if(/^\d+:\d+$/.test(String(id||''))&&(p.type==='video'||p.media_info))value={pageUrl:`https://weibo.com/tv/show/${id}`,title:node.text_raw||node.text||p.page_title,author:node.user?.screen_name,thumb:p.page_pic?.url,duration:p.media_info?.duration};}
  if(value){const item=videoResult(platform,value);if(item&&!seen.has(item.key)){seen.add(item.key);items.push(item);}}
  if(items.length>=60)break;
  for(const value of Object.values(node))if(value&&typeof value==='object'&&queue.length<12000)queue.push(value);
 }
 return items;
}
function readSearchCards(platform){
 const patterns={douyin:/\/(?:video|note)\/\d{16,20}/,kuaishou:/\/short-video\/[\w-]{4,100}/,bilibili:/\/video\/BV[\w]+/,weibo:/\/tv\/show\/\d+:\d+/};
 const pattern=patterns[platform],cards=[],seen=new Set();
 for(const a of document.querySelectorAll('a[href]')){
  if(!pattern.test(a.href)||seen.has(a.href)||!a.getClientRects().length)continue;
  const card=a.closest('article,li,[class*="video-card"],[class*="VideoCard"],[class*="search-card"],[class*="card-wrap"]')||a;
  const image=card.querySelector('img'),title=a.getAttribute('title')||card.querySelector('[title]')?.getAttribute('title')||image?.alt||card.innerText;
  if(!title?.trim())continue;
  seen.add(a.href);cards.push({pageUrl:a.href,title:title.slice(0,500),thumb:image?.currentSrc||image?.src||'',author:''});if(cards.length>=60)break;
 }
 return {cards,body:String(document.body?.innerText||'').slice(0,2000)};
}
const API_MATCH={douyin:/\/aweme\/.*search/,kuaishou:/\/graphql|\/search\//,bilibili:/\/x\/web-interface\/.*search/,weibo:/\/api\/(?:container|getIndex)|\/ajax\/.*search/};
export async function searchVideo(platform,keyword,{signal,read=readPublic,watch=watchPage,maxItems=60,waitMs=18000}={}){
 signal?.throwIfAborted();
 const query=String(keyword||'').trim().slice(0,100);if(!query)throw Error('请输入视频关键词');
 const source=videoSearchUrl(platform,query),items=new Map();
 const add=values=>{for(const item of values)if(item)items.set(item.key,item);};
 const done=()=>({title:`${LABELS[platform]} · ${query}`,source:query,search:true,items:[...items.values()].slice(0,Math.min(60,maxItems)),skipped:[]});
 // ponytail: use the normal source API when available, otherwise reuse the existing signed-in page.
 if(platform==='bilibili'||platform==='weibo'){
  const api=platform==='bilibili'?'https://api.bilibili.com/x/web-interface/search/type?'+new URLSearchParams({search_type:'video',keyword:query,page:'1',page_size:'30'}):'https://m.weibo.cn/api/container/getIndex?'+new URLSearchParams({containerid:`100103type=61&q=${query}`,page_type:'searchall'});
  try{const r=await read(api,{signal,headers:{Referer:source,'User-Agent':'Mozilla/5.0'},timeout:12000,maxBytes:4*1024**2});if(r.status===200)add(parseVideoSearch(platform,JSON.parse(r.body.toString('utf8'))));}catch(error){signal?.throwIfAborted();}
  if(items.size)return done();
 }
 signal?.throwIfAborted();
 return watch(async page=>{
  const hits=new Set(),pending=new Set();let body='';
  const off=page.on('Network.responseReceived',p=>{const response=p?.response;if(response?.status===200&&API_MATCH[platform].test(response.url||'')&&hits.size<12)hits.add(p.requestId);});
  const loaded=page.on('Network.loadingFinished',p=>{
   if(!hits.has(p.requestId)||Number(p.encodedDataLength)>4*1024**2)return;
   hits.delete(p.requestId);
   const promise=page.send('Network.getResponseBody',{requestId:p.requestId},4000).then(r=>{if(r.body?.length>6*1024**2)return;const raw=r.base64Encoded?Buffer.from(r.body,'base64').toString('utf8'):r.body;try{add(parseVideoSearch(platform,JSON.parse(raw)));}catch{}}).catch(()=>{}).finally(()=>pending.delete(promise));pending.add(promise);
  });
  try{
   signal?.throwIfAborted();await page.send('Page.navigate',{url:source},12000);
   const end=Date.now()+waitMs;
   while(Date.now()<end){
    signal?.throwIfAborted();
    const evaluated=await page.send('Runtime.evaluate',{expression:`(${readSearchCards.toString()})(${JSON.stringify(platform)})`,returnByValue:true},4000).catch(()=>null);
    const value=evaluated?.result?.value;if(value){body=value.body||body;add((value.cards||[]).map(card=>videoResult(platform,card)));}
    if(items.size)return done();
    await new Promise(resolve=>setTimeout(resolve,500));
   }
   if(/登录|验证码|验证|login|captcha|访问异常/i.test(body))throw Error(`${LABELS[platform]} 搜索需要登录或验证，请点击平台「登录」完成后重试`);
   throw Error(`${LABELS[platform]} 未返回可读取的视频搜索结果；可能无匹配内容或平台接口已调整`);
  }finally{off();loaded();await Promise.allSettled(pending);}
 },{timeout:35000});
}
