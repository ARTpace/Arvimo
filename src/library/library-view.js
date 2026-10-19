// The library's rendering layer: counts/status line, grid & waterfall, filter placement, preview.
//
// These five functions are one concern — turn app state into DOM — and they only ever read state
// that another module owns. Splitting them out keeps app.js responsible for *deciding* what is true
// (which feed answered, what is selected, what is queued) and this file for *drawing* it.
// Collaborators that only exist once the app has finished wiring itself arrive as getters.
import {statusText,subtitleText,pageInfoNote,loadMoreLabel,describeRequest} from './discovery-view.js';
import {galleryAvailable,aspectRatioStyle} from './gallery-view.js';
import {findLocalJob} from './blender-send.js';
import {openExternal} from './open-url.js';

export function createLibraryView(ctx){
 const {$,icon,esc,fmt,state,queuePulse,cardView,composite,filtered,activeModes,galleryActive,categories,describeArt,artstationUI,downloadsUI,filterTreesUI,mergedFiltersUI,findModel,blenderSendButton,imageDownload,gltfPreview}=ctx;
function counts(){
 const activeStates=new Set(['queued','held','retry_wait','running','transferring','validating','saving','cancelling']);
 const activeJobs=(downloadsUI()?.jobs||[]).filter(j=>activeStates.has(j.state));
 const activeUids=new Set(activeJobs.map(j=>j.uid));
 const pulse=[...queuePulse].filter(([uid,t])=>Date.now()-t<6000&&!activeUids.has(uid)).length;
 const queue=activeJobs.length+pulse;
 $('#nav-count').textContent=state.models.length;$('#fav-count').textContent=state.models.filter(m=>state.favorites.has(m.uid)).length;$('#queue-count').textContent=queue;$('#queue-count').classList.toggle('has-queue',queue>0);
 $('#selected-count').textContent=state.selected.size;$('#selection-bar').hidden=!state.selected.size||state.route==='downloads';
}
function renderStatus(){
 const f=composite(),el=$('#scan-status');el.hidden=state.route!=='discover';
 // 各站「已加载 / 本轮跳过 / 没有匹配」已经能从结果本身看出来，不再铺在搜索框下面。
 // 这一行只留给检索中、失败、中止，以及链接解析的返回按钮。
 const warnings=(f.warnings||[]).filter(text=>!/本轮跳过|没有对应分类|没有匹配/.test(text));
 const noteworthy=f.busy||f.error||f.aborted||state.source==='link';
 el.classList.toggle('idle',!noteworthy);el.classList.toggle('error',f.error);
 el.replaceChildren();
 if(!noteworthy)return;
 if(f.busy)el.insertAdjacentHTML('beforeend','<span class="spinner"></span>');
 const span=document.createElement('span');span.textContent=f.error||f.aborted||state.source==='link'?statusText({sources:f.sources,feeds:state.feeds}):(f.busy?'正在检索…':'');el.append(span);
 if(f.busy){const stop=document.createElement('button');stop.className='text-button';stop.textContent='停止检索';stop.id='cancel-discovery';stop.onclick=()=>f.controller?.abort();el.append(stop);}
 if(state.source==='link'){const back=document.createElement('button');back.className='text-button';back.id='back-to-search';back.textContent='返回搜索结果';back.onclick=()=>{state.source='search';renderGrid();};el.append(back);}
 if(warnings.length&&(f.error||f.aborted)){const warning=document.createElement('span');warning.className='warning';warning.textContent=warnings.slice(0,2).join('；');el.append(warning);}
}
function renderGrid(){
 // 两个平台的卡片共用同一张模型网格（卡片按 platform 走各自的下载通道）。
 // 网格内容由 composite() 决定：搜索时是当前平台各流交错的结果，链接解析时是解析结果。
 const online=state.route==='discover',f=composite(),models=filtered(),gallery=galleryActive(state);
 const translation=$('#discovery-translation');
 translation.textContent=online&&state.source!=='link'?[...new Set(f.sources.map(mode=>state.feeds[mode].translation).filter(Boolean))].join(' · '):'';
 translation.hidden=!translation.textContent;
 $('#model-count').textContent=models.length;$('#library-title').firstChild.textContent=(online?describeRequest({source:state.source,platform:state.platform,feeds:state.feeds,categories:categories,describeArt:request=>describeArt(request)}):state.route==='favorites'?'我的收藏':'我的模型库')+' ';
 $('#library-subtitle').textContent=online?subtitleText({source:state.source,platform:state.platform,feeds:state.feeds,count:f.rows.length,pages:f.pages,request:f.request,categories:categories}):state.search?`在本地库中匹配 “${state.search}” · 不会发起在线搜索`:`本地已保留 ${state.models.length} 个模型 · 在线结果与本地库独立`;
 $('#local-toolbar').hidden=online;$('#clear-library').hidden=online;
 const heading=document.querySelector('.library-heading');
 const displayTools=document.querySelector('.display-tools');
 const toolsHost=online?heading:$('#local-toolbar');
 // ponytail: move the existing controls so IDs, event handlers and view state stay shared.
 if(displayTools.parentElement!==toolsHost)toolsHost.append(displayTools);
 heading.hidden=!online;
 $('#local-facets').hidden=online;
 if(!online){
  const total=state.route==='favorites'?state.models.filter(model=>state.favorites.has(model.uid)).length:state.models.length;
  $('#local-results').textContent=models.length===total?`${total} 项资产`:`${models.length} / ${total} 项`;
  $('#local-results').title=downloadsUI()?.connected?'当前匹配数量 / 资产总数':'下载服务未连接，文件状态暂不可用';
  $('#local-status').disabled=!downloadsUI()?.connected;
  $('#reset-local-filters').hidden=!(state.search.trim()||state.filter!=='all'||$('#local-kind').value||$('#local-status').value);
 }
 document.body.dataset.route=state.route;
 // ponytail: reuse the existing online selectors; local sorting stays in its own toolbar.
 $('#unified-kind-wrap').hidden=!online||state.platform!=='all';
 $('#unified-sort-wrap').hidden=!online||state.platform!=='all';
 if(!online){
  $('#library-title').firstChild.textContent=state.route==='favorites'?'我的收藏 ':'我的资产库 ';
  $('#library-subtitle').textContent='入库保存资源记录，下载后可使用本地文件';
 }
 // 三种展示互斥，按钮状态只由这里的状态推导，不在点击处理里各写一遍。
 $('#grid').classList.toggle('compact',state.compact&&!gallery);$('#grid').classList.toggle('gallery',gallery);$('#grid').classList.toggle('loading',online&&f.busy);$('#grid').setAttribute('aria-busy',online&&f.busy?'true':'false');
 $('#grid-view').classList.toggle('active',!state.compact&&!gallery);$('#list-view').classList.toggle('active',state.compact&&!gallery);
 $('#gallery-view').classList.toggle('active',gallery);$('#gallery-view').hidden=!galleryAvailable(state);
 $('#grid').innerHTML=models.map(m=>cardView.card(m,{gallery})).join('')||(online&&f.busy?'<div class="skeleton"></div>'.repeat(4):'');
 $('#empty').hidden=models.length>0||(online&&f.busy);
 const searched=state.source==='link'?!!state.feeds.web.request:activeModes().every(mode=>!!state.feeds[mode].request);
 $('#empty h3').textContent=online?(f.error?'暂时无法获取资产':searched?'没有找到匹配的资产':'从一个关键词开始'):state.route==='favorites'?'还没有匹配的收藏':'模型库，留给真正想用的资产';
 $('#empty p').textContent=online?(f.error?'检查网络后重新搜索。旧结果不会被失败请求覆盖。':searched?`试试更短的关键词、英文关键词，或减少筛选条件。${state.platform==='artstation'?'ArtStation 上的 Marmoset Viewer 作品只占搜索结果的一部分。':''}`:'直接输入关键词，或选择上方的推荐词。'):state.search||state.filter!=='all'?'尝试清除本地搜索与筛选条件。':'去“发现资产”搜索，点击加入模型库或爱心收藏，即可在这里保留。';
 $('#empty-explore').hidden=online&&f.busy;
 if(!online){
  const narrowed=state.search.trim()||state.filter!=='all'||$('#local-kind').value||$('#local-status').value;
  $('#empty h3').textContent=narrowed?'没有匹配的资产':state.route==='favorites'?'还没有收藏':'为下一个项目，收集第一项资产';
  $('#empty p').textContent=narrowed?'试试其他关键词或类型，或点击“清除筛选”恢复全部资产。':'前往“发现资产”，将需要的资源加入资产库。入库记录与本地下载文件分别管理。';
  $('#empty-explore').hidden=!!narrowed;
 }
 document.querySelectorAll('.thumbnail').forEach(img=>img.addEventListener('error',()=>{img.replaceWith(Object.assign(document.createElement('div'),{className:'image-placeholder',innerHTML:`${icon('cube')}<span>缩略图加载失败</span>`}));},{once:true}));
 // 搜索结果里没有宽高，瀑布流只能先按方形占位；图片解码后再把真实比例写回，列高一次纠正到位。
 if(gallery)document.querySelectorAll('#grid .thumbnail').forEach(img=>{
  const apply=()=>{const ratio=aspectRatioStyle(img.naturalWidth,img.naturalHeight);if(ratio)img.style.aspectRatio=ratio;};
  if(img.complete)apply();else img.addEventListener('load',apply,{once:true});
 });
 $('#pagination').hidden=!online||!(f.next||f.pending.length); $('#page-info').textContent=`已加载 ${f.rows.length} 个 · ${f.pending.length?`待解析 ${f.pending.length} 个链接`:pageInfoNote({source:state.source,platform:state.platform})}`;
 $('#load-more').disabled=$('#load-all').disabled=f.busy||f.rows.length>=1000;$('#load-more').innerHTML=`${loadMoreLabel({source:state.source,platform:state.platform})} ${icon('arrow-down')}`;
 renderStatus();counts();
 syncStickyOffset();
}
/** sticky 偏移同步：结果标题行钉在搜索区下面，而搜索区高度随筛选行摆放变化（宽屏在侧栏、
 *  窄屏搬回面板里），所以每次渲染量一次外层 .search-sticky 的高度（含它自己那段上间距）
 *  写进 CSS 变量。非 discover 页整块 display:none，offsetHeight 为 0，标题行直接落到
 *  「顶栏 + 内容区上边距」处——正是想要的行为。 */
let stickyRO=null;
function syncStickyOffset(){
 const sticky=document.querySelector('.search-sticky');
 document.documentElement.style.setProperty('--sticky-search',sticky?sticky.offsetHeight+'px':'0px');
 // 搜索区里有两样东西不由 renderGrid 驱动高度：筛选行在宽/窄屏之间搬进搬出、
 // 以及扫描状态行（#scan-status）文案增减。用 RO 兜住这两种变化，否则标题行会钉在
 // 旧偏移上，和搜索区之间露出一条缝、卡片从缝里透出来。
 if(sticky&&!stickyRO&&typeof ResizeObserver==='function'){
  stickyRO=new ResizeObserver(()=>{
   document.documentElement.style.setProperty('--sticky-search',sticky.offsetHeight+'px');
  });
  stickyRO.observe(sticky);
 }
}
/** 筛选行住在哪：宽屏进左侧栏（#filter-rows），窄屏侧栏只剩 65px 图标条放不下，
 *  就搬回搜索卡片（#panel-filters）——也就是它原来的位置。搬的是同一批节点，
 *  事件、自绘下拉、当前选中的值都跟着走，不复制第二份 DOM。 */
const FILTER_ROWS=['#filters-sketchfab','#filters-artstation','#filters-polyhaven','#filters-ambientcg','#filters-polypizza','#filters-kenney','#filters-freestylized','#filters-merged','#filters-all'];
function placeFilters(){
 const narrow=window.matchMedia('(max-width:780px)').matches;
 const host=$(narrow?'#panel-filters':'#filter-rows');
 for(const selector of FILTER_ROWS){const row=$(selector);if(row&&row.parentElement!==host)host.append(row);}
 // 两个模式按键跟着一起搬：窄屏侧栏只剩 65px 图标条塞不下它们，但「找模型 / 找参考图」是入口级
 // 的东西，不能跟着消失。搬的是同一个节点，绑好的点击处理跟着走。
 const modes=$('#side-modes');
 if(modes){
  if(narrow){if(modes.parentElement!==$('#panel-filters'))$('#panel-filters').prepend(modes);}
  else{const label=$('#side-filters .side-label');if(label&&modes.nextElementSibling!==label)$('#side-filters').insertBefore(modes,label);}
 }
 $('#side-filters').hidden=narrow;
 filterTreesUI()?.setNarrow(narrow);                          // 65px 图标条放不下树，整棵折起来只留分支标题
 mergedFiltersUI()?.setNarrow(narrow);
}
function preview(uid){
 const m=findModel(uid);if(!m)return;
 // 上一个预览弹窗还没关就又点了一个（极端连点 / 上一次 close 事件还没排到），
// 直接 showModal 会抛 InvalidStateError、后面的 load 根本不执行，于是画面卡在上一个模型。
// 先把已开的弹窗关掉再开，保证每次都从干净状态开始。
// 这里不要顺手补上「释放上一轮预览」那一手：释放逻辑统一在 app.js 的弹窗 close 监听里，
// 且那个监听会判断弹窗是否已重新打开（close 事件是排队异步派发的，见那里的说明）。
 const dlg=$('#preview-dialog');if(dlg&&dlg.open)dlg.close();
 // 有内嵌 Marmoset 场景的才开 3D 预览弹窗；纯图片作品直接去官方作品页，弹窗里没有东西可看。
 if(artstationUI().isArt(m))return artstationUI().has3dScene(m)?artstationUI().openPreview(m):artstationUI().openArtwork(m);
 // ambientCG 材质没有 3D 模型可转，但有官方的 PBR 材质查看器（releases.pbr.one，官网自己也在
 // 内嵌它）：iframe 直接给材质上色、调法线和粗糙度。没有预览地址的旧卡片退回官方页面。
 if(m.platform==='ambientcg')return previewMaterial(m);
 // Poly Haven 官方没有可嵌入的 viewer（官网是自己用 three.js 加载 CDN 数据），
 // 但模型 / 贴图 / HDRI 三类我们都能本地渲染：gltf-preview.js 取同一份官方 CDN 数据自己画。
 if(m.platform==='polyhaven'){
  const phType=m.assetType||'models';
  polyhavenDetails(m,phType);
  $('#viewer').removeAttribute('src');
  $('#preview-dialog').showModal();
  gltfPreview.load(m.assetId,phType);
  return;
 }
 // FreeStylized 同样没有可嵌入 viewer：模型包里是 FBX、材质包是 PNG 组、天空盒是全景图，
 // 全都由服务端解包后本地渲染。资源包 / Alpha / 智能材质没有可渲染内容，直接去官方页面。
 if(m.platform==='freestylized'){
  const fsType=m.assetType||'models';
  if(!['models','textures','skybox'].includes(fsType))return openExternal(m.url);
  freestylizedDetails(m,fsType);
  $('#viewer').removeAttribute('src');
  $('#preview-dialog').showModal();
  gltfPreview.loadFreestylized(m.assetId,fsType);
  return;
 }
 document.querySelector('.viewer-hint').textContent='正在加载 Sketchfab 交互预览…';
 const licenseUrl=typeof m.licenseUrl==='string'&&/^https:\/\/creativecommons\.org\//.test(m.licenseUrl)?m.licenseUrl:null;
 $('#model-details').innerHTML=`<div class="eyebrow">MODEL DETAILS</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author)}</p><div class="details-stats"><div><strong>${fmt(m.faces)}</strong><span>面数</span></div><div><strong>${fmt(m.vertices)}</strong><span>顶点</span></div><div><strong>${m.animations||0}</strong><span>动画</span></div><div><strong>${fmt(m.views)}</strong><span>浏览</span></div></div><div class="detail-license"><strong>${esc(m.license)}</strong>${licenseUrl?`<a href="${esc(licenseUrl)}" target="_blank" rel="noopener noreferrer">阅读许可条款 ${icon('external')}</a>`:''}<p>${m.downloadable?'平台标记为可下载，不代表可商用；请遵循许可证的署名、非商业等要求。':'未标记为可下载，仅在拥有明确授权时导出。'}</p></div><div class="tag-list">${(m.tags||[]).slice(0,8).map(t=>`<button data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div><button class="secondary" data-action="ai-tags" data-uid="${uid}">AI 整理标签</button><button class="secondary" data-action="collect" data-uid="${uid}">${icon('folder')}加入我的模型库</button><button class="primary" data-action="download" data-uid="${uid}">${icon('download')}导出到本地</button>${blenderSendButton({job:findLocalJob(downloadsUI()?.jobs||[],uid),className:'secondary',label:'发送到 Blender'})}<a class="source-link" href="https://sketchfab.com/models/${uid}" target="_blank" rel="noopener noreferrer">打开原始模型页面 ${icon('external')}</a>`;
 $('#viewer').src=`https://sketchfab.com/models/${uid}/embed?autostart=1&ui_infos=0&ui_watermark_link=0`;$('#preview-dialog').showModal();
}
 /** 预览面板的精度选择：与卡片共用同一份 select，并把已下载档位打勾（判据同卡片：
 *  saved + 文件还在；没记精度的老任务算默认 2K）。 */
 function detailResolutionPicker(m){
  const res=new Set((downloadsUI()?.jobs||[]).filter(t=>t.uid===m.uid&&t.state==='saved'&&t.fileExists!==false&&t.id).map(t=>t.options?.resolution||'2K'));
  return cardView.materialResolutionSelect(m,res);
 }
 /** Poly Haven 的侧栏：与 Sketchfab 卡片同一套收藏/导出按钮，右侧留给资产自己的信息。
  *  左侧是本地 three.js 渲染（见 gltf-preview.js），不是 iframe，所以这里不碰 #viewer。
  *  模型 / 贴图 / HDRI 三类的文案各有一套，但按钮全共用。 */
 function polyhavenDetails(m,type='models'){
  const eyebrow=type==='textures'?'POLY HAVEN TEXTURE':type==='hdris'?'POLY HAVEN HDRI':'POLY HAVEN MODEL';
  const previewNote=type==='textures'
   ?'预览是本地渲染的 1K 贴图（球体看高光法线，地面看平铺）；导出的材质包包含全部通道，重命名后可直接拖进 Unity / Blender。'
   :type==='hdris'
   ?'预览是本地渲染的 1K HDR 全景（反射球看照明分布）；导出按下面选的分辨率打包 .hdr / .exr。'
   :'预览是本地渲染的 1K glTF，与官网同一份数据；导出可选 glTF / FBX / Blend，贴图按下面选的分辨率打包。';
  $('#model-details').innerHTML=`<div class="eyebrow">${eyebrow}</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author||'Poly Haven')}</p><div class="details-stats"><div><strong>1K</strong><span>预览精度</span></div><div><strong>CC0</strong><span>可商用</span></div></div><div class="detail-license"><strong>${esc(m.license||'CC0')}</strong><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">在 Poly Haven 打开 ${icon('external')}</a><p>${previewNote}</p></div><button class="secondary" data-action="collect" data-uid="${esc(m.uid)}">${icon('folder')}加入我的模型库</button>${detailResolutionPicker(m)}<button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}导出到本地</button><a class="source-link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开官方页面 ${icon('external')}</a>`;
 }
 /** FreeStylized 的侧栏：与 Poly Haven 同一套按钮，右侧文案按类型分三套。
  *  预览是本地渲染（gltf-preview.js 的 loadFreestylized），不是 iframe，所以这里不碰 #viewer。 */
 function freestylizedDetails(m,type='models'){
  const eyebrow=type==='textures'?'FREESTYLIZED MATERIAL':type==='skybox'?'FREESTYLIZED SKYBOX':'FREESTYLIZED MODEL';
  const previewNote=type==='textures'
   ?'预览是本地渲染的 2K 贴图（球体看高光法线，地面看平铺）；导出的材质包包含全部通道，重命名后可直接拖进 Unity / Blender。'
   :type==='skybox'
   ?'预览是本地渲染的全景贴图（反射球看照明分布）；导出的是完整天空盒资源包。'
   :'预览是本地渲染的资源包内模型；FreeStylized 的模型包只有 FBX，导出后可直接在 Blender 里打开。';
  $('#model-details').innerHTML=`<div class="eyebrow">${eyebrow}</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author||'FreeStylized')}</p><div class="details-stats"><div><strong>${type==='textures'?'2K':type==='skybox'?'全景':'FBX'}</strong><span>预览内容</span></div><div><strong>免费</strong><span>官网授权</span></div></div><div class="detail-license"><strong>${esc(m.license||'FreeStylized 免费资源')}</strong><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">在 FreeStylized 打开 ${icon('external')}</a><p>${previewNote}</p></div><button class="secondary" data-action="collect" data-uid="${esc(m.uid)}">${icon('folder')}加入我的模型库</button>${detailResolutionPicker(m)}<button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}导出到本地</button>${blenderSendButton({job:findLocalJob(downloadsUI()?.jobs||[],m.uid),className:'secondary'})}<a class="source-link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开官方页面 ${icon('external')}</a>`;
 }
 /** ambientCG 材质的交互预览：iframe 里是官方 PBR 查看器（拖动转视角、贴图实时着色），
  *  侧栏是材质自己的信息——贴图通道、CC0 授权、与模型卡片同一套收藏/导出按钮。
  *  查看器地址是懒加载的：搜索结果自带，旧收藏卡片开预览时按 assetId 现取一次并缓存回卡片。 */
 async function previewMaterial(m){
  const maps=m.maps||[];
  $('#model-details').innerHTML=`<div class="eyebrow">PBR MATERIAL</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author)}</p><div class="details-stats"><div><strong>${maps.length||'—'}</strong><span>贴图通道</span></div><div><strong>CC0</strong><span>可商用</span></div></div><div class="detail-license"><strong>${esc(m.license)}</strong><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">在 ambientCG 打开 ${icon('external')}</a><p>预览来自 ambientCG 官方的 PBR 材质查看器；导出的材质包包含全部贴图通道，重命名后可直接拖进 Unity / Blender。</p></div><div class="tag-list">${maps.slice(0,8).map(t=>`<button data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div><button class="secondary" data-action="collect" data-uid="${esc(m.uid)}">${icon('folder')}加入我的模型库</button>${detailResolutionPicker(m)}<button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}导出材质到本地</button><a class="source-link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开原始材质页面 ${icon('external')}</a>`;
  const hint=document.querySelector('.viewer-hint');
  $('#viewer').removeAttribute('src');$('#preview-dialog').showModal();
  if(m.viewerUrl){hint.textContent='拖动旋转 · 滚轮缩放 · 官方 PBR 材质预览（需要联网）';$('#viewer').src=m.viewerUrl;return;}
  if(!m.assetId){hint.textContent='这个材质缺少资产标识，请到官方页面查看预览';return;}
  hint.textContent='正在获取官方 PBR 材质预览…';
  try{
   const response=await fetch(`/api/ambientcg/preview?id=${encodeURIComponent(m.assetId)}`,{cache:'no-store',headers:{'X-SFX-Local':'1'}});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
   m.viewerUrl=typeof data.viewerUrl==='string'?data.viewerUrl:'';
   if(m.viewerUrl){hint.textContent='拖动旋转 · 滚轮缩放 · 官方 PBR 材质预览（需要联网）';$('#viewer').src=m.viewerUrl;}
   else hint.textContent='ambientCG 没有为这个材质提供可嵌入预览，请到官方页面查看';
  }catch(e){hint.textContent=`无法加载交互预览：${e.message}`;}
 }
 return {counts,renderStatus,renderGrid,placeFilters,preview,syncStickyOffset};
}
