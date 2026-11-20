// Endpoint references: jiuhunwl/music_jx; see docs/third-party/music-jx.md.
import {readPublic,validateUrl} from './public-http.mjs';
import {MUSIC_SITES} from '../src/library/music-platforms.js';
import {extractShareUrl} from '../src/library/short-video-platforms.js';
import {kuwoReader} from './kuwo-http.mjs';

const safeUrl=value=>{if(!value)return '';try{return validateUrl(String(value).replace(/^\/\//,'https://')).href;}catch{return '';}};
const blocked=()=>Error('平台未提供完整音频，可能需要登录、购买或会员权限；不会将试听片段当作完整歌曲下载');
export function completeAudio(item,duration=0){
 if(!item||!safeUrl(item.url)||item.freeTrialInfo||item.is_trial||item.is_preview||item.preview||item.trial||item.code<0)throw blocked();
 if(duration&&item.time&&Number(item.time)<duration*.95)throw blocked();
 return safeUrl(item.url);
}
function result(platform,source,meta,url,alternates=[]){
 if(!url)throw blocked();
 return {...meta,source,items:[{...meta,type:'audio',url,alternates:alternates.map(safeUrl).filter(Boolean),thumb:meta.cover||'',pageUrl:source,key:`${platform}:${source}`}],skipped:[],rendition:'available'};
}
export async function resolveMusic(platform,input,{signal,read=readPublic,maxItems=20}={}){
 const config=MUSIC_SITES[platform];if(!config)throw Error('不支持的音乐平台');
 const matches=u=>config.hosts.some(host=>u.hostname===host||u.hostname.endsWith('.'+host));
 // NetEase uses hash routing; validate the network target separately without losing #/song?id.
 const headers={'User-Agent':'Mozilla/5.0',Referer:`https://${config.hosts[0]}/`};
 const request=platform==='kuwo'?kuwoReader(read,{signal,headers}):read;
 const get=async(url,extra={})=>{const r=await request(url,{signal,headers,maxBytes:4*1024**2,timeout:20000,...extra});if(r.status!==200)throw Error(`${config.label} 请求失败（HTTP ${r.status}）`);return r;};
 const json=async(url)=>{const r=await get(url);try{return JSON.parse(r.body.toString('utf8'));}catch{throw Error(`${config.label} 返回验证页，请登录后重试`);}};
 const extracted=extractShareUrl(input);
 if(!/^https?:\/\//i.test(extracted)){
  if(!config.search)throw Error('汽水音乐暂仅支持单曲分享链接');
  const keyword=String(input||'').trim().slice(0,100);if(!keyword)throw Error('请输入歌名、歌手或单曲链接');
  const limit=Math.min(30,Math.max(1,Number(maxItems)||20));
  const data=await json(platform==='netease'?'https://music.163.com/api/search/get/web?'+new URLSearchParams({s:keyword,type:'1',limit:String(limit),offset:'0'}):'https://www.kuwo.cn/search/searchMusicBykeyWord?'+new URLSearchParams({vipver:'1',client:'kt',ft:'music',cluster:'0',strategy:'2012',encoding:'utf8',rformat:'json',mobi:'1',issubtitle:'1',show_copyright_off:'1',pn:'0',rn:String(limit),all:keyword}));
  if(platform==='netease'&&data.code!==200)throw Error(`${config.label} 搜索不可用，请登录或完成站点验证后重试`);
  const songs=platform==='netease'?data.result?.songs:data.abslist;
  if(!Array.isArray(songs))throw Error(`${config.label} 搜索响应异常，未返回歌曲列表`);
  const items=(songs||[]).slice(0,limit).map(song=>{
   const id=String(song.id||song.rid||song.MUSICRID?.replace(/^MUSIC_/, '')||'');if(!/^\d{1,20}$/.test(id))return null;
   const pageUrl=platform==='netease'?`https://music.163.com/song?id=${id}`:`https://www.kuwo.cn/play_detail/${id}`;
   return {key:`${platform}:${id}`,type:'audio',url:'',pageUrl,title:song.name||song.NAME,author:platform==='netease'?(song.artists||song.ar||[]).map(a=>a.name).join(' / '):song.ARTIST||song.artist||'',thumb:safeUrl(song.album?.picUrl||song.al?.picUrl||song.pic||(song.web_albumpic_short?`https://img2.kuwo.cn/star/albumcover/${song.web_albumpic_short}`:'')),duration:platform==='netease'?Number(song.duration||song.dt||0)/1000:Number(song.DURATION||song.duration||0),album:song.ALBUM||(typeof song.album==='string'?song.album:song.album?.name||song.al?.name||'')};
  }).filter(Boolean);
  return {title:`${config.label} · ${keyword}`,items,source:keyword,skipped:[],search:true};
 }
 let target=new URL(extracted);validateUrl(target.href);if(!matches(target))throw Error('链接与音乐平台不匹配');
 const hasId=u=>platform==='netease'?(/\/song(?:\/|\?|$)/.test(u.pathname+u.hash)) :platform==='kuwo'?(/\/(?:play_detail|song)\/\d+/.test(u.pathname)||u.searchParams.has('mid')):u.searchParams.has('track_id');
 if(!hasId(target)){const r=await get(target.href);target=new URL(r.url||target.href);validateUrl(target.href);if(!matches(target))throw Error('音乐短链跳转到了其他站点');}
 const source=target.href;
 if(platform==='netease'){
  const hash=target.hash.replace(/^#\/?/,'/'),id=target.searchParams.get('id')||new URLSearchParams(hash.split('?')[1]||'').get('id')||target.pathname.match(/\/song\/(\d+)/)?.[1];
  if(!/^\d{1,20}$/.test(id||''))throw Error('请粘贴网易云单曲链接，暂不支持歌单或专辑');
  const detail=await json('https://music.163.com/api/song/detail/?'+new URLSearchParams({id,ids:JSON.stringify([id])}));
  const song=detail.songs?.[0];if(detail.code!==200||String(song?.id)!==id)throw Error('网易云歌曲不存在或不可访问');
  const play=await json('https://music.163.com/api/song/enhance/player/url?'+new URLSearchParams({ids:JSON.stringify([id]),br:'320000'}));
  const entry=play.data?.find(item=>String(item.id)===id),url=completeAudio(entry,song.duration||song.dt);
  let lyrics='';try{lyrics=(await json('https://music.163.com/api/song/lyric?'+new URLSearchParams({id,lv:'-1',kv:'-1',tv:'-1'}))).lrc?.lyric||'';}catch(error){signal?.throwIfAborted();}
  return result(platform,source,{title:song.name,author:(song.artists||song.ar||[]).map(a=>a.name).join(' / '),album:song.album?.name||song.al?.name||'',cover:safeUrl(song.album?.picUrl||song.al?.picUrl),duration:Number(song.duration||song.dt||0)/1000,lyrics,bitrate:entry.br||null},url);
 }
 if(platform==='kuwo'){
  const id=target.pathname.match(/\/(?:play_detail|song)\/(\d+)/)?.[1]||target.searchParams.get('mid');if(!/^\d{1,20}$/.test(id||''))throw Error('请粘贴酷我单曲链接');
  const detail=await json('https://www.kuwo.cn/api/www/music/musicInfo?'+new URLSearchParams({mid:id,httpsStatus:'1'}));
  const song=detail.data;if(detail.code!==200||!song||String(song.rid)!==id)throw Error('酷我歌曲信息不可访问，请先登录或完成站点验证');
  const play=await json('https://www.kuwo.cn/api/v1/www/music/playUrl?'+new URLSearchParams({mid:id,type:'music',httpsStatus:'1'}));
  if(play.code!==200)throw blocked();const url=completeAudio(play.data,Number(song.duration||0)*1000);
  let lyrics='';try{const lrc=await json(`https://www.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId=${id}`);lyrics=(lrc.data?.lrclist||[]).map(row=>`[${String(Math.floor(Number(row.time)/60)).padStart(2,'0')}:${(Number(row.time)%60).toFixed(2).padStart(5,'0')}]${row.lineLyric}`).join('\n');}catch(error){signal?.throwIfAborted();}
  return result(platform,source,{title:song.name,author:song.artist||'',album:song.album||'',cover:safeUrl(song.pic),duration:Number(song.duration||0),lyrics},url);
 }
 const id=target.searchParams.get('track_id')||target.pathname.match(/\/track\/(\d+)/)?.[1];if(!/^\d{1,22}$/.test(id||''))throw Error('请粘贴汽水音乐单曲分享链接');
 const data=await json(`https://beta-luna.douyin.com/luna/h5/seo_track?track_id=${id}&device_platform=web`),track=data.seo_track?.track,player=data.track_player;
 if(!track||!player||String(track.id||track.track_id)!==id)throw Error('汽水音乐未返回该歌曲，可能需要登录或站点接口已调整');
 let candidates=[];
 if(player.video_model){let model;try{model=JSON.parse(player.video_model);}catch{throw blocked();}candidates=Object.values(model.video_list||{}).sort((a,b)=>Number(b.bitrate||0)-Number(a.bitrate||0));}
 else if(player.url_player_info){const url=safeUrl(player.url_player_info);if(!url)throw blocked();const info=await json(url);candidates=info.Result?.Data?.PlayInfoList||[];}
 const first=candidates[0];if(!first||player.is_preview||player.is_trial||player.freeTrialInfo)throw blocked();
 const decode=value=>{if(!value)return '';if(/^https?:/.test(value))return safeUrl(value);return safeUrl(Buffer.from(value,'base64').toString('utf8'));};
 const urls=candidates.flatMap(c=>[c.main_url,c.backup_url,c.MainPlayUrl,c.BackupPlayUrl]).map(decode).filter(Boolean);
 const url=completeAudio({url:urls[0],is_preview:first.is_preview,is_trial:first.is_trial,time:Number(first.duration||0)*1000},Number(track.duration||0));
 return result(platform,source,{title:track.name||track.title||'汽水音乐',author:(track.artists||[]).map(a=>a.name||a.user_info?.nickname||'').filter(Boolean).join(' / '),album:track.album?.name||'',cover:safeUrl(track.album?.url_cover?.urls?.[0]||track.album?.cover?.urls?.[0]),duration:Number(track.duration||0)/1000,lyrics:data.lyric?.content||''},url,urls.slice(1));
}
export const MUSIC_RESOLVERS=Object.fromEntries(Object.entries(MUSIC_SITES).map(([id,config])=>[id,{id,label:config.label,client:id,search:config.search,resolve:({url},options)=>resolveMusic(id,url,options)}]));
