// ArtStation client: Marmoset Viewer search and previews.
//
// Search results ride the shared model grid — they carry Sketchfab-shaped fields
// (uid/name/author/thumbnail/license) plus `platform:'artstation'` — so card rendering, collect,
// favourites, the local library and pagination keep working unchanged.
//
// Converting a hit is an ordinary download task (`kind: 'artstation'`): queueing, concurrency,
// progress, cancel, retry, verification, saving and "open folder" are all owned by the download
// manager, so this module only finds models and resolves their embedded Marmoset viewer.
import {zhArtCategory,zhArtType} from './filter-labels.js';
import {openExternal} from './open-url.js';

const MAX_BATCH=20;

export function createArtstationUI({enabled=()=>true,$,icon,esc,toast,state,requestFeed}){
 const ui={filters:null};
 const isArt=model=>model?.platform==='artstation';
 const artworkUrl=model=>model?.artworkUrl||(model?.artId?`https://www.artstation.com/artwork/${model.artId}`:'');

// 关键词由统一的搜索框提供（app.js 拥有那个表单），这里只负责 ArtStation 自己的
// 分类/排序/精选，以及「识别单个作品地址」这条通道。
 function read(){
  return {q:$('#asset-query').value.trim().slice(0,200),category:$('#art-category').value,sort:$('#art-sort').value,picked:$('#art-picked').checked,assetType:$('#art-type').value,artist:ui.artist||null};
 }
 function write(request={}){
  for(const [key,selector] of [['q','#asset-query'],['category','#art-category'],['sort','#art-sort'],['assetType','#art-type']])if(request[key]!==undefined)$(selector).value=request[key];
  if(request.picked!==undefined)$('#art-picked').checked=!!request.picked;
  return read();
 }
 // 三种取结果的方式：艺术家浏览、关键词搜索、以及"全部作品"（不限资产类型，结果里会混进
 // 没有 Marmoset 场景的作品）。文案必须如实说明是哪一种，否则用户会以为每个结果都能转 3D。
 function describe(request){
  if(request?.artist)return `@${request.artist.username} 的${request.artist.tab==='likes'?'点赞':'作品'}`;
  const scope=request?.assetType===''?'ArtStation 作品':'Marmoset 资产';
  return request?.q?`“${request.q}” 的${scope}`:`全部${scope}`;
 }
 function start(){ui.artist=null;return requestFeed('art',read());}
 function resetFilters(){ui.artist=null;$('#art-artist').value='';return requestFeed('art',write({category:'',sort:'relevance',picked:false,assetType:'marmoset'}));}
 /** 按艺术家浏览作品或点赞。请求体带 artist，服务端据此分流到 /users/<name>/… 接口；
  *  翻页时只带 cursor，服务端从游标形状认出这是艺术家浏览。 */
 async function browseArtist(tab){
  const username=$('#art-artist').value.trim();
  if(!username)return toast('请先填写 ArtStation 用户名');
  ui.artist={username,tab};
  // 资料卡是锦上添花：拿不到也照样能列出作品，所以失败只静默跳过。
  try{
   const data=await api(`/artist?username=${encodeURIComponent(username)}`);
   if(data.artist)toast(`@${data.artist.username} · ${data.artist.name}${data.artist.projects?` · ${data.artist.projects} 个作品`:''}`);
   else toast(`没找到艺术家 @${username}，仍会尝试列出作品`);
  }catch{}
  return requestFeed('art',read());
 }

 async function api(route,body){
  const get=body===undefined;
  const response=await fetch(`/api/artstation${route}`,{method:get?'GET':'POST',cache:'no-store',headers:{'X-SFX-Local':'1',...(get?{}:{'Content-Type':'application/json'})},...(get?{}:{body:JSON.stringify(body)})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||`ArtStation 服务请求失败 HTTP ${response.status}`);
  return data;
 }
 async function loadFilters(){
  if(!enabled())return;
  try{
   const data=await api('/filters');
   ui.filters=data;
   $('#art-category').innerHTML=['<option value="">全部分类</option>',...(data.categories||[]).map(c=>`<option value="${esc(c.value)}">${esc(zhArtCategory(c.label))}</option>`)].join('');
   if(data.sorts?.length)$('#art-sort').innerHTML=data.sorts.map(s=>`<option value="${esc(s.value)}">${esc(s.label)}</option>`).join('');
   // 资产类型沿用 ArtStation 自己的分面清单；「全部作品」是本地的空值选项——选中它会让关键词
   // 命中 2D 作品，那些作品没有内嵌场景，只能当参考图下载。标签里写明哪一项能转 3D。
   if(data.assetTypes?.length){
    const keep=$('#art-type').value;
    $('#art-type').innerHTML=['<option value="">全部作品</option>',...data.assetTypes.map(t=>`<option value="${esc(t.value)}">${esc(zhArtType(t.label))}${t.value==='marmoset'?'（可转 3D）':''}</option>`)].join('');
    $('#art-type').value=data.assetTypes.some(t=>t.value===keep)?keep:'marmoset';
   }
  }catch(e){toast(`ArtStation 分类清单加载失败，仍可按关键词搜索：${e.message}`);}
 }
 async function resolve(url){
  const data=await api('/resolve',{url});
  if(!data.embedUrl)throw Error('这个作品里没有可嵌入的 Marmoset 场景');
  return data;
 }
 /** Single artwork URL -> a grid-shaped model, so paste-a-link and search share one download path. */
 async function resolveModel(url){
  const meta=await resolve(url);
  if(!meta.uid)throw Error('无法从作品地址得到稳定的作品标识');
  return {uid:meta.uid,platform:'artstation',artId:meta.artId,name:meta.title||url,author:meta.author||'未知作者',thumbnail:meta.thumbnail||null,size:meta.size||null,license:'ArtStation 作品 · 需确认授权',downloadable:false,artworkUrl:meta.artworkUrl||url,embedUrl:meta.embedUrl,mviewUrl:meta.mviewUrl||null,platformCategories:meta.platformCategories||[],categories:meta.categories||[]};
 }
 async function resolveEmbed(model){
  const meta=await resolve(artworkUrl(model));
  model.embedUrl=meta.embedUrl;model.mviewUrl=meta.mviewUrl||null;
  if(meta.title)model.name=meta.title;
  return meta.embedUrl;
 }
/** 只有内嵌了 Marmoset 场景的作品才值得开 3D 预览弹窗。 */
const has3dScene=model=>isArt(model)&&model.hasMarmoset!==false;
/** 没有场景的纯图片作品（全站搜索会搜到）不套那层空壳弹窗——点开只看到「本站没有可预览的 3D 内容」，
 *  等于白点一次。直接开官方作品页，那里才是这张图真正的出处。 */
function openArtwork(model){
 const url=artworkUrl(model);
 if(!url)return toast('这个作品没有可访问的 ArtStation 页面地址');
 // 走 openExternal：安装版的 WebView 不认 target="_blank"/window.open，得让系统浏览器接管。
 openExternal(url);
}
/** ArtStation previews are the author's own Marmoset Viewer iframe (embed id resolved lazily). */
async function openPreview(model){
 const artwork=artworkUrl(model);
 $('#model-details').innerHTML=`<div class="eyebrow">MARMOSET VIEWER</div><h2>${esc(model.name)}</h2><p class="author-name">by ${esc(model.author)}</p><div class="details-stats"><div><strong>${esc(model.artId||'—')}</strong><span>作品标识</span></div><div><strong>${esc((model.username||'—').slice(0,12))}</strong><span>作者账号</span></div></div><div class="detail-license"><strong>${esc(model.license)}</strong><a href="${esc(artwork)}" target="_blank" rel="noopener noreferrer">在 ArtStation 打开作品 ${icon('external')}</a><p>场景来自作品页内嵌的 Marmoset Viewer；导出任务与 Sketchfab 共用同一个下载管理与校验流程。</p></div><button class="secondary" data-action="collect" data-uid="${esc(model.uid)}">${icon('folder')}加入我的模型库</button><button class="primary" data-action="download" data-uid="${esc(model.uid)}">${icon('download')}下载并转换</button><a class="source-link" href="${esc(artwork)}" target="_blank" rel="noopener noreferrer">ArtStation 作品页 ${icon('external')}</a>`;
 $('#viewer').removeAttribute('src');
 $('#preview-dialog').showModal();
 // 舞台切换见 library-view.js 的 showFrameStage：iframe 在 index.html 里默认 hidden，
 // 这条路径不走 gltfPreview，必须自己放出来，否则弹窗里只剩黑底和「正在加载模型…」。
 const frame=$('#viewer'),stageCanvas=document.getElementById('viewer-canvas'),stageState=document.getElementById('state');
 if(stageCanvas)stageCanvas.hidden=true;
 if(frame)frame.hidden=false;
 if(stageState){stageState.textContent='';stageState.className='';}
  try{
   $('#viewer').src=model.embedUrl||await resolveEmbed(model);
  }catch(e){if(stageState){stageState.textContent=`无法加载交互预览：${e.message}`;stageState.className='error';}}
 }

function setup(){
 // 关键词与提交按钮属于统一搜索表单（app.js），这里只接住 ArtStation 自己的筛选与分类清单。
 for(const id of ['art-category','art-sort','art-picked','art-type'])$('#'+id).onchange=()=>start();
 $('#art-reset-filters').onclick=()=>resetFilters();
 // 艺术家浏览：回车等同按"看作品"，与表单提交的直觉一致。
 $('#art-artist-projects').onclick=()=>browseArtist('projects');
 $('#art-artist-likes').onclick=()=>browseArtist('likes');
 $('#art-artist').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();browseArtist('projects');}};
 return loadFilters();
}
 return Object.assign(ui,{isArt,has3dScene,setup,start,read,write,describe,resolveModel,resolveEmbed,openPreview,openArtwork,artworkUrl,browseArtist,maxBatch:MAX_BATCH});
}
