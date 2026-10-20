import {createDownloadUI} from './download-ui.js';
import {createPersistentStorage} from './persistent-storage.js';
import {createArtstationUI} from './artstation-ui.js';
import {createAmbientcgUI} from './ambientcg-ui.js';
import {createPolyhavenUI} from './polyhaven-ui.js';
import {createKenneyUI} from './kenney-ui.js';
import {createFreestylizedUI} from './freestylized-ui.js';

import {CATEGORIES,searchParams,dailyTopics} from './search-options.js';
import {PLATFORMS,ALL,DEFAULT_PLATFORM,platformById,platformLabel,routeLink,FEEDS,jobKindOf} from './platforms.js';
import {createContentModes,modeTarget} from './content-modes.js';
import {combine,statusText,subtitleText,pageInfoNote,loadMoreLabel,describeRequest,feedErrorMessage} from './discovery-view.js';
import {galleryAvailable,galleryActive,aspectRatioStyle} from './gallery-view.js';
import {loadLibrary,saveLibrary,mergeModels,collectModels,UID,loadDiscovery,saveDiscovery} from './library-state.js';
import {enhanceSelects} from './picker.js';
import {findLocalJob,createBlenderButton,classifyBlenderJob} from './blender-send.js';
import {icon} from './icon-set.js';
import {createCardView} from './card-view.js';
import {openExternal} from './open-url.js';
import {createLibraryView} from './library-view.js';
import {createGltfPreview} from './gltf-preview.js';
import {createDiscoveryFeed,resetDiscoveryFeeds} from './discovery-feed.js';
import {createImageDownloader} from './image-download.js';
import {createBlenderBridgePanel} from './blender-bridge.js';
import {createBrowserRuntimePanel} from './browser-runtime.js';
import {createSetupWizard} from './setup-wizard.js';
import {createSearchHistory} from './search-history.js';
import {createMergedFilters,artstationCategory,feedPlan,joinQuery,kindAllows,kindType} from './merged-filters.js';
import {createFilterTrees} from './filter-tree.js';
import {esc} from './html-esc.js';
import {filterLocalAssets} from './local-filters.js';
import {createAISettings} from './ai-settings.js';
import {tagsFor,addAITags,tagPanel} from './asset-tags.js';
import {createSettingsPanel} from './settings-panel.js';
import {createAppUpdates} from './app-updates.js';
import {bindLocalSearch,createLocalQueryParser,createThemeBrainstorm,createTagSuggester} from './search-translation.js';
const $=selector=>document.querySelector(selector);
const parseLocal=createLocalQueryParser();
const brainstorm=createThemeBrainstorm();
let settingsPanel;
const fmt=n=>n==null?'—':Number(n)>=1000?`${(Number(n)/1000).toFixed(Number(n)>=10000?0:1)}k`:String(n);
let storage;try{storage=window.localStorage;}catch{}
try{storage=await createPersistentStorage(storage);}catch(error){alert(`${error.message}。暂时使用页面缓存，本次修改可能无法持久保存。`);}
window.addEventListener('assetvault:storage-error',event=>toast(event.detail));
const initial=loadLibrary(storage);
const newFeed=()=>({rows:[],request:null,next:null,pending:[],pages:0,busy:false,token:0,controller:null,status:'',error:false,aborted:false,warnings:[],visited:new Set(),origin:''});
// 每个结果流都先建好骨架，骨架清单来自 platforms.js 的 FEEDS：加平台时不用回来改这里，
// 也不会出现「平台声明了流但 state 里没有」这种一进页面就崩的错。platform 决定哪几个流
// 共同组成网格（见 platforms.js），source 决定网格当前展示的是搜索还是某一次链接解析。
const state={...initial,route:'discover',platform:DEFAULT_PLATFORM,source:'search',filter:'all',search:'',sort:'recent',selected:new Set(),compact:false,gallery:false,modelOnly:false,feeds:Object.fromEntries(FEEDS.map(mode=>[mode,newFeed()]))};
// 每批翻多少页由「每次加载多少条」推出来（见 discovery-feed.js）。它属于界面节奏而不是导出参数，
// 所以不塞进 options（那边会被设置面板整份覆盖回去），只跟 discovery 快照一起存。
const savedDiscovery=loadDiscovery(storage);
state.pageSize=[24,48,96,192].includes(Number(savedDiscovery?.pageSize))?Number(savedDiscovery.pageSize):48;
if(savedDiscovery){
 state.platform=platformById(savedDiscovery.platform).id;
}
const queuePulse=new Map();
let downloads,artstation,ambientcgUI,polyhavenUI,kenneyUI,freestylizedUI,blenderBridge,browserRuntime,setupWizard,contentModes,searchHistory,filterTrees,mergedFilters,filterTimer,persistTimer,toastTimer,searchTimer;
// 「本次会话里用户主动检索过」的痕迹。它只是 searchStillActive 的补充判据：
// 首次打开页面时框本来就是空的，不能把「框为空」当成一次删除（详见 clearSearchIfEmptied）。
let hadQuery=false;
// 粘进搜索框的 ArtStation 作品页走这一支：它只负责识别出那个作品（返回模型），
// 卡片和下载键由 discovery-feed 摆进链接结果区。识别器还没就绪时抛错，让状态行显示，不弹 toast。
let resolveArtworkLink=async()=>{throw Error('ArtStation 识别器尚未就绪，请稍后重试。');};
// Blender 按钮由「本地有没有文件」决定，卡片和预览面板共用这一个生成器。
const blenderSendButton=createBlenderButton({icon});
const persistNow=()=>{clearTimeout(persistTimer);try{saveLibrary(storage,state);saveDiscovery(storage,{platform:state.platform,pageSize:state.pageSize,filters:discoveryFilters()});}catch{toast('浏览器存储空间不足，列表未保存；请先释放空间。');}};
const persist=()=>{clearTimeout(persistTimer);persistTimer=setTimeout(persistNow,200);};
function discoveryFilters(){
 const value=id=>{const node=document.querySelector(id);return node?node.value:'';};
 const checked=id=>{const node=document.querySelector(id);return !!node?.checked;};
 return {query:value('#asset-query'),polyhavenType:value('#polyhaven-type'),polyhavenCategory:value('#polyhaven-category'),ambientcgCategory:value('#ambientcg-category'),kenneyCategory:value('#kenney-category'),kenneySeries:value('#kenney-series'),freestylizedType:value('#freestylized-type'),freestylizedCategory:value('#freestylized-category'),polypizzaCc0:checked('#polypizza-cc0'),onlineCategory:value('#online-category'),onlineSort:value('#online-sort'),downloadable:checked('#online-downloadable'),animated:checked('#online-animated'),staffpicked:checked('#online-staffpicked')};
}
function restoreDiscoveryFilters(){
 const filters=savedDiscovery?.filters;if(!filters)return;
 const set=(id,next)=>{const node=document.querySelector(id);if(node&&next!=null)node.value=next;};
 // 搜索词和结果只在本次会话中保留，不恢复历史搜索现场。
 set('#asset-query','');
 set('#polyhaven-type',filters.polyhavenType);
 set('#polyhaven-category',filters.polyhavenCategory);
 if(filters.polyhavenCategory&&$('#polyhaven-category'))$('#polyhaven-category').dataset.keep=filters.polyhavenCategory;
 set('#ambientcg-category',filters.ambientcgCategory);
 if(filters.ambientcgCategory&&$('#ambientcg-category'))$('#ambientcg-category').dataset.keep=filters.ambientcgCategory;
 set('#kenney-category',filters.kenneyCategory);
 if(filters.kenneyCategory&&$('#kenney-category'))$('#kenney-category').dataset.keep=filters.kenneyCategory;
 set('#kenney-series',filters.kenneySeries);
 if(filters.kenneySeries&&$('#kenney-series'))$('#kenney-series').dataset.keep=filters.kenneySeries;
 set('#freestylized-type',filters.freestylizedType);
 set('#freestylized-category',filters.freestylizedCategory);
 if(filters.freestylizedCategory&&$('#freestylized-category'))$('#freestylized-category').dataset.keep=filters.freestylizedCategory;
 set('#online-category',filters.onlineCategory);
 set('#online-sort',filters.onlineSort);
 if($('#polypizza-cc0'))$('#polypizza-cc0').checked=!!filters.polypizzaCc0;
 if($('#online-downloadable'))$('#online-downloadable').checked=!!filters.downloadable;
 if($('#online-animated'))$('#online-animated').checked=!!filters.animated;
 if($('#online-staffpicked'))$('#online-staffpicked').checked=!!filters.staffpicked;
}
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4200);}
// 「下载高清图」的按钮生成与批量入队都在 image-download.js：卡片要显示哪些资产的按钮、多选栏点下去
// 发什么样的任务，答案必须只有一个，所以两边都问这一个对象。
const imageDownload=createImageDownloader({icon,toast,downloads:()=>downloads,findModel,refresh:()=>{renderGrid();counts();}});
// 卡片怎么画也住在自己的模块里（card-view.js）； Drawer 只把它需要的合作者喂进去。
const cardView=createCardView({icon,esc,fmt,state,queuePulse,imageDownload,blenderSendButton,classifyBlenderJob,platformLabel,artstationUI:()=>artstation,downloadsUI:()=>downloads});
// 状态行、网格、筛选行摆放、预览弹窗的画法都住在 library-view.js；这里解构出同名函数，
// 所以其余代码读起来还是只有 renderGrid() / counts() 这层语义。
const gltfPreview=createGltfPreview();
const view=createLibraryView({$,icon,esc,fmt,state,queuePulse,cardView,composite,filtered,activeModes,galleryActive,categories:CATEGORIES,describeArt:request=>artstation.describe(request),artstationUI:()=>artstation,downloadsUI:()=>downloads,filterTreesUI:()=>filterTrees,mergedFiltersUI:()=>mergedFilters,findModel,blenderSendButton,imageDownload,gltfPreview});
const {counts,renderStatus,renderGrid,placeFilters,preview:previewAsset,syncStickyOffset}=view;
function refreshPreviewTags(uid){
 if(!$('#preview-dialog').open)return;
 const details=$('#model-details'),model=findModel(uid);if(!model||details.dataset.tagUid!==uid)return;
 details.querySelectorAll('.tag-list,[data-action="ai-tags"],.asset-tags').forEach(node=>node.remove());
 details.insertAdjacentHTML('beforeend',tagPanel(state,model,esc));
}
function preview(uid){
 previewAsset(uid);
 $('#model-details').dataset.tagUid=uid;
 refreshPreviewTags(uid);
}
// 发起检索也有自己的模块（discovery-feed.js）：翻页、关键词、粘贴链接三条入口共用同一段取流逻辑。
const feed=createDiscoveryFeed({$,toast,state,persist,renderGrid,mergeModels,describeArt:request=>artstation.describe(request),activeModes,showsFeed,searchHistoryUI:()=>searchHistory,resolveArtworkLink:url=>resolveArtworkLink(url),routeTo:route,readRequest:mode=>readRequest(mode),clearSearchTimer:()=>clearTimeout(searchTimer),feedError:feedErrorMessage,markQueryActive:()=>{hadQuery=true;}});
const {requestFeed,startSearch,submitLink}=feed;
function fillIcons(){document.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icon(el.dataset.icon).replace(/^<i>|<\/i>$/g,'');});}

