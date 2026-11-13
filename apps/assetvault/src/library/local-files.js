// 资产库目录里的「未登记文件」+ 通用文件预览。
//
// 资产库的卡片来自下载任务记录；用户自己拷进资产库文件夹的素材（模型、贴图、材质、字体、
// 音频、视频、PDF）没有任何记录，原本永远看不见。这个模块扫一遍资产库自己的目录，把这些
// 文件补进同一个网格，并按扩展名选渲染器。两条硬约束：
//   1. 只读——扫描不写盘、不改名、不删除；
//   2. 3D / 全景复用 gltf-preview 那个渲染器（单例，canvas 在 #preview-dialog 里），
//      图片/字体/音频/视频/文档才用 #file-preview-dialog，两种弹窗分工明确。
import {TGALoader} from 'three/examples/jsm/loaders/TGALoader.js';
import {decodeTiff} from './tiff-decode.js';
import {decodePsd} from './psd-decode.js';
import {groupImageSequences} from './image-sequence.js';
import {assetCard,cardMedia,cardNote} from './card-shell.js';
import {favoriteUid,registerFavoriteTarget,favoriteButtonHtml} from './favorite-targets.js';
/** 字节格式化只有一份实现（下载任务卡那边），这里复用，别再抄第三遍。 */
import {sizeText as fmtBytes} from './download-card.js';
// 格式清单的唯一事实源：以前这里有 NATIVE_IMAGE / SERVER_IMAGE / GALLERY_IMAGE /
// BROWSER_VIDEO 四份正则和服务端各写一份，新增 RAW / FLV / AI 时必然漏。现在全部从注册表派生。
import {FORMATS, extensionOf, formatOf, formatKind, formatsOfModel} from './format-registry.js';
import {matchesFormatFilter} from './format-filter-selection.js';
// 文档渲染的纯策略层（无 DOM、无第三方库，主包几乎不增重）：分派判定与提示文案都从它取。
// 真正的渲染器 doc-render.js 是独立 bundle，只在第一次打开文档时 import() 加载。
import {docRenderModeOf, DOC_HINTS, DOC_CONVERT_UNAVAILABLE_HINT, DOC_RENDER_TIMEOUT_MS} from './doc-render-state.js';

const extsWhere = predicate => new Set(Object.values(FORMATS).filter(predicate).map(item => item.ext));
/** 浏览器自己能显示的图片，直接 <img>。 */
const NATIVE_EXTS = extsWhere(item => item.preview === 'native');
/** 浏览器解不了、但后端能转 PNG 的格式（PSD / 相机 RAW / HEIC / DDS）。 */
const THUMB_EXTS = extsWhere(item => item.preview === 'thumb' || item.preview === 'decode-psd');
/** 能进图片素材包预览的格式（缩略图墙 + 大图）：原生图 + 后端转码图。 */
const GALLERY_EXTS = new Set([...NATIVE_EXTS, ...extsWhere(item => item.preview === 'thumb' && (item.group === 'image' || item.kind === 'image'))]);
/** 视频是否原生可播由 openFile() 直接问注册表的 preview 字段，这里不再留第二份判据。 */
const SERVER_IMAGE = name => THUMB_EXTS.has(extensionOf(name));
const GALLERY_IMAGE = name => GALLERY_EXTS.has(extensionOf(name));
const KIND_LABEL={model:'3D 模型',env:'环境贴图',image:'图片',font:'字体',audio:'音频',video:'视频',document:'文档',other:'其他'};
const KIND_ICON={model:'cube',env:'image',image:'image',font:'list',audio:'play',video:'play',document:'list',other:'grid'};
/** 资产库的类型筛选值 → 本地文件类型。资源包（packs）没有对应的单个文件，不匹配。 */
const KIND_FILTER={models:'model',textures:'image',hdris:'env',images:'image'};
/** 资产包（一个下载资产＝一张卡）的类型名、图标与筛选值。 */
const PACKAGE_LABEL={model:'模型',material:'材质',skybox:'天空盒',images:'图片素材'};
const PACKAGE_ICON={model:'cube',material:'grid',skybox:'image',images:'image'};
const PACKAGE_FILTER={models:'model',textures:'material',hdris:'skybox',images:'images'};

