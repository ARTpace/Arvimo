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
import {assetCard,cardMedia,cardNote} from './card-shell.js';
/** 字节格式化只有一份实现（下载任务卡那边），这里复用，别再抄第三遍。 */
import {sizeText as fmtBytes} from './download-card.js';

/** 浏览器自己能显示的图片，直接 <img>；其余交给 loader（TGA/PSD）或明确报不支持。 */
const NATIVE_IMAGE=/\.(png|jpe?g|jfif|gif|webp|avif|svg|bmp|ico)$/i;
/** 浏览器解不了、但后端能转成 PNG 的格式：素材包里成堆的 PSD 靠这条才进得了缩略图墙。 */
const SERVER_IMAGE=/\.psd$/i;
/** 能进图片素材包预览的格式（缩略图墙 + 大图）。 */
const GALLERY_IMAGE=/\.(png|jpe?g|jfif|gif|webp|avif|svg|bmp|ico|psd)$/i;
const BROWSER_VIDEO=/\.(mp4|webm|m4v|ogv)$/i;
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

export function createLocalFiles({$,icon,esc,gltfPreview,notify,onChanged}){
 let files=[];
 let packages=[];
 let truncated=false;
 let loading=false;
 let seq=0;

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
 async function scan(){
  const mine=++seq;
  loading=true;
  try{
   const response=await fetch('/api/library/scan',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:'{}'});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
   if(mine!==seq)return null;
   files=Array.isArray(data.files)?data.files:[];
   packages=Array.isArray(data.packages)?data.packages:[];
   truncated=!!data.truncated;
   return {files,packages,truncated};
  }catch(error){
   if(mine===seq){files=[];packages=[];truncated=false;}
   throw error;
  }finally{
   if(mine===seq)loading=false;
  }
 }

 /** 搜索词与类型筛选跟着资产库工具条走，两种条目共用一套条件。 */
 function matches(file,{query='',kind=''}={}){
  if(kind){
   const want=KIND_FILTER[kind];
   if(!want||file.kind!==want)return false;
  }
  const q=String(query||'').trim().toLowerCase();
  if(!q)return true;
  return file.name.toLowerCase().includes(q)||file.rel.toLowerCase().includes(q);
 }

 /** 资产包共用同一套搜索词与类型筛选。 */
 function matchesPackage(pkg,{query='',kind=''}={}){
  if(kind){
   const want=PACKAGE_FILTER[kind];
   if(!want||pkg.category!==want)return false;
  }
  const q=String(query||'').trim().toLowerCase();
  if(!q)return true;
  return [pkg.title,pkg.author,pkg.rel].some(value=>String(value||'').toLowerCase().includes(q));
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
  // 官方缩略图走现有图片代理（CSP 只允许 self，直连外链会被拦），包内图片直接读本地文件。
  const cover=pkg.thumb?`/api/image?url=${encodeURIComponent(pkg.thumb)}`:(pkg.cover?packageImageUrl(pkg,pkg.cover,512):'');
  // 标题行只有一行位置：作者和统计二选一，作者没有时显示文件数与体积。
  const byline=pkg.author?`<span class="card-byline">${esc(pkg.author)}</span>`
   :`<span class="card-byline">${esc([`${pkg.fileCount} 个文件`,fmtBytes(pkg.bytes)].filter(Boolean).join(' · '))}</span>`;
  // 详细事实（更新时间、体积、磁盘份数、路径）收进提示键，不占版面。
  const tip=[`更新于 ${fmtTime(pkg.mtime)}`,fmtBytes(pkg.bytes),pkg.copies>1?`磁盘上有 ${pkg.copies} 份`:'',pkg.rel].filter(Boolean).join(' · ');
  // 没有 info.json 的包（用户自己拷进来的素材）给一个登记入口：写一次 uid + 事实字段，
  // 之后它就有固定身份，收藏/标签/整理都认得住。ZIP 包写不进去，不给按钮。
  const register=pkg.type==='folder'&&!pkg.hasMeta
   ?`<button type="button" class="text-button" data-package-register="${esc(packageKey(pkg))}" title="写入 info.json，给这个素材包一个固定身份">✎ 登记</button>`
   :'';
  // 整包下载：文件夹包由后端现场压成 ZIP（不落临时文件），ZIP 包直接发原文件。
  // 主机和局域网访客都显示——访客拿到的是自己电脑上的一个压缩包。
  const download=`<button type="button" class="card-download" data-package-download="${esc(packageKey(pkg))}" title="把整个素材包下载成 ZIP" aria-label="下载素材包 ${esc(pkg.title)}">${icon('download')}<span>下载</span></button>`;
  return assetCard({
   keyName:'package',
   keyValue:esc(packageKey(pkg)),
   // 素材包的封面是 1:1 图，按 contain 显示（cover 会把 alpha 蒙版的边切掉）。
   className:'thumb-contain',
   media:cardMedia({src:cover?esc(cover):'',alt:esc(pkg.title),icon:icon(PACKAGE_ICON[pkg.category]||'cube'),text:esc(label)}),
   overlay:`<button class="preview-hit" aria-label="打开素材包 ${esc(pkg.title)}"><span>${icon(PACKAGE_ICON[pkg.category]||'cube')}打开素材包</span></button><div class="card-type">${icon(PACKAGE_ICON[pkg.category]||'cube')}${esc(label)}</div>`,
   titleAttrs:`title="${esc(pkg.rel)}"`,
   title:esc(pkg.title),
   byline,
   side:cardNote(tip,icon,esc),
   actions:`${register}${download}`,
  });
 }

 function packageKey(pkg){return `${pkg.root}|${pkg.rel}`;}
 /** 包内条目的 rel 是相对包目录的（`JRO_JP.Ornament01_out.png`），取文件接口要的是相对扫描根的路径，
  *  少拼一层包目录就会 404/400，缩略图一个都不出来（2026-10-21 实测）。 */
 function packageRel(pkg,rel){return pkg.rel?`${pkg.rel}/${rel}`:rel;}
 function packageFileUrl(pkg,rel){return `/api/local/file?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent(packageRel(pkg,rel))}`;}
 /** 整包下载地址：文件夹包走现场打包端点，ZIP 包直接发原文件（不套娃）。 */
 function packageZipUrl(pkg){
  return pkg.type==='zip'
   ?`/api/local/file?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent(pkg.rel)}`
   :`/api/local/package-zip?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent(pkg.rel)}`;
 }
 /** 缩略图 URL：一律走后端缩略图缓存（PNG 缩放、PSD 转码都在那里，w 是最大边）。
  *  后端遇到做不了的格式（SVG / 没装 ffmpeg）会原样透传，所以这里不必要再按格式分支。 */
 function packageImageUrl(pkg,rel,width){
  return `/api/local/thumb?root=${encodeURIComponent(pkg.root)}&rel=${encodeURIComponent(packageRel(pkg,rel))}&w=${width||512}`;
 }
 /** 大图 URL：浏览器自己认的格式直接给原文件（保留原分辨率，也不做无谓的 PNG 重编码，
  *  JPG 转 PNG 只会更大）；PSD 这类必须靠后端转码。 */
 function packagePhotoUrl(pkg,rel){
  const name=String(rel).split('/').pop();
  return SERVER_IMAGE.test(name)?packageImageUrl(pkg,rel,2048):packageFileUrl(pkg,rel);
 }

 function openPackage(pkg){
  if(!pkg)return;
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
   .filter(item=>item.rel&&GALLERY_IMAGE.test(item.name))
   .map(item=>({...item,rel:item.rel,name:item.name}));
 }

