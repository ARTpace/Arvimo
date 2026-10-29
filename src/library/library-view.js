// The library's rendering layer: counts/status line, grid & waterfall, filter placement, preview.
//
// These five functions are one concern — turn app state into DOM — and they only ever read state
// that another module owns. Splitting them out keeps app.js responsible for *deciding* what is true
// (which feed answered, what is selected, what is queued) and this file for *drawing* it.
// Collaborators that only exist once the app has finished wiring itself arrive as getters.
import {statusText,subtitleText,pageInfoNote,loadMoreLabel,describeRequest} from './discovery-view.js';
import {galleryAvailable,aspectRatioStyle,displayGridClass} from './gallery-view.js';
import {platformById,isPictureSite,pictureSiteLoginable} from './platforms.js';
import {findLocalJob} from './blender-send.js';
import {openExternal} from './open-url.js';
import {pictureSiteJobUid} from './platforms.js';
import {observeMasonry} from './masonry.js';
import {openPolyforkPreview} from './polyfork-params.js';
import {previewActions} from './preview-actions.js';
import {localAssetCategories} from './local-filters.js';

export function createLibraryView(ctx){
 const {$,icon,esc,fmt,state,queuePulse,cardView,composite,filtered,activeModes,galleryActive,categories,describeArt,artstationUI,downloadsUI,filterTreesUI,mergedFiltersUI,findModel,sendControl,isVisitor=false,imageDownload,gltfPreview,extraCards=()=>[],openPictureBoard,openPictureAuthor,backToPictureBoards,toast,openImageGallery}=ctx;
 observeMasonry($('#grid'));
// 缩略图确认加载失败的在线条目（Sketchfab 图床 404，基本等于模型已下架）：记住 uid，
// 翻页、换视图、收藏重渲染都不会再把空卡片画回来。会话级即可，下次搜索换一批结果。
const brokenCovers=new Set();
function counts(){
 const activeStates=new Set(['queued','held','retry_wait','running','transferring','validating','saving','cancelling']);
 const activeJobs=(downloadsUI()?.jobs||[]).filter(j=>activeStates.has(j.state));
 const activeUids=new Set(activeJobs.map(j=>j.uid));
 const pulse=[...queuePulse].filter(([uid,t])=>Date.now()-t<6000&&!activeUids.has(uid)).length;
 const queue=activeJobs.length+pulse;
 // 本地素材包（含图站整站下载的图片文件夹）也是资产库里看得见的卡片，
 // 侧栏数字得跟着它们走，否则「卡片比数字多」看起来就像扫描出错。
 const localExtra=state.route==='discover'?0:(extraCards?.()||[]).length;
 $('#nav-count').textContent=state.models.length+localExtra;$('#queue-count').textContent=queue;$('#queue-count').classList.toggle('has-queue',queue>0);
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
/** 网格绘制。数据集签名 = uid 序列 + 视图标志（瀑布流/紧凑）：签名不变说明这一轮只是
 *  状态变化（收藏、勾选、下载态、精度选择），逐卡比对 HTML 字符串，只替换有变化的卡片，
 *  消失的卡片移除 —— 高频重渲染不再整块重建 innerHTML，1000 张卡的模型库切状态也不卡。
 *  在线结果变动也按 uid 复用并调整位置，避免多平台陆续返回时重建所有缩略图。 */
let cardHtml=new Map(),gridSignature='';
function paintGrid(models,gallery,online,busy){
 const grid=$('#grid');
 // 资产库目录里那些没登记成下载任务的文件（用户自己拷进来的素材）作为额外卡片接在后面。
 // 它们不是 `state.models` 的成员——那份数据有 32 位 hex uid 的持久化校验，混不进去；
 // 所以只在绘制层拼接，key 参与签名，扫描结果一变就整块重建。
 // 「最近入库」时本地卡片带磁盘 mtime，要和模型的 addedAt 按同一条时间线混排：
 // 只往后追加的话，刚下完的图片包永远排在所有卡片后面（用户 2026-10-26 反馈排序失效）。
 const extras=online?[]:(extraCards()||[]);
 const views=[];
 for(const model of models)views.push({key:`m:${model.uid}`,t:Number(model.addedAt)||0,html:cardView.card(model,{gallery})});
 for(const extra of extras)views.push({key:`e:${extra.key}`,t:Number(extra.mtime)||0,html:extra.html});
 const mixed=!online&&state.sort==='recent'&&extras.length>0;
 const items=mixed?[...views].sort((a,b)=>b.t-a.t):views;
 const htmlOf=new Map(views.map(view=>[view.key,view.html]));
 const signature=items.map(item=>item.key).join('|')+(gallery?'#g':'')+(state.compact?'#c':'');
 const oldCards=[...grid.querySelectorAll(':scope > .model-card[data-uid]')];
 const appending=online&&oldCards.length>0;
 if((gridSignature===signature||appending)&&cardHtml.size&&grid.firstElementChild){
  // 只认带 uid 的卡片：本地素材包现在也复用 .model-card 结构，但它用 data-package 当主键，
  // 混进来会被记成 undefined 并互相覆盖，导致旧包卡残留在网格里。
  const existing=new Map();grid.querySelectorAll('.model-card[data-uid]').forEach(c=>existing.set(c.dataset.uid,c));
  const keep=new Set(models.map(m=>m.uid));
  for(const m of models){
   const uid=m.uid,html=htmlOf.get(`m:${uid}`);
   if(cardHtml.get(uid)===html)continue;
   const el=existing.get(uid);
   if(el)el.outerHTML=html;else grid.insertAdjacentHTML('beforeend',html);
   cardHtml.set(uid,html);
  }
  for(const [uid,el] of existing)if(!keep.has(uid)){el.remove();cardHtml.delete(uid);}
  if(online){
   // 插入和移动现有节点，保留已加载图片；顺序仍以合并后的平台结果为准。
   const cards=new Map([...grid.querySelectorAll('.model-card[data-uid]')].map(card=>[card.dataset.uid,card]));
   let cursor=grid.firstElementChild;
   for(const model of models){const card=cards.get(model.uid);if(!card)continue;if(card!==cursor)grid.insertBefore(card,cursor);cursor=card.nextElementSibling;}
  }
  // 混排时本地卡片夹在模型之间，整体移除再追加会打乱顺序；签名没变说明它们的集合和位置都没变，
  // 原地保留即可。非混排（追加在末尾）时才重铺，让新扫描到的包立刻出现。
  if(!mixed){
   grid.querySelectorAll('.local-file-card,[data-package]').forEach(node=>node.remove());
   if(extras.length)grid.insertAdjacentHTML('beforeend',extras.map(extra=>extra.html).join(''));
  }
 }else{
  grid.innerHTML=items.map(item=>item.html).join('')||(busy?'<div class="skeleton"></div>'.repeat(4):'');
  cardHtml=new Map(models.map(model=>[model.uid,htmlOf.get(`m:${model.uid}`)]));
 }
 gridSignature=signature;
}
function renderDisplayButtons({boards=false}={}){
 const gallery=galleryActive(state);
 for(const [id,active] of [['grid-view',!state.compact&&!gallery],['list-view',state.compact&&!gallery],['gallery-view',gallery]]){
  const button=$('#'+id);
  button.classList.toggle('active',!boards&&active);
  button.setAttribute('aria-pressed',String(!boards&&active));
  button.disabled=boards;
 }
 $('#gallery-view').hidden=!galleryAvailable(state);
}
function renderGrid(){
 renderLocalFilters();
 // 图站（素材下载器整合）：粘贴图站链接进入此模式，画廊渲染整站图片而非 3D 模型卡片，
 // 复用搜索框与图片下载管线。普通模型网格逻辑一律跳过，避免两套卡片混进同一张网格。
 if(state.pictureSite){renderPictureSite();return;}
 $('#grid').className=displayGridClass(state);
 $('#model-count').hidden=false;
 // 两个平台的卡片共用同一张模型网格（卡片按 platform 走各自的下载通道）。
 // 网格内容由 composite() 决定：搜索时是当前平台各流交错的结果，链接解析时是解析结果。
 const online=state.route==='discover',f=composite(),models=filtered().filter(m=>!online||!brokenCovers.has(m.uid)),gallery=galleryActive(state);
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
  const total=state.filter==='trash'?(state.trashed||[]).length:state.route==='favorites'?state.models.filter(model=>state.favorites.has(model.uid)).length:state.models.length;
  $('#local-results').textContent=models.length===total?`${total} 项资产`:`${models.length} / ${total} 项`;
  $('#local-results').title=downloadsUI()?.connected?'当前匹配数量 / 资产总数':'下载服务未连接，文件状态暂不可用';
  $('#local-status').disabled=!downloadsUI()?.connected;
  $('#reset-local-filters').hidden=!(state.localCategory||state.search.trim()||state.filter!=='all'||$('#local-kind').value||$('#local-status').value);
 }
 document.body.dataset.route=state.route;
 // ponytail: reuse the existing online selectors; local sorting stays in its own toolbar.
 $('#unified-kind-wrap').hidden=!online||state.platform!=='all';
 $('#unified-sort-wrap').hidden=!online||state.platform!=='all';
 if(!online){
  $('#library-title').firstChild.textContent=state.filter==='trash'?'回收站 ':state.route==='favorites'?'我的收藏 ':'我的资产库 ';
  $('#library-subtitle').textContent=state.filter==='trash'?'移除的资产先在这里暂存，可恢复或彻底删除':'入库保存资源记录，下载后可使用本地文件';
 }
 // 三种展示互斥，按钮状态只由这里的状态推导，不在点击处理里各写一遍。
 $('#grid').classList.toggle('compact',state.compact&&!gallery);$('#grid').classList.toggle('gallery',gallery);$('#grid').classList.toggle('loading',online&&f.busy&&!models.length);$('#grid').setAttribute('aria-busy',online&&f.busy?'true':'false');
 renderDisplayButtons();
 paintGrid(models,gallery,online,f.busy);
 $('#empty').hidden=models.length>0||(online&&f.busy);
 const searched=state.source==='link'?!!state.feeds.web.request:activeModes().every(mode=>!!state.feeds[mode].request);
 $('#empty h3').textContent=online?(f.error?'暂时无法获取资产':searched?'没有找到匹配的资产':'从一个关键词开始'):state.route==='favorites'?'还没有匹配的收藏':'模型库，留给真正想用的资产';
 $('#empty p').textContent=online?(f.error?'检查网络后重新搜索。旧结果不会被失败请求覆盖。':searched?`试试更短的关键词、英文关键词，或减少筛选条件。${state.platform==='artstation'?'ArtStation 上的 Marmoset Viewer 作品只占搜索结果的一部分。':''}`:'直接输入关键词，或选择上方的推荐词。'):state.search||state.filter!=='all'?'尝试清除本地搜索与筛选条件。':'去“发现资产”搜索，点击加入模型库或爱心收藏，即可在这里保留。';
 $('#empty-explore').hidden=online&&f.busy;
 if(online&&!activeModes().length){
  // 图站没有关键词检索流：空网格要说清「该粘链接」，别让它看起来像所有平台都被关掉了。
  const picture=isPictureSite(state.platform),current=platformById(state.platform);
  $('#empty h3').textContent=picture?`${current.label} 按链接解析`:'所有平台已关闭';
  $('#empty p').textContent=picture?`把 ${current.label} 的作品页 / 标签页地址粘到上方搜索框，回车即可解析整站图片。`:'在设置 → 平台模块中开启需要的平台后，即可搜索在线资产。本地资产仍可使用。';
 }
 if(!online){
  const narrowed=state.localCategory||state.search.trim()||state.filter!=='all'||$('#local-kind').value||$('#local-status').value;
  if(state.filter==='trash'){
   $('#empty h3').textContent='回收站是空的';
   $('#empty p').textContent='在模型库里点移除键，资产会先放到这里，随时可以恢复。';
  }else{
  $('#empty h3').textContent=narrowed?'没有匹配的资产':state.route==='favorites'?'还没有收藏':'为下一个项目，收集第一项资产';
  $('#empty p').textContent=narrowed?'试试其他关键词或类型，或点击“清除筛选”恢复全部资产。':'前往“发现资产”，将需要的资源加入资产库。入库记录与本地下载文件分别管理。';
  }
  $('#empty-explore').hidden=!!narrowed||state.filter==='trash';
 }
 document.querySelectorAll('.thumbnail').forEach(img=>img.addEventListener('error',()=>{
  // 在线搜索里缩略图 404 基本等于模型已下架（点开原页面也是空的）：整张卡片移出网格，
  // 并记住 uid 让后续重渲染跳过它。本地库/收藏里保留占位提示，不隐藏已有资产。
  const card=img.closest('.model-card'),uid=card?.dataset.uid;
  if(online&&uid){brokenCovers.add(uid);card.remove();return;}
  img.replaceWith(Object.assign(document.createElement('div'),{className:'image-placeholder',innerHTML:`${icon('cube')}<span>缩略图加载失败</span>`}));
 },{once:true}));
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
function renderLocalFilters(){
 const host=$('#filter-rows');
 let panel=$('#library-filters');
 if(!panel){panel=document.createElement('div');panel.id='library-filters';host.append(panel);}
 panel.hidden=state.route!=='library';
 if(panel.hidden)return;
 const counts=new Map();
 const models=state.filter==='trash'?(state.trashed||[]):state.models;
 const known=new Set(models.map(model=>model.uid));
 const disk=state.filter==='trash'?[]:[...ctx.localPackages().filter(pkg=>!pkg.uid||!known.has(pkg.uid)),...ctx.localEntries()];
 for(const model of [...models.map(model=>({...model,tags:ctx.localTags(model)})),...disk])for(const category of localAssetCategories(model))counts.set(category,(counts.get(category)||0)+1);
 const button=(value,label,count)=>`<button type="button" class="ftree-leaf${(state.localCategory||'')===value?' active':''}" data-local-category="${esc(value)}" aria-pressed="${(state.localCategory||'')===value}"><span class="ftree-leaf-label">${esc(label)}</span>${count===undefined?'':`<span class="ftree-count">${count}</span>`}</button>`;
 const kind=$('#local-kind');
 panel.innerHTML=`<div class="ftree-plate">资产库筛选</div><div class="side-field"><span>类型</span><div class="local-kind-options">${[...kind.options].map(option=>`<button type="button" class="ftree-leaf${kind.value===option.value?' active':''}" data-local-kind="${esc(option.value)}" aria-pressed="${kind.value===option.value}">${esc(option.textContent)}</button>`).join('')}</div></div><div class="side-field"><span>分类（标签）</span><div>${button('','全部分类')}${[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'zh')).map(([value,count])=>button(value,value,count)).join('')}</div></div>`;
 panel.onclick=event=>{
  const category=event.target.closest('[data-local-category]');
  const type=event.target.closest('[data-local-kind]');
  if(type){kind.value=type.dataset.localKind;kind.dispatchEvent(new Event('change'));}
  else if(category){state.localCategory=category.dataset.localCategory;state.selected.clear();renderGrid();}
 };
}
/** 筛选始终留在侧栏容器；窄屏通过分类抽屉访问，不占用搜索卡片。 */
const FILTER_ROWS=['#filters-sketchfab','#filters-artstation','#filters-polyhaven','#filters-ambientcg','#filters-polypizza','#filters-kenney','#filters-freestylized','#filters-polyfork','#filters-merged','#filters-all'];
function placeFilters(){
 const host=$('#filter-rows');
 for(const selector of FILTER_ROWS){const row=$(selector);if(row&&row.parentElement!==host)host.append(row);}
 const modes=$('#side-modes');
 if(modes){
  const label=$('#side-filters .side-label');if(label&&modes.nextElementSibling!==label)$('#side-filters').insertBefore(modes,label);
 }
 $('#side-filters').hidden=false;
 filterTreesUI()?.setNarrow(false);
 mergedFiltersUI()?.setNarrow(false);
}
function preview(uid){
 const m=findModel(uid);if(!m)return;
 picturePreviewToken++;
 // 上一个预览弹窗还没关就又点了一个（极端连点 / 上一次 close 事件还没排到），
// 直接 showModal 会抛 InvalidStateError、后面的 load 根本不执行，于是画面卡在上一个模型。
// 先把已开的弹窗关掉再开，保证每次都从干净状态开始。
// 这里不要顺手补上「释放上一轮预览」那一手：释放逻辑统一在 app.js 的弹窗 close 监听里，
// 且那个监听会判断弹窗是否已重新打开（close 事件是排队异步派发的，见那里的说明）。
 const dlg=$('#preview-dialog');if(dlg&&dlg.open)dlg.close();
 // ArtStation 的场景和图片在同一个画廊内浏览，场景优先。
 if(artstationUI().isArt(m))return openArtworkPictures(m);
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
 // Polyfork 是可参数化的程序化资产：本地渲染（不走它的网页），右侧同步挂参数面板。
 // 颜色旋钮就地改顶点色，几何旋钮才回服务端重建，分工见 polyfork-params.js 顶部说明。
 if(m.platform==='polyfork'){
  $('#viewer').removeAttribute('src');
  $('#preview-dialog').showModal();
  openPolyforkPreview(m,{gltfPreview,toast});
  return;
 }
 document.querySelector('.viewer-hint').textContent='正在加载 Sketchfab 交互预览…';
 const licenseUrl=typeof m.licenseUrl==='string'&&/^https:\/\/creativecommons\.org\//.test(m.licenseUrl)?m.licenseUrl:null;
 $('#model-details').innerHTML=`<div class="eyebrow">MODEL DETAILS</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author)}</p><div class="details-stats"><div><strong>${fmt(m.faces)}</strong><span>面数</span></div><div><strong>${fmt(m.vertices)}</strong><span>顶点</span></div><div><strong>${m.animations||0}</strong><span>动画</span></div><div><strong>${fmt(m.views)}</strong><span>浏览</span></div></div><div class="detail-license"><strong>${esc(m.license)}</strong>${licenseUrl?`<a href="${esc(licenseUrl)}" target="_blank" rel="noopener noreferrer">阅读许可条款 ${icon('external')}</a>`:''}<p>${m.downloadable?'平台标记为可下载，不代表可商用；请遵循许可证的署名、非商业等要求。':'未标记为可下载，仅在拥有明确授权时导出。'}</p></div><div class="tag-list">${(m.tags||[]).slice(0,8).map(t=>`<button data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div><button class="secondary" data-action="ai-tags" data-uid="${uid}">AI 整理标签</button><button class="secondary" data-action="collect" data-uid="${uid}">${icon('folder')}加入我的模型库</button><button class="primary" data-action="download" data-uid="${uid}">${icon('download')}导出到本地</button>${sendControl({job:findLocalJob(downloadsUI()?.jobs||[],uid),className:'secondary',isVisitor})}<a class="source-link" href="https://sketchfab.com/models/${uid}" target="_blank" rel="noopener noreferrer">打开原始模型页面 ${icon('external')}</a>`;
 // 同一个模型的 embed 地址没变就不重设 src：iframe 内容保持热态，关闭弹窗再开同一个
 // 模型是秒开（Sketchfab viewer 那几 MB JS 不用重新拉）。ArtStation / 本地 three.js
 // 预览会清掉 #viewer 的 src，那时地址不同，自然会重新加载，不会串画面。
 const embed=`https://sketchfab.com/models/${uid}/embed?autostart=1&ui_infos=0&ui_watermark_link=0`;
 if($('#viewer').getAttribute('src')!==embed)$('#viewer').src=embed;
 $('#preview-dialog').showModal();
}
 /** 预览面板的精度选择：与卡片共用同一份 select，并把已下载档位打勾（判据同卡片：
 *  saved + 文件还在；没记精度的老任务算默认 2K）。 */
 function detailResolutionPicker(m){
  const fmt=m.materialFormat==='PNG'||m.materialFormat==='SBSAR'?m.materialFormat:'JPG';
  const res=new Set((downloadsUI()?.jobs||[]).filter(t=>t.uid===m.uid&&t.state==='saved'&&t.fileExists!==false&&t.id&&(t.options?.textureFormat||'JPG')===fmt).map(t=>t.options?.resolution||'2K'));
  return (cardView.materialFormatSelect?cardView.materialFormatSelect(m):'')+cardView.materialResolutionSelect(m,res);
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
  $('#model-details').innerHTML=`<div class="eyebrow">${eyebrow}</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author||'FreeStylized')}</p><div class="details-stats"><div><strong>${type==='textures'?'2K':type==='skybox'?'全景':'FBX'}</strong><span>预览内容</span></div><div><strong>免费</strong><span>官网授权</span></div></div><div class="detail-license"><strong>${esc(m.license||'FreeStylized 免费资源')}</strong><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">在 FreeStylized 打开 ${icon('external')}</a><p>${previewNote}</p></div><button class="secondary" data-action="collect" data-uid="${esc(m.uid)}">${icon('folder')}加入我的模型库</button>${detailResolutionPicker(m)}<button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}导出到本地</button>${sendControl({job:findLocalJob(downloadsUI()?.jobs||[],m.uid),className:'secondary',isVisitor})}<a class="source-link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开官方页面 ${icon('external')}</a>`;
 }
 /** ambientCG 材质的交互预览：iframe 里是官方 PBR 查看器（拖动转视角、贴图实时着色），
  *  侧栏是材质自己的信息——贴图通道、CC0 授权、与模型卡片同一套收藏/导出按钮。
  *  查看器地址是懒加载的：搜索结果自带，旧收藏卡片开预览时按 assetId 现取一次并缓存回卡片。 */
 function localSbsar(m){
  const jobs=downloadsUI()?.jobs||[];
  const job=jobs.findLast(t=>t.uid===m.uid&&t.state==='saved'&&t.fileExists!==false&&t.options?.textureFormat==='SBSAR'&&t.filePath);
  return job?.filePath||'';
 }
 function substanceImageUrl(name){
  return `/api/substance/image?name=${encodeURIComponent(name)}&t=${Date.now()}`;
 }
 async function previewSbsar(m){
  const file=localSbsar(m);
  $('#model-details').innerHTML=`<div class="eyebrow">SBSAR</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author)}</p><div class="detail-license"><strong>${esc(m.license)}</strong><p>${file?'参数由本机 Substance 引擎计算，拖动后球体上的贴图会更新。':'先把格式选成 SBSAR 并下载，才能调参数预览。'}</p></div><div id="sbsar-params" class="sbsar-params"></div><button class="secondary" data-action="collect" data-uid="${esc(m.uid)}">${icon('folder')}加入我的模型库</button>${detailResolutionPicker(m)}<button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}导出材质到本地</button>`;
  const hint=document.querySelector('.viewer-hint');
  $('#viewer').removeAttribute('src');$('#preview-dialog').showModal();
  if(!file){hint.textContent='还没有本地 SBSAR 文件';return;}
  hint.textContent='正在启动 Substance 引擎…';
  const box=$('#sbsar-params');
  try{
   const response=await fetch('/api/substance/open',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({file})});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
   const urls=()=>Object.fromEntries(Object.entries(data.images||{}).filter(([,name])=>name).map(([slot,name])=>[slot,substanceImageUrl(name)]));
   await gltfPreview.loadSubstance(urls());
   let timer=0;
   box.innerHTML=(data.inputs||[]).map(input=>`<label class="sbsar-input"><span>${esc(input.label)}</span><input data-sbsar-id="${input.id}" data-sbsar-identifier="${esc(input.identifier)}" data-sbsar-type="${esc(input.type)}" type="number" step="any" value="${esc(input.value??'')}" ${input.min!=null?`min="${esc(input.min)}"`:''} ${input.max!=null?`max="${esc(input.max)}"`:''}></label>`).join('')||'<p>这张 SBSAR 没有可调的数值参数。</p>';
   box.onchange=event=>{
    const field=event.target.closest('[data-sbsar-id]');if(!field)return;
    clearTimeout(timer);
    timer=setTimeout(async()=>{
     hint.textContent='正在按新参数渲染…';
     const next=await fetch('/api/substance/input',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({id:Number(field.dataset.sbsarId),identifier:field.dataset.sbsarIdentifier,type:field.dataset.sbsarType,value:Number(field.value)})});
     const body=await next.json().catch(()=>({}));
     if(!next.ok){hint.textContent=body.error||'参数更新失败';return;}
     data.images=body.images||data.images;
     await gltfPreview.loadSubstance(urls());
    },300);
   };
  }catch(e){hint.textContent=e.message;}
 }
 async function previewMaterial(m){
  if(m.sourceType==='substance'||(m.materialFormat||'JPG')==='SBSAR')return previewSbsar(m);
  if(m.assetType==='models'||m.assetType==='hdris'){
   $('#model-details').innerHTML=`<h2>${esc(m.name)}</h2><p>ambientCG · CC0 · ${m.assetType==='hdris'?'环境':'模型 / 地形'}</p><p>下载保留官方原始文件。${m.sourceType==='terrain'?'地形下载为 OBJ。':''}</p>${detailResolutionPicker(m)}<button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}下载</button><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开官方页面</a>`;
   const hint=document.querySelector('.viewer-hint');$('#viewer').removeAttribute('src');$('#preview-dialog').showModal();
   if(m.viewerUrl){$('#viewer').src=m.viewerUrl;hint.textContent='ambientCG 官方环境预览（需要联网）';}
   else hint.textContent='此资产没有官方交互预览，可下载原始文件或打开官方页面查看';
   return;
  }
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
/** 图站抓取结果的画廊渲染（素材下载器整合）。复用 .model-grid.gallery 的瀑布流样式，
 *  把整站图片铺进网格，顶部一条「下载整站到图片库」按钮走既有的 images 任务管线（本地图片库）。 */
 let picturePreviewToken=0;
 async function openArtworkPictures(model){
  const metadata={platform:'artstation',title:model.name,author:model.author,authorUrl:model.username?`https://www.artstation.com/${encodeURIComponent(model.username)}`:'',pageUrl:model.artworkUrl||model.url};
  const token=++picturePreviewToken;
  toast?.('正在读取作品预览…');
  try{
   const response=await fetch(`/api/picture-site/resolve?platform=artstation&url=${encodeURIComponent(metadata.pageUrl)}`,{headers:{'X-SFX-Local':'1'}});
   const data=await response.json();
   if(token!==picturePreviewToken)return;
   if(!response.ok)throw Error(data.error||'读取作品图片失败');
   if(!data.items?.length&&!data.scenes?.length)throw Error('这个作品没有可展示的图片或 3D 场景');
   const description=new DOMParser().parseFromString(data.description||'','text/html').body.textContent||'';
   const details={...metadata,title:data.title||model.name,author:data.author||model.author,authorUrl:data.authorUrl||metadata.authorUrl,description,tags:data.tags||[]};
   const items=[...(data.scenes||[]),...(data.items||[])].map(item=>({...details,...item,title:item.title||details.title,platform:'artstation',thumb:item.thumb||item.url||model.thumbnail}));
   openPicturePreview(items[0],{platform:'artstation',source:metadata.pageUrl,items,project:true,model});
  }catch(error){if(token===picturePreviewToken)toast?.(`作品预览读取失败：${error.message}`);}
 }
 function openPicturePreview(it,ps){
  picturePreviewToken++;
  const dlg=$('#file-preview-dialog'),stage=$('#file-preview-stage'),aside=$('#file-preview-details');
  if(!dlg||!stage||!aside)return;
  const images=ps?.items?.length?ps.items:[it];
  const index=Math.max(0,images.indexOf(it));
  openImageGallery({title:ps?.title||it.title||'图片预览',images,index,onChange:(current,currentIndex,count)=>{
  it=current;
  aside.dataset.tagUid=ps?.model?.uid||'';
  const label=ps?.platform==='pinterest'?'Pinterest':(it.platform||ps?.platform||'');
  // 右侧信息栏
  const dims=(it.width&&it.height)?`${it.width} × ${it.height}`:'';
  const sourceText=ps?.source||it.source||it.url;
  // 作者：服务端能给出可解析的作者主页（花瓣 /user/用户名、pixiv /users/id、civitai /user/用户名）时，
  // 名字就是一个入口 —— 点了用同一套图站解析去看他的作品或画板，不用回浏览器翻。
  const authorName=it.author||ps?.author||'';
  const canJump=typeof openPictureAuthor==='function'&&!!it.authorUrl;
  const authorLine=it.platform==='artstation'&&it.authorUrl?`<a class="picture-author" href="${esc(it.authorUrl)}" target="_blank" rel="noopener noreferrer">${esc(authorName)}</a>`:canJump
   ?`<button class="picture-author" data-author-url="${esc(it.authorUrl)}" title="查看该作者的作品 / 画板">${esc(authorName||'查看作者')}<span class="picture-author-go" aria-hidden="true">›</span></button>`
   :`<p class="author-name">${esc(authorName||'图站抓取')}</p>`;
  const tagLine=(Array.isArray(it.tags)&&it.tags.length)
   ?`<div class="picture-tags">${it.tags.slice(0,10).map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:'';
  aside.innerHTML=`<div class="eyebrow">PICTURE${label?` · ${esc(label)}`:''}</div>
   <h2>${esc(it.title||'未命名图片')}</h2>
   ${authorLine}
   <div class="details-stats">
     ${dims?`<div><strong>${esc(dims)}</strong><span>尺寸</span></div>`:''}
     <div><strong>${esc(label||'—')}</strong><span>来源平台</span></div>
   </div>
   ${tagLine}
   ${it.description?`<p class="picture-description" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(it.description)}</p>`:''}
   <div class="local-gallery-current"><span class="local-gallery-label">当前${it.type==='3d'?' 3D 场景':'图片'} ${currentIndex+1} / ${count}</span><p class="local-gallery-name">${esc(it.title||`图片 ${currentIndex+1}`)}</p>${dims?`<p class="local-gallery-size">${esc(dims)}</p>`:''}</div>
   ${ps?.model?artworkActions(ps.model):`<div class="preview-actions">
     <a class="primary" href="${esc(it.embedUrl||it.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}${it.type==='3d'?'打开 3D 场景':'打开原图'}</a>
     ${it.pageUrl?`<a class="secondary" href="${esc(it.pageUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}原页面</a>`:''}
     ${it.pid?`<button class="secondary" data-pin-similar="${esc(it.pid)}">${icon('search')}找相似</button>`:''}
   </div>`}
   <div class="detail-license">
     <p class="local-file-path" style="overflow-wrap:anywhere">${esc(sourceText)}</p>
   </div>`;
  const authorBtn=aside.querySelector('[data-author-url]');
  if(authorBtn)authorBtn.addEventListener('click',()=>{
   const target=authorBtn.dataset.authorUrl;
   dlg.close();
   openPictureAuthor?.(target,ps?.platform);
  });
  const similarBtn=aside.querySelector('[data-pin-similar]');
  if(similarBtn)similarBtn.onclick=async()=>{
   const saved=similarBtn.innerHTML;similarBtn.disabled=true;similarBtn.innerHTML='相似中…';
   try{
    const res=await fetch('/api/pinterest/related',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({pin_ids:[similarBtn.dataset.pinSimilar],count:24})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'相似推荐失败');
    const urls=new Set((ps.items||[]).map(i=>i.url));
    const added=(data.items||[]).filter(i=>i.url&&!urls.has(i.url));
    if(!added.length){toast?.('没有更多相似图片了');return;}
    ps.items=[...(ps.items||[]),...added];renderGrid();dlg.close();toast?.(`已追加 ${added.length} 张相似图片`);
   }catch(e){toast?.(e.message);}
   finally{similarBtn.disabled=false;similarBtn.innerHTML=saved;}
  };
  }});
 }

 function artworkActions(model){
  return previewActions({model,favorite:state.favorites.has(model.uid),icon,exportControl:sendControl({job:findLocalJob(downloadsUI()?.jobs||[],model.uid),className:'secondary preview-blender',isVisitor:ctx.isVisitor})});
 }
 function refreshArtworkActions(uid){
  const aside=$('#file-preview-details'),model=findModel(uid);
  if(!model||!$('#file-preview-dialog').open||aside?.dataset.tagUid!==uid)return;
  const actions=aside.querySelector('.preview-actions');
  if(actions)actions.outerHTML=artworkActions(model);
 }

function renderPictureSite(){
 gridSignature='';cardHtml.clear();
 const ps=state.pictureSite||{};
 const grid=$('#grid');
 const items=Array.isArray(ps.items)?ps.items:[];
 const isPin=ps.platform==='pinterest';
 const boards=Array.isArray(ps.boards)?ps.boards:[];
 // 两级解析的第一级：作者主页 → 画板墙（一块画板一张卡）；第二级才是它的图片。
 const boardMode=ps.mode==='boards';
 $('#model-count').hidden=true;
 $('#library-title').firstChild.textContent=boardMode?`${ps.author||ps.title||'作者'} 的画板`:(ps.title?`${ps.title} 的图片`:'图站图片');
 $('#library-subtitle').textContent=boardMode?`${boards.length} 个画板 · 点卡片查看里面的图片`:(ps.author?`作者：${ps.author}`:(ps.source?'来源：'+ps.source:'图站抓取'));
 $('#empty').hidden=true;
 $('#pagination').hidden=true;
 renderDisplayButtons({boards:boardMode});
 // 三种「无图可看」的状态一律用普通网格：gallery 是多列瀑布流，会把单个提示块切成多栏错位。
 if(ps.busy){grid.className='model-grid';grid.innerHTML='<div class="skeleton"></div>'.repeat(6);return;}
 if(ps.error){grid.className='model-grid';grid.innerHTML=`<div class="empty"><div class="empty-cube"><i data-icon="cube"></i></div><h3>解析失败</h3><p>${esc(ps.status||'抓取失败')}</p><p class="hint">若提示「该图站暂不支持抓取」，说明后台服务仍是旧进程，重启 AssetVault 后重试。</p></div>`;return;}
 if(boardMode){
  if(!boards.length){grid.className='model-grid';grid.innerHTML='<div class="empty"><div class="empty-cube"><i data-icon="cube"></i></div><h3>没有公开画板</h3><p>这个作者还没有公开的画板。</p></div>';return;}
  grid.className='board-grid';
  grid.innerHTML=boards.map(board=>`<figure class="board-card" data-board-id="${esc(board.id)}" data-board-url="${esc(board.url||'')}" data-board-title="${esc(board.title||'')}" role="button" tabindex="0" aria-label="打开画板 ${esc(board.title||'')}">
    ${board.thumb||board.cover?`<img class="board-cover" loading="lazy" src="/api/image?url=${encodeURIComponent(board.thumb||board.cover)}" alt="">`:'<div class="board-cover board-cover-empty" aria-hidden="true"></div>'}
    <figcaption><strong>${esc(board.title||'未命名画板')}</strong><span>${board.count?`${board.count} 张`:'空画板'}</span></figcaption>
   </figure>`).join('');
  // 点卡片 = 解析这块画板的图片（同一套 /api/picture-site/resolve，只是 URL 换成画板页）。
  grid.querySelectorAll('[data-board-id]').forEach(node=>{
   const open=()=>openPictureBoard?.({id:node.dataset.boardId,url:node.dataset.boardUrl,title:node.dataset.boardTitle});
   node.addEventListener('click',open);
   node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
  });
  return;
 }
 if(!items.length){grid.className='model-grid';grid.innerHTML='<div class="empty"><div class="empty-cube"><i data-icon="cube"></i></div><h3>没有可显示的图片</h3><p>该链接可能未公开或需要登录。</p></div>';return;}
 grid.className='picture-site-results';
 const downloadOk=!!downloadsUI()?.enqueue;
 const cards=items.map(it=>{
  // `thumb` 是站方 CDN 的小尺寸变体（花瓣 _fw480：1.7MB → 173KB）；没有就用原图。data-url 始终是原图。
  const src=`/api/image?url=${encodeURIComponent(it.thumb||it.url)}`;
  return `<figure class="model-card" style="margin:0 0 18px;break-inside:avoid;background:#0f151d;border:1px solid #222b36;border-radius:10px;overflow:hidden">
    <div class="card-media" style="position:relative">
      <img class="thumbnail" loading="lazy" src="${esc(src)}" alt="${esc(it.title||'')}" data-url="${esc(it.url)}" data-pid="${esc(it.pid||'')}" data-w="${it.width||''}" data-h="${it.height||''}" data-title="${esc(it.title||'')}" data-platform="${esc(ps.platform||'')}" data-source="${esc(ps.source||'')}" data-author="${esc(it.author||'')}" data-author-url="${esc(it.authorUrl||'')}" data-page-url="${esc(it.pageUrl||'')}" data-tags="${esc((it.tags||[]).join(' '))}" style="display:block;width:100%;height:auto;background:#141c25;cursor:zoom-in">
      ${isPin&&it.pid?`<button class="pin-similar" data-pid="${esc(it.pid)}" title="找相似" aria-label="找相似" style="position:absolute;left:8px;bottom:8px;display:inline-flex;align-items:center;justify-content:center;padding:6px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(8,12,18,.72);color:#dbe6f1;cursor:pointer;backdrop-filter:blur(4px);line-height:0">${icon('search')}<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">找相似</span></button>`:''}
    </div>
    <figcaption style="padding:8px 10px;font-size:11px;color:#c8d3de">
      <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.title||'')}</div>
      ${it.author?`<button class="pic-author" data-card-author="${esc(it.authorUrl||'')}" title="${it.authorUrl?'查看该作者的作品 / 画板':'该作者没有可解析的主页'}">${esc(it.author)}</button>`:''}
    </figcaption>
  </figure>`;
 }).join('');
 const more=!!ps.truncated;
 // 从画板墙点进来时给一个返回入口：画板墙还在内存里，返回不发请求。
 const back=ps.fromBoards?'<button id="picture-site-back">← 返回画板</button>':'';
 // 关键词搜索（ps.url 是词不是网址）和粘链接是两种来源，按钮与说明行要说对：
 // 搜索没有「整站」概念，说「下载这批图」才不会让人以为点一下就抓全站。
 const isSearchQuery=!/^https?:\/\//i.test(ps.url||'');
 // 需要登录态 / 人机验证的站点（站酷作品页、500px 大图、Pinterest 私有画板…）：给一个登录入口。
 // 窗口里登录完直接关掉，cookie 自动入库，下次解析不再需要开浏览器跑验证。
 const canLogin=pictureSiteLoginable(ps.platform);
 const bar=`<div class="picture-site-bar" style="display:flex;gap:10px;align-items:center;margin:0 0 14px;flex-wrap:wrap">
   ${back}
   <button class="primary" id="picture-site-download" ${downloadOk?'':'disabled'}>${icon('download')} 下载${isSearchQuery?'这批图':'整站'}到图片库${more?'':`（${items.length} 张）`}</button>
   ${isPin?`<button id="picture-site-similar" ${downloadOk?'':'disabled'}" style="font-size:12px">用当前结果找相似</button>`:''}
   ${canLogin?`<button id="picture-site-login" style="font-size:12px" title="弹一个浏览器窗口，在里面登录（或完成人机验证）后直接关闭窗口，cookie 会自动保存，之后这个站解析走纯 HTTP 快得多">登录 / 过验证</button>`:''}
   <span class="hint" style="color:#8a98a8;font-size:12px">${more?`预览仅加载前 ${items.length} 张（结果总量更多），下载会抓取全部`:`${isSearchQuery?'搜索':'粘贴的链接'}：${esc(isSearchQuery?(ps.title||ps.url||''):(ps.source||''))}`}</span>
 </div>`;
 // 登录按钮：只负责把窗口开起来，cookie 的同步在服务端做（窗口里每 2.5 秒抓一次）。
 const loginBtn=$('#picture-site-login');
 if(loginBtn)loginBtn.onclick=async()=>{
  loginBtn.disabled=true;
  try{
   const res=await fetch('/api/browser/login',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({platform:ps.platform})});
   const data=await res.json().catch(()=>({}));
   if(!res.ok)throw new Error(data.error||'打开登录窗口失败');
   toast?.('已打开浏览器窗口，登录（或完成验证）后直接关闭窗口即可，cookie 会自动保存');
  }catch(err){toast?.(err.message||'打开登录窗口失败');}
  finally{loginBtn.disabled=false;}
 };
 grid.innerHTML=bar+`<div class="${displayGridClass(state)} picture-site-gallery">${cards}</div>`;
 const backBtn=$('#picture-site-back');
 if(backBtn)backBtn.onclick=()=>{if(!backToPictureBoards?.())toast?.('已经是最外层');};
 // 卡片上的作者名：有可解析主页才能跳（booru / 站酷本身没有作者页，按钮不作跳转）。
 grid.querySelectorAll('[data-card-author]').forEach(btn=>{
  if(!btn.dataset.cardAuthor)return;
  btn.addEventListener('click',event=>{
   event.preventDefault();event.stopPropagation();
   openPictureAuthor?.(btn.dataset.cardAuthor,ps.platform);
  });
 });
 // 点缩略图复用模型预览同款界面（#file-preview-dialog：左侧大图 + 右侧信息栏）。
 grid.querySelectorAll('img[data-url]').forEach(img=>{
  img.addEventListener('click',()=>{
   openPicturePreview({
    url:img.dataset.url,pid:img.dataset.pid||'',
    width:Number(img.dataset.w)||0,height:Number(img.dataset.h)||0,
    title:img.dataset.title||'',platform:img.dataset.platform||'',source:img.dataset.source||'',
    author:img.dataset.author||'',authorUrl:img.dataset.authorUrl||'',pageUrl:img.dataset.pageUrl||'',
    tags:(img.dataset.tags||'').split(' ').filter(Boolean)
   },ps);
  });
 });
 // 复用「模型预览」界面展示单张图站图片：左侧铺原图，右侧信息栏给出标题 / 作者 / 尺寸 / 来源，
 // Pinterest 卡片额外提供「找相似」。直接骑在 #file-preview-dialog 上（布局与模型预览一致），
 // 不引入新的弹窗，关闭逻辑与本地文件预览共用。
 const dl=$('#picture-site-download');
 if(dl)dl.onclick=()=>{
  const manager=downloadsUI();
  if(!manager?.enqueue){toast?.('后台服务未连接，无法下载图片。');return;}
  const uid=pictureSiteJobUid(ps.platform,ps.url);
  manager.enqueue([{uid,platform:ps.platform,name:ps.title||ps.author||ps.platform,author:ps.author||'',url:ps.url}],{output:'folder'},false,undefined,'images')
   .then(result=>toast?.(`已加入 ${result.added.length} 个图片下载任务${result.duplicates.length?`，跳过 ${result.duplicates.length} 个已有记录`:''}`))
   .catch(e=>toast?.(e.message));
 };
 // Pinterest 相似推荐：把选中 pin 的 id 列表丢给后台 /api/pinterest/related（pin-grabber 独有），
 // 它从当前 STATE.images 采「更多类似图案」推荐流并追加进画廊。代理层已做单飞串行，避免 STATE 被覆盖。
 if(isPin){
  const similarHandler=async(pids,btn)=>{
   if(!pids.length){toast?.('没有可用的图片 id');return;}
   const saved=btn?btn.innerHTML:null;
   if(btn)btn.disabled=true,btn.innerHTML='相似中…';
   try{
    const res=await fetch('/api/pinterest/related',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({pin_ids:pids,count:24})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'相似推荐失败');
    const urls=new Set((ps.items||[]).map(i=>i.url));
    const added=(data.items||[]).filter(i=>i.url&&!urls.has(i.url));
    if(!added.length){toast?.('没有更多相似图片了');return;}
    ps.items=[...(ps.items||[]),...added];renderGrid();toast?.(`已追加 ${added.length} 张相似图片`);
   }catch(e){toast?.(e.message);}
   finally{if(btn)btn.disabled=false,btn.innerHTML=saved;}
  };
  grid.querySelectorAll('.pin-similar').forEach(btn=>{btn.onclick=()=>similarHandler([btn.dataset.pid],btn);});
  const all=$('#picture-site-similar');
  if(all)all.onclick=()=>{const pids=(ps.items||[]).map(i=>i.pid).filter(Boolean);similarHandler(pids,all);};
 }
}
return {counts,renderStatus,renderGrid,placeFilters,preview,syncStickyOffset,refreshArtworkActions};
}