function fmtTime(ms){
 const d=new Date(Number(ms)||0);
 if(Number.isNaN(d.getTime()))return '—';
 const pad=v=>String(v).padStart(2,'0');
 return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 包内条目的 rel 是相对包目录的（`JRO_JP.Ornament01_out.png`），取文件接口要的是相对扫描根的路径，
 *  少拼一层包目录就会 404/400，缩略图一个都不出来（2026-10-21 实测）。 */
export function packageRel(pkg,rel){return pkg.rel?`${pkg.rel}/${rel}`:rel;}
/** 缩略图 URL：一律走后端缩略图缓存（PNG 缩放、PSD 转码都在那里，w 是最大边）。
 *  后端遇到做不了的格式（SVG / 没装 ffmpeg）会原样透传，所以这里不必要再按格式分支。
 *  导出给画板视图用：画板要显示素材包封面，走的是同一套取图规则。 */
export function packageImageUrl(pkg,rel,width){
  if(pkg.imageUrl)return pkg.imageUrl(rel,true);
  return `/api/local/thumb?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent(packageRel(pkg,rel))}&w=${width||512}`;
}

export function createLocalFiles({$,icon,esc,gltfPreview,notify,onChanged,onFetchPackage,storage,favorites=()=>new Set()}){
 let files=[];
 let packages=[];
 // 图片序列是「视图层」概念：磁盘上仍是一个个文件，只有渲染时才折叠成一张卡。
 let sequences=[];
 let sequenceMembers=new Set();
 let truncated=false;
 let loading=false;
 let seq=0;
 let pending=null;
 // ponytail: reuse the existing host storage; the scan remains authoritative.
 try{
  const index=JSON.parse(storage?.getItem('sfx-local-index-v1')||'null');
  if(index?.version===1&&Array.isArray(index.files)&&Array.isArray(index.packages)){
   files=index.files;packages=index.packages;truncated=!!index.truncated;
   rebuildSequences();
  }
 }catch{}

 const keyOf=file=>`${file.root}|${file.rel}`;
 const fileUrl=file=>`/api/local/file?root=${encodeURIComponent(file.root)}&rel=${encodeURIComponent(file.rel)}`;
 /** 需要转封装的视频走这里：服务端用 ffmpeg 边转边发 mp4。 */
 const playUrl=file=>`/api/local/play?root=${encodeURIComponent(file.root)}&rel=${encodeURIComponent(file.rel)}`;

 /** 问服务端这个视频能不能转、里面是什么编码，用来给失败场景一句准确的提示。 */
 async function probeVideo(file){
  try{
   const response=await fetch(`${playUrl(file)}&probe=1`,{cache:'no-store'});
   return response.ok?await response.json():null;
  }catch{return null;}
 }

 /** 登记：给没有 info.json 的包补一份（uid + 事实字段 + 包统计）。这是唯一的写盘点，
  *  扫描永远只读 —— 用户不点这个按钮，磁盘上什么都不会变。 */
 async function register(pkg){
  if(!pkg)return null;
  try{
   const response=await fetch('/api/library/register',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({root:pkg.root,rel:pkg.rel})});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
   notify?.(data.skipped?'这个资产已经有 info.json 了':'已写入 info.json，这个资产有了固定身份');
   await onChanged?.();
   return data;
  }catch(error){
   notify?.(`登记失败：${error.message}`);
   return null;
  }
 }

 /** 整包下载：走隐藏 <a>，让浏览器的下载管理器接管（服务端带 Content-Disposition: attachment）。
  *  不打 fetch——几 GB 的包读进 Blob 再存等于把文件在内存里过一遍。 */
 function downloadPackage(pkg,button){
  if(!pkg)return;
  const size=pkg.bytes?`（${fmtBytes(pkg.bytes)}）`:'';
  notify?.(pkg.type==='zip'?'正在传这个压缩包…':`正在打包 ${pkg.fileCount} 个文件${size}，浏览器会接着弹出下载`);
  button?.classList.add('is-busy');
  // ZIP 包沿用原名，文件夹包用资产标题；Windows 不允许的字符换成下划线。
  const base=String(pkg.type==='zip'?pkg.rel.split('/').pop():pkg.title||pkg.rel.split('/').pop()||'asset').replace(/[\\/:*?"<>|]/g,'_');
  const a=document.createElement('a');
  a.href=packageZipUrl(pkg);
  a.download=/\.zip$/i.test(base)?base:`${base}.zip`;
  a.rel='noopener';
  a.style.display='none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(()=>button?.classList.remove('is-busy'),4000);
 }

 /** 扫描资产库自己的目录。根由后台服务决定（下载目录 + 各任务下载根），前端不传路径。 */
 function scan({force=false}={}){
  if(pending&&!force)return pending;
  const task=readScan(force);pending=task;
  task.finally(()=>{if(pending===task)pending=null;}).catch(()=>{});
  return task;
 }
 async function readScan(force){
  const mine=++seq;
  loading=true;
  try{
   const response=await fetch(`/api/library/scan${force?'?force=1':''}`,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:'{}'});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
   if(mine!==seq)return null;
   files=Array.isArray(data.files)?data.files:[];
   packages=Array.isArray(data.packages)?data.packages:[];
   truncated=!!data.truncated;
   rebuildSequences();
   const index=JSON.stringify({version:1,files,packages,truncated});
   try{if(index.length<2*1024*1024)storage?.setItem('sfx-local-index-v1',index);else storage?.setItem('sfx-local-index-v1','null');}catch{}
   return {files,packages,truncated};
  }catch(error){
   throw error;
  }finally{
   if(mine===seq)loading=false;
  }
 }

 /** 搜索词与类型筛选跟着资产库工具条走，两种条目共用一套条件。 */
 function matches(file,{query='',kind='',formats=null}={}){
  if(kind){
   const want=KIND_FILTER[kind];
   if(!want||file.kind!==want)return false;
  }
  // 与高级检索面板同一个匹配器：服务端筛模型，这里筛磁盘上未登记的零散文件 / 资产包。
  if(formats?.active&&!matchesFormatFilter([file.ext||file.format].filter(Boolean),formats))return false;
  const q=String(query||'').trim().toLowerCase();
  if(!q)return true;
  return file.name.toLowerCase().includes(q)||file.rel.toLowerCase().includes(q);
 }

 /** 资产包共用同一套搜索词与类型筛选。 */
 function matchesPackage(pkg,{query='',kind='',formats=null}={}){
  if(kind){
   const want=PACKAGE_FILTER[kind];
   if(!want||pkg.category!==want)return false;
  }
  // 包级格式 = info.json 的 format + 包内主文件 / 条目清单的后缀。
  if(formats?.active&&!matchesFormatFilter(formatsOfModel(pkg),formats))return false;
  const q=String(query||'').trim().toLowerCase();
  if(!q)return true;
  return [pkg.title,pkg.author,pkg.rel].some(value=>String(value||'').toLowerCase().includes(q));
 }

 /** 序列索引只从 files 派生，不写盘；扫描结果变了就整表重建。 */
 function rebuildSequences(){
  const grouped=groupImageSequences(files);
  sequences=grouped.sequences;
  sequenceMembers=grouped.memberKeys;
 }

 const frameUrl=(seq,frame)=>`/api/local/file?root=${encodeURIComponent(frame.root||seq.root)}&rel=${encodeURIComponent(frame.rel)}`;

 /** 一条序列一张卡：封面用首帧缩略图，角标写帧数。点开进播放器，不是逐张翻。 */
 function sequenceCard(seq){
  const cover=seq.cover||seq.frames[0];
  const thumb=`/api/local/thumb?w=384&root=${encodeURIComponent(cover.root||seq.root)}&rel=${encodeURIComponent(cover.rel)}`;
  return `<article class="local-file-card local-sequence-card" data-sequence="${esc(seq.key)}" data-uid="${esc(seq.uid)}" tabindex="0" role="button"
   aria-label="播放图片序列 ${esc(seq.label)}，共 ${seq.count} 帧" title="${esc(`${seq.dir?`${seq.dir}/`:''}${seq.prefix}*`)} · ${seq.count} 帧 · ${esc(fmtBytes(seq.bytes))} · ${esc(fmtTime(seq.mtime))}">
   <div class="local-seq-cover"><img src="${thumb}" loading="lazy" alt=""><span class="local-seq-badge">${icon('play')}${seq.count}</span></div>
   <div class="local-file-copy"><strong>${esc(seq.label)}</strong><small>图片序列 · ${esc(fmtBytes(seq.bytes))}</small></div>
  </article>`;
 }

 // 播放器只有一个实例：换序列/关弹窗都要停掉上一个的定时器与键盘监听。
 let seqPlayer=null;
 function stopSequence(){
  if(!seqPlayer)return;
  clearTimeout(seqPlayer.timer);
  if(seqPlayer.onKey)seqPlayer.dlg?.removeEventListener('keydown',seqPlayer.onKey);
  seqPlayer=null;
 }

 function openSequence(seq){
  if(!seq)return;
  stopSequence();
  const pseudo={name:seq.label,ext:seq.ext,kind:'image',bytes:seq.bytes,mtime:seq.mtime,rel:`${seq.dir?`${seq.dir}/`:''}${seq.prefix}*`};
  const stage=showOther(pseudo,
   `<div class="seq-player">
     <div class="seq-stage"><img class="seq-frame" alt="${esc(seq.label)}" decoding="async"></div>
     <div class="seq-controls">
      <button class="seq-btn" type="button" data-seq-toggle aria-label="暂停">${icon('pause')}</button>
      <input class="seq-seek" type="range" min="0" max="${Math.max(0,seq.count-1)}" value="0" step="1" aria-label="帧位置">
      <span class="seq-pos">1 / ${seq.count}</span>
      <div class="seq-fps" role="group" aria-label="帧率（FPS）">
       ${[6,8,12,15,24,30].map(value=>`<button type="button" class="seq-fps-btn${value===12?' is-active':''}" data-fps="${value}" aria-label="${value} 帧每秒">${value}</button>`).join('')}
      </div>
      <button type="button" class="seq-btn seq-loop-btn is-active" data-seq-loop aria-label="循环播放" title="循环播放">${icon('refresh')}</button>
     </div>
    </div>`,
   `图片序列 · ${seq.count} 帧 · 空格播放/暂停 · ← → 逐帧`);
  const img=stage.querySelector('.seq-frame');
  const toggle=stage.querySelector('[data-seq-toggle]');
  const seek=stage.querySelector('.seq-seek');
  const pos=stage.querySelector('.seq-pos');
  const fpsGroup=stage.querySelector('.seq-fps');
  const loopBtn=stage.querySelector('[data-seq-loop]');
  let loopOn=true;
  if(!img||!toggle)return;
  const player={dlg:$('#file-preview-dialog'),index:0,playing:false,timer:null,fps:12};
  seqPlayer=player;
  const warm=new Set();
  const paint=index=>{
   const at=((index%seq.count)+seq.count)%seq.count;
   player.index=at;
   img.src=frameUrl(seq,seq.frames[at]);
   seek.value=String(at);
   pos.textContent=`${at+1} / ${seq.count}`;
   // 顺着播放方向预热后面三帧：24/30fps 时现解码会拖影。
   for(const step of [1,2,3]){
    const url=frameUrl(seq,seq.frames[(at+step)%seq.count]);
    if(warm.has(url))continue;
    warm.add(url);
    const pre=new Image();
    pre.decoding='async';
    pre.src=url;
   }
  };
  const pause=()=>{
   player.playing=false;
   clearTimeout(player.timer);player.timer=null;
   toggle.innerHTML=icon('play');toggle.setAttribute('aria-label','播放');
  };
  const tick=()=>{
   if(seqPlayer!==player)return;
   // 末帧不循环就停住，别让定时器空转到用户关窗。
   if(player.index>=seq.count-1&&!loopOn){pause();return;}
   paint(player.index+1);
   player.timer=setTimeout(tick,1000/player.fps);
  };
  const play=()=>{
   if(player.playing)return;
   player.playing=true;
   toggle.innerHTML=icon('pause');toggle.setAttribute('aria-label','暂停');
   player.timer=setTimeout(tick,1000/player.fps);
  };
  toggle.addEventListener('click',()=>{if(player.playing)pause();else play();});
  // 拖进度条时先停：否则定时器会和手一起改帧号，画面来回跳。
  seek.addEventListener('input',()=>{pause();paint(Number(seek.value)||0);});
  fpsGroup.addEventListener('click',e=>{
   const b=e.target.closest('[data-fps]'); if(!b)return;
   player.fps=Math.max(1,Number(b.dataset.fps)||12);
   fpsGroup.querySelectorAll('.seq-fps-btn').forEach(x=>x.classList.toggle('is-active',x===b));
   if(!player.playing)return;
   clearTimeout(player.timer);
   player.timer=setTimeout(tick,1000/player.fps);
  });
  loopBtn?.addEventListener('click',()=>{
   loopOn=!loopOn;
   loopBtn.classList.toggle('is-active',loopOn);
   loopBtn.setAttribute('aria-label',loopOn?'循环播放':'单次播放');
   loopBtn.setAttribute('title',loopOn?'循环播放':'单次播放');
  });
  player.onKey=event=>{
   if(seqPlayer!==player)return;
   if(event.key===' '){event.preventDefault();if(player.playing)pause();else play();return;}
   if(event.key==='ArrowLeft'){event.preventDefault();pause();paint(player.index-1);return;}
   if(event.key==='ArrowRight'){event.preventDefault();pause();paint(player.index+1);}
  };
  player.dlg?.addEventListener('keydown',player.onKey);
  paint(0);
  play();
 }

 function card(file){
  const label=KIND_LABEL[file.kind]||'其他';
  return `<article class="local-file-card" data-file="${esc(keyOf(file))}" tabindex="0" role="button"
   aria-label="预览 ${esc(file.name)}" title="${esc(file.rel)}">
   <div class="local-file-badge">${icon(KIND_ICON[file.kind]||'cube')}<span>${esc(file.ext||'—')}</span></div>
   <div class="local-file-copy"><strong>${esc(file.name)}</strong><small>${esc(label)} · ${esc(fmtBytes(file.bytes))}</small><small>${esc(fmtTime(file.mtime))}</small></div>
  </article>`;
 }

 /** 一个资产包一张卡：封面是官方缩略图或包内图片，点开看包内文件或直接进 3D 预览。
  *  DOM 与远端资产卡共用 card-shell，下载键、标题行、类型角标的位置和样式都一样。 */
function packageCard(pkg){
  const label=PACKAGE_LABEL[pkg.category]||'资产';
  const kindIcon=icon(PACKAGE_ICON[pkg.category]||'cube');
 // 登记 / 补原图这些低频动作已收进右键菜单，不在卡片信息面板里摆中文文字键。
 // 整包下载：文件夹包由后端现场压成 ZIP（不落临时文件），ZIP 包直接发原文件。
  // 主机和局域网访客都显示——访客拿到的是自己电脑上的一个压缩包。
  const download=`<button type="button" class="card-download" data-package-download="${esc(packageKey(pkg))}" title="把整个素材包下载成 ZIP" aria-label="下载素材包 ${esc(pkg.title)}">${icon('download')}<span>下载</span></button>`;
  // 边下边写的图片包：清单带 status，压一个角标说明这是还在长的画板，不是成品。
  const liveBadge=pkg.status==='downloading'||pkg.status==='incomplete'
   ?`<span class="card-live-badge" data-status="${esc(pkg.status)}">${pkg.status==='downloading'?'下载中':'未完成'} · ${Number(pkg.imageCount)||0} 张</span>`
   :'';
  // 「只入库」的远程收藏卡：只有元数据 + 平台远程封面，一张图都没有。
  // 和「下载中」用同一套角标样式，但文案说清它是收藏而不是成品。
  const remoteBadge=pkg.remote
   ?`<span class="card-live-badge" data-status="remote">远程收藏${Number(pkg.imageCount)?` · ${Number(pkg.imageCount)} 张`:''}</span>`
   :'';
 // 远程卡补原图也收进右键菜单。
  // 多图集合：包里能进预览的图片 ≥2 张、且不是边下边写的半成品时，媒体区改成 2×2 拼贴。
  // 计数用左上角蓝色「N 张」角标（与画板的绿、单图卡的灰区分），不在这里的脚注里重复。
  const galleryImgs=packageImages(pkg);
  const isCollection=galleryImgs.length>1&&!liveBadge;
  // 素材包的封面是 1:1 图，按 contain 显示（cover 会把 alpha 蒙版的边切掉）。
  const cover=pkg.thumb?`/api/image?url=${encodeURIComponent(pkg.thumb)}`:(pkg.cover?packageImageUrl(pkg,pkg.cover,384):'');
  const media=isCollection
   ? collectionMedia(galleryImgs,pkg)
   : cardMedia({src:cover?esc(cover):'',alt:esc(pkg.title),icon:kindIcon,text:esc(label)});
  // 脚注：平台标签 + 名称 + 作者，统一压在封面底部（图片内部），不另占封面外的文字栏，
  // 也不在封面左上角再摆一条类型标（避免和角标挤在同一角）。下载按钮挪到脚注右上角。
 const facts=[label,pkg.author||'',isCollection?`${galleryImgs.length} 张`:'',pkg.rel||''].filter(Boolean);
 // 本地素材包也用同一颗心形键。它已经在资产库里（只是由磁盘索引画卡），所以登记为
 // skipCollect：只记收藏标记，不再往 state.models 里塞一份会把素材包卡顶掉的模型卡。
 const favUid=/^[a-f0-9]{32}$/i.test(pkg.uid||'')?pkg.uid:favoriteUid('package',packageKey(pkg));
 registerFavoriteTarget(favUid,{uid:favUid,name:pkg.title,platform:pkg.platform||'local',assetType:'images',thumbnail:pkg.thumb||pkg.cover||''},{skipCollect:true});
 const heart=favoriteButtonHtml({uid:favUid,saved:favorites().has(favUid),icon,esc});
 const overlay=`${isCollection?countBadge(galleryImgs.length):''}<button class="preview-hit" aria-label="打开素材包 ${esc(pkg.title)}"><span>${kindIcon}打开素材包</span></button>${liveBadge}${remoteBadge}${heart}<button type="button" class="card-facts-btn" data-card-facts title="查看信息" aria-label="查看信息">${icon('help')}</button><div class="card-facts">${facts.map(line=>`<p>${esc(line)}</p>`).join('')}</div>`;
  return assetCard({
   keyName:'package',
   keyValue:esc(packageKey(pkg)),
   className:isCollection?'pkg-collection':'thumb-contain',
   media,
   overlay,
   title:esc(pkg.title),
   titleAttrs:`title="${esc(pkg.rel||pkg.title)}"`,
   byline:pkg.author?`<span class="card-byline">${esc(pkg.author)}</span>`:'',
   actions:download,
  });
}
/** 左上角蓝色「N 张」角标芯片：多图集合卡的识别标记（与画板的绿、单图卡的灰区分）。 */
function countBadge(n){return `<span class="pkg-count-badge">${icon('grid')}<span>${n} 张</span></span>`;}
/** 多图集合卡的媒体区：取前 4 张图拼成 2×2，超额时第 4 格压「+N」。 */
function collectionMedia(imgs,pkg){
  const shown=imgs.slice(0,4);
  const tiles=shown.map((im,i)=>{
   const dim=i===3&&imgs.length>4;
   const src=packageImageUrl(pkg,im.rel,256);
   return `<div class="pkg-tile"><img class="pkg-tile-img" src="${esc(src)}" alt="" loading="lazy" decoding="async">${dim?`<span class="pkg-tile-plus">+${imgs.length-3}</span>`:''}</div>`;
  }).join('');
  return `<div class="pkg-collage">${tiles}</div>`;
}

 function packageKey(pkg){return `${pkg.root}|${pkg.rel}`;}
 function packageFileUrl(pkg,rel){return `/api/local/file?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent(packageRel(pkg,rel))}`;}
 /** 整包下载地址：文件夹包走现场打包端点，ZIP 包直接发原文件（不套娃）。 */
 function packageZipUrl(pkg){
  return pkg.type==='zip'
   ?`/api/local/file?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent(pkg.rel)}`
   :`/api/local/package-zip?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent(pkg.rel)}`;
 }

 /** 大图 URL：浏览器自己认的格式直接给原文件（保留原分辨率，也不做无谓的 PNG 重编码，
  *  JPG 转 PNG 只会更大）；PSD 这类必须靠后端转码。 */
 function packagePhotoUrl(pkg,rel){
  if(pkg.imageUrl)return pkg.imageUrl(rel,false);
  const name=String(rel).split('/').pop();
  // 大图预览最大边从 2048 降到 1024：PSD/RAW/HEIC/DDS 这类要后端转码的图，尺寸减半后
  // 解码与传输都明显变快，预览本就看个全貌，1024 足矣；原生浏览器图走原文件不受影响。
  return SERVER_IMAGE(name)?packageImageUrl(pkg,rel,1024):packageFileUrl(pkg,rel);
 }

 function openPackage(pkg){
  if(!pkg)return;
  // 远程收藏卡里只有 info.json：没有可打开的文件，也没有缩略图墙。
  // 别弹一个空清单让人以为包坏了 —— 直接说清下一步该点哪儿。
  if(pkg.remote){notify?.('这个包只记了平台信息（标题 / 作者 / 封面），图片还没下载到本机：点卡片上的「下载原图」补齐。');return;}
  // 有主文件就直接进它自己的预览（模型进 3D，图片进图片预览）；没有就把包内清单摊出来。
  if(pkg.entry&&pkg.type==='folder'){
   const name=pkg.entry.split('/').pop();
   openFile({root:pkg.root,rel:packageRel(pkg,pkg.entry),name,ext:name.split('.').pop().toLowerCase(),kind:fileKindOf(name)});
   return;
  }
  // 图片素材包（alpha / 贴图 / 图集）打开就是缩略图墙：70 张图逐张点开太重，先看全貌再点大图。
  // ZIP 交付的包取不到内部文件，只能列清单，所以只对文件夹包开放。
  const shots=pkg.type==='folder'?packageImages(pkg):[];
  if(shots.length){openGallery(pkg,shots);return;}
  if(pkg.cover&&pkg.type==='folder'){
   const name=pkg.cover.split('/').pop();
   openFile({root:pkg.root,rel:packageRel(pkg,pkg.cover),name,ext:name.split('.').pop().toLowerCase(),kind:'image'});
   return;
  }
  // 只有 ZIP 的包预览不了内部文件（浏览器拿不到压缩包里的字节），但能给出清单。
  const rows=(pkg.entries||[]).slice(0,120).map(item=>`<li><span>${esc(item.name.split('/').pop())}</span><em>${esc(fmtBytes(item.bytes))}</em></li>`).join('');
  const more=(pkg.entries||[]).length>120||pkg.truncatedEntries?'<p class="file-preview-note">清单过长，只列出前 120 项。</p>':'';
  showOther({name:pkg.title,rel:pkg.rel,kind:'other',bytes:pkg.bytes,mtime:pkg.mtime},
   `<div class="local-package-list"><p class="file-preview-note">${esc(PACKAGE_LABEL[pkg.category]||'资产')} · ${pkg.fileCount} 个文件 · ${esc(fmtBytes(pkg.bytes))}${pkg.type==='zip'?' · 打包为 ZIP':''}</p><ul>${rows}</ul>${more}</div>`,
   '资产包清单 · 只读');
 }

 /** 包内能进预览的图片（TGA/TIFF 这类还是得靠单文件预览，先不进缩略图墙）。 */
 function packageImages(pkg){
  return (pkg.entries||[])
   .filter(item=>item.rel&&GALLERY_IMAGE(item.name))
   .map(item=>({...item,rel:item.rel,name:item.name}));
 }

const MAX_TILES=120;
let galleryPkg=null,galleryImages=[],galleryIndex=0,galleryZoom=null;
/** 缩略图条懒加载观察器：只让滚到视口附近的图真正去后端取，避免一次性打上百个请求。 */
let stripObserver=null;

// 视频条目的判据只写一份：接口给的 type 优先，其次看播放源（play）或 .mp4 之类的地址。
// 图站缓存里可能有更早版本的数据（没有 type 字段），只认 type 会让这类条目退化成图片，
// 预览拿 /api/image 去取 mp4，结果就是「这张图生成不了预览」。
const isVideoItem=item=>item?.type==='video'||!!item?.play||/\.(mp4|webm|mov)(\?|$)/i.test(item?.url||'');

/** 图片素材包：上面左大图、右侧素材包信息，下方一整条可横向滚动的缩略图。
 *  滚轮缩放大图、按住拖动看细节；缩略图文件名默认不显示，悬停才浮出。 */
function openGallery(pkg,images,index=0){
 if(!pkg||!images.length)return;
 const dlg=$('#file-preview-dialog'),stage=$('#file-preview-stage'),aside=$('#file-preview-details');
 if(!dlg||!stage||!aside)return;
 galleryPkg=pkg;
 galleryImages=pkg.imageUrl?images:images.slice(0,MAX_TILES);
 galleryIndex=Math.max(0,Math.min(Number(index)||0,galleryImages.length-1));
 clearStage();
 dlg.classList.add('is-gallery');
 dlg.classList.toggle('is-xhs-note',!!pkg.note);
 stage.classList.add('is-gallery');
 $('#file-preview-title').innerHTML=`${icon(PACKAGE_ICON[pkg.category]||'image')}${esc(pkg.title)}`;
 // 这一行「资产包预览 · 只读」压在画面正中，纯噪音，直接留空。
 $('#file-preview-hint').textContent='';
 stage.innerHTML=`<div class="local-gallery-main" data-gallery-main>
   <img class="local-gallery-photo" alt="" draggable="true" data-drag-url="" data-drag-root="" data-drag-rel="" data-drag-name="">
   <video class="local-gallery-video" controls playsinline loop preload="auto" hidden></video>
   <iframe data-gallery-viewer title="交互式 3D 预览" allow="fullscreen" allowfullscreen hidden style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>
   <p class="local-gallery-error" hidden>这张图生成不了预览</p>
   ${pkg.note?'<div class="xhs-float-title" data-xhs-title></div>':''}
   ${pkg.note?`<div class="xhs-pager"><span data-xhs-page></span><div class="xhs-dots" data-xhs-dots></div></div>`:''}
   <div class="local-gallery-hud">
    <button type="button" data-gallery-zoom="out" aria-label="缩小">−</button>
    <span data-gallery-zoom-label>100%</span>
    <button type="button" data-gallery-zoom="in" aria-label="放大">+</button>
    <button type="button" data-gallery-zoom="reset" title="适应窗口">适应</button>
   </div>
  </div>`;
 // 缩略图条挂在 dialog 上（不是 preview-layout 里面），才能横跨大图和信息栏的整个宽度。
 const strip=ensureStrip(dlg);
 // 不再一次性把全部缩略图 src 写死（一条 222 张的图集会瞬间发出 222 个请求，卡住图片服务与磁盘）；
 // 改成「占位 + 滚到附近才加载」，宽度也从 256 降到 128，更快更省。
 strip.innerHTML=galleryImages.map((item,i)=>{
  const body=item.type==='3d'?'<strong>3D</strong>'
   :isVideoItem(item)?'<strong>VIDEO</strong>'
   :`<img data-lazy-src="${esc(packageImageUrl(pkg,item.rel,128))}" alt="${esc(item.name)}" decoding="async">`;
  return `<button type="button" class="local-gallery-thumb" data-gallery-index="${i}" title="${esc(item.name)}">${body}<span>${esc(item.name)}</span></button>`;
 }).join('');
 setupStripLazyLoad(strip);
 galleryZoom=bindZoom(stage.querySelector('[data-gallery-main]'),stage.querySelector('[data-gallery-zoom-label]'));
 preloadGallery();
 showGalleryImage(galleryIndex,{reveal:true});
 if(!dlg.open)dlg.showModal();
 lockPageScroll();
}

function ensureStrip(dlg){
 let strip=dlg.querySelector('.local-gallery-strip');
 if(!strip){
  strip=document.createElement('div');
  strip.className='local-gallery-strip';
  dlg.append(strip);
 }
 return strip;
}

/** 缩略图条懒加载：strip 本身是横向滚动容器（root），只让进入视口附近（含 240px 余量）的图
 *  真正设置 src 去后端取缩略图，离开后不回收（预览场景里来回滚不频繁，省得反复请求）。
 *  不支持 IntersectionObserver 的老浏览器退回「一次性全加载」，行为等价于旧实现。 */
function setupStripLazyLoad(strip){
 const imgs=Array.from(strip.querySelectorAll('img[data-lazy-src]'));
 if(!imgs.length)return;
 if(stripObserver)stripObserver.disconnect();
 if('IntersectionObserver' in window){
  stripObserver=new IntersectionObserver(entries=>{
   for(const entry of entries){
    if(!entry.isIntersecting)continue;
    const img=entry.target,src=img.dataset.lazySrc;
    if(src){img.src=src;img.removeAttribute('data-lazy-src');}
    stripObserver.unobserve(img);
   }
  },{root:strip,rootMargin:'240px',threshold:0.01});
  for(const img of imgs)stripObserver.observe(img);
 }else{
  for(const img of imgs){const src=img.dataset.lazySrc;if(src){img.src=src;img.removeAttribute('data-lazy-src');}}
 }
}

/** 右侧信息栏：素材包概况 + 当前这张图。换图时整块重写，内容短，不怕重建。 */
function galleryInfoHtml(pkg,item){
 if(pkg.details)return '';
 const count=galleryImages.length;
 return `<div class="eyebrow">LOCAL PACKAGE</div>
  <h2>${esc(pkg.title)}</h2>
  <p class="author-name">${esc(PACKAGE_LABEL[pkg.category]||'资产')}${pkg.resolution?` · ${esc(pkg.resolution)}`:''}</p>
  <div class="details-stats"><div><strong>${count}</strong><span>张图片</span></div><div><strong>${esc(fmtBytes(pkg.bytes))}</strong><span>包大小</span></div></div>
  <div class="local-gallery-current">
   <span class="local-gallery-label">当前图片 ${galleryIndex+1} / ${count}</span>
   <p class="local-gallery-name">${esc(item.name)}</p>
   <p class="local-gallery-size">${esc(fmtBytes(item.bytes))}</p>
  </div>
  <div class="detail-license"><p class="local-file-path">${esc(pkg.rel||pkg.root)}</p><p>滚轮缩放大图、按住拖动看细节；← → 或点下方缩略图切换。</p></div>`;
}

let galleryPreload=[];
/** 笔记图往往一张几 MB，滚到才请求就会空等。打开时把整篇图并行拉进内存，翻页直接换已经解码的那张。 */
function preloadGallery(){
 galleryPreload.forEach(img=>{img.onload=null;img.onerror=null;});
 if(!galleryPkg?.note||galleryPkg.noteLoading||galleryImages.length<2){galleryPreload=[];return;}
 galleryPreload=galleryImages.map(item=>{
  const img=new Image();
  img.decoding='async';
  img.src=packagePhotoUrl(galleryPkg,item.rel);
  return img;
 });
}

/** 换大图只改 <img> 的 src，缩略图条保留不动：整块重绘会让横向滚动位置跳回开头。 */
function showGalleryImage(index,{reveal=false}={}){
 const item=galleryImages[index];
 if(!item)return;
 galleryIndex=index;
 const stage=$('#file-preview-stage'),is3d=item.type==='3d',isVideo=isVideoItem(item);
 const viewer=stage?.querySelector('[data-gallery-viewer]');
 if(viewer){
  viewer.hidden=!is3d;
  if(is3d){if(viewer.getAttribute('src')!==item.embedUrl)viewer.src=item.embedUrl;}
  else viewer.removeAttribute('src');
 }
 // 视频条目走 <video>（Range 由 /api/video 透传，能拖进度）；图片仍走 <img>，两条互斥。
 const video=stage?.querySelector('.local-gallery-video');
 if(video){
  video.hidden=!isVideo;
  if(isVideo){
   const src=galleryPkg?.videoUrl?.(item.rel)||'';
   if(src&&video.getAttribute('src')!==src){
    video.src=src;
    try{video.currentTime=0;}catch{/* 还没拿到 metadata 时赋值会抛 */ }
    // 点卡片本身就是用户手势，这里直接起播；被策略拦下也不影响原生 controls 手动播。
    video.play?.().catch(()=>{});
   }
  }else{
   video.pause?.();
   video.removeAttribute('src');
   video.load?.();
  }
 }
 const hud=stage?.querySelector('.local-gallery-hud');
 if(hud)hud.hidden=is3d||isVideo;
  const img=stage?.querySelector('img');
  if(img){
   img.hidden=is3d||isVideo;
   // 预览大图也能拖到 PS / PureRef：写清「这一张」的真实来源，drag-payload.js 按它换文件。
   // 本地包给 root/rel（原文件字节），图站包给原图 URL（服务端 full=1 档落盘）。
   img.dataset.dragUrl=/^https?:\/\//i.test(String(item.url||''))?item.url:'';
   img.dataset.dragRoot=galleryPkg?.root||'';
   img.dataset.dragRel=galleryPkg?.root?packageRel(galleryPkg,item.rel):'';
   img.dataset.dragName=item.name||item.title||'';
   const error=img.parentElement?.querySelector('.local-gallery-error');
  if(error)error.hidden=true;
  img.onload=()=>{if(error)error.hidden=true;img.classList.remove('is-broken');};
  // PSD 转码失败（坏文件 / 不认识的压缩）时别留一张破图，说清楚为什么。
  img.onerror=()=>{
   // 图站原图（花瓣这种无后缀直链、部分站的 4K 图）回源偶发失败时会整块黑屏。
   // 先用缩略图顶上——同一张图的小尺寸变体基本都在缓存里——缩略图也挂才提示失败。
   if(img.dataset.fallback!=='1'&&typeof galleryPkg?.thumbUrl==='function'){
    const fallback=galleryPkg.thumbUrl(item.rel);
    if(fallback&&fallback!==img.getAttribute('src')){img.dataset.fallback='1';img.src=fallback;return;}
   }
   if(error)error.hidden=false;img.classList.add('is-broken');
  };
  if(is3d||isVideo){img.onload=null;img.onerror=null;img.removeAttribute('src');}
  else {
   delete img.dataset.fallback;
   img.alt=item.name;
   const url=packagePhotoUrl(galleryPkg,item.rel);
   const cached=galleryPreload[index];
   const show=()=>{if(galleryIndex===index)img.src=url;};
   // 还没解码完就先留着上一张，避免切过去是一块空白再慢慢出来。
   if(!img.getAttribute('src')||(cached?.complete&&cached.naturalWidth))show();
   else if(cached)cached.addEventListener('load',show,{once:true});
   else show();
  }
 }
 galleryZoom?.reset();
 const aside=$('#file-preview-details');
 if(aside)aside.innerHTML=galleryInfoHtml(galleryPkg,item);
 galleryPkg.details?.(item,galleryIndex,galleryImages.length);
 const pageLabel=stage?.querySelector('[data-xhs-page]');
 if(pageLabel)pageLabel.textContent=galleryPkg?.noteLoading?'正在读取这篇笔记的全部图片…':`第${index+1}页 / 共${galleryImages.length}页`;
 const floatTitle=stage?.querySelector('[data-xhs-title]');
 if(floatTitle)floatTitle.textContent=item.title||galleryPkg?.title||'';
 const dots=stage?.querySelector('[data-xhs-dots]');
 if(dots)dots.innerHTML=!galleryPkg?.noteLoading&&galleryImages.length>1&&galleryImages.length<=12
  ?galleryImages.map((_,i)=>`<i class="${i===index?'is-on':''}"></i>`).join('')
  :'';
 const strip=$('#file-preview-dialog .local-gallery-strip');
 strip?.querySelector('.local-gallery-thumb.is-active')?.classList.remove('is-active');
 const active=strip?.querySelector(`[data-gallery-index="${index}"]`);
 if(active){
  active.classList.add('is-active');
  if(reveal)active.scrollIntoView({inline:'center',block:'nearest'});
 }
}

/** 滚轮以光标为中心缩放，按住拖动平移。wheel 必须 preventDefault，
 *  否则缩放到边、或缩略图栏滚到底时会把滚动接力给背后那一页。 */
function bindZoom(main,label){
 if(!main)return null;
 const img=main.querySelector('img');
 const state={scale:1,x:0,y:0};
 const paint=()=>{
  if(img)img.style.transform=`translate(${state.x.toFixed(1)}px,${state.y.toFixed(1)}px) scale(${state.scale.toFixed(3)})`;
  if(label)label.textContent=`${Math.round(state.scale*100)}%`;
 };
 const zoomAt=(next,cx,cy)=>{
  const scale=Math.min(8,Math.max(.2,next));
  const ratio=scale/state.scale;
  state.x=cx-(cx-state.x)*ratio;
  state.y=cy-(cy-state.y)*ratio;
  state.scale=scale;
  paint();
 };
 let wheeledAt=0;
 main.addEventListener('wheel',event=>{
  event.preventDefault();
  // 小红书笔记：滚轮翻页，Ctrl+滚轮才缩放。普通图库仍是滚轮缩放。
  if(galleryPkg?.note&&!event.ctrlKey){
   const now=Date.now();
   if(now-wheeledAt<220)return;
   wheeledAt=now;
   const next=galleryIndex+(event.deltaY>0?1:-1);
   if(next>=0&&next<galleryImages.length)showGalleryImage(next);
   return;
  }
  const rect=main.getBoundingClientRect();
  zoomAt(state.scale*Math.exp(-event.deltaY*0.0016),
   event.clientX-rect.left-rect.width/2,event.clientY-rect.top-rect.height/2);
 },{passive:false});
 let drag=null;
 main.addEventListener('pointerdown',event=>{
  // 视频条目用的是原生 controls：拖动平移会在 pointerdown 里 setPointerCapture，
  // 后续 pointerup/click 全被重定向到外层容器，播放键点了毫无反应 —— 视频上不接管指针。
  if(event.button!==0||event.target.closest('.local-gallery-hud')||event.target.closest('video'))return;
  drag={left:event.clientX,top:event.clientY,x:state.x,y:state.y};
  try{main.setPointerCapture(event.pointerId);}catch{}
  main.classList.add('is-dragging');
 });
 main.addEventListener('pointermove',event=>{
  if(!drag)return;
  state.x=drag.x+event.clientX-drag.left;
  state.y=drag.y+event.clientY-drag.top;
  paint();
 });
 const stop=event=>{
  if(!drag)return;
  drag=null;
  main.classList.remove('is-dragging');
  try{main.releasePointerCapture(event.pointerId);}catch{}
 };
 main.addEventListener('pointerup',stop);
 main.addEventListener('pointercancel',stop);
 main.addEventListener('dblclick',()=>{state.scale=1;state.x=0;state.y=0;paint();});
 paint();
 return {
  reset:()=>{state.scale=1;state.x=0;state.y=0;paint();},
  step:factor=>zoomAt(state.scale*factor,0,0)
 };
}

/** 弹窗打开时锁住背后的页面：弹窗里的滚动到边不该带跑整页。 */
function lockPageScroll(){document.documentElement.classList.add('file-preview-open');}
function unlockPageScroll(){document.documentElement.classList.remove('file-preview-open');}

 /** 之前这里又抄了一份扩展名表，字体/音频/视频全被判成 other；改问注册表。 */
 function fileKindOf(name){
  return formatKind(name);
 }

 function detailsHtml(file){
  return `<div class="eyebrow">LOCAL FILE</div><h2>${esc(file.name)}</h2>
   <p class="author-name">${esc(KIND_LABEL[file.kind]||'其他')}${file.ext?` · .${esc(file.ext)}`:''}</p>
   <div class="details-stats"><div><strong>${esc(fmtBytes(file.bytes))}</strong><span>大小</span></div><div><strong>${esc(fmtTime(file.mtime))}</strong><span>修改时间</span></div></div>
   <div class="detail-license"><p class="local-file-path">${esc(file.rel)}</p><p>只读预览：打开这个文件不会改动磁盘上的内容。</p></div>`;
 }

 /** 3D 与全景走现有的 #preview-dialog（渲染器在那），其余用 #file-preview-dialog。 */
 function openModel(file){
  const dlg=$('#preview-dialog');
  $('#model-details').innerHTML=detailsHtml(file);
  const iframe=$('#viewer');if(iframe)iframe.removeAttribute('src');
  dlg.showModal();
  if(file.kind==='env')gltfPreview.loadLocalEnvironment({url:fileUrl(file),name:file.name});
  else gltfPreview.loadLocalModel({url:fileUrl(file),name:file.name});
 }

 function clearStage(){
  stopSequence();
  if(stripObserver){stripObserver.disconnect();stripObserver=null;}
  const stage=$('#file-preview-stage');
  if(!stage)return;
  for(const node of stage.querySelectorAll('video,audio')){try{node.pause();node.removeAttribute('src');}catch{}}
  for(const node of stage.querySelectorAll('iframe'))node.removeAttribute('src');
  // 文档渲染器（独立 bundle）把清理函数挂在 host 上：EPUB 的 rendition 持有 iframe 与事件，
  // 不清会一直活着。这里只认通用钩子，不 import doc-render.js，主包因此不会背 1.2MB。
  for(const node of stage.querySelectorAll('[data-doc-host]')){try{node.__avDispose?.();}catch{}}
  stage.replaceChildren();
  stage.hidden=false;
  stage.classList.remove('is-gallery');
  const dlg=$('#file-preview-dialog');
  dlg?.classList.remove('is-gallery','is-xhs-note');
  dlg?.querySelector('.local-gallery-strip')?.remove();
}

 function showOther(file,stageHtml,hint){
  const dlg=$('#file-preview-dialog');
  const stage=$('#file-preview-stage');
  clearStage();
  $('#file-preview-details').innerHTML=detailsHtml(file);
  $('#file-preview-title').innerHTML=`${icon(KIND_ICON[file.kind]||'cube')}${esc(file.name)}`;
  stage.innerHTML=stageHtml;
  $('#file-preview-hint').textContent=hint||'';
  if(!dlg.open)dlg.showModal();
  return stage;
 }

 async function fetchBytes(url){
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok)throw Error(`读取文件失败（HTTP ${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
 }

 /** ZIP 内嵌浏览：左列条目，右侧看选中的那个。目录只读一遍，不解压整包。 */
 async function showArchive(file){
  const stage=showOther(file,'<div class="file-preview-note">正在读 ZIP 目录…</div>','读取中');
  const base=`/api/local/archive?root=${encodeURIComponent(file.root)}&rel=${encodeURIComponent(file.rel)}`;
  let data=null;
  try{
   const response=await fetch(base,{cache:'no-store'});
   data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
  }catch(error){
   stage.innerHTML=`<div class="file-preview-note">ZIP 目录读不出来：${esc(error.message)}</div>`;
   $('#file-preview-hint').textContent='读取失败';
   return;
  }
  const entries=Array.isArray(data.entries)?data.entries:[];
  if(!entries.length){
   stage.innerHTML='<div class="file-preview-note">这个压缩包里没有文件。</div>';
   $('#file-preview-hint').textContent='空压缩包';
   return;
  }
  stage.innerHTML=`<div class="zip-browser">
   <div class="zip-list" role="listbox" aria-label="压缩包条目">${entries.map(entry=>`<button class="zip-row" type="button" role="option" data-zip-entry="${esc(entry.name)}" style="padding-left:${8+entry.depth*12}px">
     <span class="zip-name">${esc(entry.name.split('/').pop()||entry.name)}</span>
     <span class="zip-size">${esc(fmtBytes(entry.size))}</span>
    </button>`).join('')}</div>
   <div class="zip-view"><p class="file-preview-note">左边选一个文件。图片、文本、音视频可以直接看，其他格式只列清单。</p></div>
  </div>`;
  $('#file-preview-hint').textContent=`${data.count} 个条目 · ${fmtBytes(data.total)}${data.truncated?` · 只列了前 ${entries.length} 个`:''} · 只读`;
  const view=stage.querySelector('.zip-view');
  stage.querySelector('.zip-list')?.addEventListener('click',async event=>{
   const row=event.target.closest('[data-zip-entry]');
   if(!row)return;
   for(const node of stage.querySelectorAll('.zip-row.is-active'))node.classList.remove('is-active');
   row.classList.add('is-active');
   const name=row.dataset.zipEntry;
   const url=`/api/local/archive/entry?root=${encodeURIComponent(file.root)}&rel=${encodeURIComponent(file.rel)}&entry=${encodeURIComponent(name)}`;
   const format=formatOf(name)||{};
   if(format.kind==='image'){
    view.innerHTML=`<img class="file-preview-image" src="${url}" alt="${esc(name)}" loading="lazy">`;
    return;
   }
   if(format.kind==='video'){
    view.innerHTML=`<video class="file-preview-video" controls playsinline src="${url}"></video>`;
    return;
   }
   if(format.kind==='audio'){
    view.innerHTML=`<audio class="file-preview-audio" controls src="${url}"></audio>`;
    return;
   }
   if(format.preview==='text'){
    view.innerHTML='<div class="file-preview-note">正在解出文本…</div>';
    try{
     const response=await fetch(url,{cache:'no-store'});
     if(!response.ok)throw Error(`HTTP ${response.status}`);
     const text=await response.text();
     view.innerHTML=`<pre class="file-preview-text">${esc(text.slice(0,200000))}</pre>`;
     if(text.length>200000)$('#file-preview-hint').textContent='文本超过 200KB，只显示前 200KB';
    }catch(error){
     view.innerHTML=`<div class="file-preview-note">解不出来：${esc(error.message)}</div>`;
    }
    return;
   }
   view.innerHTML=`<div class="file-preview-note">.${esc(extensionOf(name)||'文件')} 不能在线看。整个包可以先下载，再解压。</div>`;
  });
 }

 /** 解码结果（RGBA）画到 canvas。超过 8192 的图先缩再画：canvas 有尺寸上限，直接建会得到空白。 */
 function paintBitmap(stage,{width,height,data}){
  const scratch=document.createElement('canvas');
  scratch.width=width;scratch.height=height;
  scratch.getContext('2d').putImageData(new ImageData(data,width,height),0,0);
  const scale=Math.min(1,8192/Math.max(width,height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(width*scale));
  canvas.height=Math.max(1,Math.round(height*scale));
  const ctx=canvas.getContext('2d');
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(scratch,0,0,canvas.width,canvas.height);
  canvas.className='file-preview-canvas';
  stage.replaceChildren(canvas);
 }

 async function drawTga(url,stage){
  const tex=await new Promise((res,rej)=>new TGALoader().load(url,res,undefined,rej));
  const image=tex.image||{};
  const {data,width,height}=image;
  if(!data||!width||!height)throw Error('TGA 解码失败');
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');
  const out=ctx.createImageData(width,height);
  for(let i=0,j=0;i<width*height;i++,j+=4){
   out.data[j]=data[j];out.data[j+1]=data[j+1];out.data[j+2]=data[j+2];out.data[j+3]=data[j+3]??255;
  }
  ctx.putImageData(out,0,0);
  canvas.className='file-preview-canvas';
  stage.replaceChildren(canvas);
  tex.dispose?.();
}

 /** 后端把浏览器解不了的格式转成 PNG：相机 RAW / AI / HEIC / DDS / PSD。 */
 function derivedImageUrl(file,width=1600){
  return `/api/local/thumb?root=${encodeURIComponent(file.root)}&rel=${encodeURIComponent(file.rel)}&w=${width}`;
 }

 function showDerivedImage(file,hint){
  const stage=showOther(file,`<img class="file-preview-image" src="${derivedImageUrl(file)}" alt="${esc(file.name)}">`,hint);
  // 转不了时 /api/local/thumb 会回退原文件，<img> 随即报错：给一句能动手的提示，别留破图。
  stage.querySelector('img')?.addEventListener('error',()=>{
   $('#file-preview-hint').textContent='本机 ffmpeg 也转不了这个格式；请用原软件打开，或先转成 PNG';
  });
  return stage;
 }

 async function showTextPreview(file,url){
  const response=await fetch(url,{cache:'no-store'});
  const value=await response.text();
  const clipped=value.length>200000?`${value.slice(0,200000)}\n\n…（文件太长，只显示前 200 KB）`:value;
  showOther(file,`<pre class="file-preview-text">${esc(clipped)}</pre>`,'文本预览 · 只读');
 }

 /** 独立 bundle 懒加载：失败时清掉缓存的 Promise，下次打开能重试（同 lazy-preview.js 的做法）。 */
 let docRendererPromise=null;
 function loadDocRenderer(){
  if(!docRendererPromise)docRendererPromise=import('./doc-render.js').catch(error=>{docRendererPromise=null;throw error;});
  return docRendererPromise;
 }

 /** markdown / docx / epub：字节统一在这里取，渲染器只负责「字节 → DOM」。 */
 async function showDocument(file,mode,url){
  const stage=showOther(file,'<div class="doc-render-host" data-doc-host></div>','正在载入文档渲染器…');
  const host=stage.querySelector('[data-doc-host]');
  try{
   const {renderDocument}=await loadDocRenderer();
   $('#file-preview-hint').textContent='正在渲染…';
   const input={mode,host,ext:file.ext};
   if(mode==='markdown'){
    const response=await fetch(url,{cache:'no-store'});
    if(!response.ok)throw Error(`读取文件失败（HTTP ${response.status}）`);
    input.text=await response.text();
   }else{
    input.bytes=await fetchBytes(url);
   }
   // 第三方渲染器（尤其 epubjs）在损坏文件上可能永久 pending；兜底超时保证用户不会无限转圈。
   let timer;
   const result=await Promise.race([
    renderDocument(input).finally(()=>clearTimeout(timer)),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('文档渲染超时，请检查文件是否完整或受密码保护')),DOC_RENDER_TIMEOUT_MS);}),
   ]);
   $('#file-preview-hint').textContent=result.hint;
  }catch(error){
   host?.replaceChildren();
   const note=document.createElement('div');
   note.className='file-preview-note';
   note.textContent=error?.message||'文档渲染失败';
   host?.append(note);
   $('#file-preview-hint').textContent='文档预览失败';
  }
 }

 /** doc-pdf：pptx/xlsx/rtf 等由服务端 LibreOffice 转 PDF，iframe 复用现有 pdf 通道。
  *  iframe 带不了 x-sfx-local 自定义头，所以服务端按 /api/local/thumb 的 root 白名单鉴权。 */
 async function showDocPdf(file){
  const stage=showOther(file,'','正在检查文档转换环境…');
  let status=null;
  try{
   const response=await fetch('/api/doc/status',{cache:'no-store',headers:{'x-sfx-local':'1'}});
   if(response.ok)status=await response.json();
  }catch{}
  if(!status?.available){
   const note=document.createElement('div');
   note.className='file-preview-note';
   note.textContent=DOC_CONVERT_UNAVAILABLE_HINT;
   stage.replaceChildren(note);
   $('#file-preview-hint').textContent='缺少 LibreOffice';
   return;
  }
  const pdfUrl=`/api/doc/pdf?root=${encodeURIComponent(file.root)}&rel=${encodeURIComponent(file.rel)}`;
  stage.innerHTML=`<iframe class="file-preview-frame" src="${pdfUrl}" title="${esc(file.name)}"></iframe>`;
  $('#file-preview-hint').textContent=DOC_HINTS['doc-pdf'];
 }

 async function openFile(file){
  if(!file)return;
  const entry=formatOf(file.name)||formatOf(file.rel);
  const mode=entry?.preview||'none';
  // USD 家族有独立解析器，但本地单文件入口没接它：给明确提示，别弹一个空 3D 舞台。
  if(mode==='usd'){
   showOther(file,`<div class="file-preview-note">.${esc(file.ext)} 是 USD 场景文件；几何预览走资产包的 3D 入口，单文件暂不内建预览。<br><code>${esc(file.rel)}</code></div>`,'暂无内建预览');
   return;
  }
  if(mode==='model'||mode==='env'||file.kind==='model'||file.kind==='env'){openModel(file);return;}
  const url=fileUrl(file);
  try{
   // 文本预览按注册表分派：43 种文本后缀与 MTL 都能看，不受 kind 取值影响。
   if(mode==='text'){await showTextPreview(file,url);return;}
   if(file.kind==='image'){
    if(mode==='native'){
     showOther(file,`<img class="file-preview-image" src="${url}" alt="${esc(file.name)}">`,'图片预览 · 只读');
    }else if(/\.tga$/i.test(file.name)){
     const stage=showOther(file,'',`正在解码 ${file.name}…`);
     await drawTga(url,stage);
     $('#file-preview-hint').textContent='TGA 已解码为图片 · 只读';
    }else if(/\.(tif|tiff)$/i.test(file.name)){
     const stage=showOther(file,'',`正在解码 ${file.name}…`);
     const decoded=await decodeTiff(await fetchBytes(url));
     paintBitmap(stage,decoded);
     $('#file-preview-hint').textContent=decoded.pages>1
      ? `TIFF 已解码 · 共 ${decoded.pages} 页，这里只显示第 1 页`
      : 'TIFF 已解码为图片 · 只读';
    }else if(/\.psd$/i.test(file.name)){
     const stage=showOther(file,'',`正在解码 ${file.name}…`);
     const decoded=decodePsd(await fetchBytes(url));
     paintBitmap(stage,decoded);
     $('#file-preview-hint').textContent=`PSD 合并图像 · ${decoded.width}×${decoded.height}${decoded.bitDepth===16?' · 16 位':''}${decoded.layers?' · 只显示拼合结果':''}`;
    }else if(mode==='thumb'){
     showDerivedImage(file,'已由 ffmpeg 转成 PNG 预览（浏览器不认原始格式）· 只读');
    }else{
     showOther(file,`<div class="file-preview-note">这个格式浏览器解不了：.${esc(file.ext)}。用 Photoshop 或 Krita 打开，或者先转成 PNG。</div>`,'格式不支持');
    }
    return;
   }
   if(file.kind==='font'){
    const family=`fx-${Date.now()}`;
    const face=new FontFace(family,`url("${url}")`);
    await face.load();
    document.fonts.add(face);
    showOther(file,`<div class="file-font-sample" style="font-family:'${family}'">
      <p class="file-font-title">${esc(file.name)}</p>
      <p class="file-font-large">Aa 字体预览 0123</p>
      <p class="file-font-body">The quick brown fox jumps over the lazy dog.</p>
      <p class="file-font-body">中文字形：永 和 九 年 春 夏 秋 冬</p>
     </div>`,'字体已加载 · 只读');
    return;
   }
   if(file.kind==='audio'){
    // AIF / AIFF / AC3 浏览器多半不认，走与视频同一个 ffmpeg 转码通道出 MP4 音轨。
    const transcode=mode==='audio-transcode';
    const stage=showOther(file,
     `<audio class="file-preview-audio" controls autoplay src="${transcode?playUrl(file):url}"></audio>`,
     transcode?'这个音频容器浏览器不认，正由 ffmpeg 实时转码，首帧要等几秒':'音频预览 · 只读');
    stage.querySelector('audio')?.addEventListener('error',()=>{
     $('#file-preview-hint').textContent='这个音频解不出来；本机没有 ffmpeg 时请先转成 MP3 / WAV';
    });
    return;
   }
   if(file.kind==='video'){
    const native=mode==='video-native';
    const stage=showOther(file,
     `<video class="file-preview-video" controls playsinline preload="metadata" src="${native?url:playUrl(file)}"></video>`,
     native?'视频预览 · 只读':'这个容器浏览器不认，正由 ffmpeg 实时转封装，首帧要等几秒');
    const video=stage.querySelector('video');
    let fellBack=false;
    video?.addEventListener('error',async()=>{
     // 容器对不代表编码对：mp4 里装 hevc/prores 一样放不出来，失败后往转封装退一次。
     if(native&&!fellBack){
      fellBack=true;
      $('#file-preview-hint').textContent='原生解码失败，改用 ffmpeg 转封装…';
      video.src=playUrl(file);
      video.load();
      video.play().catch(()=>{});
      return;
     }
     const info=await probeVideo(file);
     if(info?.available){
      $('#file-preview-hint').textContent=`这个文件解不出来（${info.codecs?.video||'未知编码'}），ffmpeg 也处理不了`;
     }else{
      $('#file-preview-hint').textContent='浏览器放不了这个容器，本机也没有 ffmpeg；装一个 ffmpeg 或先转成 MP4';
     }
    });
    return;
   }
   // ZIP 的注册表 preview 是 none，但它值得一个内嵌浏览，别落到「无预览」。
   if(/\.zip$/i.test(file.name||'')){await showArchive(file);return;}
   if(file.kind==='document'){
    // 文档渲染扩展：分派判定来自注册表 preview 与纯策略表，新增格式不用在这里堆 if。
    const docMode=docRenderModeOf(mode);
    if(docMode==='doc-pdf'){await showDocPdf(file);return;}
    if(docMode){await showDocument(file,mode,url);return;}
    if(mode==='pdf'){
     showOther(file,`<iframe class="file-preview-frame" src="${url}" title="${esc(file.name)}"></iframe>`,'PDF 预览 · 只读');
     return;
    }
    if(mode==='html'){
     // sandbox 无 allow-scripts：页面里的脚本不执行，只当静态文档看。
     showOther(file,`<iframe class="file-preview-frame" sandbox src="${url}" title="${esc(file.name)}"></iframe>`,'HTML 静态预览（脚本已禁用）');
     return;
    }
    if(mode==='thumb'){
     // Illustrator .ai 内含 PDF 兼容流时 ffmpeg 能取到图；取不到就明确提示，不留破图。
     showDerivedImage(file,'已由 ffmpeg 转成 PNG 预览（AI 文件）· 只读');
     return;
    }
    await showTextPreview(file,url);
    return;
   }
   showOther(file,`<div class="file-preview-note">.${esc(file.ext||'未知')} 没有内建预览${entry?` · ${esc(entry.group)} 组`:''}。它在磁盘上的位置：<br><code>${esc(file.rel)}</code></div>`,'无预览');
  }catch(e){
   showOther(file,`<div class="file-preview-note">预览失败：${esc(e.message)}</div>`,'预览失败');
  }
 }

 function openFromEvent(event){
  const seqCard=event.target.closest('[data-sequence]');
  if(seqCard){
   const seq=sequences.find(item=>item.key===seqCard.dataset.sequence);
   if(seq){openSequence(seq);return true;}
  }
  const card=event.target.closest('[data-package]');
  if(card){
   const pkg=packages.find(entry=>packageKey(entry)===card.dataset.package);
   if(pkg){openPackage(pkg);return true;}
  }
  const item=event.target.closest('[data-file]');
  if(!item)return false;
  const file=files.find(entry=>keyOf(entry)===item.dataset.file);
  if(!file)return false;
  openFile(file);
  return true;
 }

 function setup(){
  const grid=$('#grid');
  if(grid){
   grid.addEventListener('click',event=>{
    // 卡片右上角的小按钮都在「打开资产」之前处理，否则点下载会先弹出预览。
    const downloadButton=event.target.closest('[data-package-download]');
    if(downloadButton){
     event.preventDefault();
     event.stopPropagation();
     downloadPackage(packages.find(entry=>packageKey(entry)===downloadButton.dataset.packageDownload),downloadButton);
     return;
    }
    // 登记 / 补原图已收进右键菜单（走 packageAction），这里只留整包下载一颗卡片按键。
    if(openFromEvent(event))event.preventDefault();
   });
   grid.addEventListener('keydown',event=>{
    if(event.key!=='Enter'&&event.key!==' ')return;
    if(event.target.closest?.('[data-package-download]'))return;
    if(openFromEvent(event))event.preventDefault();
   });
  }
  // 缩略图与大图同在一个弹窗里，点击用弹窗级委托：换图只改 src，元素不重建。
  const previewDialog=$('#file-preview-dialog');
  previewDialog?.addEventListener('click',event=>{
   const thumb=event.target.closest('[data-gallery-index]');
   if(thumb&&galleryPkg){showGalleryImage(Number(thumb.dataset.galleryIndex));return;}
   const zoom=event.target.closest('[data-gallery-zoom]');
   if(zoom&&galleryZoom){
    const mode=zoom.dataset.galleryZoom;
    if(mode==='reset')galleryZoom.reset();
    else galleryZoom.step(mode==='in'?1.35:1/1.35);
   }
  });
  previewDialog?.addEventListener('keydown',event=>{
   if(!galleryPkg||(event.key!=='ArrowLeft'&&event.key!=='ArrowRight'))return;
   event.preventDefault();
   const next=galleryIndex+(event.key==='ArrowRight'?1:-1);
   if(next>=0&&next<galleryImages.length)showGalleryImage(next,{reveal:true});
  });
  previewDialog?.addEventListener('close',()=>{
   clearStage();
   unlockPageScroll();
   galleryPreload.forEach(img=>{img.onload=null;img.onerror=null;});
  galleryPreload=[];
  galleryPkg=null;galleryImages=[];galleryIndex=0;galleryZoom=null;
  });
 }

 function openImageGallery({title,images,index=0,onChange,note=false,noteLoading=false}){
  const items=images.map((item,i)=>({...item,rel:String(i),name:item.title||`图片 ${i+1}`}));
  // v=2 与卡片缩略图保持同一套版本戳：之前服务端把一次 4xx 的图连同 7 天 max-age 一起发回去，
  // 浏览器就把「裂图」记了一周。卡片早就加了 v=2 绕开，预览和缩略图条没加，于是卡片正常、
  // 点开却是一片黑（花瓣这类原图直链最容易撞上）。两处必须共用同一个版本号。
  // 同源相对地址（本地托管副本的 /api/local/file、/api/local/thumb）本来就是本机直出，
  // 套 /api/image 代理会被「只支持图床地址」挡下来，本地素材点开预览就是一片黑。
  const imgUrl=(rel,useThumb)=>{const it=items[Number(rel)]||{};const raw=useThumb&&it.thumb?it.thumb:it.url;return /^\/(?!\/)/.test(String(raw||''))?raw:`/api/image?url=${encodeURIComponent(raw)}&v=2`;};
  const thumbUrl=rel=>imgUrl(rel,true);
  openGallery({title,category:'images',note,noteLoading,imageUrl:imgUrl,thumbUrl,videoUrl:rel=>`/api/video?url=${encodeURIComponent(items[Number(rel)].play||items[Number(rel)].url)}`,details:onChange},items,index);
 }
 /** 右键菜单直接调动作，不再靠卡片上隐藏按钮的模拟点击。key = root|rel。 */
 function packageAction(key,action){
  const pkg=packages.find(entry=>packageKey(entry)===key);
  if(!pkg)return false;
  if(action==='register'&&pkg.type==='folder'&&!pkg.hasMeta){register(pkg);return true;}
  if(action==='fetch'&&pkg.remote){onFetchPackage?.(pkg,null);return true;}
  return false;
 }
 function findSequence(uid){
  return sequences.find(s=>s.uid===uid)||null;
 }
 function openSequenceByUid(uid){
  const seq=findSequence(uid);
  if(seq)openSequence(seq);
  return !!seq;
 }
 return {setup,scan,matches,matchesPackage,card,packageCard,openFile,openPackage,openImageGallery,sequences:()=>sequences,sequenceMembers:()=>sequenceMembers,sequenceCard,openSequence,findSequence,openSequenceByUid,entries:()=>files,packages:()=>packages,count:()=>files.length,truncated:()=>truncated,loading:()=>loading,packageAction};
}