/** 当前平台由哪几个结果流来回答，顺序即展示顺序。 */
function activeModes(){return platformById(state.platform).feeds;}
/** 网格、状态行与分页都只读这一个视图：链接解析时它是 web 流，否则是当前平台各流的投影。 */
function composite(){
 return combine({sources:state.source==='link'?['web']:activeModes(),feeds:state.feeds});
}
/** 链接解析结果不属于任何平台流，但它同样要能驱动界面刷新。 */
function showsFeed(mode){return mode==='web'||activeModes().includes(mode);}
// 每个在线结果流都要查：ArtStation 结果只存在于 feeds.art，漏掉它会让预览与下载
// 在全平台结果里“点了没反应”（findModel 返回 undefined 后静默 return）。
function findModel(uid){return FEEDS.reduce((hit,mode)=>hit||state.feeds[mode].rows.find(m=>m.uid===uid),null)||state.models.find(m=>m.uid===uid)||downloads?.jobs.findLast(m=>m.uid===uid)||state.tasks.findLast(m=>m.uid===uid);}

function filtered(){
 if(state.route==='discover'){
  const rows=composite().rows;
  if(state.platform===ALL&&$('#unified-sort').value==='name')return [...rows].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'zh'));
  return rows;
 }
 let models=state.models.filter(m=>state.route!=='favorites'||state.favorites.has(m.uid));
 if(state.filter==='downloadable')models=models.filter(m=>m.downloadable);if(state.filter==='animated')models=models.filter(m=>m.animations>0);
 models=filterLocalAssets(models.map(m=>({...m,tags:tagsFor(state,m)})),{kind:$('#local-kind').value,status:$('#local-status').value,search:state.search,english:state.searchEnglish||''},downloads?.connected?downloads.jobs:null);
 return [...models].sort(state.sort==='popular'?(a,b)=>b.likes-a.likes:state.sort==='name'?(a,b)=>a.name.localeCompare(b.name):(a,b)=>(b.addedAt||0)-(a.addedAt||0));
}