const MAX_TILES=120;
let galleryPkg=null,galleryImages=[],galleryIndex=0,galleryZoom=null;

/** 图片素材包：上面左大图、右侧素材包信息，下方一整条可横向滚动的缩略图。
 *  滚轮缩放大图、按住拖动看细节；缩略图文件名默认不显示，悬停才浮出。 */
function openGallery(pkg,images,index=0){
 if(!pkg||!images.length)return;
 const dlg=$('#file-preview-dialog'),stage=$('#file-preview-stage'),aside=$('#file-preview-details');
 if(!dlg||!stage||!aside)return;
 galleryPkg=pkg;
 galleryImages=images.slice(0,MAX_TILES);
 galleryIndex=Math.max(0,Math.min(Number(index)||0,galleryImages.length-1));
 clearStage();
 dlg.classList.add('is-gallery');
 stage.classList.add('is-gallery');
 $('#file-preview-title').innerHTML=`${icon(PACKAGE_ICON[pkg.category]||'image')}${esc(pkg.title)}`;
 // 这一行「资产包预览 · 只读」压在画面正中，纯噪音，直接留空。
 $('#file-preview-hint').textContent='';
 stage.innerHTML=`<div class="local-gallery-main" data-gallery-main>
   <img class="local-gallery-photo" alt="" draggable="false">
   <p class="local-gallery-error" hidden>这张图生成不了预览</p>
   <div class="local-gallery-hud">
    <button type="button" data-gallery-zoom="out" aria-label="缩小">−</button>
    <span data-gallery-zoom-label>100%</span>
    <button type="button" data-gallery-zoom="in" aria-label="放大">+</button>
    <button type="button" data-gallery-zoom="reset" title="适应窗口">适应</button>
   </div>
  </div>`;
 // 缩略图条挂在 dialog 上（不是 preview-layout 里面），才能横跨大图和信息栏的整个宽度。
 const strip=ensureStrip(dlg);
 strip.innerHTML=galleryImages.map((item,i)=>`<button type="button" class="local-gallery-thumb" data-gallery-index="${i}" title="${esc(item.name)}"><img src="${esc(packageImageUrl(pkg,item.rel,256))}" alt="${esc(item.name)}" loading="lazy" decoding="async"><span>${esc(item.name)}</span></button>`).join('');
 galleryZoom=bindZoom(stage.querySelector('[data-gallery-main]'),stage.querySelector('[data-gallery-zoom-label]'));
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

/** 右侧信息栏：素材包概况 + 当前这张图。换图时整块重写，内容短，不怕重建。 */
function galleryInfoHtml(pkg,item){
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

/** 换大图只改 <img> 的 src，缩略图条保留不动：整块重绘会让横向滚动位置跳回开头。 */
function showGalleryImage(index,{reveal=false}={}){
 const item=galleryImages[index];
 if(!item)return;
 galleryIndex=index;
 const img=$('#file-preview-stage')?.querySelector('img');
 if(img){
  const error=img.parentElement?.querySelector('.local-gallery-error');
  img.onload=()=>{if(error)error.hidden=true;img.classList.remove('is-broken');};
  // PSD 转码失败（坏文件 / 不认识的压缩）时别留一张破图，说清楚为什么。
  img.onerror=()=>{if(error)error.hidden=false;img.classList.add('is-broken');};
  img.src=packagePhotoUrl(galleryPkg,item.rel);img.alt=item.name;
 }
 galleryZoom?.reset();
 const aside=$('#file-preview-details');
 if(aside)aside.innerHTML=galleryInfoHtml(galleryPkg,item);
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
 main.addEventListener('wheel',event=>{
  event.preventDefault();
  const rect=main.getBoundingClientRect();
  zoomAt(state.scale*Math.exp(-event.deltaY*0.0016),
   event.clientX-rect.left-rect.width/2,event.clientY-rect.top-rect.height/2);
 },{passive:false});
 let drag=null;
 main.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.target.closest('.local-gallery-hud'))return;
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

 function fileKindOf(name){
  if(/\.(glb|gltf|fbx|obj|stl|ply|3mf)$/i.test(name))return 'model';
  if(/\.(hdr|exr)$/i.test(name))return 'env';
  if(/\.(png|jpe?g|jfif|gif|webp|avif|svg|bmp|ico|tga|tif|tiff|psd)$/i.test(name))return 'image';
  return 'other';
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
  const stage=$('#file-preview-stage');
  if(!stage)return;
  for(const node of stage.querySelectorAll('video,audio')){try{node.pause();node.removeAttribute('src');}catch{}}
  for(const node of stage.querySelectorAll('iframe'))node.removeAttribute('src');
  stage.replaceChildren();
  stage.hidden=false;
  stage.classList.remove('is-gallery');
  const dlg=$('#file-preview-dialog');
  dlg?.classList.remove('is-gallery');
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

 async function openFile(file){
  if(!file)return;
  if(file.kind==='model'||file.kind==='env'){openModel(file);return;}
  const url=fileUrl(file);
  try{
   if(file.kind==='image'){
    if(NATIVE_IMAGE.test(file.name)){
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
    showOther(file,`<audio class="file-preview-audio" controls autoplay src="${url}"></audio>`,'音频预览 · 只读');
    return;
   }
   if(file.kind==='video'){
    const native=BROWSER_VIDEO.test(file.name);
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
   if(file.kind==='document'){
    if(/\.pdf$/i.test(file.name)){
     showOther(file,`<iframe class="file-preview-frame" src="${url}" title="${esc(file.name)}"></iframe>`,'PDF 预览 · 只读');
     return;
    }
    if(/\.(html?|htm)$/i.test(file.name)){
     // sandbox 无 allow-scripts：页面里的脚本不执行，只当静态文档看。
     showOther(file,`<iframe class="file-preview-frame" sandbox src="${url}" title="${esc(file.name)}"></iframe>`,'HTML 静态预览（脚本已禁用）');
     return;
    }
    const response=await fetch(url,{cache:'no-store'});
    const text=await response.text();
    const clipped=text.length>200000?`${text.slice(0,200000)}\n\n…（文件太长，只显示前 200 KB）`:text;
    showOther(file,`<pre class="file-preview-text">${esc(clipped)}</pre>`,'文本预览 · 只读');
    return;
   }
   showOther(file,`<div class="file-preview-note">这类文件没有内建预览。它在磁盘上的位置：<br><code>${esc(file.rel)}</code></div>`,'无预览');
  }catch(e){
   showOther(file,`<div class="file-preview-note">预览失败：${esc(e.message)}</div>`,'预览失败');
  }
 }

 function openFromEvent(event){
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
    const button=event.target.closest('[data-package-register]');
    if(button){
     event.preventDefault();
     event.stopPropagation();
     register(packages.find(entry=>packageKey(entry)===button.dataset.packageRegister));
     return;
    }
    if(openFromEvent(event))event.preventDefault();
   });
   grid.addEventListener('keydown',event=>{
    if(event.key!=='Enter'&&event.key!==' ')return;
    if(event.target.closest?.('[data-package-register],[data-package-download]'))return;
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
   galleryPkg=null;galleryImages=[];galleryIndex=0;galleryZoom=null;
  });
 }

 return {setup,scan,matches,matchesPackage,card,packageCard,openFile,openPackage,entries:()=>files,packages:()=>packages,count:()=>files.length,truncated:()=>truncated,loading:()=>loading};
}
