// Platform extraction adapted from jiuhunwl/short_videos (MIT); see docs/third-party/short-videos.md.
// Keep AssetVault's public-network checks, TLS verification and cookie handling; no external parser service.
import {readPublic,validateUrl} from './public-http.mjs';
import {SHORT_VIDEO_SITES,extractShareUrl} from '../src/library/short-video-platforms.js';
import {searchVideo} from './video-search.mjs';

const UA='Mozilla/5.0 (Linux; Android 10; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36';
const unique=values=>[...new Set(values.filter(Boolean))];
const list=value=>Array.isArray(value)?value:[];
export function socialMediaUrl(value){
 try{const u=validateUrl(String(value||'').replace(/^\/\//,'https://'));u.protocol='https:';return u.href;}catch{return '';}
}
const urls=value=>unique(list(value).map(item=>socialMediaUrl(typeof item==='string'?item:item?.src||item?.url)));
const address=value=>urls(value?.url_list||value?.urlList||value?.playAddr||[]);
function rateUrls(video={}){
 const rates=list(video.bit_rate||video.bitRateList).slice().sort((a,b)=>(Number(b.bit_rate||b.bitRate)||0)-(Number(a.bit_rate||a.bitRate)||0));
 return unique([...rates.flatMap(rate=>urls(rate.playAddr).concat(address(rate.play_addr))),...address(video.play_addr),...address(video.play_addr_h264)]);
}
function plan(platform,source,meta,items){
 const clean=items.filter(item=>item.url).map((item,index)=>({...meta,...item,key:item.key||`${platform}:${index}`,pageUrl:item.pageUrl||source,thumb:item.thumb||meta.cover||item.url}));
 if(!clean.length)throw Error('没有解析到可下载媒体；可能需要登录、验证，或平台接口已调整');
 return {...meta,source,items:clean,skipped:[],rendition:'original'};
}
export function parseDouyin(detail,source){
 const author=detail.author||{},video=detail.video||{};
 const meta={title:detail.desc||'抖音作品',description:detail.desc||'',author:author.nickname||'',authorUrl:author.sec_uid?`https://www.douyin.com/user/${encodeURIComponent(author.sec_uid)}`:'',cover:address(video.cover)[0]||address(detail.images?.[0])[0]||'',publishedAt:detail.create_time||null,duration:Number(video.duration||0)/1000,music:detail.music?{title:detail.music.title||'',author:detail.music.author||'',url:address(detail.music.play_url)[0]||''}:null};
 const items=[];
 for(const [index,image] of list(detail.images).entries()){
  const imageUrls=address(image),pairId=`${detail.aweme_id}:live:${index}`;
  if(imageUrls.length)items.push({url:imageUrls[0],alternates:imageUrls.slice(1),type:'image',width:image.width||0,height:image.height||0,pairId});
  const candidates=rateUrls(image.video);
  if(candidates.length)items.push({url:candidates[0],alternates:candidates.slice(1),type:'video',pairId,thumb:imageUrls[0]||meta.cover});
 }
 if(!items.length){
  const candidates=rateUrls(video),vid=video.play_addr?.uri;
  // The play endpoint redirects to the original file. Keep actual CDN renditions as fallbacks.
  if(vid&&/^[\w-]+$/.test(vid))candidates.unshift(`https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(vid)}&ratio=default&line=0&is_play_url=1&source=PackSourceEnum_PUBLISH&mime_type=video_mp4`);
  if(candidates.length)items.push({type:'video',url:candidates[0],alternates:unique(candidates.slice(1)),width:video.width||0,height:video.height||0});
 }
 return plan('douyin',source,meta,items);
}
function embeddedJson(html,name){
 const at=html.indexOf(name);if(at<0)return null;
 const start=html.indexOf('{',at+name.length);if(start<0)return null;
 let depth=0,string=false,escape=false;
 for(let i=start;i<html.length;i++){
  const c=html[i];if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;continue;}
  if(c==='"')string=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{return JSON.parse(html.slice(start,i+1));}catch{return null;}}
 }
 return null;
}
export function parseKuaishou(html,source){
 const state=embeddedJson(html,'window.INIT_STATE')||embeddedJson(html,'window.__APOLLO_STATE__');
 const queue=[state];let photo=null;
 for(let i=0;i<queue.length&&i<20000;i++){
  const node=queue[i];if(!node||typeof node!=='object')continue;
  if(node.photo?.mainMvUrls||node.photo?.ext_params?.atlas||node.photo?.photoUrl){photo=node.photo;break;}
  if(node.mainMvUrls||node.photoUrl||node.ext_params?.atlas){photo=node;break;}
  queue.push(...Object.values(node).filter(value=>value&&typeof value==='object'));
 }
 if(!photo)throw Error('快手页面没有可读取的媒体信息，请完成登录或验证后重试');
 const meta={title:photo.caption||'快手作品',author:photo.userName||'',cover:urls(photo.coverUrls)[0]||socialMediaUrl(photo.coverUrl),publishedAt:photo.timestamp||null};
 const atlas=list(photo.ext_params?.atlas?.list),candidates=unique([...urls(photo.mainMvUrls),...urls(photo.videoResource?.h264?.adaptationSet?.[0]?.representation?.map(r=>r.url)),socialMediaUrl(photo.photoUrl)]);
 return plan('kuaishou',source,meta,atlas.length?atlas.map(path=>({type:'image',url:socialMediaUrl(/^https?:/.test(path)?path:`https://tx2.a.yximgs.com/${path}`)})):candidates.length?[{type:'video',url:candidates[0],alternates:candidates.slice(1)}]:[]);
}
export async function resolveShortVideo(platform,input,{signal,read=readPublic,maxItems=60,search=searchVideo}={}){
 const config=SHORT_VIDEO_SITES[platform];if(!config)throw Error('不支持的短视频平台');
 if(!/^https?:\/\//i.test(extractShareUrl(input)))return search(platform,input,{signal,read,maxItems});
 const requested=validateUrl(extractShareUrl(input));
 const matches=u=>config.hosts.some(host=>u.hostname===host||u.hostname.endsWith('.'+host));
 if(!matches(requested))throw Error('分享链接与所选平台不匹配');
 const headers={'User-Agent':UA,Referer:`https://${config.hosts[0]}/`};
 const get=async(url,extra={})=>{
  const r=await read(url,{signal,headers,maxBytes:8*1024*1024,timeout:20000,...extra});
  if(r.status<200||r.status>=300)throw Error(`${config.label} 请求失败（HTTP ${r.status}）`);
  return r;
 };
 const json=async(url,extra)=>{const r=await get(url,extra);try{return JSON.parse(r.body.toString('utf8'));}catch{throw Error(`${config.label} 返回了验证页或无效数据，请登录或完成验证后重试`);}};
 let source=requested.href,page=null;
 if(['v.douyin.com','v.kuaishou.com','b23.tv','t.cn'].includes(requested.hostname)||requested.hostname.endsWith('.chenzhongtech.com')){
  page=await get(source);const resolved=validateUrl(page.url||source);if(!matches(resolved))throw Error('分享短链跳转到了其他站点');source=resolved.href;
 }
 let result;
 if(platform==='douyin'){
  const u=new URL(source),id=u.pathname.match(/\/(?:video|note|slides)\/(\d{16,20})/)?.[1]||u.searchParams.get('modal_id')||u.searchParams.get('item_id');
  if(!id||!/^\d{16,20}$/.test(id))throw Error('请粘贴抖音单篇作品链接；暂不支持主页或合集');
  const data=await json('https://api.amemv.com/aweme/v1/aweme/detail/?'+new URLSearchParams({aweme_id:id,aid:'6383',device_platform:'web',version_code:'190500',version_name:'19.5.0'}));
  if(data.status_code!==0||String(data.aweme_detail?.aweme_id)!==id)throw Error(`抖音未返回作品详情（${data.status_code??'无状态码'}），请检查链接、登录态或平台限制`);
  result=parseDouyin(data.aweme_detail,`https://www.douyin.com/video/${id}`);
 }else if(platform==='kuaishou'){
  page=page||await get(source);result=parseKuaishou(page.body.toString('utf8'),source);
 }else if(platform==='bilibili'){
  const u=new URL(source),bvid=u.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
  if(!bvid)throw Error('请粘贴 B 站 BV 视频链接或分享短链');
  const view=await json('https://api.bilibili.com/x/web-interface/view?'+new URLSearchParams({bvid}));
  if(view.code!==0||!view.data)throw Error(`B 站作品信息不可用（${view.code}）`);
  const data=view.data,items=[],selected=Number(u.searchParams.get('p'));
  const pages=selected?list(data.pages).filter(p=>p.page===selected):list(data.pages);
  for(const p of pages.slice(0,Math.min(60,maxItems))){
   const play=await json('https://api.bilibili.com/x/player/playurl?'+new URLSearchParams({bvid,cid:String(p.cid),qn:'112',fnval:'1',fnver:'0',fourk:'0',platform:'html5'}));
   if(play.code!==0||play.data?.is_preview)throw Error('该 B 站视频需登录或权限，只返回试看，未加入下载');
   const parts=list(play.data?.durl);
   if(parts.length!==1||!/\.mp4(?:\?|$)/i.test(parts[0]?.url||''))throw Error('B 站当前只提供分段或分离音视频；此版本不把不完整媒体当成完整视频下载');
   const candidates=urls([parts[0].url,...list(parts[0].backup_url)]);
   items.push({type:'video',url:candidates[0],alternates:candidates.slice(1),title:p.part||data.title,duration:p.duration,key:`${bvid}:${p.cid}`,pageUrl:`https://www.bilibili.com/video/${bvid}?p=${p.page}`});
  }
  result=plan(platform,source,{title:data.title,description:data.desc||'',author:data.owner?.name||'',authorUrl:data.owner?.mid?`https://space.bilibili.com/${data.owner.mid}`:'',cover:socialMediaUrl(data.pic),publishedAt:data.pubdate||null},items);
 }else{
  const u=new URL(source),id=u.searchParams.get('fid')||u.pathname.match(/\/tv\/(?:show|v)\/([\w:]+)/)?.[1];
  if(!id||!/^\d+:\d+$/.test(id))throw Error('请使用微博视频链接（tv/show 或带 fid），暂不支持普通微博文章');
  const payload=await json('https://weibo.com/tv/api/component?page='+encodeURIComponent('/tv/show/'+id),{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:JSON.stringify({Component_Play_Playinfo:{oid:id}})}).toString()});
  const v=payload.data?.Component_Play_Playinfo;if(String(payload.code)!=='100000'||!v)throw Error('微博未返回视频信息，请登录或检查链接');
  const entries=Object.entries(v.urls||{}).sort((a,b)=>(Number(b[0].match(/\d+/)?.[0])||0)-(Number(a[0].match(/\d+/)?.[0])||0)),candidates=urls(entries.map(([,url])=>url));
  result=plan(platform,source,{title:v.title||'微博视频',author:v.author||v.nick||'',cover:socialMediaUrl(v.cover_image||v.cover_img)},candidates.length?[{type:'video',url:candidates[0],alternates:candidates.slice(1)}]:[]);
 }
 return {...result,items:result.items.slice(0,maxItems)};
}
export const SHORT_VIDEO_RESOLVERS=Object.fromEntries(Object.entries(SHORT_VIDEO_SITES).map(([id,config])=>[id,{id,label:config.label,client:id,search:config.search,resolve:({url},options)=>resolveShortVideo(id,url,options)}]));