/** 点最近检索里的一条：搜索记录重放那次检索，链接记录回到解析通道。 */
function applyHistory(entry){
 if(!entry)return;
 if(entry.kind==='search'){
  try{writeSearch(entry.params);setPlatform(entry.platform||'sketchfab',{autostart:false});if(state.route!=='discover')route('discover');startSearch();}
  catch{toast('这条历史记录已不兼容，请重新搜索。');}
  return;
 }
 $('#asset-query').value=entry.url;submitLink(entry.url);
}
// 每个标签页各自记住自己的滚动位置。切走时那个标签页的内容被隐藏，页面瞬间变矮，
// 浏览器把窗口滚动量夹到顶部；再切回来就停在顶部了（2026-10-16 用户反馈的「切回发现页滚动复位」）。
// 所以要赶在隐藏之前读一次 window.scrollY 存起来，回来时再放回去。
const routeScroll=new Map();
function restoreRouteScroll(top){
 // 两帧：第一帧让这次的显隐与重绘落盘，第二帧页面高度已经稳定，再放回去。
 // 高度不够时 scrollTo 自己会夹住，不需要另外算（比如下载页刚开始还没内容）。
 requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo(0,Math.max(0,top))));
}
function route(name){
 // 先读、后动显隐：这一读拿到的还是切走前用户看到的位置。
 const leaving=state.route;
 if(leaving&&leaving!==name)routeScroll.set(leaving,window.scrollY);
 state.route=name;state.selected.clear();
 // 画廊只画在线 A 站结果，本地库与收藏里混着两个平台，离开发现页就退出画廊。
 if(name!=='discover'){state.gallery=false;searchHistory?.close();}
 document.querySelectorAll('[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route===name));
 // 顶部面包屑（工作空间 / 当前页）已按用户要求撤掉：侧边栏的高亮项本身就说明了在哪一页。
 $('#library-view').hidden=name==='downloads';$('#downloads-view').hidden=name!=='downloads';$('#search-panel').hidden=name!=='discover';
 if(name==='downloads'){downloads?.render();downloads?.refresh();}else renderGrid();renderStatus();counts();
 // 只在真的换页时恢复：首次进入（leaving 与 name 相同）保持浏览器自己的行为，
 // 否则每次刷新页面都会被强制拉回顶部。
 if(leaving&&leaving!==name)restoreRouteScroll(routeScroll.get(name)||0);
}
/** 平台决定「谁来回答」：标签文案、推荐词、筛选行全部由注册表驱动，不在这里分支。 */
function renderPlatform(){
 const platform=platformById(state.platform);
 const select=$('#search-platform');
 // data-hint 是下拉菜单里的第二行小字：自绘菜单读它，不用在 UI 里再写一份平台说明。
 select.innerHTML=PLATFORMS.map(item=>`<option value="${item.id}"${item.hint?` data-hint="${esc(item.hint)}"`:''}>${esc(item.label)}</option>`).join('');
 select.value=platform.id;
 $('#asset-query').placeholder=platform.placeholder;
 $('#filters-all').textContent=platform.note||'';
 renderFilters(platform);
 const all=state.platform===ALL;
 $('#unified-kind-wrap').hidden=!all;
 $('#unified-sort-wrap').hidden=!all;
 contentModes?.render();                              // 平台变了，两个模式按键的高亮跟着走
}
/** 筛选区显隐（R6）：全部平台下只留那一棵统一树——两棵平台树与「全部平台」说明行一起收起，
 *  模型模式是全部平台的一个子集，走同一条分支。单平台照旧按注册表清单显隐自己那一棵
 *  （保留精细回退：想在单个平台上按它自己的分类体系筛，切过去就有）。 */
function renderFilters(platform){
 const unified=state.platform===ALL;
 $('#filters-merged').hidden=!unified;
 if(unified){
  $('#filters-sketchfab').hidden=true;$('#filters-artstation').hidden=true;$('#filters-ambientcg').hidden=true;$('#filters-polyhaven').hidden=true;$('#filters-polypizza').hidden=true;$('#filters-kenney').hidden=true;$('#filters-freestylized').hidden=true;$('#filters-all').hidden=true;
  mergedFilters?.refresh();
  return;
 }
 const filterRows=Array.isArray(platform.filters)?platform.filters:platform.filters?[platform.filters]:[];
 mergedFilters?.release();                         // R5：离开全部平台，把类型 / 艺术家插回 #filters-artstation
 $('#filters-sketchfab').hidden=!filterRows.includes('filters-sketchfab');
 $('#filters-artstation').hidden=!filterRows.includes('filters-artstation');
 $('#filters-ambientcg').hidden=!filterRows.includes('filters-ambientcg');
 $('#filters-polyhaven').hidden=!filterRows.includes('filters-polyhaven');
 $('#filters-polypizza').hidden=!filterRows.includes('filters-polypizza');
 $('#filters-kenney').hidden=!filterRows.includes('filters-kenney');
 $('#filters-freestylized').hidden=!filterRows.includes('filters-freestylized');
 $('#filters-all').hidden=filterRows.length>0;
}
/** 切平台只重搜「还没被检索过的」源；已经有结果的源直接复用，避免每次切换都闪一下。 */
function setPlatform(id,{autostart=true,gallery=false}={}){
 const next=platformById(id).id;
 if(next===state.platform)return;
 // 取消是异步的：busy 要等那次请求的 finally 才回落，而下面「哪个源还没有结果」的判断
 // 就在同一个 tick 里跑。不在这里立刻清掉 busy，刚被取消的源会被当成还在跑，于是这次切换
 // 一个检索都不发，界面停在「已停止检索」加一张空网格。
 activeModes().forEach(mode=>{const f=state.feeds[mode];if(f.controller){f.controller.abort();f.busy=false;}});
 state.platform=next;state.source='search';state.selected.clear();
 // 模型模式只在「全部平台」下成立：手动切到单平台就当作退出。
 if(next!==ALL)state.modelOnly=false;
 // 手动切平台一律回到网格：画廊按钮会随平台隐藏，视图不能停在一个刚刚消失的模式上。
 // 只有「图片模式」这个快捷入口会显式要求瀑布流，所以它是参数、不是默认值。
 state.gallery=gallery;
 renderPlatform();
 if(state.route!=='discover')route('discover');else renderGrid();
 const cold=activeModes().filter(mode=>!state.feeds[mode].request&&!state.feeds[mode].busy&&!state.feeds[mode].rows.length);
 if(autostart&&cold.length)return Promise.all(cold.map(mode=>requestFeed(mode,readRequest(mode))));
}
/** 模型模式 / 图片模式被点了一下：切到哪个平台、要不要瀑布流都由 content-modes 算好，
 *  这里只负责把「平台」这件事交给 setPlatform（它管重搜冷源、并顺手同步按键高亮）。
 *  再点一次当前模式＝退出回全部平台，所以两个键的语义是「模型 / 图片 / 都不是」三态。 */
let artTypeBeforeModel='';
function applyContentMode(id){
 const target=modeTarget(id,state);
 if(!target)return;
 if(state.route!=='discover')route('discover');     // 在模型库页点这个键，先回到发现页再说
 const prev=state.modelOnly;
 state.modelOnly=!!target.modelOnly;
 if(state.modelOnly!==prev){
  // 模式切换会改 A 站请求的形状：进入时把「类型」拨到 Marmoset（可转 3D），退出时还原用户的选择；
  // 旧结果作废，让下面（或 setPlatform 的冷源重搜）用新形状重新检索。
  if(state.modelOnly){artTypeBeforeModel=$('#art-type').value||'marmoset';$('#art-type').value='marmoset';}
  else if(artTypeBeforeModel){$('#art-type').value=artTypeBeforeModel;artTypeBeforeModel='';}
  const f=state.feeds.art;f.controller?.abort();f.busy=false;f.request=null;f.rows=[];f.pending=[];f.next=null;
 }
 renderFilters(platformById(state.platform));        // 统一树 ↔ 两棵平台树的显隐立刻切
 if(target.platform===state.platform){
  // 平台没变（例如全部平台下点模型模式）：setPlatform 会直接 return，这里得自己收尾。
  state.gallery=target.gallery;contentModes?.render();
  if(state.modelOnly!==prev||!state.feeds.art.request)return requestFeed('art',readRequest('art'));
  renderGrid();return;
 }
 setPlatform(target.platform,{gallery:target.gallery});
}
/** R1：统一树的组头一键筛选把整组的 slug 串写进隐藏容器（多值），它非空时优先于单值叶子。 */
function readCategory(){return $('#online-category-group').value||$('#online-category').value;}
function readSearch(){return searchParams({q:$('#asset-query').value,category:readCategory(),sort:$('#online-sort').value,downloadable:$('#online-downloadable').checked,animated:$('#online-animated').checked,staffpicked:$('#online-staffpicked').checked});}
/** R4：选中的分类 A 站没有对应映射时，这一路本轮不检索。
 *  旧结果一并丢掉——留着会让人以为「这回搜出来的就是这些 A 站结果」；token 前进一位是为了让
 *  在途请求的收尾（它会把状态下成「已停止检索」）认输，不把我们这句话覆盖掉。
 *  原因同时放进 warnings：状态行只在有话说时才显示，光写 status 会在检索结束时被一起藏起来。 */
function skipFeed(mode,reason){
 const f=state.feeds[mode];if(!f)return;
 f.controller?.abort();f.token++;f.controller=null;f.busy=false;
 f.rows=[];f.pending=[];f.next=null;f.pages=0;f.request=null;f.error=false;f.aborted=false;
 f.status='本轮跳过';f.warnings=[reason];
 renderStatus();renderGrid();
}
/** 每个源读自己那套筛选参数；关键词只有一个，由所有平台共用。 */
 const readRequest=mode=>{
  const picked=state.platform===ALL&&mergedFilters?.kinds?mergedFilters.kinds():[];
  const plan=state.platform===ALL?feedPlan({group:$('#online-category-group').value,leaf:$('#online-category').value}):null;
  const baseQ=$('#asset-query').value.trim();
  const refuse=(type,reason)=>{if(picked.length&&!kindAllows(picked,mode,type)){skipFeed(mode,reason||'当前范围不包含这个资产类型');return true;}return false;};
  if(plan){
   const target=mode==='search'?plan.sketchfab:mode==='art'?plan.art:plan[mode];
   if(!target){skipFeed(mode,'这个题材在该站没有对应分类');return null;}
   if(refuse(target.type))return null;
   if(mode==='search'){const request=readSearch();request.category=target.category;return request;}
   if(mode==='art'){const request=artstation.read();request.category=target.category;return request;}
   if(mode==='polyhaven')return {q:joinQuery(baseQ,target.q),type:target.type,category:target.category||''};
   if(mode==='ambientcg')return {q:joinQuery(baseQ,target.q),category:''};
   if(mode==='freestylized')return {q:joinQuery(baseQ,target.q),type:target.type,category:'',sort:$('#online-sort').value};
   if(mode==='polypizza')return {q:joinQuery(baseQ,target.q),cc0:$('#polypizza-cc0').checked};
   if(mode==='kenney')return {q:joinQuery(baseQ,target.q),category:'',series:''};
  }
  if(picked.length&&refuse(mode==='polyhaven'?kindType(picked,'polyhaven')||'models':mode==='freestylized'?kindType(picked,'freestylized'):undefined))return null;
  if(mode==='ambientcg')return ambientcgUI.read();
  if(mode==='polyhaven'){
   const type=kindType(picked,'polyhaven');
   if(picked.length&&!type){skipFeed(mode,'模型和材质、HDRI 请分开选范围');return null;}
   return type?{q:baseQ.slice(0,200),type,category:''}:polyhavenUI.read();
  }
  if(mode==='polypizza')return {q:baseQ.slice(0,200),cc0:$('#polypizza-cc0').checked};
  if(mode==='kenney')return kenneyUI.read();
  if(mode==='freestylized'){
   const type=kindType(picked,'freestylized');
   if(picked.length&&!type){skipFeed(mode,'不同资产类型请分开选范围');return null;}
   return type?{q:baseQ.slice(0,200),type,category:'',sort:$('#online-sort').value}:freestylizedUI.read();
  }
  const request=mode==='art'?artstation.read():readSearch();
  if(mode==='art'&&state.platform===ALL){
   const categoryIds=artstationCategory({group:$('#online-category-group').value,leaf:$('#online-category').value});
   if(categoryIds===null){skipFeed('art','这个题材在 ArtStation 没有对应分类');return null;}
   request.category=categoryIds;
   if($('#online-sort').value==='newest'||$('#online-sort').value==='relevance')request.sort=$('#online-sort').value;
  }
  return request;
 };
/** 把一份检索参数写回控件；历史回放、重置、推荐词点击都从这里进来。
 *  分类有两个容器（R1），语义互斥：多值串只可能来自统一树的组头一键筛选——单值下拉里没有逗号
 *  选项，所以它一定属于隐藏容器；单值照旧写 #online-category。这样「整组检索」被记进历史再回放，
 *  还能原样重现，不会退化成某个叶子。 */
function writeSearch(params){
 const p=searchParams(params);
 $('#asset-query').value=p.q;$('#online-sort').value=p.sort;for(const key of ['downloadable','animated','staffpicked'])$('#online-'+key).checked=p[key];
 const grouped=p.category.includes(',');
 $('#online-category-group').value=grouped?p.category:'';
 $('#online-category').value=grouped?'':p.category;
 return p;
}
/** 模型模式的统一树重置：两边一起回默认；A 站类型保持模型模式锁定的 Marmoset。
 *  分类的两个容器（含 R1 的组容器）由 writeSearch 一次清零，不在这里复制第二处写值。 */
function resetMergedFilters(){
 mergedFilters?.clearKinds?.();
 writeSearch({q:$('#asset-query').value});
 $('#art-category').value='';$('#art-sort').value='relevance';$('#art-picked').checked=false;
 startSearch();
}

/** 一个关键词框：当前平台的每个结果流都用自己那套筛选参数去检索。 */

function restartSearch(delay=180){clearTimeout(searchTimer);searchTimer=setTimeout(startSearch,delay);}

/** 搜索框被清空时，把「上一次检索」彻底忘掉，回到浏览热门。
 *
 *  之前搜索框只监听 submit（回车），删字这个动作界面完全不知道 —— 于是结果区还挂着
 *  上一次的卡片，切平台也只是把旧结果原样搬过去，看上去像「搜索没清干净」。
 *  回到空关键词 = 回到浏览热门（见 startSearch 的 q 为空分支），这也正是用户删字时
 *  预期看到的状态。
 *
 *  所有平台一起失效，包括隐藏平台和还在翻译或解析的请求，避免切换后重新出现旧结果。
 */
/** 上一次真正发出去的检索里还带着关键词（或解析链接）吗？ */
function searchStillActive(){
 if(state.source==='link')return !!state.feeds.web?.request?.url;
 return Object.values(state.feeds).some(feed=>feed.busy||!!(feed.request?.q||feed.request?.url));
}
/** 每日主题推荐带：只在「搜索框空着」的时候露脸 —— 那正是用户在逛、在等推荐的时候。
 *  点一个词等于他自己在搜索框里敲了一遍（所以会记进最近检索）；其他时候整条藏起来，不占版面。
 *  内容按天推进（见 dailyTopics），当天内无论刷新还是切标签页都不会跳。 */
function refreshTopicStrip(){
 const strip=$('#topic-strip');if(!strip)return;
 const browsing=!$('#asset-query').value.trim();
 strip.hidden=!browsing;
 if(!browsing)return;
 const today=new Date().toDateString();          // 跨天或从睡眠里醒来时重画一次，平时不动
 if(strip.dataset.day===today&&strip.childElementCount)return;
 strip.dataset.day=today;
 strip.innerHTML='<span class="topic-lead">今日主题</span>'+dailyTopics().map(topic=>
  `<button type="button" class="topic-chip${topic.today?' today':''}" data-topic="${topic.en}" title="${topic.today?'今天的主题':'试试这个主题'}">${topic.en}</button>`).join('');
}
function clearSearchIfEmptied(){
 if($('#asset-query').value.trim())return;      // 还有字：正在打字或只删了几个字，不打断检索
 if(!searchStillActive()&&!hadQuery)return;     // 结果区本来就是浏览态，没什么可清
 hadQuery=false;
 resetDiscoveryFeeds(state);
 persist();renderGrid();
 searchHistory?.close();   // 这里写 searchHistoryUI() 会抛 ReferenceError：那个名字只是传给 discovery-feed 的属性键，app.js 里并不存在（旧代码正是这样，一整条清空链路从第二步就断了）
 restartSearch(0);
}
/** 一个链接框：先按注册表判定平台，再交给对应通道（作品识别 / 网页解析）。
 *  入口只剩搜索框本身（粘贴链接直接回车），所以默认值也从搜索框读。 */

function collect(ids,{quiet=false}={}){
 const result=collectModels(state.models,ids.map(findModel).filter(Boolean));state.models=result.models;persist();renderGrid();
 if(!quiet)toast(result.refused?`已加入 ${result.added} 个；模型库已达 1000 个，请先整理。`:result.added?`已加入 ${result.added} 个模型`:'这些模型已在模型库中');
 return result;
}
function toggleFavorite(uid){
 if(state.favorites.has(uid))state.favorites.delete(uid);
 else{const r=collect([uid],{quiet:true});if(r.refused){toast('模型库已满，请先移除一些模型再收藏。');return;}state.favorites.add(uid);}
 persist();renderGrid();
}

async function enqueueImmediate(picked,{force=false}={}){
 const kind=jobKindOf(picked);
  if(!kind){toast('不同平台的资产请分批次下载（ArtStation / Sketchfab / Poly Haven 各自单独一批）。');return;}
  const polyMaterial=kind==='polyhaven'&&picked.every(m=>m.assetType==='textures');
  const polyHdri=kind==='polyhaven'&&picked.every(m=>m.assetType==='hdris');
  if(kind==='polyhaven'&&picked.some(m=>m.assetType==='textures'||m.assetType==='hdris')&&!polyMaterial&&!polyHdri){toast('Poly Haven 的模型、材质和 HDRI 请分批下载。');return;}
  if(kind==='artstation'?picked.length>artstation.maxBatch:picked.length>50){toast(`每批最多 ${kind==='artstation'?artstation.maxBatch:50} 个${kind==='artstation'?' ArtStation 作品':'模型'}，请减少选择数量。`);return;}
  if(!picked.length){toast('未找到模型记录，请重新检索。');return;}
  // 材质没有 FBX 转换这一说，Blender 缺席的提醒只对模型任务有意义。
  if(kind!=='ambientcg'&&!polyMaterial&&!polyHdri&&kind!=='polypizza'&&kind!=='kenney'&&kind!=='freestylized'&&downloads?.blenderAvailable===false)toast('默认会导出 GLB + FBX；未检测到 Blender 时 FBX 转换会失败，请先安装 Blender 或设置 SFX_BLENDER。');
  state.selected.clear();
  for(const model of picked)queuePulse.set(model.uid,Date.now());
  renderGrid();counts();
  try{
   // 材质任务的选项：精度取自卡片下载键左边的选择（批量取第一张，服务端再校验一次），
   // 输出固定为解压文件夹——材质没有 GLB/FBX 选项，也不再给压缩包与文件夹的二选一。
   const materialResolution=/^[1248]K$/.test(picked[0]?.materialResolution||'')?picked[0].materialResolution:'2K';
   const downloadOptions=kind==='ambientcg'||polyMaterial?{output:'folder',resolution:materialResolution,textureFormat:'JPG'}:polyHdri?{output:'folder',resolution:materialResolution,textureFormat:'HDR'}:kind==='freestylized'?{output:'folder',format:'glb',resolution:materialResolution}:kind==='polypizza'||kind==='kenney'?{output:'folder',format:'glb'}:{...state.options,output:'folder',format:'fbx',downloadTextures:true,pngOnly:true,fastZip:true};
  // kind 已在函数顶部由 jobKindOf(picked) 判定，覆盖 Poly Haven 等新平台，不再写死 sketchfab
  const result=await downloads.enqueue(picked,downloadOptions,force,undefined,kind);
  const libraryResult=collectModels(state.models,picked);state.models=libraryResult.models;persist();
  for(const model of picked)queuePulse.delete(model.uid);
  renderGrid();counts();
  const noun=kind==='artstation'?' ArtStation 转换任务':polyHdri?' Poly Haven HDRI':polyMaterial?' Poly Haven 材质':kind==='polyhaven'?' Poly Haven 模型':kind==='ambientcg'?' ambientCG 材质':kind==='polypizza'?' Poly Pizza 模型':kind==='kenney'?' Kenney 资源包':kind==='freestylized'?' FreeStylized 资产':'后台任务';
  // 这条消息是入队结果唯一的出口：先前会有一条「已识别某作品」的上下文提示，
  // 粘贴链接改成只出卡片、不自动入队之后，那个上下文已无处可挂，删掉免得留下死参数。
  const message=result.added.length?`已加入 ${result.added.length} 个${noun}${result.duplicates.length?`，跳过 ${result.duplicates.length} 个重复任务`:''}`:result.duplicates.length?'这些任务已在队列或已完成。':'没有任务加入';
  toast(libraryResult.refused?message+'；模型库已满，部分下载模型未自动入库':message);
 }catch(e){for(const model of picked)queuePulse.delete(model.uid);toast(e.message);renderGrid();counts();}
}
function requestDownload(ids){
 const picked=mergeModels([],ids.map(findModel).filter(Boolean)).map(m=>({...m}));
 enqueueImmediate(picked);
}
/** 只传输已在本地的文件：不进队列、不重新下载，所以入口是任务编号而不是模型编号。 */
async function sendBlenderToOpenScene(id){
 if(!downloads?.sendToBlender)return toast('后台服务未连接，无法发送到 Blender。');
 try{await downloads.sendToBlender(id);toast('已发送到已打开的 Blender 场景');}catch(e){toast(e.message);}
}
function renderTasks(){downloads?.render();}
function openSettings(){
 $('#pack-mode').value=state.options.packMode;$('#texture-size').value=state.options.maxTextureEdge;$('#scan-limit').value=state.options.scanLimit;
 $('#backend-folder').value=downloads?.settings?.folder||'';$('#backend-concurrency').value=downloads?.settings?.concurrency||1;$('#backend-retries').value=downloads?.settings?.retryLimit??1;
 // 每次打开都重新探一次：用户很可能刚重启过 Blender，状态得跟上。
 blenderBridge?.refresh();
 // 「运行环境」：后台浏览器是可下载的，每次打开都要按实际情况刷新按钮文案。
 browserRuntime?.refresh();
 settingsPanel.open();
}
async function browseFolderInto(inputId,errorId){
 const input=$(inputId),error=errorId?$(errorId):null;if(!input)return;
 if(!downloads?.pickFolder){toast('后台服务未连接，暂时不能打开文件夹选择器。');return;}
 if(error)error.textContent='';
 try{const folder=await downloads.pickFolder(input.value.trim());if(folder)input.value=folder;}catch(e){if(error)error.textContent=e.message;toast(e.message);}
}
function setup(){
 restoreDiscoveryFilters();
 refreshTopicStrip();
 downloads=createDownloadUI({$,icon,esc,toast,legacy:()=>state.tasks,requestLegacy:uid=>requestDownload([uid]),isVisible:()=>state.route==='downloads',onUpdate:changed=>{counts();if(changed&&state.route!=='downloads')renderGrid();}});downloads.setup();
 artstation=createArtstationUI({$,icon,esc,toast,state,requestFeed});artstation.setup();
 // ambientCG 侧栏（分类 / 精度 / 输出方式）：分类清单开页就拉一次，静态 facets 不常变。
 ambientcgUI=createAmbientcgUI({$,toast,requestFeed});ambientcgUI.setup();
 polyhavenUI=createPolyhavenUI({$,toast,requestFeed});polyhavenUI.setup();
 kenneyUI=createKenneyUI({$,toast,requestFeed});kenneyUI.setup();
 freestylizedUI=createFreestylizedUI({$,esc,toast,requestFeed});freestylizedUI.setup();
 $('#polypizza-cc0').onchange=()=>{if(state.platform==='polypizza')requestFeed('polypizza',readRequest('polypizza'));};
 // 设置面板里的「Blender 连接」：显示脚本装到哪、Blender 开着没有、端口通不通。
 blenderBridge=createBlenderBridgePanel({$,esc,icon,toast});blenderBridge.setup();
 // 设置面板里的「运行环境」：后台浏览器不再随安装包分发，缺了就点这里下载。
 browserRuntime=createBrowserRuntimePanel({$,esc,icon,toast});browserRuntime.setup();
 // 首次运行的依赖准备：缺了后台浏览器 / Blender / 桥接脚本时自己弹出来，之后从设置页进来。
 setupWizard=createSetupWizard({$,esc,icon,toast});setupWizard.setup();
 resolveArtworkLink=async url=>{
  // 只负责「识别出这个作品」，不碰下载队列：结果卡片的下载键由主人在结果区点。
  // 入队逻辑只留在 enqueueImmediate 那一条路上，避免识别顺手把任务排上。
  return artstation.resolveModel(url);
 };
 // R1 的组容器是「值」不是「显示层」：filter-tree 重建 #filters-sketchfab 时会先把行内的原生控件
 // 摘进隐藏盒子、再整片重画，标记在行里的节点会被丢掉。自己留一份引用，树建好后把它放回该行。
 const categoryGroup=$('#online-category-group');
 filterTrees=createFilterTrees({$,icon});                        // 筛选行改画成树状分类：字段是根分支，分类下面按主题分组
 if(categoryGroup&&!categoryGroup.isConnected)$('#filters-sketchfab').append(categoryGroup);
 enhanceSelects('#search-panel select:not(.ftree-native), #filter-rows select:not(.ftree-native)');   // 原生下拉的系统弹出层改不了样式，这里统一换成自绘的；树里的控件另有显示层，跳过
 contentModes=createContentModes({state,onPick:applyContentMode,buttons:document.querySelectorAll('[data-content-mode]')});   // 两个快捷入口：模型模式＝只看 Sketchfab，图片模式＝只看 A 站并排瀑布流
 placeFilters();                                                // 宽屏把筛选行搬进左侧栏，窄屏搬回搜索卡片
 window.addEventListener('resize',()=>{clearTimeout(filterTimer);filterTimer=setTimeout(()=>{placeFilters();syncStickyOffset();},120);});
 fillIcons();$('#online-category').innerHTML=CATEGORIES.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');filterTrees.refresh();/* 分类选项填进去了，树可以画叶子了 */searchHistory=createSearchHistory({$,icon,state,persist,toast,onPick:applyHistory});searchHistory.setup();renderPlatform();route('discover');
 if(initial.migrated||initial.warning){$('#migration-note').hidden=false;$('#migration-note span').textContent=initial.warning||`已兼容旧版：保留 ${state.models.length} 个模型及收藏、任务记录。新的在线结果不会再自动入库。`;persistNow();}
 $('#dismiss-migration').onclick=()=>{$('#migration-note').hidden=true;};
 document.addEventListener('click',e=>{
  // 装成桌面应用后，WebView 不会把 target="_blank" 交给系统浏览器 —— 点了没反应。
  // 详情面板里所有「打开官方页面」都是这类链接，统一在这里接走，交给系统默认浏览器。
  const external=e.target.closest('a[target="_blank"]');
  if(external&&/^https?:/i.test(external.href||'')){e.preventDefault();openExternal(external.href);return;}
  const routeButton=e.target.closest('[data-route]');if(routeButton)route(routeButton.dataset.route);
  const close=e.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();
  const action=e.target.closest('[data-action]');if(action){const {uid}=action.dataset;switch(action.dataset.action){case 'preview':preview(uid);break;case 'download':requestDownload([uid]);break;case 'download-images':imageDownload.requestImages([uid]);break;case 'blender-send':sendBlenderToOpenScene(action.dataset.id);break;case 'favorite':toggleFavorite(uid);break;case 'ai-tags':aiTagThis(uid);break;case 'collect':collect([uid]);break;case 'reveal-download':downloads?.reveal(action.dataset.id).catch(e=>toast(e.message));break;case 'remove':if(confirm('从模型库移除此模型和收藏？不会删除已下载文件。')){state.models=state.models.filter(m=>m.uid!==uid);state.favorites.delete(uid);state.selected.delete(uid);persist();renderGrid();}break;}}
  const filter=e.target.closest('[data-filter]');if(filter){state.filter=filter.dataset.filter;state.selected.clear();document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===filter));renderGrid();}
  const tag=e.target.closest('[data-tag]');if(tag){$('#preview-dialog').close();writeSearch({q:tag.dataset.tag});startSearch();}
  
 });
 $('#grid').addEventListener('change',e=>{const id=e.target.dataset.select;if(!id)return;e.target.checked?state.selected.add(id):state.selected.delete(id);renderGrid();});
 // 材质精度选择（卡片下载键左边、预览面板各一份）：写回模型对象，重渲染时按它回填，
 // 下载时也从同一个字段读——不复制第二份状态，就不存在两处显示不一致。
 // 写回后必须重渲染：下载键的「已下载」按精度判定，不刷新的话切了精度按钮还停在旧档位的状态。
 document.addEventListener('change',e=>{const select=e.target.closest('[data-material-resolution]');if(!select)return;const model=findModel(select.dataset.materialResolution);if(!model||model.materialResolution===select.value)return;model.materialResolution=select.value;renderGrid();});
 // 只有「手动在搜索框里敲关键词并提交」才写进最近检索：分类 / 排序 / 复选这些筛选动作
 // 也会重发检索，但它们是筛选不是检索词，混进历史里只会把真正的关键词挤掉（2026-10-16 用户要求）。
 $('#asset-search-form').addEventListener('submit',e=>{e.preventDefault();startSearch({record:true});});
 // 删字也算一次检索：只清空时才触发（见 clearSearchIfEmptied），
 // 否则每敲一个字都发请求，既吵又慢。
 $('#asset-query').addEventListener('input',clearSearchIfEmptied);
 $('#asset-query').addEventListener('input',refreshTopicStrip);
 // 主题胶囊：写进搜索框再走一次正常检索。赋值不会触发 input 事件，所以顺手自己刷新推荐带。
 $('#topic-strip').addEventListener('click',event=>{
  const chip=event.target.closest('[data-topic]');if(!chip)return;
  $('#asset-query').value=chip.dataset.topic;refreshTopicStrip();startSearch({record:true});
 });
 // 主题拆包助手（A3）：一句话主题 → AI 拆成一组搜索词，点一下即检索。
 const themeInput=$('#asset-query'),themeResults=$('#theme-results');
 themeInput.title='多个搜索词用逗号分隔，例如：house, tree, cart；AI 可将主题拆解成搜索词';
 let themeToken=0;
 themeInput.addEventListener('input',()=>{themeToken++;});
 $('#theme-breakdown-btn').onclick=async()=>{
  const theme=themeInput.value.trim();if(!theme){themeInput.focus();return;}
  const token=++themeToken,button=$('#theme-breakdown-btn');button.disabled=true;button.textContent='拆解中…';
  themeResults.hidden=false;themeResults.innerHTML='<span class="theme-loading">正在拆解主题…</span>';
  const data=await brainstorm(theme);
  button.disabled=false;button.textContent='✦ AI 拆解';
  if(token!==themeToken){themeResults.hidden=true;return;}
  if(!data.brainstormed){themeResults.innerHTML=`<span class="theme-empty">${esc(data.reason||'未能拆解，请换个说法')}</span>`;return;}
  const terms=[...new Set(data.terms.filter(t=>typeof t==='string').map(t=>t.trim()).filter(Boolean))].slice(0,8);
  if(!terms.length){themeResults.textContent='未生成有效搜索词，请换个说法';return;}
  themeInput.value=terms.join(', ');refreshTopicStrip();persist();
  themeResults.innerHTML='<span>已填入搜索栏，点击搜索可同时检索；也可点击单个词：</span>'+terms.map(t=>`<button type="button" class="theme-chip" data-term="${esc(t)}">${esc(t)}</button>`).join('');
 };
 themeResults.addEventListener('click',event=>{
  const chip=event.target.closest('[data-term]');if(!chip)return;
  $('#asset-query').value=chip.dataset.term;refreshTopicStrip();startSearch({record:true});
 });
  // 两个分类容器都要监听：统一树点叶子写 #online-category、点组头写 #online-category-group，改哪个都重搜。
 for(const id of ['online-category','online-category-group','online-sort','online-downloadable','online-animated','online-staffpicked'])$('#'+id).onchange=()=>restartSearch();
 $('#unified-sort').onchange=()=>{
  const next=$('#unified-sort').value;
  if(next==='name'){renderGrid();return;}
  if($('#online-sort').value!==next){$('#online-sort').value=next;$('#online-sort').dispatchEvent(new Event('change',{bubbles:true}));}
 };
 $('#unified-kind').onchange=()=>startSearch();
 mergedFilters=createMergedFilters({$,icon,state,onReset:resetMergedFilters,onSearch:()=>startSearch()});   // 全部平台的统一筛选树
$('#reset-search-filters').onclick=()=>{writeSearch({q:$('#asset-query').value});startSearch();};
$('#search-platform').onchange=e=>setPlatform(e.target.value);
$('#empty-explore').onclick=()=>{writeSearch({sort:'popular'});refreshTopicStrip();startSearch();};
 const localSearch=bindLocalSearch({$,state,renderGrid,parse:parseLocal});
const tagSuggester=createTagSuggester();
 let activeTagUid='';
 const tagging=new Set();
 function renderTagDialog(uid){
  const model=findModel(uid);if(!model)return;
  $('#asset-tags-title').textContent=model.name||'资产标签';
  $('#asset-tags-content').innerHTML=tagPanel(state,model,esc);
  $('#asset-tags-content').querySelector('[data-action="ai-tags"]').disabled=tagging.has(uid);
 }
 function openTags(uid){
  activeTagUid=uid;renderTagDialog(uid);
  $('#asset-tags-status').textContent=tagging.has(uid)?'正在整理标签…':'标签自动保存，无需另外点击保存。';
  if(!$('#asset-tags-dialog').open)$('#asset-tags-dialog').showModal();
 }
 document.addEventListener('click',event=>{
  const button=event.target.closest('[data-action="asset-tags"]');
  if(button)openTags(button.dataset.uid);
  if(event.target.closest('#asset-tags-dialog [data-tag]'))$('#asset-tags-dialog').close();
 });
 $('#sort').onchange=e=>{state.sort=e.target.value;renderGrid();};
 for(const id of ['#local-kind','#local-status'])$(id).onchange=()=>{state.selected.clear();renderGrid();};
 $('#local-feature').onchange=e=>{state.filter=e.target.value;state.selected.clear();renderGrid();};
 $('#reset-local-filters').onclick=()=>{
  localSearch.reset();
  state.search='';state.filter='all';state.selected.clear();
  $('#model-search').value='';$('#local-kind').value='';$('#local-status').value='';$('#local-feature').value='all';
  renderGrid();
 };
 $('#tag-all').onclick=tagAllAssets;
 let tagBusy=false,tagAbort=false;
 async function aiTagThis(uid){
  const model=findModel(uid);if(!model)return;
  if(tagging.has(uid))return;
  tagging.add(uid);openTags(uid);
  try{
   const data=await tagSuggester({name:model.name,author:model.author,kind:model.assetType||model.kind,existing:tagsFor(state,model)});
   if(!data.tagged||!data.tags.length){toast(data.reason||'未能生成标签');if(activeTagUid===uid)$('#asset-tags-status').textContent=data.reason||'未能生成标签，可重试。';return;}
   const added=addAITags(state,model,data.tags);
   persistNow();renderGrid();refreshPreviewTags(uid);
   const message=added?`已补充 ${added} 个 AI 标签，已自动保存到本机。`:'没有新增标签，原有标签已保留。';
   if(activeTagUid===uid)$('#asset-tags-status').textContent=message;
   toast(message);
  }finally{
   tagging.delete(uid);
   if(activeTagUid===uid)renderTagDialog(uid);
  }
 }
 async function tagAllAssets(){
  if(tagBusy){tagAbort=true;toast('已请求停止整理');return;}
  const candidates=state.models.filter(m=>tagsFor(state,m).length<2);
  if(!candidates.length){toast('没有需要整理标签的资产');return;}
  if(!confirm(`将为 ${candidates.length} 个标签偏少的本地资产补充 AI 标签，可能较慢，继续？`))return;
  tagBusy=true;tagAbort=false;let done=0;
  try{
   for(const m of candidates){
    if(tagAbort)break;
    if(tagging.has(m.uid))continue;
    tagging.add(m.uid);
    try{
     const data=await tagSuggester({name:m.name,author:m.author,kind:m.assetType||m.kind,existing:tagsFor(state,m)});
     if(data.tagged&&data.tags.length){addAITags(state,m,data.tags);persistNow();}
    }catch{}finally{tagging.delete(m.uid);}
    done++;
    if(done%5===0){persist();renderGrid();toast(`已整理 ${done}/${candidates.length}`);}
   }
  }finally{tagBusy=false;}
  persistNow();renderGrid();
  if(activeTagUid){renderTagDialog(activeTagUid);refreshPreviewTags(activeTagUid);}
  toast(tagAbort?`已停止，整理 ${done} 个资产`:`完成，共为 ${done} 个资产补充标签`);
 }
 // 三种展示共用一个切换入口；按钮高亮由 renderGrid 从 state 推出，不在点击处理里各改一遍。
 const setDisplay=view=>{state.compact=view==='compact';state.gallery=view==='gallery';renderGrid();};
 $('#grid-view').onclick=()=>setDisplay('grid');$('#list-view').onclick=()=>setDisplay('compact');$('#gallery-view').onclick=()=>setDisplay('gallery');
 // 「继续检索」推进当前平台的每个源；链接解析结果只有 web 一个源。
const more=options=>{if(state.source==='link')return requestFeed('web',state.feeds.web.request,options);return activeModes().map(mode=>requestFeed(mode,state.feeds[mode].request,options));};
$('#load-more').onclick=()=>more({more:true});$('#load-all').onclick=()=>more({more:true,all:true});
 // 每批加载条数：写在 state 上并持久化，翻页批次按它算（见 discovery-feed.js 的 batchPages）。
 const pageSizeSelect=$('#page-size');
 if(pageSizeSelect){
  pageSizeSelect.value=String(state.pageSize);
  pageSizeSelect.onchange=()=>{state.pageSize=Math.max(1,Number(pageSizeSelect.value)||24);persist();};
  // 恢复上次的偏好：<select> 的 value 只认 markup 里写死的选项。
  if(![...pageSizeSelect.options].some(o=>o.value===String(state.pageSize)))pageSizeSelect.value='24';
 }
 // 滚动到底自动加载：观察分页行而不是监听 scroll 事件 —— 事件需要自己算容器位置、
 // 还要防抖与去抖，而 IntersectionObserver 在分页行进入视口时天然只触发一次；
 // 分页行 hidden 时不产生交点，于是「没有下一页」也自动停，不会空转。
 // autoBusy 是必要的：一次加载可能新增上千像素内容，分页行在加载完成前会再次进入视口。
 let autoLoadBusy=false;
 const autoLoad=new IntersectionObserver(entries=>{
  if(!entries.some(e=>e.isIntersecting)||autoLoadBusy)return;
  const f=composite();
  if(state.route!=='discover'||f.busy||f.rows.length>=1000||!(f.next||f.pending.length))return;
  autoLoadBusy=true;
  Promise.all([more({more:true})]).catch(()=>{}).finally(()=>{autoLoadBusy=false;});
 },{rootMargin:'320px 0px'});
 autoLoad.observe($('#pagination'));
 $('#select-all').onclick=()=>{filtered().forEach(m=>state.selected.add(m.uid));renderGrid();};$('#deselect').onclick=()=>{state.selected.clear();renderGrid();};$('#collect-selected').onclick=()=>collect([...state.selected]);$('#download-selected').onclick=()=>requestDownload([...state.selected]);$('#download-images-selected').onclick=()=>imageDownload.requestImages([...state.selected]);

// 关弹窗要停掉 three.js 的渲染循环并释放 GPU 资源 —— 只清iframe 的 src 的话，Poly Haven
// 的 canvas 会继续每帧渲染，白烧 CPU/GPU 直到页面刷新。
//
// Sketchfab 的 iframe 反过来：**不**清 src。dialog 一关它就是 display:none，浏览器暂停
// 它的渲染循环（不烧 GPU），但 WebGL 上下文和已加载的模型保持热态，同一个模型再次
// 预览直接秒开；换模型时 preview() 发现地址不同会自己重设 src。
//
// close 事件是**排队异步派发**的，而「上一个弹窗还开着就点下一个资产」这条路是
// close() → showModal() → gltfPreview.load() 同步走完的：新预览的 load 先占了 loadToken，
// 这个迟到的 close 再跑一遍就会把 token 作废、canvas 藏起来，于是新资产永远等不到自己的
// 加载回调——表现就是「第一个模型能看，之后每个都是黑屏」。所以弹窗若已经重新打开，
// 这属于上一轮的收尾，一律跳过。
$('#preview-dialog').addEventListener('close',()=>{
  if($('#preview-dialog').open)return;
  gltfPreview.close();
});
 document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
 $('#settings-button').onclick=$('#download-settings').onclick=openSettings;$('#help').onclick=()=>$('#help-dialog').showModal();
 const aiSettings=createAISettings({$,toast});
 const appUpdates=createAppUpdates({hasActiveTasks:()=>downloads.activeCount()>0});
 settingsPanel=createSettingsPanel({$,loadAI:()=>aiSettings.load(),updateCard:appUpdates.card});
 window.addEventListener('assetvault:open-updates',()=>settingsPanel.open('updates'));
 appUpdates.start();
 $('#open-setup-wizard').onclick=()=>{$('#settings-dialog').close();setupWizard?.open();};
 $('#reset-folder').onclick=()=>{$('#backend-folder').value=downloads.defaultFolder||downloads.settings?.folder||'';};
 $('#browse-backend-folder').onclick=()=>browseFolderInto('#backend-folder');
 $('#save-settings').onclick=async()=>{const button=$('#save-settings');button.disabled=true;try{await downloads.saveSettings({folder:$('#backend-folder').value.trim(),concurrency:Number($('#backend-concurrency').value),retryLimit:Number($('#backend-retries').value)});state.options={packMode:$('#pack-mode').value,maxTextureEdge:Number($('#texture-size').value),output:'folder',format:'fbx',downloadTextures:true,pngOnly:true,fastZip:true,scanLimit:Number($('#scan-limit').value),optionsVersion:3};persist();$('#settings-dialog').close();toast('后台设置已保存；新任务将以文件夹形式保存 GLB + FBX');}catch(e){toast(e.message);}finally{button.disabled=false;}};
 $('#clear-library').onclick=()=>{if(confirm('清空本地模型库与收藏？在线结果、下载记录和已下载文件不会被删除。')){state.models=[];state.favorites.clear();state.selected.clear();persistNow();renderGrid();}};
 window.addEventListener('pagehide',persistNow);
  // 顶部那条状态栏（连接指示灯 + 头像）已撤掉，所以这里不再往元素里写状态：
 // 连上了就安静地做「首次进入自动检索」，连不上才出声（状态行 + 一条提示）。
 fetch('/api/health').then(r=>{if(!r.ok)throw Error();return r.json();}).then(()=>{const warm=activeModes().some(mode=>state.feeds[mode].rows.length);if(!warm&&activeModes().every(mode=>!state.feeds[mode].request&&!state.feeds[mode].busy&&!state.feeds[mode].rows.length)&&state.route==='discover'&&!$('#asset-query').value.trim())startSearch();}).catch(()=>{state.feeds[activeModes()[0]].status='请通过 Start-Library.cmd 启动工作台。';state.feeds[activeModes()[0]].error=true;renderStatus();toast('本地服务未连接：卡片动作都依赖本地服务');});
}

setup();
