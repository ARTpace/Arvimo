import {createLibraryVisibility} from './library-visibility.js';
import {libraryBackgroundTarget,libraryBackgroundItems} from './library-background-menu.js';
import {bindLibraryShortcuts} from './library-shortcuts.js';
import {prepareAlbumBoard,prepareAlbumReference,legacyAlbumMembers} from './album-board-import.js';
import {albumImageKey} from './image-albums.js';
import {setupCategoryOrder} from './category-order.js';
import {withRemovalMotion} from './removal-motion.js';
import {removeCustomCategory,customCategories,addCustomCategory,assignCustomCategory,categoriesForAsset,categoryParentLabel,isCustomCategory,matchesCustomCategory,customCategoryValue,customCategoryOf} from './custom-categories.js';
import {createResourceUsagePanel} from './resource-usage.js';
import {compactPreview,setupPreviewSidebarToggle} from './preview-sidebar.js';
import {createPlatformSettingsCard} from './platform-settings.js';
import {askText,askConfirm,askNotice,askChoice} from './ask-dialog.js';
import {thumbSrc,visualTagSrc} from './image-src.js';
import {enabledPlatform,platformForFeed} from './platforms.js';
import {createDownloadUI} from './download-ui.js';
import {isLanVisitor} from './visitor-mode.js';
import {createPersistentStorage} from './persistent-storage.js';
import {createFormatFilterState} from './format-filter.js';
import {createLibraryPaging} from './library-paging.js';
import {metaOf} from './auto-tags.js';
import {categoryMatches} from './tag-facet-map.js';
import {createArtstationUI} from './artstation-ui.js';
import {createAmbientcgUI} from './ambientcg-ui.js';
import {createPolyhavenUI} from './polyhaven-ui.js';
import {createKenneyUI} from './kenney-ui.js';
import {createPolyforkUI} from './polyfork-ui.js';
import {createFreestylizedUI} from './freestylized-ui.js';

import {CATEGORIES,searchParams,dailyTopics} from './search-options.js';
import {PLATFORMS,ALL,DEFAULT_PLATFORM,platformById,platformLabel,routeLink,FEEDS,jobKindOf,isPictureSite,isVideoSite} from './platforms.js';
import {createContentKindTabs,contentMatchesKind,kindById,modeAllowsLocalKind,modeTabById,savedMode,rememberMode} from './content-kind-tabs.js';
import {MODE_PRESETS,modePresetById,platformPoolFor,loadModePlatforms,rememberModePlatform,pickModePlatform} from './mode-presets.js';
import {combine,statusText,subtitleText,pageInfoNote,loadMoreLabel,describeRequest,feedErrorMessage} from './discovery-view.js';
import {galleryAvailable,galleryActive,aspectRatioStyle} from './gallery-view.js';
import {loadLibrary,saveLibrary,mergeModels,collectModels,UID,LIBRARY_LIMIT,loadDiscovery,saveDiscovery,trashModels,restoreModels,purgeModels,setUserMeta,userMetaFor} from './library-state.js';
import {applyLocalFileMoves} from './local-file-moves.js';
import {enhanceSelects} from './picker.js';
import {openSiteLogin,loginStates,loginTargets} from './site-login.js';
import {readPins,writePins,togglePin,sortByPins} from './platform-pins.js';
import {findLocalJob,classifyBlenderJob} from './blender-send.js';
import {TARGETS as SOFTWARE_TARGETS,createSendMenu,targetById,applicableTargets,exportMenuHtml,setSelectedTarget} from './export-targets.js';
import {icon} from './icon-set.js';
import {createCardView} from './card-view.js';
import {probeLocalBridge,importIntoLocalBlender,createLocalBlenderGuide} from './client-blender.js';
import {openExternal} from './open-url.js';
// 「打开所在文件夹」：本机服务定位路径，系统文件管理器打开。实现只有一份，右键菜单各处共用。
import {revealLocalPath} from './local-reveal.js';
import {openHelp} from './help-panel.js';
import {initFeedbackPanel} from './feedback.js';
import {hookDiagnostics,rememberError} from './diagnostics.js';
import {createLibraryView,FILTER_ROWS} from './library-view.js';
import {resetPolyforkDetails} from './polyfork-params.js';
import {createLazyPreview} from './lazy-preview.js';
import {createLocalFiles,packageImageUrl} from './local-files.js';
import {createLocalImport} from './local-import.js';
import {setupDropImport,isDropImporting} from './drop-import.js';
import {openRelinkFile} from './relink-file.js';
import {createRangeSelect} from './range-select.js';
import {favoriteUid,favoriteTarget,favoriteSkipsCollect} from './favorite-targets.js';
import {createDiscoveryFeed,resetDiscoveryFeeds,restorePictureSnapshot} from './discovery-feed.js';
import {createImageDownloader} from './image-download.js';
import {createBlenderBridgePanel} from './blender-bridge.js';
import {createBrowserRuntimePanel} from './browser-runtime.js';
import {createSetupWizard} from './setup-wizard.js';
import {createSearchHistory} from './search-history.js';
import {createMergedFilters,artstationCategory,feedPlan,joinQuery,kindAllows,kindType} from './merged-filters.js';
import {fetchUiCode,uiSourceText} from './ui-element-preview.js';
import {createFilterTrees} from './filter-tree.js';
import {esc} from './html-esc.js';
import {filterLocalAssets,localAssetCategories,localAssetKind} from './local-filters.js';
import {waitForInitialCategories} from './category-options.js';
import {createAISettings} from './ai-settings.js';
import {setupDragOut} from './drag-out.js';
import {createBoardDrop} from './board-drop.js';
import {createCardGroupUI} from './card-group-ui.js';
import {collectModelFolders} from './card-groups.js';
import {setupPictureDrag} from './picture-drag.js';
import {setupLibraryDragWeb} from './library-drag-web.js';
import {tagsFor,addAITags,tagPanel,addUserTag,removeUserTag,listUserTags,renameUserTag,mergeUserTag,deleteUserTag,mergeTags} from './asset-tags.js';
import {previewActions} from './preview-actions.js';
import {exportSettingsHtml,selectSoftwareTab} from './export-settings.js';
import {chineseError} from './error-message.js';
import {authorButton} from './asset-author.js';
import {createSimilarAssets} from './similar-assets.js';
import {createSettingsPanel} from './settings-panel.js';
import {createAutostartCard} from './desktop-settings.js';
import {createAppearanceCard, applyAppearance, readAppearance} from './appearance.js';
import {createCloudSyncCard} from './cloud-sync.js';
// 外观要在首帧之前落地：等设置面板构造完再应用，用户会先看到一眼默认底色再跳到自己的壁纸。
applyAppearance(readAppearance(window.localStorage));
import {createBackupPanel} from './backup-panel.js';
import {createStorePanel} from './store-panel.js';
import {createSemanticSearch} from './semantic-search.js';
import {initSearchMotion} from './search-motion.js';
import {createMascotAssistant} from './mascot-assistant.js';
import {setupMascotDeveloper} from './mascot-developer.js';
import {createAssistantDownloads} from './assistant-downloads.js';
import {createRelatedSearch} from './related-search.js';
import {createLanSharingSettings} from './lan-sharing.js';
import {createTeamSettings} from './team-settings.js';
import {createAppUpdates} from './app-updates.js';
import {setupSidebarCollapse} from './sidebar-collapse.js';
import {setupFilterDrawer} from './filter-drawer.js';
import {setupCardContextMenu,assetMenuItems,packageMenuItems,fileMenuItems,pictureMenuItems,sequenceMenuItems,groupMenuItems,copyText} from './card-context-menu.js';
import {bindLocalSearch,createLocalQueryParser,createThemeBrainstorm,createTagSuggester} from './search-translation.js';
import {bindImageSearch,toDataUrl} from './image-search.js';
import {createAdvancedQuery} from './advanced-query.js';
import {createLibraryEvents} from './library-events.js';
import {applyRemoteDetails} from './remote-sync.js';
import {createFilterDock} from './filter-dock.js';
import {folderOf} from './filter-dimensions.js';
import {openLocalHealth} from './local-health.js';
import {sizeText} from './download-card.js';
import {createAssetProbe} from './asset-probe.js';
import {createBoardHub} from './board-hub.js';
import {bindScrollPerformance,scrollIdleTask} from './scroll-performance.js';
import {bindCardImageResidency} from './card-image-residency.js';
import {bindScrollbarInteraction} from './scrollbar-interaction.js';
import {mountScrollTop} from './scroll-top.js';
const $=selector=>document.querySelector(selector);
const visitor=isLanVisitor();
document.documentElement.dataset.lanVisitor=String(visitor);
const parseLocal=createLocalQueryParser();
const brainstorm=createThemeBrainstorm();
let settingsPanel;
const fmt=n=>n==null?'—':Number(n)>=1000?`${(Number(n)/1000).toFixed(Number(n)>=10000?0:1)}k`:String(n);
let storage;try{storage=window.localStorage;}catch{}
try{storage=await createPersistentStorage(storage,fetch,{catalogPaged:true});}catch(error){askNotice({title:'存储不可用',message:`${error.message}。暂时使用页面缓存，本次修改可能无法持久保存。`});}
window.addEventListener('assetvault:storage-error',event=>toast(event.detail));
// 先加载主机配置，再初始化任何在线平台；读取失败时禁止自动访问平台。
let platformSettings;
try{const response=await fetch('/api/platforms',{cache:'no-store',signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error('平台配置读取失败');platformSettings=await response.json();}
catch(error){platformSettings=Object.fromEntries(PLATFORMS.filter(p=>p.id!==ALL).map(p=>[p.id,false]));askNotice({title:'在线平台已停用',message:`${error.message}，在线平台暂时停用，请重启后台后刷新。`});}
const platformEnabled=id=>enabledPlatform(platformSettings,id);
const feedEnabled=mode=>platformEnabled(platformForFeed(mode));
const initial=loadLibrary(storage);
const newFeed=()=>({rows:[],request:null,next:null,pending:[],pages:0,busy:false,token:0,controller:null,status:'',error:false,aborted:false,warnings:[],visited:new Set(),origin:''});
// 每个结果流都先建好骨架，骨架清单来自 platforms.js 的 FEEDS：加平台时不用回来改这里，
// 也不会出现「平台声明了流但 state 里没有」这种一进页面就崩的错。platform 决定哪几个流
// 共同组成网格（见 platforms.js），source 决定网格当前展示的是搜索还是某一次链接解析。
// mode 是显式主状态：图标高亮、平台下拉池、结果流、布局全部由它决定，不再从 platform 反推。
// contentKind 只是它在资产库页的「本地类型筛选」影子，避免 filtered() 里再分叉一次。
const state={...initial,route:'discover',platform:DEFAULT_PLATFORM,source:'search',filter:'all',search:'',sort:'recent',selected:new Set(),gallery:false,modelOnly:false,libraryMode:'',mode:savedMode(),contentKind:'',modePlatforms:loadModePlatforms(storage),feeds:Object.fromEntries(FEEDS.map(mode=>[mode,newFeed()]))};
// 显示模式（网格 / 瀑布流）按页面各自记一份：资产库默认瀑布流，发现页默认网格。
// 用户手动切过就以他的选择为准，下次进来不再被默认值改回去。
const DISPLAY_KEY='sfx-display-mode';
const displayPrefs=(()=>{try{const raw=JSON.parse(localStorage.getItem(DISPLAY_KEY)||'{}');return raw&&typeof raw==='object'?raw:{};}catch{return {};}})();
const displayFor=name=>displayPrefs[name==='library'?'library':'discover']||(name==='library'?'gallery':'grid');
function rememberDisplay(view){
 const key=state.route==='library'?'library':'discover';
 displayPrefs[key]=view;
 try{localStorage.setItem(DISPLAY_KEY,JSON.stringify(displayPrefs));}catch{}
}
// ADR-09：启动期已到的目录页在 cache 里（loadLibrary 已读进 state.models），后续页由
// 持久化层增量投递。这里只做去重合并 + 重绘，绝不重建整张状态，也不改写入契约。
storage?.setCatalogPageHandler?.(items=>{
 const known=new Set(state.models.map(m=>m?.uid));let added=0;
 for(const item of items){if(!item||!item.uid||known.has(item.uid))continue;known.add(item.uid);state.models.push(item);added++;}
 if(added&&state.route==='library')try{renderGrid();}catch{}
});
if(state.mode){const preset=modePresetById(state.mode);state.contentKind=preset?.groupId||preset?.localKind||'';}
// 画板中枢在底部装配；右键菜单是运行时才触发的，这里先占位避免 TDZ。
// 访客模式 / 装配失败时保持 null，菜单里的画板项会自动缺席。
let boardHub=null;
// 常驻筛选图标条（设备初始化时才建）。资产库的本地类型过滤要问它一句「标签筛选中吗」：
// 标签是跨类型维度，选了标签就不该再被顶部模式带来的类型夹住（2026-11-11 用户反馈）。
let filterDock=null;
/** 当前真正生效的本地类型：标签筛选期间一律放开，清掉标签后原类型自动回来。 */
const activeLocalKind=()=>($('#local-kind')?.value||'');
// 上次停在哪个平台。图站最吃这条：不记住的话每次刷新都回到「全部平台」，用户得重新点一次
// 图站、再等一屏图，看上去就是「刷新就把图片重新加载了一遍」。
const LAST_PLATFORM_KEY='assetvault-last-platform-v1';
function rememberPlatform(id){try{storage?.setItem(LAST_PLATFORM_KEY,id);}catch{/* 存不了就只在本次会话生效 */}}
// 平台置顶顺序：会话内是数组，改动即写回 localStorage。置顶项在下拉里排到「全部平台」之后。
let platformPins=readPins(storage);
// 各平台的账号登录态（platform id → 'ok' / 'have'），由 /api/browser/cookies 与
// /api/browser/logins 推出来：菜单里登录图标常亮与否、以及「已登录」标识都看它。
let platformLogins={};
// 登记过登录入口的平台（后端 PICTURE_LOGIN_URLS 的键）。没登记的免登录站不出登录图标。
let platformLoginSites=new Set();
// 每批翻多少页由「每次加载多少条」推出来（见 discovery-feed.js）。它属于界面节奏而不是导出参数，
// 所以不塞进 options（那边会被设置面板整份覆盖回去），只跟 discovery 快照一起存。
const savedDiscovery=loadDiscovery(storage);
state.pageSize=[24,48,96,192].includes(Number(savedDiscovery?.pageSize))?Number(savedDiscovery.pageSize):48;
if(savedDiscovery){
 state.platform=platformEnabled(savedDiscovery.platform)?platformById(savedDiscovery.platform).id:ALL;
}
// 恢复的模式若与上次平台不配套（换机器 / 平台被关掉），退回该模式记住的站，
// 别让下拉出现「选中项不在池子里」的空壳，也别把图片模式恢复成 3D 平台的结果流。
if(state.mode){
 const preset=modePresetById(state.mode);
 if(preset?.linkOnly){
  // 文本 / 视频：没有站可恢复，「链接解析」就是它的平台。只拨状态，不在这里发请求。
  state.platform='link';state.modelOnly=false;
 }else if(preset&&!preset.localOnly){
  const pool=platformPoolFor(preset,{enabled:platformEnabled});
  if(!pool.some(item=>item.id===state.platform)){
   const target=pickModePlatform(preset,state.modePlatforms[state.mode],pool);
   if(target===ALL||platformEnabled(target)){state.platform=target;rememberPlatform(target);}
  }
  state.modelOnly=!!preset.modelOnly;
 }
}
state.gallery=displayFor('discover')==='gallery';
const queuePulse=new Map();
let downloads,artstation,ambientcgUI,polyhavenUI,kenneyUI,freestylizedUI,polyforkUI,blenderBridge,browserRuntime,setupWizard,contentModes,searchHistory,filterTrees,mergedFilters,filterTimer,persistTimer,toastTimer,searchTimer,liveEvents;
// 「本次会话里用户主动检索过」的痕迹。它只是 searchStillActive 的补充判据：
// 首次打开页面时框本来就是空的，不能把「框为空」当成一次删除（详见 clearSearchIfEmptied）。
let hadQuery=false;
// 粘进搜索框的 ArtStation 作品页走这一支：它只负责识别出那个作品（返回模型），
// 卡片和下载键由 discovery-feed 摆进链接结果区。识别器还没就绪时抛错，让状态行显示，不弹 toast。
let resolveArtworkLink=async()=>{throw Error('ArtStation 识别器尚未就绪，请稍后重试。');};
// 「发送到…」控件由「本地有没有文件」决定，卡片和预览面板共用这一个生成器。
const sendControl=createSendMenu({icon,esc});
const persistNow=()=>{clearTimeout(persistTimer);try{saveLibrary(storage,state);saveDiscovery(storage,{platform:state.platform,pageSize:state.pageSize,filters:discoveryFilters()});}catch{toast('浏览器存储空间不足，列表未保存；请先释放空间。');}};
const persist=()=>{clearTimeout(persistTimer);persistTimer=setTimeout(persistNow,200);};
function discoveryFilters(){
 const value=id=>{const node=document.querySelector(id);return node?node.value:'';};
 const checked=id=>{const node=document.querySelector(id);return !!node?.checked;};
 return {query:value('#asset-query'),polyhavenType:value('#polyhaven-type'),polyhavenCategory:value('#polyhaven-category'),ambientcgType:value('#ambientcg-type'),ambientcgCategory:value('#ambientcg-category'),kenneyCategory:value('#kenney-category'),kenneySeries:value('#kenney-series'),freestylizedType:value('#freestylized-type'),freestylizedCategory:value('#freestylized-category'),polypizzaCc0:checked('#polypizza-cc0'),onlineCategory:value('#online-category'),onlineSort:value('#online-sort'),downloadable:checked('#online-downloadable'),animated:checked('#online-animated'),staffpicked:checked('#online-staffpicked')};
}
function restoreDiscoveryFilters(){
 const filters=savedDiscovery?.filters;if(!filters)return;
 const set=(id,next)=>{const node=document.querySelector(id);if(node&&next!=null)node.value=next;};
 // 搜索词和结果只在本次会话中保留，不恢复历史搜索现场。
 set('#asset-query','');
 set('#polyhaven-type',filters.polyhavenType);
 set('#polyhaven-category',filters.polyhavenCategory);
 if(filters.polyhavenCategory&&$('#polyhaven-category'))$('#polyhaven-category').dataset.keep=filters.polyhavenCategory;
 set('#ambientcg-type',filters.ambientcgType||'material');
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
function toast(message){const text=chineseError(message);if(/失败|错误|不可用|超时/.test(text))rememberError(text);$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),4200);}
// 「下载高清图」的按钮生成与批量入队都在 image-download.js：卡片要显示哪些资产的按钮、多选栏点下去
// 发什么样的任务，答案必须只有一个，所以两边都问这一个对象。
const imageDownload=createImageDownloader({icon,toast,downloads:()=>downloads,findModel,refresh:()=>{renderGrid();counts();}});
// 卡片怎么画也住在自己的模块里（card-view.js）； Drawer 只把它需要的合作者喂进去。
const cardView=createCardView({albumCard:model=>localFiles.referenceCard(model),icon,esc,fmt,state,queuePulse,imageDownload,sendControl,classifyBlenderJob,platformLabel,artstationUI:()=>artstation,downloadsUI:()=>downloads,isVisitor:visitor});
// 状态行、网格、筛选行摆放、预览弹窗的画法都住在 library-view.js；这里解构出同名函数，
// 所以其余代码读起来还是只有 renderGrid() / counts() 这层语义。
const gltfPreview=createLazyPreview({onError:error=>toast('无法加载 3D 预览：'+error.message)});
// 格式筛选状态是唯一实例：高级检索面板写它，本地文件网格读它（localStorage 跨重启保留）。
// 用 window.localStorage 而不是 persistentStorage —— 后者是资产库主状态，UI 偏好不能污染它。
const formatFilter=createFormatFilterState();
// 资产库文件夹里没登记成下载任务的文件（用户自己拷进去的素材）：扫描 + 通用预览。
const localFiles=createLocalFiles({activeBoardId:()=>boardHub?.store.activeId,$,icon,esc,gltfPreview,storage,notify:message=>toast(message),onChanged:()=>scanLibraryFiles(true),onFetchPackage:fetchRemoteBoard,onBrowse:()=>renderGrid(),onAlbumBoard:visitor?null:addAlbumToBoard,albumTags:(pkg,item)=>state.options.albumImageTags?.[albumImageKey(pkg,item)]||[],onAlbumTags:(pkg,item,value)=>{if(visitor)return;state.options.albumImageTags={...state.options.albumImageTags,[albumImageKey(pkg,item)]:[...new Set(value.split(/[,，;；]/).map(tag=>tag.trim()).filter(Boolean))].slice(0,40)};persistNow();toast('单图标签已保存');},favorites:()=>state.favorites});
// 资产包/文件都不是 state.models 的成员（那份数据要求 32 位 hex uid），只在绘制层接在网格后面，
// 搜索词与类型筛选跟着资产库工具条走。已有下载任务或已在库里的资产不再从磁盘重复出一张卡。
let cardGroups=null;
function extraCards(){
 if(boardHub?.store.activeId){localFiles.resetAlbumFolder?.();return [];}
 if(state.filter==='trash')return [];
 if(cardGroups?.active())return cardGroups.extras();
 if(state.filter==='favorites')localFiles.resetAlbumFolder?.();
 const query=state.search||'';
 const kind=activeLocalKind();
 // 图标模式选了「文本 / 视频」这类下拉里没有的类型时，kind 是空的 —— 额外卡片得自己再对一次类型，
 // 否则会出现「计数 0 条、卡片却铺满一屏」的割裂（这些卡不属于 state.models，不走 contentKindsOf）。
 const modeKind=state.contentKind||'';
 const formats=formatFilter.matcher();
 // 只让「已经完成下载」的包出卡：排队中/下载中/失败的目录是半成品，磁盘上也已经有下载任务卡了。
 // 例外是图片包：它是边下边写进最终文件夹的（fileExists 一有就有），所以下载中也要出卡。
 const known=new Set([...state.models.map(model=>model.uid),...(state.trashed||[]).map(model=>model.uid),...(downloads?.jobs||[]).filter(job=>job.state!=='saved'&&!job.fileExists).map(job=>job.uid)].filter(Boolean));
 // 目录维度只在本地生效：选中的目录按「包相对根的第一段」比对，空数组 = 不筛。
 const folders=Array.isArray(state.folders)?state.folders:[];
 const inFolders=pkg=>!folders.length||folders.includes(folderOf(pkg.rel));
 const matchingPackages=localFiles.packages()
  .filter(pkg=>!cardGroups||cardGroups.acceptsPackage(pkg))
  .filter(inFolders)
  .filter(pkg=>state.filter!=='favorites'||state.favorites.has(/^[a-f0-9]{32}$/i.test(pkg.uid||'')?pkg.uid:favoriteUid('package',pkg.root+'|'+pkg.rel)))
  .filter(pkg=>!state.localCategory||(isCustomCategory(state.localCategory)?matchesCustomCategory(state.options,pkg,state.localCategory):categoryMatches(localAssetCategories(pkg),state.localCategory)))
  .filter(pkg=>modeAllowsLocalKind(modeKind,'packages',pkg))
  .filter(pkg=>!pkg.uid||!known.has(pkg.uid))
  .filter(pkg=>localFiles.matchesPackage(pkg,{query,kind,formats}))
;
 const expandedImages=matchingPackages.flatMap(pkg=>localFiles.searchPackageImages(pkg,query));
 const expandedPackages=new Set(query?matchingPackages.filter(pkg=>localFiles.searchPackageImages(pkg,query).length).map(pkg=>pkg.root+'|'+pkg.rel):[]);
 const packages=localFiles.organizePackages(matchingPackages.filter(pkg=>!expandedPackages.has(pkg.root+'|'+pkg.rel)),{query}).map(({pkg,folder})=>folder?{key:'folder|'+folder.rel,mtime:folder.addedAt||folder.mtime,name:folder.name,get html(){return localFiles.folderCard(folder);}}:{key:`pkg|${pkg.root}|${pkg.rel}`,mtime:Number(pkg.addedAt||pkg.mtime)||0,name:String(pkg.title||pkg.name||pkg.rel||''),get html(){return localFiles.packageCard(pkg);}});
 packages.push(...expandedImages.map(file=>({key:'image|'+file.root+'|'+file.rel,mtime:Number(file.addedAt||file.mtime)||0,name:file.name,get html(){return localFiles.card(file);}})));
 if(state.filter==='favorites'||localFiles.albumFolderActive()&&!query)return packages;
 const members=localFiles.sequenceMembers();
 const rest=localFiles.entries()
  .filter(file=>!cardGroups||cardGroups.acceptsFile(file))
  // 已折叠成序列的帧不再单独出卡，否则一条 60 帧序列会把整屏占满。
  .filter(file=>!members.has(`${file.root}|${file.rel}`))
  .filter(inFolders)
  .filter(file=>!state.localCategory||(isCustomCategory(state.localCategory)?matchesCustomCategory(state.options,file,state.localCategory):categoryMatches(localAssetCategories(file),state.localCategory)))
  .filter(file=>modeAllowsLocalKind(modeKind,'files',file))
  .filter(file=>localFiles.matches(file,{query,kind,formats}))
  .map(file=>({key:`${file.root}|${file.rel}`,mtime:Number(file.addedAt||file.mtime)||0,name:String(file.name||file.rel||''),get html(){return localFiles.card(file);}}));
 // 序列卡走同一套筛选：拿首帧当代表，格式/类型看的是图片本身。
 const seqCards=localFiles.sequences()
  .map(seq=>({seq,file:{root:seq.root,rel:seq.cover.rel,name:seq.label,ext:seq.ext,kind:'image',bytes:seq.bytes,mtime:seq.mtime}}))
  .filter(({file})=>inFolders(file))
  .filter(({file})=>!state.localCategory||(isCustomCategory(state.localCategory)?matchesCustomCategory(state.options,file,state.localCategory):localAssetCategories(file).includes(state.localCategory)))
  .filter(({file})=>modeAllowsLocalKind(modeKind,'files',file.kind))
  .filter(({file})=>localFiles.matches(file,{query,kind,formats}))
  .map(({seq})=>({key:`seq|${seq.key}`,mtime:Number(seq.addedAt||seq.mtime)||0,name:seq.label,get html(){return localFiles.sequenceCard(seq);}}));
 const localCards=[...rest,...seqCards];
 // 「最近入库」按磁盘更新时间倒序，paintGrid 再把这批本地卡片和模型的 addedAt 按同一条时间线混排；
 // 名称排序时跟着名字走；其余排序保持扫描顺序（追加在模型后面）。
 const order=state.sort==='recent'?(a,b)=>b.mtime-a.mtime:state.sort==='name'?(a,b)=>a.name.localeCompare(b.name,'zh'):null;
 return [...(order?packages.sort(order):packages),...(order?localCards.sort(order):localCards),...(cardGroups?.extras()||[])];
}
/** 远程收藏卡上的「下载原图」：把平台原图抓回本机。
 *  服务端按 uid 找到这张卡所在的目录并原地接管（见 resumeRemoteBoard），
 *  所以下载目录里不会多出一个「(1)」，资产库里也不会同一个画板出两张卡。 */
async function fetchRemoteBoard(pkg,button){
  if(!pkg?.uid||!pkg?.sourceUrl){toast('这张卡没有来源链接，补不了下载；回原站重新粘一次链接即可。');return;}
  if(!downloads?.enqueue){toast('后台服务未连接，无法下载图片。');return;}
  const saved=button?.innerHTML;
  if(button){button.disabled=true;button.innerHTML='正在加入队列…';}
  try{
    const result=await downloads.enqueue([{uid:pkg.uid,platform:pkg.platform,name:pkg.title,author:pkg.author,url:pkg.sourceUrl}],{output:'folder'},false,undefined,'images');
    toast(result.added.length?'已加入图片下载任务，接着补原图（已下好的不会重下）':'这个画板已在队列里或已经下载过');
  }catch(e){toast(e.message);}
  finally{if(button){button.disabled=false;button.innerHTML=saved;}}
  await scanLibraryFiles(true);
}
/** 扫一遍资产库文件夹：下载落盘的资产包 + 用户自己拷进去的素材，只有这条路能看见。 */
async function scanLibraryFiles(manual=false){
 const status=$('#local-file-status');
 // 命令条只放「图标 + 数字」，整句说明进 title —— 一行里塞「磁盘上另有 11 个资产包、2 个零散文件」
 // 会把排序、动作图标全挤到右边变成一堵墙，也是这一轮要求精简掉的长文字。
 const paint=(iconName,text,title='')=>{
  if(!status)return;
  status.hidden=!text;
  status.classList.toggle('is-scanning',iconName==='rotate');
  status.innerHTML=text?`${icon(iconName)}<b>${esc(text)}</b>`:'';
  status.title=title||'';
 };
 if(manual)paint('rotate','扫描中','正在扫描资产库文件夹…');
 try{
  // 导入写入了服务端资产记录，磁盘扫描本身不会更新分页查询的 uid 范围。
  if(manual)await state.onRemoteRefresh?.();
  const result=await localFiles.scan({force:manual});
  if(!result)return;
  if(!visitor&&collectModelFolders(state.options,result.files,state.models))persistNow();
  const count=result.packages.length,loose=result.files.length;
  const total=count+loose;
  paint('archive',total?String(total):'',
   total?`磁盘上另有 ${count} 个资产包${loose?`、${loose} 个零散文件`:''}${result.truncated?'（数量过多已截断）':''}`:'');
  if(state.route!=='discover')renderGrid();
 }catch(error){
  paint('help','失败',`扫描资产库文件夹失败：${error.message}`);
  if(manual)toast?.(`扫描资产库文件夹失败：${error.message}`);
 }
}
// 阶段 3：本地库大批量资产只在绘制层分页，state.models 仍保持全量（写入契约不能裁）。
// 阶段 4：高级检索激活时「加载更多」改走服务端按页取数，回调由 advanced-query.js 挂到 state 上。
const paging=createLibraryPaging({$,state,onMore:()=>renderGrid(),onRemoteMore:()=>state.onRemoteMore?.(),icon});
const libraryScope=()=>boardHub?.store.activeId?'board:'+boardHub.store.activeId:cardGroups?.scope()||(localFiles.albumFolderActive()?'folder:'+localFiles.albumFolderScope():'library');
const view=createLibraryView({libraryScope,activeBoardId:()=>boardHub?.store.activeId,$,icon,esc,fmt,pageRows:rows=>paging.slice(rows,{scope:libraryScope(),local:localFiles.albumFolderActive()&&!state.search&&!boardHub?.store.activeId}),localTags:model=>tagsFor(state,model),localPackages:()=>localFiles.packages(),localEntries:()=>localFiles.entries(),openImageGallery:options=>localFiles.openImageGallery(options),state,onAddCustomCategory:createCustomCategory,onDeleteCustomCategory:deleteCustomCategory,onPickCustomCategory:pickCustomCategory,queuePulse,cardView,composite,filtered,activeModes,galleryActive,categories:CATEGORIES,describeArt:request=>artstation.describe(request),artstationUI:()=>artstation,downloadsUI:()=>downloads,filterTreesUI:()=>filterTrees,mergedFiltersUI:()=>mergedFilters,findModel,sendControl,isVisitor:visitor,imageDownload,gltfPreview,extraCards,toast,openPictureBoard:board=>feed.openPictureBoard(board),openPictureAuthor:(url,platform)=>feed.openPictureAuthor(url,platform),backToPictureBoards:()=>feed.backToPictureBoards(),reloadPictureSite:()=>feed.reloadPictureSite(),openPictureUrl:url=>feed.openPictureUrl(url),refreshAssets:()=>scanLibraryFiles(true),applyLocalType,notifyCategory:label=>assistant.notify({type:'category',label})});
// 画板视图：Artflow 完整应用以 iframe 装载（见 artflow-embed.js）。
// 这里只负责「资产 → 画布」的解析与工具条动作；画布上的选择、框选、吸附、编队、
// 撤销、便签/文字/形状/绘制等全部由 Artflow 自己提供，交互行为与它独立运行时一致。
let boardCanvas=null;
function canvasKindOf(model){
 if(!model)return 'image';
 const platform=String(model.platform||''),type=String(model.assetType||'');
 if(platform==='uiverse')return 'ui';
 if(type==='textures')return 'material';
 if(type==='hdris')return 'hdri';
 if(type==='models'||platform==='sketchfab')return 'model';
 if(isVideoSite(platform)&&type==='videos')return 'video';
 if(/\.(mp4|webm|mov)(\?|$)/i.test(String(model.thumbnail||'')))return 'video';
 return 'image';
}
/** 把 uid 解析成画布要的三件事：图、类型、名字。查不到 = 资产已从库里删掉，返回 null 让卡片显示失效。 */
function resolveCanvasAsset(uid){
 if(!uid)return null;
 if(uid.startsWith('local:')){
  const [root,...rest]=uid.slice(6).split('|');
  const rel=rest.join('|');
  return {src:`/api/local/thumb?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}&w=512`,kind:'image',name:rel.split('/').pop()||'本地文件'};
 }
 // 本地图片序列：封面用首帧缩略图，画布把它当一张图铺进去（序列本身是资产，画板是容器）。
 if(uid.startsWith('seq:')){
  const seq=localFiles.findSequence(uid);
  if(!seq)return null;
  const cover=seq.cover||seq.frames[0];
  if(!cover)return null;
  return {src:`/api/local/thumb?root=${encodeURIComponent(cover.root||seq.root)}&rel=${encodeURIComponent(cover.rel)}&w=512`,kind:'image',name:seq.label||'图片序列'};
 }
 const model=findModel(uid);
 if(!model)return null;
 const raw=model.thumbnail||model.thumb||'';
 return {src:thumbSrc(raw),kind:canvasKindOf(model),name:model.name||model.title||'未命名'};
}
async function enterCanvas(){
 const host=$('#cv-host');
 if(!host)return;
 if(!boardCanvas){
  const {mountArtflow}=await import('./artflow-embed.js');
  boardCanvas=mountArtflow(host,{
   resolve:resolveCanvasAsset,
   onCount:(count)=>{const el=$('#cv-count');if(el)el.textContent=String(count);},
   onStatus:(text)=>{if(text)toast?.(text);},
   onSynced:result=>{
    if(result?.cardGroups)state.options.cardGroups=result.cardGroups;
    boardHub?.store.refresh().catch(()=>{});
   },
   onOpenLibrary:id=>boardHub?.openBoard(id,{force:true,refresh:true}),
  });
  // 暴露给调试与外部脚本。
  window.__avCanvas=boardCanvas;
 }else await boardCanvas.refresh();
}
window.addEventListener('assetvault:open-canvas-board',async event=>{
 await enterCanvas();route('canvas');await boardCanvas?.openBoard(event.detail.id);
});
// 画板动作（铺开 / 整理 / 适应）统一交给画布自己的快捷键，侧边栏不再放动作组。
// 图片包是边下边写的，资产库得跟着磁盘一起长：新任务一露头就强制重扫一次（绕过扫描缓存），
// 第一张图落盘后就能出正式卡。之后进入「稳态轮询」——把频率从每 5 秒降到每 15 秒：
// 单张图落盘晚一二十秒被画廊捕获对用户无感，却能大幅削减后台对全部根目录的持续签名扫描开销
// （rootsSignature 每次都要对所有下载根做 stat + readdir，历史任务越多越亏）。
// 发现页也照扫（只是不重绘），这样切回资产库时 route() 的 renderGrid 用的是最新包索引。
let liveImageKey='';
let downloadedAssetsKey='';
let pollSteady=false;   // 当前这批活动图片任务已稳定（key 不再变）→ 切低频
let pollRunning=false;  // 防止上轮 await 未完成时定时器重入
let pollTimer=null;
function schedulePoll(){
 if(pollTimer)return;
 pollTimer=setTimeout(runPoll,pollSteady?15000:5000);
}
async function runPoll(){
 if(pollRunning){schedulePoll();return;}
 pollRunning=true;pollTimer=null;
 try{
  if(document.hidden)return; // 隐藏页不扫，下一轮照常排期
  const response=await fetch('/api/downloads',{cache:'no-store'});
  if(!response.ok)return;
  const snapshot=await response.json();
  const live=(snapshot.jobs||[]).filter(job=>job.kind==='images'&&!['saved','failed','cancelled','interrupted'].includes(job.state)&&job.fileExists);
  const key=live.map(job=>job.id).join('|');
  if(!key){liveImageKey='';pollSteady=false;return;}
  if(key!==liveImageKey){liveImageKey=key;pollSteady=false;await scanLibraryFiles(true);}
  else {pollSteady=true;await scanLibraryFiles();}
 }catch{}
 finally{pollRunning=false;schedulePoll();}
}
schedulePoll();
const {counts,renderStatus,renderGrid:drawGrid,placeFilters,preview:previewAsset,syncStickyOffset}=view;
// 每次重绘顺带刷新图标轨：新收藏了一条音频 / 文档，对应的 tab 要当场长出来（计数有长度缓存）。
// 每次重绘顺带刷新图标轨：新收藏了一条音频 / 文档，对应的 tab 要当场长出来（计数有长度缓存）。
// syncSelectionUI 在框选装配后填进来：重绘走的是「按 HTML 缓存做增量替换」，卡片 HTML 没变时
// 不会重写 DOM，选中态就只能靠这一次就地同步兜住（否则取消选择后绿框会留在卡上）。
let syncSelectionUI=()=>{};
let libraryVisibility;
const renderGrid=()=>{libraryVisibility?.apply();drawGrid();contentModes?.render();syncSelectionUI();cardGroups?.refresh();};
let toolCheckPanel=null;
if(!visitor){
 const resourceEntry=document.createElement('button');resourceEntry.type='button';resourceEntry.className='nav settings-nav';resourceEntry.title='工具检测：运行占用 + 资产一致性检查';resourceEntry.setAttribute('aria-label','工具检测');resourceEntry.innerHTML=icon('scan')+'工具检测';
 $('#settings-button')?.before(resourceEntry);
 toolCheckPanel=createResourceUsagePanel({entry:resourceEntry,notify:toast,audit:{esc,notify:toast,fmtNumber:value=>Number(value||0).toLocaleString('zh-CN')}});
}
for(const id of ['#preview-dialog','#file-preview-dialog'])setupPreviewSidebarToggle($(id));
const similarAssets=createSimilarAssets({dialog:$('#preview-dialog'),state,
 candidates:()=>[...state.models,...Object.values(state.feeds).flatMap(feed=>feed.rows)],
 imageUrl:model=>cardView.imageUrl(model),onPreview:uid=>preview(uid)});
/** 在资源管理器里定位某个本地文件 / 目录；失败原因原样提示（「文件不存在或已被移动」这类要说得清）。 */
async function revealLocal(root,rel){
 try{await revealLocalPath(root,rel);}
 catch(error){toast(error.message);}
}
async function revealPreviewFolder(model){await revealLocal(model.localRoot,model.localRel);}
function refreshPreviewTags(uid){
 view.refreshArtworkActions(uid);
 if(!$('#preview-dialog').open)return;
 const details=$('#model-details'),model=findModel(uid);if(!model||details.dataset.tagUid!==uid)return;
 const author=details.querySelector('.author-name');if(author)author.innerHTML=authorButton(model);
 details.querySelectorAll('.tag-list,[data-action="ai-tags"],.asset-tags').forEach(node=>node.remove());
 details.insertAdjacentHTML('beforeend',tagPanel(state,model,esc));
 // ponytail: 各平台沿用原有预览内容，仅统一操作区，不复制各平台的详情渲染。
 details.querySelectorAll('.preview-actions,.export-control,.export-toggle,.export-go,[data-action="collect"],[data-action="favorite"],[data-action="download"],[data-action="export-pick"],[data-action="export-go"],[data-action="export-toggle"]').forEach(node=>node.remove());
 const exportControl=sendControl({job:findLocalJob(downloads?.jobs||[],uid),className:'secondary preview-blender',isVisitor:visitor});
 const license=details.querySelector('.detail-license');
 const actionsHtml=previewActions({model,favorite:state.favorites.has(uid),icon,exportControl});
 if(license)license.insertAdjacentHTML('afterend',actionsHtml);else details.insertAdjacentHTML('beforeend',actionsHtml);
 const actions=details.querySelector('.preview-actions');
 if(actions)details.querySelectorAll('.material-format,.material-resolution').forEach(node=>actions.insertAdjacentElement('beforebegin',node));
 const source=details.querySelector('.source-link');if(source)details.append(source);
 compactPreview(details,model);
}
function preview(uid){
 const model=findModel(uid);
 if(model?.albumPackage){const pkg=localFiles.packages().find(p=>p.root===model.albumRoot&&p.rel===model.albumRel)||model.albumPackage;return localFiles.openPackage(pkg);}
 const previewTask=previewAsset(uid);
 if(previewTask?.then)previewTask.then(()=>{if($('#model-details').dataset.tagUid===uid)refreshPreviewTags(uid);}).catch(error=>toast(error.message));
 // Fab 的预览在 view.preview 里已走图片画廊（多图 + 描述 + 下载），这里不再往 3D 详情面板补内容。
 if(model?.platform==='fab')return;
 $('#model-details').dataset.tagUid=uid;
 refreshPreviewTags(uid);
 similarAssets.show(findModel(uid));
}
// 发起检索也有自己的模块（discovery-feed.js）：翻页、关键词、粘贴链接三条入口共用同一段取流逻辑。
const feed=createDiscoveryFeed({$,toast,state,persist,renderGrid,mergeModels,describeArt:request=>artstation.describe(request),activeModes,showsFeed,feedEnabled,adoptPlatform,searchHistoryUI:()=>searchHistory,resolveArtworkLink:url=>resolveArtworkLink(url),routeTo:route,readRequest:mode=>readRequest(mode),clearSearchTimer:()=>clearTimeout(searchTimer),feedError:feedErrorMessage,markQueryActive:()=>{hadQuery=true;}});
const {requestFeed,startSearch:runSearch,submitLink}=feed;
let searchMotionToken=0;
let localSearch,assistant,imageSearch,semanticSearch;
const assistantDownloads=createAssistantDownloads(event=>assistant?.notify(event));
async function startSearch(options){
 if(state.route==='library'){localSearch?.search();return;}
 const token=++searchMotionToken,panel=$('#search-panel');
 updateRelatedTopics($('#asset-query').value.trim());
 panel?.dispatchEvent(new CustomEvent('search-motion-state',{detail:{busy:true}}));
 try{const result=await runSearch(options);if(token===searchMotionToken&&state.route==='discover'){
  const ok=!activeModes().some(mode=>state.feeds[mode]?.error)&&!state.pictureSite?.error;
  panel?.dispatchEvent(new CustomEvent('search-motion-state',{detail:{busy:false,ok}}));
  if(ok&&$('#asset-query').value.trim()&&!state.pictureSite&&!composite().rows.length)assistant?.notify({type:'empty'});
 }return result;}
 catch(error){if(token===searchMotionToken&&state.route==='discover')panel?.dispatchEvent(new CustomEvent('search-motion-state',{detail:{busy:false,ok:false}}));throw error;}
}
function fillIcons(){document.querySelectorAll('[data-icon]').forEach(el=>{el.innerHTML=icon(el.dataset.icon).replace(/^<i>|<\/i>$/g,'');});}

/** 当前平台由哪几个结果流来回答，顺序即展示顺序。 */
function activeModes(){return platformById(state.platform).feeds.filter(feedEnabled);}
/** 网格、状态行与分页都只读这一个视图：链接解析时它是 web 流，否则是当前平台各流的投影。 */
function composite(){
 return combine({sources:state.source==='link'?['web']:activeModes(),feeds:state.feeds});
}
/** 链接解析结果不属于任何平台流，但它同样要能驱动界面刷新。 */
function showsFeed(mode){return mode==='web'||activeModes().includes(mode);}
// 每个在线结果流都要查：ArtStation 结果只存在于 feeds.art，漏掉它会让预览与下载
// 在全平台结果里“点了没反应”（findModel 返回 undefined 后静默 return）。
function findModel(uid){return FEEDS.reduce((hit,mode)=>hit||state.feeds[mode].rows.find(m=>m.uid===uid),null)||state.models.find(m=>m.uid===uid)||similarAssets.find(uid)||downloads?.jobs.findLast(m=>m.uid===uid)||state.tasks.findLast(m=>m.uid===uid)||favoriteTarget(uid)||cardGroups?.findAsset(uid);}

/** 右键菜单的内容：按被右击的卡片类型分别组装。
 *  远端资产卡看卡片上已渲染的三个节点（下载键 / .export-control / .open-folder）来判断
 *  「能不能下载、能不能导出、能不能打开文件夹」——菜单与卡片显示的状态天然一致，
 *  不在这里另判一套（另判迟早会和卡片分叉）。 */
function removalCards(payload){
 const uids=payload.uids?new Set(payload.uids):null;
 const key=payload.root+'|'+payload.rel;
 return [...document.querySelectorAll('#grid .model-card[data-uid],#grid [data-file],#grid [data-package]')].filter(node=>uids?uids.has(node.dataset.uid):payload.uid&&node.dataset.uid===payload.uid||payload.root&&(node.dataset.file===key||node.dataset.package===key));
}
async function removeAssetCard(uid){
 await withRemovalMotion(removalCards({uid}),async()=>{trashModels(state,[uid]);persist();renderGrid();counts();await trashOnServer([uid]);});
 toast('已移入回收站 · 点工具栏的回收站图标可查看并恢复');
}
async function deleteLibraryAsset(payload){
 try{
  await withRemovalMotion(removalCards(payload),async()=>{
  const uid=payload.uid||'';
  const model=uid?findModel(uid)||(state.trashed||[]).find(item=>item.uid===uid):null;
  const response=await fetch('/api/library/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,thumbnail:model?.thumbnail||''})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'删除失败');
  // 没删到任何文件、也没有资产记录可摘：说清楚，别弹「已删除」之后卡片还好好待在那儿。
  if(!data.removed?.length&&!uid)throw Error('这个文件不在可删除的目录里，请手动到文件夹中删除');
  for(const uid of new Set([payload.uid,...(data.removedUids||[])].filter(Boolean))){
   state.models=state.models.filter(item=>item.uid!==uid);
   if(state.trashed)state.trashed=state.trashed.filter(item=>item.uid!==uid);
   state.favorites?.delete(uid);
   state.selected?.delete(uid);
   if(state.userMeta)delete state.userMeta[uid];
   if(state.userTags)delete state.userTags[uid];
   if(state.aiTags)delete state.aiTags[uid];
   persistNow();
  }
  await downloads?.refresh?.();
  await scanLibraryFiles(true);
  renderGrid();
  toast('已删除');
  });
 }catch(error){toast(error.message||'删除失败');}
}
function sendToCanvas(uids){
 // 画布（Artflow iframe）以资产 URL 为图片源铺图，不解码、不内嵌 —— 画布成为资产库的活视图。
 // 当前不在画布路由时画布未挂载，先切过去等 mount 再发。
 const api=window.__avArtflow;
 if(api&&api.addAssets){api.addAssets(uids);toast('已发送到画布');return;}
 route('canvas');
 const start=Date.now();
 const wait=()=>{
  const a=window.__avArtflow;
  if(a&&a.addAssets){a.addAssets(uids);toast('已发送到画布');}
  else if(Date.now()-start<3000)requestAnimationFrame(wait);
  else toast('画布尚未就绪，请稍后重试');
 };
 requestAnimationFrame(wait);
}
// 合集内成员卡的「从合集移出」：只在合集激活且这张卡确实是成员时给入口。
const groupSplitOf=card=>{
 if(!cardGroups?.active())return null;
 const ref=cardGroups.refOf?.(card);
 return ref?()=>cardGroups.split(ref):null;
};
function cardContextItems(card){
 // 资产合集卡：容器级动作（打开 / 解散）；成员拆分走合集内部右键。
 const groupKey=card.dataset.cardGroup;
 if(groupKey){
  const row=cardGroups?.store.find(groupKey);
  if(!row)return null;
  return groupMenuItems({card,row,onDissolve:()=>cardGroups.dissolve(groupKey)});
 }
 // 本地图片序列卡：data-uid 形如 seq:root|dir|prefix|ext，data-sequence 是原始分组键。
 // 序列是资产，画板是容器——右键给「播放 / 加入画板 / 复制路径」，与模型卡同源。
 const seqUid=card.dataset.uid&&card.dataset.uid.startsWith('seq:')?card.dataset.uid:null;
 if(seqUid){
  const seq=localFiles.findSequence(seqUid);
  if(!seq)return null;
  const path=`${seq.dir?seq.dir+'/':''}${seq.prefix}*`;
  return sequenceMenuItems({
   seq,uid:seqUid,notify:toast,
   onOpen:uid=>localFiles.openSequenceByUid(uid),
   onReveal:()=>revealLocal(seq.root,seq.cover?.rel||''),
   onSendToCanvas:sendToCanvas,
   onBoardPicker:state.route==='library'&&!visitor&&boardHub?(uids,options)=>boardHub.pickBoards(uids,options):null,
   onCopyPath:()=>copyText(path).then(ok=>toast(ok?'路径已复制':'复制失败，请手动复制')),
  });
 }
 const uid=card.dataset.uid;
 if(uid){
  // 回收站里的卡片，模型已经不在 state.models 里（挪到 state.trashed），findModel 找不到，
  // 这里补一次查找 —— 否则回收站里的卡片右键会没有菜单。
  const model=findModel(uid)||(state.trashed||[]).find(m=>m.uid===uid);
  if(!model)return null;
  // 「打开下载文件夹」按钮已从卡片收进右键，revealId 直接由任务表算，别再读 DOM 节点。
  const savedJob=(downloads?.jobs||[]).findLast(j=>j.uid===uid&&j.state==='saved'&&j.fileExists!==false&&j.id);
  const revealId=savedJob?.id||'';
  // 右键点在「框选出来的那一批」上时，删除应当整批生效（见下面 onDelete）。
  const multiSel=!!state.selected&&state.selected.size>1&&state.selected.has(uid);
  // 同一张卡在「发现」与「资产库」两种视图下右键菜单功能不同：发现页只给「看 / 抓 / 存进库」，
  // 资产库页才追加本地管理（打开文件夹 / 发送给 / 画板 / 重新定位 / 移除 / 删除）。realm 直接由 route 决定。
  return assetMenuItems({
   card,model,uid,onCustomCategory:!visitor&&state.route==='library'?()=>categorizeAsset(model):null,notify:toast,realm:state.route==='library'?'library':'discover',
   canDownload:!!card.querySelector('[data-action="download"]'),
   revealId,
   canExport:!!card.querySelector('.export-control'),
   favorite:state.favorites.has(uid),
   inLibrary:state.models.some(m=>m.uid===uid),
   isTrash:state.filter==='trash',
   inBoard:!!boardHub?.store.activeId,
   isVisitor:visitor,
   // 右键落在「已框选的一批」里时，删除直接作用于整批：单卡删除在多选场景下
   // 只会删掉鼠标下那一个，其余选中项纹丝不动，用户会以为批量删除坏了。
   onDelete:state.route==='library'&&!visitor?(multiSel
     ?()=>deleteSelectedCards({files:true,rest:true})
     :()=>deleteLibraryAsset({jobId:revealId,uid})):null,
   deleteLabel:multiSel?`删除选中的 ${state.selected.size} 个`:'',
   deleteConfirm:multiSel?`再点一次，删除选中的 ${state.selected.size} 个（有本地文件的连文件一起删）`:'',
   onGroupSplit:groupSplitOf(card),
   onBoardPicker:state.route==='library'&&!visitor&&boardHub?(uids,options)=>boardHub.pickBoards(uids,options):null,
   onSimilar:state.route==='library'&&!visitor&&semanticSearch?uid=>semanticSearch.similar(uid):null,
   onSendToCanvas:sendToCanvas,
   canRelink:state.route==='library'&&state.filter!=='trash'&&!visitor&&model.storageMode==='linked',
   onRelink:()=>openRelinkFile({model,toast,onChanged:()=>scanLibraryFiles(true)}),
   // 只有「重新定位」过的资产在磁盘上有确切路径；其余资产没下载到本机，不给这颗键（点了只会报错）。
   onReveal:model.localRoot&&model.localRel?()=>revealLocal(model.localRoot,model.localRel):null,
  });
 }
 // 图站图片卡：没有 uid，动作全从缩略图的 data-* 和卡片里的按钮来（预览 / 原图 / 作者 / 找相似）。
 // 只在图站结果里成立：本地图片库的卡片结构不同，不能靠「有没有 img[data-url]」去猜。
 if(state.pictureSite&&state.route==='discover'&&card.classList.contains('model-card')){
  const img=card.querySelector('img[data-url],video[data-url]');
  if(img)return pictureMenuItems({card,img,notify:toast,onBookmark:state.pictureSite?.platform==='xiaohongshu'&&state.pictureSite?.mode!=='boards'?()=>view.bookmarkCurrentPicture().catch(error=>toast(error.message)):null});
 }
 // 本地素材包卡：key 是「根目录|相对路径」，回列表里找回对象才能拿到标题与路径。
 const pkgKey=card.dataset.package;
 if(pkgKey){
  const pkg=(localFiles.packages()||[]).find(p=>`${p.root}|${p.rel}`===pkgKey);
  if(!pkg)return null;
  return packageMenuItems({card,pkg,onGroupSplit:groupSplitOf(card),onAlbumBoard:!visitor&&pkg.category==='images'?()=>addAlbumToBoard(pkg):null,onCustomCategory:!visitor?()=>categorizeAsset({...pkg,assetType:pkg.category}):null,notify:toast,canRegister:pkg.type==='folder'&&!pkg.hasMeta,onPackageAction:(key,action)=>localFiles.packageAction(key,action),onReveal:()=>revealLocal(pkg.root,pkg.rel),onDelete:state.route==='library'&&!visitor?()=>deleteLibraryAsset({root:pkg.root,rel:pkg.rel,uid:pkg.uid}):null});
 }
 // 资产库里没登记成任务的文件（用户自己拷进来的素材）。
 const fileKey=card.dataset.file;
 if(fileKey){
  const file=(localFiles.entries()||[]).find(f=>`${f.root}|${f.rel}`===fileKey);
  if(!file)return null;
  return fileMenuItems({card,file,onGroupSplit:groupSplitOf(card),onCustomCategory:!visitor?()=>categorizeAsset({...file,assetType:file.kind}):null,notify:toast,onReveal:()=>revealLocal(file.root,file.rel),onDelete:state.route==='library'&&!visitor?()=>deleteLibraryAsset({root:file.root,rel:file.rel}):null});
 }
 return null;
}

async function addAlbumToBoard(pkg,items,targetBoard){
 if(visitor||!boardHub)return;
 const selected=items||localFiles.packageImages?.(pkg)||[];
 if(!selected.length){toast('图集内没有可加入的图片');return;}
 toast(items?`正在准备 ${selected.length} 张图片的画板引用…`:'正在加入完整图集…');
 const existing=new Set(state.models.map(model=>model.uid));
 const assets=items?await prepareAlbumBoard(pkg,selected):[await prepareAlbumReference(pkg)];
 const merged=collectModels(state.models,assets);state.models=merged.models;
 if(items)state.options.albumMemberUids=[...new Set([...(state.options.albumMemberUids||[]),...assets.filter(asset=>!existing.has(asset.uid)).map(asset=>asset.uid)])];
 persistNow();
 if(targetBoard){await boardHub.api.boardItems(targetBoard,assets.map(asset=>asset.uid),'add');
  if(!items){const old=legacyAlbumMembers(pkg,state.models,state.options.albumMemberUids);if(old.length)await boardHub.api.boardItems(targetBoard,old,'remove');}
  toast(items?`已把 ${assets.length} 张图片加入画板`:'已将完整图集加入画板');await boardHub.store.refresh();}
 else await boardHub.pickBoards(assets.map(asset=>asset.uid),{mode:'add'});
 renderGrid();
}
function filtered(){
 if(cardGroups?.active())return cardGroups.models().filter(model=>!state.search||String(model.name||'').toLowerCase().includes(state.search.toLowerCase()));
 if(state.route==='discover'){
  const rows=composite().rows;
  if(state.platform===ALL&&$('#unified-sort').value==='name')return [...rows].sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'zh'));
  return rows;
 }
  // 高级检索（阶段 2）：面板把命中 uid 集合写进 state.queryUids，这里只做一次集合过滤，
  // 排序 / 卡片渲染 / 右键菜单仍全部沿用原来的路径，不需要第二套渲染逻辑。
  const restrict=rows=>{
   if(!boardHub?.store.activeId&&state.route==='library'&&cardGroups)rows=rows.filter(model=>cardGroups.acceptsModel(model));
   if(!boardHub?.store.activeId)rows=rows.filter(model=>!model.albumPackage);
   if(state.route==='library'&&state.filter==='all'&&!boardHub?.store.activeId&&localFiles.albumFolderActive()&&!state.search)return [];
   if(!boardHub?.store.activeId&&state.route==='library'&&!state.search){const members=new Set(state.options.albumMemberUids||[]);rows=rows.filter(model=>!members.has(model.uid));}
   if(!state.queryUids)return rows;
   const hit=rows.filter(m=>state.queryUids.has(m.uid));
   if(!state.queryOrder)return hit;
   // 阶段 3：服务端返回的 uids 已按所选排序排好（含合集手动顺序），网格据此显示。
   const rank=new Map(state.queryOrder.map((uid,index)=>[uid,index]));
   return hit.sort((a,b)=>(rank.get(a.uid)??Infinity)-(rank.get(b.uid)??Infinity));
  };
  // 语义模式（ADR-15）：命中集合来自向量，关键词再筛一遍会把「能骑的坐骑」这类
  // 不含资产名字面的查询全部清掉 —— 所以此时关键词让位，只保留分类 / 类型 / 状态这些
  // 用户显式点出来的筛选维度。
  const keyword=state.semanticMode?'':state.search;
  // 回收站：走 state.trashed 而不是 models。userTags 已随记录搬进 trashed 里，搜索要拼回去。
  if(state.filter==='trash'){
   const trashed=(state.trashed||[]).filter(model=>!state.contentKind||contentMatchesKind(model,state.contentKind)).map(m=>({...m,tags:mergeTags(m.tags||[],m.userTags||[])}));
   return restrict(filterLocalAssets(trashed.filter(m=>matchesCustomCategory(state.options,m,state.localCategory)),{kind:activeLocalKind(),category:isCustomCategory(state.localCategory)?'':state.localCategory||'',search:keyword,english:state.searchEnglish||'',imageTerms:state.imageTerms||[]},null));
  }
 let models=state.models.filter(m=>matchesCustomCategory(state.options,m,state.localCategory)).filter(m=>state.filter!=='favorites'||state.favorites.has(m.uid));
 // 顶部模式轨选中的类型（文本 / 视频这类没有 #local-kind 选项的走这里）。
 if(state.contentKind)models=models.filter(model=>contentMatchesKind(model,state.contentKind));
 if(state.filter==='downloadable')models=models.filter(m=>m.downloadable);if(state.filter==='animated')models=models.filter(m=>m.animations>0);
 models=filterLocalAssets(models.map(m=>({...m,tags:tagsFor(state,m)})),{kind:activeLocalKind(),category:isCustomCategory(state.localCategory)?'':state.localCategory||'',status:$('#local-status').value,search:keyword,english:state.searchEnglish||'',imageTerms:state.imageTerms||[]},downloads?.connected?downloads.jobs:null);
 const byRating=(a,b)=>userMetaFor(state,b.uid).rating-userMetaFor(state,a.uid).rating||(b.addedAt||0)-(a.addedAt||0);
 // 图搜结果按关键词命中权重排，用户选的排序方式让位给相似度。
 if(state.imageTerms&&state.imageTerms.length)return restrict([...models].sort((a,b)=>(b._imgHits||0)-(a._imgHits||0)||(b.addedAt||0)-(a.addedAt||0)));
 return restrict([...models].sort(state.sort==='popular'?(a,b)=>b.likes-a.likes:state.sort==='name'?(a,b)=>a.name.localeCompare(b.name):state.sort==='rating'?byRating:(a,b)=>(b.addedAt||0)-(a.addedAt||0)));
}

/** 点浮层里任一推荐词（今日主题 / 相近词 / AI 拆出来的词）：等同用户手输后回车，记进最近检索。 */
function pickTerm(term){
 $('#asset-query').value=term;refreshTopicStrip();startSearch({record:true});
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
// 所以要赶在隐藏之前读一次内部滚动区的位置 存起来，回来时再放回去。
const pageScroller=()=>document.getElementById('app-scroll')||document.scrollingElement;
const routeScroll=new Map();
const routeQueries=new Map();
let routeScrollFrame=0;
function cancelRouteScroll(){cancelAnimationFrame(routeScrollFrame);routeScrollFrame=0;}
window.addEventListener('wheel',cancelRouteScroll,{passive:true});
window.addEventListener('touchstart',cancelRouteScroll,{passive:true});
function restoreRouteScroll(top){
 // 两帧：第一帧让这次的显隐与重绘落盘，第二帧页面高度已经稳定，再放回去。
 // 高度不够时 scrollTo 自己会夹住，不需要另外算（比如下载页刚开始还没内容）。
 cancelRouteScroll();
 routeScrollFrame=requestAnimationFrame(()=>{routeScrollFrame=requestAnimationFrame(()=>{routeScrollFrame=0;pageScroller().scrollTo({top:Math.max(0,top),behavior:'instant'});});});
}
function route(name){
 if(name==='favorites'){name='library';state.filter='favorites';$('#local-feature').value='favorites';}
 // 先读、后动显隐：这一读拿到的还是切走前用户看到的位置。
 const leaving=state.route;
 if(leaving!==name){
  searchMotionToken++;
  $('#search-panel').dispatchEvent(new CustomEvent('search-motion-state',{detail:{reset:true,busy:false}}));
  routeQueries.set(leaving,$('#asset-query').value);
  $('#asset-query').value=routeQueries.get(name)||'';
  if(leaving==='library')localSearch?.reset();
  imageSearch?.reset();
  $('#theme-results').hidden=true;
 }
 if(leaving&&leaving!==name)routeScroll.set(leaving,pageScroller().scrollTop);
 state.route=name;state.selected.clear();
 document.body.dataset.route=name;
 // 下载页没有卡片布局；回到发现页或资产库时恢复各自的持久偏好。
 // 图站结果不在这里丢掉：切去下载页 / 资产库再切回来，要直接回到刚才那屏（缓存命中，不重新抓）。
 if(name==='downloads')state.gallery=false;
 // 资产库默认瀑布流：本地图片长宽比各异，按原比例排比裁成统一方格更可看（见 displayFor）。
 if(name==='library'||name==='discover')state.gallery=displayFor(name)==='gallery';
 if(name!=='discover')searchHistory?.close();
  document.querySelectorAll('aside nav button[data-route]').forEach(b=>b.classList.toggle('active',b.dataset.route===name));
  // 选中项配一条会滑动的强调条：和平台模块 Tab 同一套手感，跟着高亮项上下移动。
  const navIndicator=document.querySelector('#sidebar nav .nav-indicator');
  if(navIndicator){const navActive=document.querySelector('#sidebar nav button[data-route].active');if(navActive&&navActive.offsetHeight){navIndicator.style.top=`${navActive.offsetTop}px`;navIndicator.style.height=`${navActive.offsetHeight}px`;navIndicator.classList.add('on');}}
 // 顶部面包屑（工作空间 / 当前页）已按用户要求撤掉：侧边栏的高亮项本身就说明了在哪一页。
$('#library-view').hidden=name==='downloads'||name==='canvas';
$('#canvas-view').hidden=name!=='canvas';
// 侧边栏不再有画板动作组，进画板只需要把 iframe 拉起来。
if(name==='canvas')enterCanvas();
$('#downloads-view').hidden=name!=='downloads';$('#search-panel').hidden=name==='downloads'||name==='canvas';
 // 模式是显式主状态：在资产库里点了「文本 / 视频」再切回发现页时，平台要跟着回到对应来源。
 // 不纠正就会出现「高亮说文本、下拉说 Sketchfab」——一按搜索还真去搜模型，等于模式被悄悄冲掉。
 if(name==='discover'&&state.mode){
  const preset=modePresetById(state.mode);
  if(preset?.linkOnly&&state.platform!=='link'){
   state.platform='link';state.source='search';renderPlatform();
  }else if(preset?.platformKind==='video'&&!isVideoSite(state.platform)){
   state.platform=preset.defaultPlatform||ALL;state.source='search';renderPlatform();
  }
 }
 $('#asset-query').placeholder=name==='library'?'搜索本地资产名称、作者、标签…':platformById(state.platform).placeholder;
 // 语义搜索开启时占位文案与按钮高亮都跟着路由变：切到发现页它不生效，样子就不该像开着。
 semanticSearch?.repaint?.();
 $('#asset-query').setAttribute('aria-label',name==='library'?'搜索本地资产':'搜索在线资产');
 $('#search-button').innerHTML=`${icon('search')} ${name==='library'?'搜索资产库':'搜索 / 解析'}`;
 $('#search-clear').hidden=!$('#asset-query').value;
 $('#search-clear').classList.toggle('visible',!!$('#asset-query').value);
 $('#search-panel').classList.toggle('has-search-text',!!$('#asset-query').value);
 refreshTopicStrip();
 if(name==='downloads'){downloads?.render();downloads?.refresh();}
 else if(name==='library'&&leaving!==name&&localSearch)localSearch.search();
 else if(name!=='canvas')renderGrid();
 renderStatus();counts();
 // 只在真的换页时恢复：首次进入（leaving 与 name 相同）保持浏览器自己的行为，
 // 否则每次刷新页面都会被强制拉回顶部。
 if(leaving&&leaving!==name)restoreRouteScroll(routeScroll.get(name)||0);
}
/** 平台决定「谁来回答」：标签文案、推荐词、筛选行全部由注册表驱动，不在这里分支。 */
/**
 * 只重建平台下拉的选项池。选项按当前内容模式给：模型模式只列 3D 平台，
 * 图片模式只列能出图的平台 + 各图站。
 *
 * 单独拆出来是因为「模式」也会在平台不变的情况下切换（已经在 A 站时点图片模式、
 * 或者手动切瀑布流视图），这时候 setPlatform 直接 return，不重建池子就会留着一份
 * 全量 3D 平台的旧选项 —— 看上去就像模式按钮没生效。
 */
function renderPlatformOptions(){
 const select=$('#search-platform');
 const current=platformById(state.platform);
 const preset=modePresetById(state.mode);
 // 模式是主状态：点「模型」下拉只列 3D 平台，点「图片」只列图站与能出图的平台，
 // 没激活模式就列全量。文本 / 视频没有在线采集源，给一枚本地占位，不假装能切站。
 const localOnly=!!preset?.localOnly;
 // linkOnly（文本 / 视频）已经不是「本地资产库」那一面了：platformPoolFor 会给它「链接解析」一枚，
 // 所以「本地资产库」占位只留给真正没有在线面的模式。
 const pool=preset?.linkOnly
  ? platformPoolFor(preset,{enabled:platformEnabled})
  : localOnly
   ? [{id:'library',label:'本地资产库',hint:'本地文档 / 视频资产，暂无在线采集平台'}]
   : platformPoolFor(preset,{enabled:platformEnabled});
 // 粘链接识别出来的平台可能不在当前模式的池子里（比如模型模式下粘了 Pixiv 的作品页）：
 // 补进池子，否则 select.value 落空，左边会显示成第一项，和真正解析它的平台对不上。
 if(!localOnly&&current.id!==ALL&&!pool.some(item=>item.id===current.id))pool.splice(Math.min(1,pool.length),0,current);
 const visible=pool.filter(item=>item.id===ALL||item.id==='library'||platformEnabled(item.id));
 // 置顶：全部平台永远打头且不参与置顶；当前选中的平台紧随其后（未选中即回原位）；其余按 platformPins 排前。
 const ordered=sortByPins(visible,platformPins,ALL,current.id);
 select.dataset.pinnable='true';
 select.dataset.pinExclude=ALL;
 // 登录图标：只有登记过登录入口的平台才带 data-login（后端 PICTURE_LOGIN_URLS 是权威名单），
 // 其余平台这一项不渲染图标，免登录的站不会多出一枚点不动的键。
 select.dataset.loginable='true';
 select.innerHTML=ordered.map(item=>`<option value="${item.id}"${item.hint?` data-hint="${esc(item.hint)}"`:''}${platformPins.includes(item.id)?' data-pinned="true"':''}${platformLoginSites.has(item.id)?` data-login="${platformLogins[item.id]||'none'}"`:''}>${esc(item.label)}</option>`).join('');
 select.value=pool.some(item=>item.id===current.id)?current.id:(pool[0]?.id||'');
}
function renderPlatform(){
 const platform=platformById(state.platform);
 renderPlatformOptions();
 $('#asset-query').placeholder=state.route==='library'?'搜索本地资产名称、作者、标签…':platform.placeholder;
 $('#filters-all').textContent=platform.note||'';
 renderFilters(platform);
 const all=state.platform===ALL;
 $('#unified-kind-wrap').hidden=!all;
 $('#unified-sort-wrap').hidden=!all;
 contentModes?.render();                              // 平台变了，两个模式按键的高亮跟着走
}
/** 只把「当前平台」拨到某站并重绘平台区：不取消在跑的检索、不跳页、不自动发请求。
 *  粘链接识别与图站解析都用它，保证左侧下拉永远和真正处理这个链接的平台一致。 */
function adoptPlatform(id){
 const next=platformById(id).id;
 if(!next||next===ALL||next===state.platform)return;
 // 文本 / 视频（链接解析）不认站：粘任何链接都留在这一面。
 // 拨到 Sketchfab 只会让下拉与状态行谎报「这个链接归 Sketchfab 管」，也把人从视频 / 文档那一面拽走。
 if(state.platform==='link')return;
 if(!platformEnabled(next))return;                    // 关掉的平台别拨过去，拨了也只有空结果
 state.platform=next;
 rememberPlatform(next);
 if(isPictureSite(next))state.modelOnly=false;         // 图站没有关键词检索流，别留着「只要 3D」的残留状态
 renderPlatform();
}
/** 粘贴链接时把左侧平台下拉拨到对应站点。
 *  识别用的是 routeLink —— 和「粘链接直接解析」同一份规则，所以下拉显示的平台与真正处理
 *  这个链接的平台永远一致。只拨下拉，不触发检索、不跳页，用户仍按回车或「搜索 / 解析」决定下一步。 */
function syncPlatformFromLink(raw){
 if(state.route!=='discover')return;
 const value=String(raw||'').trim();
 if(!/^https?:\/\//i.test(value))return;
 const route=routeLink(value);
 if(!route||route.error)return;
 // Sketchfab 的模型页 / 作者页在 routeLink 里写作 platform:'web'（页面解析），显示上归 Sketchfab。
 adoptPlatform(route.platform==='web'?'sketchfab':route.platform);
}
/** 筛选区显隐（R6）：全部平台下只留那一棵统一树——两棵平台树与「全部平台」说明行一起收起，
 *  模型模式是全部平台的一个子集，走同一条分支。单平台照旧按注册表清单显隐自己那一棵
 *  （保留精细回退：想在单个平台上按它自己的分类体系筛，切过去就有）。 */
function renderFilters(platform){
 const unified=state.platform===ALL;
 $('#filters-merged').hidden=!unified;
 if(unified){
  // 必须用 '#id'：FILTER_ROWS 存的是裸 id，$ 是 querySelector，传裸 id 会被当成标签名返回 null，
  // 在「全部平台」分支里直接抛 "Cannot set properties of null (setting 'hidden')"，整个界面初始化失败。
  for(const row of FILTER_ROWS){const node=$('#'+row);if(node)node.hidden=row!=='filters-merged';}
  const allNote=$('#filters-all');if(allNote)allNote.hidden=true;
  mergedFilters?.refresh();
  return;
 }
 const filterRows=Array.isArray(platform.filters)?platform.filters:platform.filters?[platform.filters]:[];
 mergedFilters?.release();                         // R5：离开全部平台，把类型 / 艺术家插回 #filters-artstation
 // 平台自己的筛选行：按注册表逐行显隐，不为每个平台手写一条赋值 ——
 // 加平台时只要在 platforms.js 写好 filters 字段，这里不用回来改。
 for(const row of FILTER_ROWS){const node=$('#'+row);if(node)node.hidden=!filterRows.includes(row);}
 $('#filters-all').hidden=filterRows.length>0;
 const empty=$('#filters-platform-empty');
 if(empty){
  empty.hidden=filterRows.length>0;
  empty.textContent=filterRows.length?'':((platform.id==='500px'||platform.id==='flickr')
   ?''   // 分类控件已由 library-view 注入到本抽屉（#filters-picture-cats），不要再叠一句提示
   :platform.picture
   ?`${platform.label} 暂未接入原站分类筛选。可在上方粘贴作品页、作者页或标签页链接浏览。`
   :`${platform.label} 暂无可用的平台分类筛选。`);
 }
}
/** 切平台只重搜「还没被检索过的」源；已经有结果的源直接复用，避免每次切换都闪一下。 */
function setPlatform(id,{autostart=true}={}){
 if(id!==ALL&&!platformEnabled(id)){toast('该平台已关闭，请在设置 → 平台模块中开启');return;}
 const next=platformById(id).id;
 if(next===state.platform)return;
 // 取消是异步的：busy 要等那次请求的 finally 才回落，而下面「哪个源还没有结果」的判断
 // 就在同一个 tick 里跑。不在这里立刻清掉 busy，刚被取消的源会被当成还在跑，于是这次切换
 // 一个检索都不发，界面停在「已停止检索」加一张空网格。
 activeModes().forEach(mode=>{const f=state.feeds[mode];if(f.controller){f.controller.abort();f.busy=false;}});
 state.platform=next;state.source='search';state.selected.clear();state.pictureSite=null;
 rememberPlatform(next);
 // modelOnly 由当前模式决定：手动在下拉里换站只是模式内的子选择，不该把模式冲掉。
 state.modelOnly=!!modePresetById(state.mode)?.modelOnly;
 // 所有平台共用发现页展示偏好，与内容类别无关。
 state.gallery=displayFor('discover')==='gallery';
 renderPlatform();
 if(state.route!=='discover')route('discover');else renderGrid();
 // 图站没有关键词检索流：切过去先拉一屏首页推荐，结果区直接有图可看，
 // 而不是一块「请把链接粘到上方搜索框」的说明书（用户 2026-11-03 反馈）。
 if(autostart&&isPictureSite(next))return feed.openPictureHome?.(next);
 if(autostart)return Promise.all(activeModes().map(mode=>requestFeed(mode,readRequest(mode),{reuse:true})));
}
/** A 站的「类型」随模式走：模型模式锁 Marmoset（可转 3D），图片模式放开全部作品图。
 *  退出模式时还原进入前的选择，别把用户自己调的筛选吃掉。 */
let artTypeBeforeModel='';
function setArtTypeForMode(preset){
 const node=$('#art-type');if(!node)return;
 if(preset?.modelOnly){
  if(node.value!=='marmoset'){artTypeBeforeModel=node.value||'';node.value='marmoset';}
 }else if(artTypeBeforeModel){node.value=artTypeBeforeModel;artTypeBeforeModel='';}
 if(preset?.id==='images')node.value='';
}
/** 模式的本地类型落到资产库页：#local-kind 有的类型交给下拉（权威），
 *  下拉里没有的（文本 / 视频）才走 state.contentKind + contentKindsOf，避免两套判定打架。 */
function applyLocalKind(preset){
 state.contentKind=preset?.groupId||preset?.localKind||'';
 state.libraryMode='';
 const select=$('#local-kind');if(select)select.value='';
}
/** 展示区立刻换数据源：图站拉首页推荐图，3D 平台用当前关键词（空词＝公开资产）重搜。
 *  startSearch 会 resetDiscoveryFeeds 清掉上一模式的结果流，不会残留别种类型的卡片。 */
function loadModeResults(target){
 if(isPictureSite(target)){renderGrid();return feed.openPictureHome?.(target);}
 return startSearch();
}
/** 顶部模式轨的落点：一个图标 = 平台下拉池 + 默认站点 + 结果流 + 本地类型，整套一起切。
 *  模式是显式主状态，手动在下拉里换站只是模式内的子选择，不会再偷偷退出模式。
 *
 *  但在「资产库」页里，图标只筛本地资产类型：那里没有在线结果流可换，
 *  跳去发现页等于把用户从他正在整理的这一库文件里踢走 —— 原地重画网格即可。 */
function applyModeTab(entry){
 const preset=modePresetById(entry?.id);
 if(!preset)return;
 state.mode=preset.id;rememberMode(preset.id);
 state.localCategory='';
 // 切换要有回执：侧边栏筛选会弹小猫气泡，这排图标以前静默切换，同一动作两种待遇（2026-11-14 用户反馈）。
 assistant.notify({type:'mode',label:preset.label,route:state.route});
 state.selected.clear();
 if(state.route==='library'){
  // 分类图标只决定「看哪一类资产」，不该连带改卡片的展示方式：网格 / 瀑布流由用户自己选、
  // 记在 displayFor('library') 里。以前这里把 gallery 清成 false，点一下分类瀑布流就被打回网格（2026-11-14 用户反馈）。
  state.modelOnly=false;state.pictureSite=null;
  state.gallery=galleryAvailable(state)&&displayFor('library')==='gallery';
  applyLocalKind(preset);                             // 类型落到 #local-kind（或 state.contentKind）
  renderGrid();persist();
  return;
 }
 state.modelOnly=!!preset.modelOnly;
 /** 文本 / 视频：留在发现页，不把人踢去资产库（2026-11-12 用户反馈）。
  *  这一模式没有可搜关键词的在线源，平台换成「链接解析」：粘视频页 / 文档页 / 直链就出卡片。
  *  关键词框里的旧词要清掉 —— 它不认关键词，留着只会让人以为「搜了却没结果」。 */
 if(preset.linkOnly){
  state.gallery=displayFor('discover')==='gallery';state.pictureSite=null;
  resetDiscoveryFeeds(state);                         // 上一模式的卡片不能留在「链接解析」这一面
  applyLocalKind(preset);                             // 资产库那一面仍按类型筛，切回库时生效
  $('#asset-query').value='';
  $('#search-clear').hidden=true;$('#search-clear').classList.remove('visible');
  $('#search-panel').classList.remove('has-search-text');
  // autostart:false：链接解析没有「先搜一屏」这回事，等用户粘东西。
  setPlatform('link',{autostart:false});
  // setPlatform 在已经是 link 时会早退，这两步不能省：模式高亮与空状态都得跟着换。
  if(state.route!=='discover')route('discover');
  renderPlatform();renderGrid();persist();
  return;
 }
 // UI 平台进来就是看首页元素流：关键词残留会让它拿一个 Uiverse 压根没有的词去搜，结果只剩一张空网格。
 if(preset.platformKind==='ui'&&$('#asset-query').value){
  $('#asset-query').value='';
  $('#search-clear').hidden=true;$('#search-clear').classList.remove('visible');
  $('#search-panel').classList.remove('has-search-text');
 }
 setArtTypeForMode(preset);
 applyLocalKind(preset);
 state.pictureSite=null;
 const pool=platformPoolFor(preset,{enabled:platformEnabled});
 const target=pickModePlatform(preset,state.modePlatforms[preset.id],pool);
 state.modePlatforms[preset.id]=target;
 rememberModePlatform(storage,preset.id,target);
 if(state.route!=='discover')route('discover');
 // autostart:false：setPlatform 只拨平台，统一由 loadModeResults 发一次请求，避免重复检索。
 if(target!==state.platform)setPlatform(target,{autostart:false});
 else state.gallery=displayFor('discover')==='gallery';
 renderPlatform();                                   // 重建下拉池 + 筛选行 + 图标高亮
 loadModeResults(target);                            // 展示区立即换成该模式的卡片
 persist();
}
/** 再点当前图标 / Esc：回到无模式，下拉恢复全量池，展示区按当前平台重新取流。
 *  资产库页只清本地类型筛选，不碰在线平台池与结果流。 */
function exitContentMode(){
 state.mode='';rememberMode('');
 assistant.notify({type:'mode',text:state.route==='library'?'已回到全部资产':'已回到全部模式'});
 state.modelOnly=false;state.libraryMode='';state.contentKind='';
 const kind=$('#local-kind');if(kind)kind.value='';
 if(artTypeBeforeModel){const node=$('#art-type');if(node)node.value=artTypeBeforeModel;artTypeBeforeModel='';}
 if(state.route==='library'){renderGrid();persist();return;}
 state.pictureSite=null;state.gallery=displayFor('discover')==='gallery';
 // 「链接解析」不是真平台、视频站也不在全量池里：退出模式要回到全量平台，
 // 否则下拉停在「只有视频模式才有意义」的站上，而它 feeds 为空，关键词检索连一路流都发不出去。
 if(state.platform==='link'||isVideoSite(state.platform)){state.platform=ALL;state.source='search';rememberPlatform(ALL);resetDiscoveryFeeds(state);}
 renderPlatform();
 if(state.route==='discover')startSearch();else renderGrid();
 persist();
}
/** Mother rows use the same action as the top bar; child rows retain an exact type filter. */
async function createCustomCategory(parent){
 if(visitor)return;
 const label=await askText({title:`${categoryParentLabel(parent)} · 新增子类`,placeholder:'输入子类名称',maxLength:40,confirmText:'创建'});
 if(label===null)return;
 try{addCustomCategory(state.options,parent,label);persistNow();renderGrid();toast('已创建子类，可在资产标签面板或右键菜单中归类');}catch(error){toast(error.message);}
}
async function deleteCustomCategory(id){
 if(visitor)return;
 const row=customCategories(state.options).find(row=>row.id===id);if(!row)return;
 if(!await askConfirm({title:'删除自定义分类',message:`删除「${row.label}」？只移除分类和归属，资产会保留在原大类中。`,confirmText:'删除分类',danger:true}))return;
 removeCustomCategory(state.options,id);
 if(state.localCategory===customCategoryValue(id))state.localCategory='';
 persistNow();renderGrid();toast('分类已删除，资产已保留');
}
function pickCustomCategory(id,parent){
 const value=customCategoryValue(id),toggle=state.localCategory===value;
 const group=MODE_PRESETS.find(preset=>preset.groupId===parent);
 if(group&&state.mode===group.id){state.contentKind=parent;const select=$('#local-kind');if(select)select.value='';}
 else applyLocalType(parent);
 state.localCategory=toggle?'':value;state.selected.clear();persist();renderGrid();
}
async function categorizeAsset(model){
 const choices=categoriesForAsset(state.options,model);
 if(!choices.length){toast('请先点击侧栏分类旁的＋创建子类');return;}
 const selected=await askChoice({title:'归入自定义子类',choices:[{value:'',label:'不指定子类'},...choices.map(row=>({value:row.id,label:`${categoryParentLabel(row.parent)} / ${row.label}${customCategoryOf(state.options,model)===row.id?' ✓':''}`}))]});
 if(selected===null)return;
 assignCustomCategory(state.options,model,selected);persistNow();renderGrid();
 if(activeTagUid===model.uid){renderTagDialog(model.uid);refreshPreviewTags(model.uid);}
}
function applyLocalType(typeId){
 const id=String(typeId||'');
 if(!id){exitContentMode();return;}
 const group=MODE_PRESETS.find(preset=>preset.groupId===id);
 if(group){applyModeTab({id:group.id});return;}
 const owner=MODE_PRESETS.find(preset=>preset.localKinds.includes(id));
 state.mode=owner?.id||'';rememberMode(state.mode);
 state.modelOnly=false;state.libraryMode='';state.localCategory='';
 state.contentKind=id;
 const select=$('#local-kind');
 if(select){const has=[...select.options].some(option=>option.value===id);select.value=has?id:'';}
 assistant.notify({type:'mode',label:kindById(id)?.label||'',route:state.route});
 state.selected.clear();
 if(state.route==='library'){renderGrid();persist();return;}
 renderPlatform();renderGrid();persist();
}
/** R1：统一树的组头一键筛选把整组的 slug 串写进隐藏容器（多值），它非空时优先于单值叶子。 */
function readCategory(){
 if(state.platform===ALL)return feedPlan({group:$('#online-category-group').value,leaf:$('#unified-category').value})?.sketchfab?.category||'';
 return $('#online-category').value;
}
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
  const plan=state.platform===ALL?feedPlan({group:$('#online-category-group').value,leaf:$('#unified-category').value}):null;
  const baseQ=$('#asset-query').value.trim();
  const refuse=(type,reason)=>{if(picked.length&&!kindAllows(picked,mode,type)){skipFeed(mode,reason||'当前范围不包含这个资产类型');return true;}return false;};
  // Polyfork 没有「题材映射表」这一层：它的 9 个 class 与统一树的题材不是一回事，
  // 所以「全部平台」下就按同一个关键词原样搜，不走 plan 的分类对齐。
  if(mode==='simready'){if(refuse())return null;return {q:baseQ.slice(0,200)};}
  if(mode==='polyfork')return {q:baseQ.slice(0,200),assetClass:'',sort:''};
  // Fab：默认只看免费（is_free 需配合 sort_by 才生效），用户可在筛选里取消「仅免费」看全部。
  if(mode==='fab')return {q:baseQ.slice(0,200),free:$('#fab-free')?$('#fab-free').checked:true,sortBy:$('#fab-sort')?.value||'-createdAt'};
  // UI 元素：类型与主题是站点自己的维度（按钮 / 加载动画 / 开关…，浅色 / 深色），
  // 与 3D 资产的统一题材树不是一回事，所以不走 plan 的分类对齐，按站点语义原样传。
  if(mode==='uiverse')return {q:baseQ.slice(0,200),type:$('#uiverse-type')?.value||'',theme:$('#uiverse-theme')?.value||''};
  if(plan){
   const target=mode==='search'?plan.sketchfab:mode==='art'?plan.art:plan[mode];
   if(!target){skipFeed(mode,'这个题材在该站没有对应分类');return null;}
   if(refuse(target.type))return null;
   if(mode==='search'){const request=readSearch();request.category=target.category;return request;}
   if(mode==='art'){const request=artstation.read();request.category=target.category;return request;}
   if(mode==='polyhaven')return {q:joinQuery(baseQ,target.q),type:target.type,category:target.category||''};
   if(mode==='ambientcg')return {q:joinQuery(baseQ,target.q),category:'',type:kindType(picked,'ambientcg')||(plan.polyhaven?.type==='hdris'?'hdri,hdri-element':'material')};
   if(mode==='freestylized')return {q:joinQuery(baseQ,target.q),type:target.type,category:'',sort:$('#online-sort').value};
   if(mode==='polypizza')return {q:joinQuery(baseQ,target.q),cc0:$('#polypizza-cc0').checked};
   if(mode==='kenney')return {q:joinQuery(baseQ,target.q),category:'',series:''};
  }
  if(picked.length&&refuse(mode==='polyhaven'?kindType(picked,'polyhaven')||'models':mode==='freestylized'?kindType(picked,'freestylized'):undefined))return null;
  if(mode==='ambientcg')return {...ambientcgUI.read(),...(state.platform===ALL?{type:kindType(picked,'ambientcg')||'material,substance,hdri,hdri-element,3d-model,terrain'}:{})};
  if(mode==='polyhaven'){
   const type=kindType(picked,'polyhaven');
   if(picked.length&&!type){skipFeed(mode,'模型和材质、HDRI 请分开选范围');return null;}
   return type?{q:baseQ.slice(0,200),type,category:''}:polyhavenUI.read();
  }
  if(mode==='polypizza')return {q:baseQ.slice(0,200),cc0:$('#polypizza-cc0').checked};
  if(mode==='kenney')return kenneyUI.read();
  if(mode==='polyfork')return polyforkUI.read();
  if(mode==='freestylized'){
   const type=kindType(picked,'freestylized');
   if(picked.length&&!type){skipFeed(mode,'不同资产类型请分开选范围');return null;}
   return type?{q:baseQ.slice(0,200),type,category:'',sort:$('#online-sort').value}:freestylizedUI.read();
  }
  const request=mode==='art'?artstation.read():readSearch();
  if(mode==='art'&&state.platform===ALL){
   const categoryIds=artstationCategory({group:$('#online-category-group').value,leaf:$('#unified-category').value});
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
 $('#unified-category').value='';
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
const relatedSearch=createRelatedSearch();
let relatedQuery='',relatedTerms=[],relatedNote='',relatedVersion=0;
function updateRelatedTopics(query){
 if(!query||/^https?:\/\//i.test(query)){relatedVersion++;relatedQuery='';refreshTopicStrip();return;}
 const version=++relatedVersion;relatedQuery=query;relatedTerms=[];relatedNote='正在推荐相近词…';refreshTopicStrip();
 relatedSearch(query).then(result=>{if(version!==relatedVersion)return;relatedTerms=result.terms;relatedNote=result.reason;refreshTopicStrip();});
}
/**
 * 主题带已经收进检索浮层：这里只负责把「今日主题 / 相近词」按当前输入框整理成一份数据，
 * 再通知浮层重画。名字沿用旧调用点，免得十几个触发位置各写一遍刷新。
 */
function termSources(){
 const query=$('#asset-query').value.trim();
 const current=!!query&&query===relatedQuery;
 return {
  daily:dailyTopics().map(topic=>({term:topic.en,label:topic.en,today:!!topic.today,badge:topic.today?'今日':'',title:topic.today?'今天的主题':'试试这个主题'})),
  related:current?relatedTerms.map(term=>({term,label:term,title:`搜索相近词：${term}`})):[],
  relatedNote:current?(relatedNote||''):'',
 };
}
function refreshTopicStrip(){searchHistory?.refresh();}
function clearSearchIfEmptied(){
 if(state.route!=='discover')return;
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
 if(!quiet)toast(result.refused?`已加入 ${result.added} 个；模型库已达 ${LIBRARY_LIMIT} 个，请先整理。`:result.added?`已加入 ${result.added} 个模型`:'这些模型已在模型库中');
 return result;
}
/**
 * 复制 UI 元素的代码。
 *
 * mode：all（默认，单文件形态）/ html / css —— 详情弹窗的页签切换会把它一起换掉，
 * 复制什么由当前页签决定，不让「复制的是哪一份」变成一道猜谜。
 *
 * 列表来源的记录里没有代码（只有元素 id），所以现取一份；
 * 取代码走的是那条轻通道（只回 html/css，不回头部元数据）。
 */
async function copyUiCode(uid,mode='all'){
 const model=findModel(uid);
 if(!model){toast('未找到这个 UI 元素');return;}
 try{
  const code=await fetchUiCode(model)||{};
  const text=mode==='html'?String(code.html||model.html||''):mode==='css'?String(code.css||model.css||''):uiSourceText(model,code);
  if(!text){toast('这个元素没有可复制的代码');return;}
  const ok=await copyText(text);
  const what=mode==='html'?'HTML':mode==='css'?'CSS':'HTML + CSS';
  toast(ok?`已复制 ${what} 到剪贴板`:'复制失败，请检查浏览器剪贴板权限');
 }catch(e){toast(`复制失败：${e.message}`);}
}
function toggleFavorite(uid){
 if(state.favorites.has(uid))state.favorites.delete(uid);
 else{
  // 图站图片 / 模型平台：收藏同时把记录留在资产库里（既有语义）。本地素材包本来就在库里，
  // 跳过 collect，否则 state.models 里多出一份，反而会把磁盘索引画的那张素材包卡顶掉。
  if(!favoriteSkipsCollect(uid)){
   const r=collect([uid],{quiet:true});
   if(r.refused){toast('模型库已满，请先移除一些模型再收藏。');return;}
  }
  state.favorites.add(uid);
 }
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
  // UI 元素落的是代码文件，同样没有 GLB/FBX 这一说。
  if(kind!=='ambientcg'&&!polyMaterial&&!polyHdri&&kind!=='polypizza'&&kind!=='kenney'&&kind!=='freestylized'&&kind!=='polyfork'&&kind!=='simready'&&kind!=='uielement'&&downloads?.blenderAvailable===false)toast('默认会导出 GLB + FBX；未检测到 Blender 时 FBX 转换会失败，请先安装 Blender 或设置 SFX_BLENDER。');
  state.selected.clear();
  for(const model of picked)queuePulse.set(model.uid,Date.now());
  renderGrid();counts();
  try{
   // 材质任务的选项：精度取自卡片下载键左边的选择（批量取第一张，服务端再校验一次），
   // 输出固定为解压文件夹——材质没有 GLB/FBX 选项，也不再给压缩包与文件夹的二选一。
   const materialResolution=/^[1248]K$/.test(picked[0]?.materialResolution||'')?picked[0].materialResolution:'2K';
   const ambientFormat=picked[0]?.sourceType==='substance'?'SBSAR':picked[0]?.materialFormat==='PNG'||picked[0]?.materialFormat==='SBSAR'?picked[0].materialFormat:'JPG';
   const downloadOptions=kind==='simready'?{output:'folder',format:'usd'}:kind==='uielement'?{output:'folder'}:kind==='ambientcg'?{output:'folder',resolution:materialResolution,textureFormat:ambientFormat}:polyMaterial?{output:'folder',resolution:materialResolution,textureFormat:'JPG'}:polyHdri?{output:'folder',resolution:materialResolution,textureFormat:'HDR'}:kind==='freestylized'?{output:'folder',format:'glb',resolution:materialResolution}:kind==='polypizza'||kind==='kenney'||kind==='polyfork'?{output:'folder',format:'glb'}:{...state.options,output:'folder',format:'fbx',downloadTextures:true,pngOnly:true,fastZip:true};
  // kind 已在函数顶部由 jobKindOf(picked) 判定，覆盖 Poly Haven 等新平台，不再写死 sketchfab
  const result=await downloads.enqueue(picked,downloadOptions,force,undefined,kind);
  const libraryResult=collectModels(state.models,picked);state.models=libraryResult.models;persist();
  for(const model of picked)queuePulse.delete(model.uid);
  renderGrid();counts();
  const noun=kind==='artstation'?' ArtStation 转换任务':kind==='uielement'?' UI 元素':polyHdri?' Poly Haven HDRI':polyMaterial?' Poly Haven 材质':kind==='polyhaven'?' Poly Haven 模型':kind==='ambientcg'?' ambientCG 材质':kind==='polypizza'?' Poly Pizza 模型':kind==='kenney'?' Kenney 资源包':kind==='polyfork'?' Polyfork 模型':kind==='freestylized'?' FreeStylized 资产':'后台任务';
  // 这条消息是入队结果唯一的出口：先前会有一条「已识别某作品」的上下文提示，
  // 粘贴链接改成只出卡片、不自动入队之后，那个上下文已无处可挂，删掉免得留下死参数。
  const message=result.added.length?`已加入 ${result.added.length} 个${noun}${result.duplicates.length?`，跳过 ${result.duplicates.length} 个重复任务`:''}`:result.duplicates.length?'这些任务已在队列或已完成。':'没有任务加入';
  toast(libraryResult.refused?message+'；模型库已满，部分下载模型未自动入库':message);
 }catch(e){for(const model of picked)queuePulse.delete(model.uid);toast(e.message);renderGrid();counts();}
}
function requestDownload(ids){
 const picked=mergeModels([],ids.map(findModel).filter(Boolean)).map(m=>({...m}));
 if(visitor)return downloadToClient(picked);
 enqueueImmediate(picked);
}
/** 访客点下载是「存到我这台电脑」：主机已有文件就直接传过来（不重跑抓取流程），
 *  没有才排进主机队列，再由浏览器接收器把成品拉到本机指定目录。 */
async function downloadToClient(models){
 const jobs=downloads?.jobs||[],queue=[];
 for(const model of models){
  const job=jobs.findLast(j=>j.uid===model.uid&&j.state==='saved'&&j.fileExists!==false&&j.id);
  if(!job){queue.push(model);continue;}
  try{await downloads.saveToClient(job.id);}catch(e){toast(e.message);}
 }
 if(queue.length)await enqueueImmediate(queue);
}
/** 只传输已在本地的文件：不进队列、不重新下载，所以入口是任务编号而不是模型编号。 */
async function sendBlenderToOpenScene(id){
 if(!downloads?.sendToBlender)return toast('后台服务未连接，无法发送到 Blender。');
 try{await downloads.sendToBlender(id);toast('已发送到已打开的 Blender 场景');}catch(e){toast(e.message);}
}
/** 访客的 Blender 在他自己电脑上：先探本机桥接，探到就把主机上的成品整包推过去导入，
 *  探不到就弹插件安装引导（主机的桥接和插件管不到别人的机器）。 */
let localBlenderGuide=null;
async function sendToLocalBlender(id){
 if(!id)return toast('这份资产在主机上还没有成品，请先下载到本机再导入。');
 const bridge=await probeLocalBridge();
 if(!bridge){localBlenderGuide?.open();return;}
 try{toast('正在传输到本机 Blender…');const result=await importIntoLocalBlender(id);toast(result.imported>0?`已导入本机 Blender：${result.imported} 个对象`:'已导入本机 Blender');}
 catch(e){toast(e.message);}
}
/** 「发送到」弹层：直接挂在 body 上。
 *  ⚠️ 不能留在卡片里：.model-card 同时有 overflow:hidden（圆角裁切）和 hover 的 transform，
 *  而 transform 会让 position:fixed 的子元素改成「相对卡片」定位 —— 菜单会被算进卡片坐标
 *  再被裁掉，表现就是「点了有反应但什么也没出来」。挂到 body 才真正浮在视口上。
 *  菜单是全局唯一一份：关闭即移除，不会留下孤儿节点。 */
let exportMenuEl=null,exportMenuToggle=null;
function closeExportMenus(){
 if(exportMenuEl){exportMenuEl.remove();exportMenuEl=null;}
 if(exportMenuToggle){exportMenuToggle.setAttribute('aria-expanded','false');exportMenuToggle=null;}
}
function toggleExportMenu(button){
 if(exportMenuEl&&exportMenuToggle===button){closeExportMenus();return;}
 closeExportMenus();
 const job=(downloads?.jobs||[]).find(j=>j.id===button.dataset.id);
 const targets=applicableTargets(job,{isVisitor:visitor});
 if(!targets.length){toast('这份资产还没有本地成品，先「导出到本地」再发送。');return;}
 const menu=document.createElement('div');
 menu.className='export-menu';
 menu.setAttribute('role','menu');
 menu.innerHTML=exportMenuHtml(targets.map(t=>({...t,jobId:job.id})),{icon,esc});
 document.body.appendChild(menu);
 exportMenuEl=menu;exportMenuToggle=button;
 button.setAttribute('aria-expanded','true');
 const r=button.getBoundingClientRect();
 const w=menu.offsetWidth,h=menu.offsetHeight;
 let top=r.bottom+6,left=r.right-w;
 if(top+h>window.innerHeight-8)top=Math.max(8,r.top-h-6);
 if(left<8)left=8;
 if(left+w>window.innerWidth-8)left=Math.max(8,window.innerWidth-w-8);
 menu.style.position='fixed';menu.style.top=top+'px';menu.style.left=left+'px';
}
/** 在菜单里挑一个目标软件。只改选择、不导出 —— 导出是旁边那枚图标键的事（两步走）。
 *  选中后把这一行的两个键就地更新：下拉键换成软件名，导出键带上目标 id。
 *  卡片整片重渲染会丢失滚动位置与悬停态，所以只改需要改的那几个节点。 */
function pickExportTarget(button,targetId,jobId){
 closeExportMenus();
 const target=setSelectedTarget(jobId,targetId);
 if(!target)return;
 const apply=row=>{
  const label=row.querySelector('.export-toggle span');
  if(label)label.textContent=target.label;
  const go=row.querySelector('.export-go');
  if(go){
   go.dataset.target=target.id;
   const tip=`导出到 ${target.label}`;
   go.title=tip;go.setAttribute('aria-label',tip);
  }
  const toggle=row.querySelector('.export-toggle');
  if(toggle){const tip=`导出到 ${target.label}（点击可更换）`;toggle.title=tip;toggle.setAttribute('aria-label',tip);}
 };
 const current=button.closest('.export-control');
 if(current)apply(current);
 // 同一份资产可能在网格和详情面板各出现一次，两处的按键都要跟着变。
 document.querySelectorAll(`.export-control[data-job="${CSS.escape(jobId)}"]`).forEach(row=>{if(row!==current)apply(row);});
 toast(`已选择导出到 ${target.label}，点旁边的导出键开始`);
}
// 弹层用 fixed 定位，滚动或缩放窗口会让它脱离按钮，统一收起即可。
let exportMenuScrollBound=false;
function bindExportMenuAutoClose(){
 if(exportMenuScrollBound)return;exportMenuScrollBound=true;
 const close=()=>closeExportMenus();
 window.addEventListener('scroll',close,{passive:true,capture:true});
 window.addEventListener('resize',close);
}
/** Blender 沿用现有桥接，DCC 等待原生导入结果，引擎交付到项目目录。 */
async function sendToTarget(targetId,id){
 closeExportMenus();
 const target=targetById(targetId);
 if(target?.kind==='bridge'){
  if(targetId==='blender'){if(visitor)return sendToLocalBlender(id);return sendBlenderToOpenScene(id);}
  return toast(`目标 ${target?.label||targetId} 尚未实现桥接推送`);
 }
 try{
  const res=await fetch('/api/exports/send',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({targetId,jobId:id})});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Error(data.error||'发送失败');
  toast(data.note||`已发送到 ${target?.label||targetId}`);
  if(data.target==='unity')toast('Unity 端：打开工程即自动建材质与预制体');
 }catch(e){toast(e.message);}
}
function renderTasks(){downloads?.render();}
let exportTargetsCache=[];
try{const cached=JSON.parse(storage?.getItem('assetvault-software-status')||'null');if(Array.isArray(cached))exportTargetsCache=SOFTWARE_TARGETS.map(t=>({...t,...cached.find(item=>item.id===t.id),connected:false,sessions:[]}));}catch{}
let exportSettingsActive='blender',blenderExportCard;
/** 引擎配置项目路径，DCC 安装一次接收脚本并显示连接状态。 */
async function renderExportTargets({preserve=true,targets,refresh=false}={}){
 const list=$('#export-targets-list');if(!list)return;
 if(!targets){
  renderExportTargets({preserve,targets:exportTargetsCache.length?exportTargetsCache.map(t=>({...t})):SOFTWARE_TARGETS.map(t=>({...t,detectionPending:true}))});
  try{
   const res=await fetch('/api/exports/targets'+(refresh?'?refresh=1':''),{headers:{'X-SFX-Local':'1'}});
   if(!res.ok)throw Error('读取导出目标失败');
   const fresh=await res.json();
   try{storage?.setItem('assetvault-software-status',JSON.stringify(fresh));}catch{}
   await renderExportTargets({preserve:true,targets:fresh});
  }catch(error){toast(error.message);}
  return;
 }
 const drafts=preserve?new Map([...list.querySelectorAll('[data-export-path]')].filter(input=>input.value!==(exportTargetsCache.find(t=>t.id===input.dataset.exportPath)?.path||'')).map(input=>[input.dataset.exportPath,input.value])):new Map();
 try{
  exportTargetsCache=targets.map(t=>({...t}));
  for(const target of targets)if(drafts.has(target.id))target.path=drafts.get(target.id);
  blenderExportCard||=$('#blender-bridge-status')?.closest('.settings-card');
  list.innerHTML=exportSettingsHtml(targets,{esc,icon,active:exportSettingsActive});
  if(blenderExportCard)list.querySelector('[data-software-panel="blender"]')?.append(blenderExportCard);
  list.onclick=event=>{const tab=event.target.closest('[data-software-tab]');if(tab){exportSettingsActive=tab.dataset.softwareTab;selectSoftwareTab(list,exportSettingsActive);}};
  list.onkeydown=event=>{
   const tab=event.target.closest('[data-software-tab]');if(!tab)return;
   const tabs=[...list.querySelectorAll('[data-software-tab]')],index=tabs.indexOf(tab);
   const delta={ArrowRight:1,ArrowDown:1,ArrowLeft:-1,ArrowUp:-1}[event.key];
   if(!delta&&event.key!=='Home'&&event.key!=='End')return;
   event.preventDefault();const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+delta+tabs.length)%tabs.length];
   exportSettingsActive=next.dataset.softwareTab;selectSoftwareTab(list,exportSettingsActive,{focus:true});
  };
  list.querySelectorAll('[data-software-refresh]').forEach(button=>button.onclick=async()=>{button.disabled=true;button.textContent='正在检测…';await renderExportTargets({refresh:true});});
  list.querySelectorAll('[data-export-browse]').forEach(b=>b.onclick=()=>browseFolderInto(`[data-export-path="${b.dataset.exportBrowse}"]`));
  list.querySelectorAll('[data-dcc-install]').forEach(button=>button.onclick=async()=>{
   button.disabled=true;
   const label=button.textContent;
   const status=document.createElement('div');status.className='dcc-install-progress';status.setAttribute('role','status');status.innerHTML='<progress max="100" value="0"></progress><span>正在准备安装…</span>';button.closest('[role="tabpanel"]').append(status);
   button.textContent='正在安装…';
   try{
    const response=await fetch('/api/exports/install',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({targetId:button.dataset.dccInstall,progress:true})});
    if(!response.ok)throw Error((await response.json()).error||'安装失败');
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',result;
    const consume=line=>{if(!line.trim())return;const update=JSON.parse(line);if(update.error)throw Error(update.error);if(update.result)result=update.result;if(update.percent!==undefined){status.querySelector('progress').value=update.percent;status.querySelector('span').textContent=update.message;}};
    while(true){const {done,value}=await reader.read();pending+=decoder.decode(value,{stream:!done});const lines=pending.split('\n');pending=lines.pop();for(const line of lines)consume(line);if(done){consume(pending);break;}}
    if(!result?.ok)throw Error('安装中断，请重新安装');
    toast(result.note);await renderExportTargets();
   }catch(error){status.querySelector('span').textContent='安装失败：'+error.message;toast(error.message);button.disabled=false;button.textContent=label;}
  });
  fillIcons();
 }catch(e){list.innerHTML='<p class="compact-note">读取导出目标失败</p>';}
}
// 备份面板实例：设置弹窗可能在初始化早期被打开，这里先占位，setup 时再赋值。
let backupPanel=null;
// 资源库面板（多库登记与切换）同样占位。
let storePanel=null;
function openSettings(){
 if(visitor)return;
 $('#pack-mode').value=state.options.packMode;$('#texture-size').value=state.options.maxTextureEdge;$('#scan-limit').value=state.options.scanLimit;
 $('#backend-concurrency').value=downloads?.settings?.concurrency||1;$('#backend-retries').value=downloads?.settings?.retryLimit??1;
 // 每次打开都重新探一次：用户很可能刚重启过 Blender，状态得跟上。
 blenderBridge?.refresh();
 // 「运行环境」：后台浏览器是可下载的，每次打开都要按实际情况刷新按钮文案。
 browserRuntime?.refresh();
 // 导出目标：列出可配置路径的引擎 / DCC，让用户指定各自的工程目录。
 renderExportTargets({preserve:false});
 settingsPanel.open();
}
async function browseFolderInto(inputId,errorId){
 const input=$(inputId),error=errorId?$(errorId):null;if(!input)return;
 if(!downloads?.pickFolder){toast('后台服务未连接，暂时不能打开文件夹选择器。');return;}
 if(error)error.textContent='';
 try{const folder=await downloads.pickFolder(input.value.trim());if(folder){input.value=folder;input.dispatchEvent(new Event('change',{bubbles:true}));}}catch(e){if(error)error.textContent=e.message;toast(e.message);}
}
/** 这一次「按下并移动」该不该交给系统拖放（返回 true = 让给窗口内的手势）。
 *
 *  资产卡：窗口内正常拖（交给画板等站内落点），拖到窗口边缘才起原生拖放，Alt 立刻拖出。
 *  预览大图：按住拖动本来就是「平移看细节」（local-files.js 的 bindZoom 挂在 .local-gallery-main
 *  上，大图在它里面），一旦起原生拖放，画面不动、松手还会落回自己窗口。所以：
 *    · 发现页的大图是从图站抓的，拖出去没有意义 —— 窗口内一律先当成平移，Alt 才拖出；
 *    · 资产库的大图是本地文件，保留原来的「直接拖到 PS / PureRef」，不用按 Alt。 */
function deferNativeDrag(event,source){
 if(event.altKey)return false;
 if(!source.uid&&!document.body.classList.contains('bd-drop-active'))return state.route==='discover'&&!!event.target?.closest?.('.local-gallery-main');
 return event.clientX>8&&event.clientY>8&&event.clientX<innerWidth-8&&event.clientY<innerHeight-8;
}

async function setup(){
 bindScrollPerformance();
 bindCardImageResidency($('#grid'));
 bindScrollbarInteraction();
 // 卡片区滚过一屏 1/3 就浮出「回到顶部」：所有列表共用 #app-scroll，一颗按钮管全部路由。
 mountScrollTop();
 // 回到上次待的平台，并把那一屏图从缓存直接铺进 state —— 都赶在第一帧渲染之前做完，
 // 刷新页面后画面就是离开前那一屏，不会再「先空一下、图再一张张回来」。
 try{
  // ?platform=xxx 优先：深链（书签 / 从别处跳进来）要能直接落到某个平台，也方便排查。
  const requested=new URLSearchParams(location.search).get('platform')||'';
  const saved=requested||storage?.getItem(LAST_PLATFORM_KEY);
  if(saved&&saved!==state.platform&&platformById(saved).id===saved&&platformEnabled(saved))state.platform=saved;
  // 深链只用一次：读完就把参数从地址栏抹掉，之后切平台靠记住的那份，不会再被 URL 钉回原站。
  if(requested){const u=new URL(location.href);u.searchParams.delete('platform');history.replaceState(null,'',u.pathname+u.search+u.hash);}
 }catch{}
 if(isPictureSite(state.platform)){const snapshot=restorePictureSnapshot(state.platform);if(snapshot)state.pictureSite=snapshot;}
 setupSidebarCollapse();
 setupFilterDrawer();
 setupCardContextMenu({icon,notify:toast,
  targetOf:target=>target.closest?.('.model-card,[data-package],[data-file],[data-sequence]')||libraryBackgroundTarget(target,state.route),
  buildItems:target=>libraryBackgroundTarget(target,state.route)?libraryBackgroundItems({
   gallery:!!state.gallery,cards:libraryVisibility?.mode()||'all',canCreate:!visitor&&!!boardHub,
   onCreate:()=>$('#board-deck-new')?.click(),onSmart:()=>$('#board-deck-smart')?.click(),onImport:()=>$('#local-import')?.click(),
   onDisplay:mode=>{if((mode==='gallery')!==!!state.gallery)$('#display-mode')?.click();},
   onCards:mode=>libraryVisibility?.setMode(mode),
  }):cardContextItems(target),
 });
 restoreDiscoveryFilters();
 refreshTopicStrip();
 downloads=createDownloadUI({$,icon,esc,toast,legacy:()=>state.tasks,requestLegacy:uid=>requestDownload([uid]),isVisible:()=>state.route==='downloads',onUpdate:changed=>{assistantDownloads(downloads.jobs);counts();if(changed){if(state.route!=='downloads')renderGrid();const key=downloads.jobs.filter(job=>job.state==='saved'||job.fileExists).map(job=>`${job.id}:${job.state==='saved'?'saved':'files'}`).sort().join('|');if(key!==downloadedAssetsKey){downloadedAssetsKey=key;void scanLibraryFiles(true);}}}});downloads.setup();
 // 桌面版：卡片可以直接拖到别的软件里（浏览器版这里会自己跳过，什么都不挂）。
 setupDragOut({toast,jobs:()=>downloads.jobs,download:uid=>enqueueImmediate([findModel(uid)].filter(Boolean)),send:sendToTarget,targetById,packages:()=>localFiles.packages(),
  // 普通资产在窗口内拖到画板；到窗口边缘交给系统拖放，Alt 可立即拖出。
  deferNativeDrag:deferNativeDrag});
 // 网页版兜底：缩略图拖出去只能得到小图，改挂原图地址。桌面版由上面的原生拖放接管，这里自动跳过。
 setupPictureDrag();
 // 网页版兜底：资产库图片卡拖出去给原文件（预取字节塞进 HTML5 拖拽）。桌面版同样自动跳过。
 setupLibraryDragWeb();
 if(visitor)localBlenderGuide=createLocalBlenderGuide({toast});
 localFiles.setup();
 // 回收站切换：图标按钮与下拉是同一份 state.filter 的两个入口，切换时同步下拉值并清选择。
const toggleTrash=()=>{
 const into=state.filter!=='trash';
 state.filter=into?'trash':'all';
 const select=$('#local-feature');if(select)select.value=state.filter;
 state.selected.clear();
 renderGrid();counts();
 toast(into?'回收站：右键卡片「放回模型库」可恢复':'已返回全部资产');
};
 libraryVisibility=createLibraryVisibility({state,activeBoard:()=>!!boardHub?.store.activeId,onChange:mode=>{if(mode!=='assets'&&boardHub?.store.activeId)boardHub.openAll();persistNow();renderGrid();},onTrash:toggleTrash});libraryVisibility.setup();
// 导入文件夹：加/删根目录后强制重扫一次，让新目录里的资产包立刻出现在网格里。
createLocalImport({$,esc,toast,visitor,onChanged:()=>scanLibraryFiles(true),onOrganized:async result=>{
 applyLocalFileMoves(state.models,result);applyLocalFileMoves(state.trashed,result);storage.applyFileMoves?.(result);
 renderGrid();await scanLibraryFiles(true);
}}).setup();
// 备份与迁移：设置里那块卡片（备份列表 / 导出整库 / 导入快照）。
backupPanel=createBackupPanel({$,esc,toast,isVisitor:visitor});
backupPanel.setup();
// 多资源库：切库改注册表再重启，卡片自己管状态（见 store-panel.js）。
storePanel=createStorePanel({esc,toast,isVisitor:visitor,pickFolder:initial=>downloads.pickFolder(initial)});
storePanel.setup();
 // 网格框选 / Shift 连选：只加高亮 class，pointerup 才提交 state.selected，拖动中不重绘卡片。
 const rangeSelect=createRangeSelect({grid:$('#grid'),state,renderGrid,onSelectionChange:()=>syncSelectionUI(),keyboardManaged:true});
rangeSelect.setup();
// 选中态每次变化都顺带维护批量栏那颗「连文件删除」：只有选中里真有本地文件时才出现。
// 少一颗常驻的危险按钮，就少一次误伤 —— 磁盘文件删了不可恢复。
const countSelectedLocal=()=>{let n=0;for(const model of state.models)if(state.selected.has(model.uid)&&(model.filePath||model.root&&model.rel))n++;return n;};
syncSelectionUI=()=>{
 rangeSelect.syncSelection();
 const files=$('#delete-selected-files');
 if(files){const n=countSelectedLocal();files.hidden=!n;files.textContent=n?`删除文件 (${n})`:'删除文件';}
};
 $('#local-rescan')?.addEventListener('click',()=>scanLibraryFiles(true));
 artstation=createArtstationUI({enabled:()=>platformEnabled('artstation'),$,icon,esc,toast,state,requestFeed});const artFilters=artstation.setup();
 // ambientCG 侧栏（分类 / 精度 / 输出方式）：分类清单开页就拉一次，静态 facets 不常变。
 ambientcgUI=createAmbientcgUI({enabled:()=>platformEnabled('ambientcg'),$,esc,toast,requestFeed});ambientcgUI.setup();
 polyhavenUI=createPolyhavenUI({enabled:()=>platformEnabled('polyhaven'),$,esc,toast,requestFeed});polyhavenUI.setup();
 kenneyUI=createKenneyUI({enabled:()=>platformEnabled('kenney'),$,esc,toast,requestFeed});kenneyUI.setup();
 freestylizedUI=createFreestylizedUI({enabled:()=>platformEnabled('freestylized'),$,esc,toast,requestFeed});freestylizedUI.setup();
 polyforkUI=createPolyforkUI({enabled:()=>platformEnabled('polyfork'),$,esc,toast,requestFeed});polyforkUI.setup();
 $('#polypizza-cc0').onchange=()=>{if(state.platform==='polypizza')requestFeed('polypizza',readRequest('polypizza'));};
 // 设置面板里的「Blender 连接」：显示脚本装到哪、Blender 开着没有、端口通不通。
 blenderBridge=createBlenderBridgePanel({$,esc,icon,toast});blenderBridge.setup();
 // 设置面板里的「运行环境」：后台浏览器不再随安装包分发，缺了就点这里下载。
 browserRuntime=createBrowserRuntimePanel({$,esc,icon,toast});browserRuntime.setup();
 // 首次运行的依赖准备：缺了后台浏览器 / Blender / 桥接脚本时自己弹出来，之后从设置页进来。
 if(!visitor){setupWizard=createSetupWizard({$,esc,icon,toast,downloads});setupWizard.setup();}
 bindExportMenuAutoClose();
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
 enhanceSelects('#search-panel select:not(.ftree-native), #filter-rows select:not(.ftree-native), #discovery-controls select:not(.ftree-native)');   // 原生下拉的系统弹出层改不了样式，这里统一换成自绘的；顶部功能栏的「每批条数」也在范围内，否则深色界面里会弹出浅色系统菜单；树里的控件另有显示层，跳过
 // 平台下拉的图钉：派发的 picker:pin 只操作置顶顺序，不碰当前选中的平台；重画选项后 picker 的
 // MutationObserver 会自动重绘已展开的菜单，所以这里不用手动刷新浮层。
 $('#search-platform').addEventListener('picker:pin',event=>{
  const value=event.detail?.value;
  if(!value||value===ALL)return;
  platformPins=togglePin(platformPins,value);
  writePins(platformPins,storage);
  renderPlatformOptions();
 });
 // 平台下拉的登录图标：开一个后台可见浏览器窗口让用户登平台账号（cookie 自动入库），
 // 窗口关掉后重读 cookie 仓，把「已登录」标识画回菜单。登录窗口可能开很久（扫码/验证码），
 // 所以只在关闭时刷新，不在打开时轮询。
 $('#search-platform').addEventListener('picker:login',async event=>{
  const id=event.detail?.value;
  if(!id||id===ALL)return;
  const name=platformById(id).label||id;
  try{
   await openSiteLogin(id,{toast,onClosed:async()=>{
    platformLogins=await loginStates();
    renderPlatformOptions();
    toast(`${name} 登录窗口已关闭，登录状态已更新`);
   }});
  }catch(error){ toast(error?.message||`打不开 ${name} 登录窗口`); }
 });
 // 首次进来先读一次登录态：菜单里已登录的站直接带绿点；切回窗口时再刷新（10 秒节流），
 // 用户在浏览器里登录完回到工具就能看到，不必重启。
 let loginSyncAt=0;
 const syncPlatformLogins=async()=>{
  loginSyncAt=Date.now();
  const [targets,states]=await Promise.all([loginTargets(),loginStates()]);
  platformLoginSites=new Set(Object.keys(targets||{}));
  platformLogins=states||{};
  renderPlatformOptions();
 };
 syncPlatformLogins().catch(()=>{});
 window.addEventListener('focus',()=>{if(Date.now()-loginSyncAt>10000)syncPlatformLogins().catch(()=>{});});
 contentModes=createContentKindTabs({host:$('#content-kind-tabs'),state,esc,readKind:()=>$('#local-kind')?.value||'',onPick:applyModeTab,onExit:exitContentMode});   // 顶部模式轨：每个模式一枚常驻图标，不显示数量 / 平台，再点当前模式或 Esc 退回全部
 setupCategoryOrder({root:document,state,onChange:()=>{persistNow();contentModes.render();view.refreshCategories();}});
 contentModes.render();
 placeFilters();                                                // 宽屏把筛选行搬进左侧栏，窄屏搬回搜索卡片
  window.addEventListener('resize',()=>{clearTimeout(filterTimer);filterTimer=setTimeout(()=>{
   placeFilters();syncStickyOffset();
   const navIndicator=document.querySelector('#sidebar nav .nav-indicator');
   const navActive=document.querySelector('#sidebar nav button[data-route].active');
   if(navIndicator&&navActive){
    const height=navActive.offsetHeight,top=navActive.offsetTop;
    if(height){navIndicator.style.top=`${top}px`;navIndicator.style.height=`${height}px`;}
   }
  },120);});
 fillIcons();$('#online-category').innerHTML=CATEGORIES.map(([value,label])=>`<option value="${value}">${label}</option>`).join('');filterTrees.refresh();/* 分类选项填进去了，树可以画叶子了 */searchHistory=createSearchHistory({$,icon,state,persist,toast,onPick:applyHistory,onTerm:pickTerm,sources:termSources});searchHistory.setup();renderPlatform();route('discover');const initialScan=scanLibraryFiles();
 if(initial.migrated||initial.warning){$('#migration-note').hidden=false;$('#migration-note span').textContent=initial.warning||`已兼容旧版：保留 ${state.models.length} 个模型及收藏、任务记录。新的在线结果不会再自动入库。`;persistNow();}
 $('#dismiss-migration').onclick=()=>{$('#migration-note').hidden=true;};
 document.addEventListener('click',e=>{
  const factsBtn=e.target.closest('[data-card-facts]');
  if(factsBtn){
   e.preventDefault();e.stopPropagation();
   const card=factsBtn.closest('.model-card');
   const open=card?.classList.contains('show-facts');
   document.querySelectorAll('.model-card.show-facts').forEach(node=>node.classList.remove('show-facts'));
   if(card&&!open)card.classList.add('show-facts');
   return;
  }
  if(!e.target.closest('.card-facts'))document.querySelectorAll('.model-card.show-facts').forEach(node=>node.classList.remove('show-facts'));
  // 装成桌面应用后，WebView 不会把 target="_blank" 交给系统浏览器 —— 点了没反应。
  // 详情面板里所有「打开官方页面」都是这类链接，统一在这里接走，交给系统默认浏览器。
  const external=e.target.closest('a[target="_blank"]');
  if(external&&/^https?:/i.test(external.href||'')){e.preventDefault();openExternal(external.href);return;}
  const routeButton=e.target.closest('aside nav button[data-route]');if(routeButton)route(routeButton.dataset.route);
  const close=e.target.closest('[data-close]');if(close)$('#'+close.dataset.close).close();
  // 点到「发送到」弹层/按钮以外的地方就收起它；点在弹层内部（含按钮与菜单项）则不收。
  if(!e.target.closest('.export-menu')&&!e.target.closest('.export-toggle'))closeExportMenus();
  // 卡片空白、封面和标题区域都可预览；独立控件与交互式 UI 卡片不接管。
  const previewCard=e.target.closest('#grid .model-card[data-uid]');
  if(previewCard&&!e.target.closest('button,a,input,select,textarea,label,[role="button"],.card-facts,.ui-element-card')){
   preview(previewCard.dataset.uid);return;
  }
  const action=e.target.closest('[data-action]');if(action){const {uid}=action.dataset;switch(action.dataset.action){case 'preview':preview(uid);break;case 'preview-folder':{const m=findModel(uid);if(m)revealPreviewFolder(m);break;}case 'download':requestDownload([uid]);break;case 'download-images':imageDownload.requestImages([uid]);break;case 'export-toggle':toggleExportMenu(action);break;case 'export-pick':pickExportTarget(action,action.dataset.target,action.dataset.id);break;case 'export-go':{const target=action.dataset.target,id=action.dataset.id;if(target)sendToTarget(target,id);break;}case 'favorite':toggleFavorite(uid);break;case 'ai-tags':aiTagThis(uid);break;case 'collect':collect([uid]);break;case 'reveal-download':downloads?.reveal(action.dataset.id).catch(e=>toast(e.message));break;case 'remove':removeAssetCard(uid).catch(error=>toast(error.message));break;case 'restore':{const r=restoreModels(state,[uid]);persist();renderGrid();counts();toast(r.refused?`模型库已满（${LIBRARY_LIMIT} 个），先清理再恢复`:'已放回模型库');break;}case 'purge':askConfirm({title:'彻底删除记录',message:'彻底删除这条记录？不可恢复（不会删除已下载的文件）。',confirmText:'彻底删除',danger:true}).then(ok=>{if(!ok)return;purgeModels(state,[uid]);persist();renderGrid();counts();});break;case 'add-user-tag':addUserTagFromDialog(uid);break;case 'copy-ui-code':copyUiCode(uid,action.dataset.copyMode||'all');break;}}
  // 评分与「我的标签」× 删除：都长在标签面板里，先于 data-tag 搜索拦截，不然点星会顺带发起检索。
  const rate=e.target.closest('[data-rate]');if(rate){setUserMeta(state,rate.dataset.uid,{rating:Number(rate.dataset.rate)});persist();renderTagDialog(rate.dataset.uid);renderGrid();patchMetaFor(rate.dataset.uid);return;}
  const rmTag=e.target.closest('[data-remove-tag]');if(rmTag){const box=rmTag.closest('[data-asset-tags]'),model=box?.dataset.assetTags?findModel(box.dataset.assetTags):null;if(model){removeUserTag(state,model,rmTag.dataset.removeTag);persist();renderTagDialog(model.uid);renderGrid();}return;}
  const filter=e.target.closest('[data-filter]');if(filter){state.filter=filter.dataset.filter;state.selected.clear();document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===filter));renderGrid();}
  const tag=e.target.closest('[data-tag]');if(tag){$('#preview-dialog').close();if(state.route==='library')$('#asset-query').value=tag.dataset.tag;else writeSearch({q:tag.dataset.tag});startSearch();}
  
 });
 $('#grid').addEventListener('change',e=>rangeSelect.onCheckboxChange(e));
 // 材质精度选择（卡片下载键左边、预览面板各一份）：写回模型对象，重渲染时按它回填，
 // 下载时也从同一个字段读——不复制第二份状态，就不存在两处显示不一致。
 // 写回后必须重渲染：下载键的「已下载」按精度判定，不刷新的话切了精度按钮还停在旧档位的状态。
 document.addEventListener('change',async e=>{
  // 备注：change 在失焦时才触发，不会和打字争焦点；落库后顺手把整份 userMeta 补进磁盘 info.json。
  const custom=e.target.closest('[data-custom-category-for]');
  if(custom){const model=findModel(custom.dataset.customCategoryFor);if(!model||visitor)return;try{assignCustomCategory(state.options,model,custom.value);persistNow();renderGrid();refreshPreviewTags(model.uid);}catch(error){toast(error.message);}return;}
  const type=e.target.closest('[data-asset-type-for]');
  if(type){
   const model=state.models.find(item=>item.uid===type.dataset.assetTypeFor);
   if(!model){toast('请先将资产收藏入库，再保存类别。');return;}
   const value=type.value;type.disabled=true;
   if(model._remoteOnly){
    try{
     const response=await fetch('/api/library/assets/mutate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ops:[{op:'asset:patch',uid:model.uid,patch:{typeOverride:value}}]})});
     const result=await response.json();
     if(!response.ok||!result.applied)throw Error(result.error||'类别保存失败');
    }catch(error){type.disabled=false;type.value=model.typeOverride||'';toast(error.message);return;}
   }
   model.typeOverride=value;
   const visible=findModel(model.uid);if(visible)visible.typeOverride=value;
   persistNow();renderGrid();renderTagDialog(model.uid);refreshPreviewTags(model.uid);return;
  }
  const note=e.target.closest('[data-note-for]');
  if(note){setUserMeta(state,note.dataset.noteFor,{note:note.value});persist();renderGrid();patchMetaFor(note.dataset.noteFor);return;}
  const resolution=e.target.closest('[data-material-resolution]');
  if(resolution){const model=findModel(resolution.dataset.materialResolution);if(!model||model.materialResolution===resolution.value)return;model.materialResolution=resolution.value;renderGrid();return;}
  const format=e.target.closest('[data-material-format]');
  if(!format)return;const model=findModel(format.dataset.materialFormat);if(!model||model.materialFormat===format.value)return;model.materialFormat=format.value;renderGrid();
 });
 // 只有「手动在搜索框里敲关键词并提交」才写进最近检索：分类 / 排序 / 复选这些筛选动作
 // 也会重发检索，但它们是筛选不是检索词，混进历史里只会把真正的关键词挤掉（2026-10-16 用户要求）。
 const canManageUpdates=!visitor&&!!window.__TAURI__?.core?.invoke;
 let appUpdates;
 const categoryIds=['online-category','unified-category','online-category-group','art-category','polyhaven-category','ambientcg-category','kenney-category','freestylized-category'];
 assistant=createMascotAssistant({panel:$('#search-panel'),canManageUpdates,onCheckUpdates:()=>appUpdates?.check(),onInstallUpdate:()=>appUpdates?.update(),onViewDownloads:()=>route('downloads'),onClearFilters:()=>{
  if(state.route==='library')$('#reset-local-filters').click();
  else{for(const id of categoryIds)if($('#'+id))$('#'+id).value='';resetMergedFilters();}
 }});
 // 复用筛选控件的真实操作，不让初始化或后台渲染触发助手提示。
 document.addEventListener('change',event=>{
  if(!event.isTrusted&&!event.bubbles)return;
  if(!categoryIds.includes(event.target.id))return;
  const label=event.target.selectedOptions?.[0]?.textContent;
  if(label)assistant.notify({type:'category',label});
 });
 document.addEventListener('click',event=>{
  const button=event.target.closest('[data-local-category],[data-local-kind]');
  if(!button||state.route!=='library')return;
  // 侧栏面板自己处理点击（那里有折叠、再点取消这类局部逻辑），这里只兜底面板外的入口：
  // 同一次点击被处理两遍的话，刚取消的选中会被本监听原样写回来。
  if(button.closest('#library-filters'))return;
  assistant.notify({type:'category',label:button.querySelector('.ftree-leaf-label')?.textContent||button.textContent});
  // 顶部模式轨与侧栏是同一件事的两个入口，落点统一在 applyLocalType：
  // 有图标的类型点亮图标，没图标的类型写 state.contentKind，绝不让图标停在上一轮的模式上。
  if(button.dataset.localKind!==undefined){applyLocalType(button.dataset.localKind);return;}
  // 「分类」是资产自带的 category / 标签，值恰好等于某个模式时才点亮，否则清空。
  if(button.dataset.localCategory!==undefined){
   state.localCategory=button.dataset.localCategory;
   const nextMode=modeTabById(state.localCategory)?state.localCategory:'';
   const changed=nextMode!==state.mode||!!state.contentKind||!!state.libraryMode;
   state.mode=nextMode;state.libraryMode=nextMode?(modePresetById(nextMode)?.legacyMode||''):'';state.contentKind='';
   if(changed){rememberMode(state.mode);renderGrid();}else contentModes?.render();
  }
 });
 initSearchMotion($('#search-panel'),{notify:assistant.notify});
 const disposeMascotDeveloper=setupMascotDeveloper({panel:$('#search-panel'),assistant,enabled:!visitor});
 window.addEventListener('pagehide',disposeMascotDeveloper,{once:true});
 window.addEventListener('pagehide',assistant.dispose,{once:true});
 $('#asset-search-form').addEventListener('submit',e=>{e.preventDefault();if(imageSearch?.submit())return;startSearch({record:true});});
 // 删字也算一次检索：只清空时才触发（见 clearSearchIfEmptied），
 // 否则每敲一个字都发请求，既吵又慢。
 $('#asset-query').addEventListener('input',clearSearchIfEmptied);
 $('#asset-query').addEventListener('input',refreshTopicStrip);
 // 粘链接就把左侧平台下拉拨过去（只拨下拉，不自动检索）。input 与 paste 都挂：
 // 部分浏览器 paste 之后的 input 会晚一帧，这里用 setTimeout 让值先落地，两条路径幂等。
 $('#asset-query').addEventListener('input',event=>syncPlatformFromLink(event.target.value));
 $('#asset-query').addEventListener('paste',event=>{const text=event.clipboardData?.getData('text');if(text)setTimeout(()=>syncPlatformFromLink(text),0);});
// 主题 / 相近词胶囊已经搬进检索浮层，统一走 createSearchHistory 的 onTerm 回调（见 pickTerm）。
 // 主题拆包助手（A3）：一句话主题 → AI 拆成一组搜索词，点一下即检索。
 const themeInput=$('#asset-query'),themeResults=$('#theme-results');
 themeInput.title='多个搜索词用逗号分隔，例如：house, tree, cart；AI 可将主题拆解成搜索词';
 let themeToken=0;
 themeInput.addEventListener('input',()=>{themeToken++;});
 $('#theme-breakdown-btn').onclick=async()=>{
  const theme=themeInput.value.trim();if(!theme){themeInput.focus();return;}
 const token=++themeToken,button=$('#theme-breakdown-btn');
 // 现在它是输入框内的一颗纯图标键：不能往里写「拆解中…」文字，否则 30px 的键会被撑开。
 // 加载态交给 .is-busy 的旋转动画 + title，拆解完把 title 换回来即可，图标节点始终不动。
 button.disabled=true;button.classList.add('is-busy');button.title='正在拆解主题…';
 themeResults.hidden=false;themeResults.innerHTML='<span class="theme-loading">正在拆解主题…</span>';
 const data=await brainstorm(theme);
 button.disabled=false;button.classList.remove('is-busy');button.title='AI 拆解：把搜索栏里的主题拆成多个搜索词';
  if(token!==themeToken){themeResults.hidden=true;return;}
  if(!data.brainstormed){themeResults.innerHTML=`<span class="theme-empty">${esc(data.reason||'未能拆解，请换个说法')}</span>`;return;}
  const terms=[...new Set(data.terms.filter(t=>typeof t==='string').map(t=>t.trim()).filter(Boolean))].slice(0,8);
  if(!terms.length){themeResults.textContent='未生成有效搜索词，请换个说法';return;}
  themeInput.value=terms.join(', ');refreshTopicStrip();persist();
  themeResults.innerHTML='<span>已填入搜索栏，点击搜索可同时检索；也可点击单个词：</span>'+terms.map(t=>`<button type="button" class="theme-chip" data-term="${esc(t)}">${esc(t)}</button>`).join('');
 };
themeResults.addEventListener('click',event=>{
 const chip=event.target.closest('[data-term]');if(!chip)return;
 pickTerm(chip.dataset.term);
});
  // 两个分类容器都要监听：统一树点叶子写 #online-category、点组头写 #online-category-group，改哪个都重搜。
  for(const id of ['online-category','unified-category','online-category-group','online-sort','online-downloadable','online-animated','online-staffpicked'])if($('#'+id))$('#'+id).onchange=()=>restartSearch();
  // Uiverse 的类型与主题：站点只认路径段过滤类型，所以这两个直接重发检索流。
  for(const id of ['uiverse-type','uiverse-theme'])if($('#'+id))$('#'+id).onchange=()=>{if(state.platform==='uiverse')requestFeed('uiverse',readRequest('uiverse'));};
  // Fab：「仅免费」与排序改变后重发检索流（当前平台含 fab 才触发）。
  for(const id of ['fab-free','fab-sort'])if($('#'+id))$('#'+id).onchange=()=>{if(activeModes().includes('fab'))requestFeed('fab',readRequest('fab'));};
 $('#unified-sort').onchange=()=>{
  const next=$('#unified-sort').value;
  if(next==='name'){renderGrid();return;}
  if($('#online-sort').value!==next){$('#online-sort').value=next;$('#online-sort').dispatchEvent(new Event('change',{bubbles:true}));}
 };
 $('#unified-kind').onchange=()=>startSearch();
 mergedFilters=createMergedFilters({$,icon,state,onReset:resetMergedFilters,onSearch:()=>startSearch()});   // 全部平台的统一筛选树
$('#reset-search-filters').onclick=()=>{writeSearch({q:$('#asset-query').value});startSearch();};
$('#search-platform').onchange=e=>{
 const id=e.target.value;
 if(id==='library')return;                        // 文本 / 视频的占位项不是在线平台
 const preset=modePresetById(state.mode);       // 换站只是模式内的选择，模式本身保持点亮
 if(preset&&!preset.localOnly){state.modePlatforms[preset.id]=id;rememberModePlatform(storage,preset.id,id);}
 setPlatform(id);
};
$('#empty-explore').onclick=()=>{if(state.route!=='discover')route('discover');writeSearch({sort:'popular'});refreshTopicStrip();startSearch();};
 localSearch=bindLocalSearch({$,state,renderGrid,parse:parseLocal,inputSelector:'#asset-query',enabled:()=>state.route==='library',onState:detail=>{
  $('#search-panel').dispatchEvent(new CustomEvent('search-motion-state',{detail}));
  if(detail.ok&&state.route==='library'&&state.search.trim()&&!filtered().length&&!extraCards().length)assistant.notify({type:'empty'});
 }});
 imageSearch=bindImageSearch({$,state,renderGrid,writeSearch,startSearch,inputSelector:'#asset-query',onState:detail=>{
  $('#search-panel').dispatchEvent(new CustomEvent('search-motion-state',{detail}));
 }});
 semanticSearch=createSemanticSearch({$,state,renderGrid,toast:message=>toast(message)});
 semanticSearch.setup();
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
  const author=event.target.closest('[data-author-uid]');
  if(author){
   const model=findModel(author.dataset.authorUid);
   if(model?.username){
    $('#preview-dialog').close();$('#asset-tags-dialog').close();
    clearTimeout(searchTimer);$('#asset-query').value='';resetDiscoveryFeeds(state);
    setPlatform(model.platform==='artstation'?'artstation':'sketchfab',{autostart:false});route('discover');refreshTopicStrip();
    if(model.platform==='artstation'){
     $('#art-type').value='';$('#art-category').value='';$('#art-picked').checked=false;
     $('#art-artist').value=model.username;$('#art-artist-projects').click();
    }else submitLink(`https://sketchfab.com/${encodeURIComponent(model.username)}/models`);
   }
  }
  const favorite=event.target.closest('#model-details [data-action="favorite"],#file-preview-details [data-action="favorite"]');
  if(favorite)refreshPreviewTags(favorite.dataset.uid);
  const button=event.target.closest('[data-action="asset-tags"]');
  if(button)openTags(button.dataset.uid);
  if(event.target.closest('#asset-tags-dialog [data-tag]'))$('#asset-tags-dialog').close();
 });
 $('#sort').onchange=e=>{state.sort=e.target.value;renderGrid();};
 // 下拉只是类型树的「旧入口」（筛选面板的 chip、语义检索、重置按钮还在写它），
// 落点统一到 applyLocalType：图标点亮、状态清场、重画都只有一处实现，不再各写一份 if。
$('#local-kind').onchange=()=>applyLocalType($('#local-kind').value);
 $('#local-status').onchange=()=>{state.selected.clear();renderGrid();};
 $('#local-feature').onchange=e=>{state.filter=e.target.value;state.selected.clear();renderGrid();};
$('#reset-local-filters').onclick=()=>{
 localSearch.reset();
 semanticSearch?.clear();
 imageSearch?.clear({silent:true});
  $('#search-panel').dispatchEvent(new CustomEvent('search-motion-state',{detail:{reset:true,busy:false}}));
  state.search='';state.filter='all';state.localCategory='';state.selected.clear();
  $('#asset-query').value='';$('#search-clear').hidden=true;$('#search-clear').classList.remove('visible');$('#search-panel').classList.remove('has-search-text');$('#local-kind').value='';$('#local-status').value='';$('#local-feature').value='all';state.libraryMode='';state.contentKind='';state.mode='';state.modelOnly=false;rememberMode('');renderPlatform();
  renderGrid();
 };
 $('#tag-all').onclick=tagAllAssets;
/** 包即真相：评分/备注/AI 标签写进浏览器状态的同时，异步补一份进磁盘 info.json。
 *  只对扫得到的资产包发请求；ZIP 包与未登记包静默跳过（状态才是主存储，失败不打扰用户）。 */
function patchMetaFor(uid){
 const pkg=(localFiles.packages()||[]).find(p=>p.uid===uid);
 if(!pkg||pkg.type==='zip')return;
 const body={root:pkg.root,rel:pkg.rel};
 if(state.aiTags?.[uid]?.length)body.ai={tags:state.aiTags[uid],updatedAt:Date.now()};
 const meta=userMetaFor(state,uid);
 if(meta.rating||meta.note)body.user={rating:meta.rating,note:meta.note};
 if(!body.ai&&!body.user)return;
 fetch('/api/local/meta-patch',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(()=>{});
}
function addUserTagFromDialog(uid){
 const model=findModel(uid);if(!model)return;
 const input=$(`[data-user-tag-input="${CSS.escape(uid)}"]`);
 const value=(input?.value||'').trim();
 if(!value)return;
 const added=addUserTag(state,model,value);
 input.value='';persist();renderTagDialog(uid);renderGrid();
 toast(added?`已添加标签「${value}」`:'这个标签已经有了');
}
// 标签输入框里回车＝添加（按钮是给不想摸键盘的人留的）。
document.addEventListener('keydown',e=>{
 if(e.key!=='Enter')return;
 const input=e.target.closest('[data-user-tag-input]');
 if(!input)return;
 e.preventDefault();addUserTagFromDialog(input.dataset.userTagInput);
});
// 标签管理：重命名 / 合并 / 删除「我的标签」，另带一键清除 AI 标签（AI 的可再生，不值得逐个管）。
function renderTagManage(){
 const tags=listUserTags(state);
 $('#tag-manage-content').innerHTML=tags.length
  ?tags.map(t=>`<div class="tm-row"><span class="tm-name" title="${esc(t.name)}">${esc(t.name)}</span><span class="tm-count">${t.count} 个资产</span><span class="tm-ops"><button type="button" class="text-button" data-tm="rename" data-name="${esc(t.name)}">重命名</button><button type="button" class="text-button" data-tm="merge" data-name="${esc(t.name)}">合并…</button><button type="button" class="text-button tm-del" data-tm="delete" data-name="${esc(t.name)}">删除</button></span></div>`).join('')
  :'<p class="compact-note">还没有「我的标签」。打开资产的标签面板即可添加；AI 整理的标签不在这里管。</p>';
 $('#tag-manage-count').textContent=tags.length?`共 ${tags.length} 个标签 · ${tags.reduce((sum,t)=>sum+t.count,0)} 次引用`:'';
}
function openTagManage(){renderTagManage();const dialog=$('#tag-manage-dialog');if(!dialog.open)dialog.showModal();}
// 本地库体检：面板里那颗盾牌只喊一声，数据与删除动作在这里接（同一条 deleteLibraryAsset）。
window.addEventListener('assetvault:local-health',()=>{
 openLocalHealth({packages:localFiles.packages(),fmtBytes:sizeText,esc,onDelete:deleteLibraryAsset});
});
// 资产检查（查「资产记录 ↔ 磁盘目录」有没有对上：重复卡 / 悬空 / 未登记）已并入「工具检测」面板，
// 这里只负责把入口转过去 —— 筛选面板里那颗扫描图标仍走这个事件。
window.addEventListener('assetvault:asset-audit',()=>toolCheckPanel?.open());
$('#tag-manage').onclick=openTagManage;
document.addEventListener('click',async e=>{
 const op=e.target.closest('[data-tm]');if(!op)return;
 const name=op.dataset.name;
 if(op.dataset.tm==='rename'){
  const next=await askText({title:'重命名标签',message:`把标签「${name}」重命名为：`,value:name,maxLength:40});
  if(!next||next===name)return;
  const count=renameUserTag(state,name,next);
  if(!count)return toast('没找到这个标签，可能已被删除');
  persist();renderTagManage();renderGrid();toast(`已重命名为「${next}」，影响 ${count} 个资产`);
 }
 if(op.dataset.tm==='merge'){
  const target=await askText({title:'合并标签',message:`把「${name}」合并到哪个标签？输入目标标签名：`,value:name,maxLength:40});
  if(!target)return;
  const count=mergeUserTag(state,name,target);
  if(!count)return toast('没找到这个标签，可能已被删除');
  persist();renderTagManage();renderGrid();toast(`已合并到「${target}」，影响 ${count} 个资产`);
 }
 if(op.dataset.tm==='delete'){
  if(!await askConfirm({title:'删除标签',message:`从所有资产上删除标签「${name}」？`,confirmText:'删除',danger:true}))return;
  const count=deleteUserTag(state,name);
  if(!count)return toast('没找到这个标签，可能已被删除');
  persist();renderTagManage();renderGrid();toast(`已删除「${name}」，影响 ${count} 个资产`);
 }
});
$('#tm-clear-ai').onclick=async()=>{
 const total=Object.keys(state.aiTags||{}).length;
 if(!total)return toast('没有 AI 标签可清除');
 if(!await askConfirm({title:'清除 AI 标签',message:`清除全部 ${total} 个资产的 AI 标签？平台标签和我的标签不受影响，之后可重新整理。`,confirmText:'清除',danger:true}))return;
 state.aiTags={};persist();renderTagManage();renderGrid();toast('已清除全部 AI 标签');
};
 let tagBusy=false,tagAbort=false;
  // 打标入参统一在这里拼：meta 是采集时的来源信息（画板 / 类目 / 出处 / 话题），
  // probe 是封面采样出的颜色与构图。老资产两者都没有，服务端提示词与旧版一致。
  const tagInputOf=model=>({name:model.name,author:model.author,kind:localAssetKind(model),existing:tagsFor(state,model),meta:metaOf(model),probe:state.assetProbe?.[model.uid]});
  async function visualTagInput(model){
   // ponytail: reuse the image proxy without its 384px card-only compression.
   const url=visualTagSrc(model.thumbnail);
   if(!url)throw Error('该资产没有可识别的图片');
   const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw Error('图片读取失败，请重试');
   return {...tagInputOf(model),image:await toDataUrl(await response.blob(),1536)};
  }
  async function aiTagThis(uid){
  const model=findModel(uid);if(!model)return;
  if(tagging.has(uid))return;
  const updateButtons=(phase='')=>document.querySelectorAll('[data-action="ai-tags"]').forEach(button=>{
   if(button.dataset.uid!==uid)return;
   const busy=tagging.has(uid);
   button.disabled=busy;button.setAttribute('aria-busy',String(busy));
   button.title=phase||(busy?'正在识别图片内容…':'识别图片内容并保存标签');
   const panel=button.closest('.asset-tags');
   if(!panel)return;
   let progress=panel.querySelector('.ai-tag-progress');
   if(!phase){progress?.remove();return;}
   if(!progress){
    progress=document.createElement('div');progress.className='ai-tag-progress';
    progress.setAttribute('role','status');progress.setAttribute('aria-live','polite');
    progress.innerHTML='<span></span><progress aria-label="标签生成处理中"></progress>';
    panel.querySelector('.tag-section-head').after(progress);
   }
   progress.querySelector('span').textContent=phase;
  });
  // 历史 AI 标签也可能来自元数据推断；仅确认本机实际完成过的视觉识别。
  const regenerate=!!state.aiTags?.[uid]?.length&&storage.getItem(`sfx-visual-tagged:${uid}`)==='1';
  let completed=false;
  tagging.add(uid);updateButtons();
  try{
   if(regenerate&&!await askConfirm({title:'重新生成 AI 标签',message:'将重新识别图片，生成成功后删除旧 AI 标签并替换为新标签。平台标签和手动标签会保留。',confirmText:'重新生成'}))return;
   updateButtons('1/3 · 正在读取图片…');
   const input=await visualTagInput(model);
   if(regenerate)input.existing=tagsFor({...state,aiTags:{}},model);
   updateButtons('2/3 · AI 正在识别，标签即将生成…');
   const data=await tagSuggester(input);
   if(!data.tagged||!data.tags.length){toast(data.reason||'未能生成标签');if(activeTagUid===uid)$('#asset-tags-status').textContent=data.reason||'未能生成标签，可重试。';return;}
   updateButtons('3/3 · 正在保存标签…');
   const added=addAITags(state,model,data.tags,{replace:regenerate});
   completed=true;
   storage.setItem(`sfx-visual-tagged:${uid}`,'1');
   persistNow();patchMetaFor(uid);renderGrid();refreshPreviewTags(uid);
   const message=regenerate?`已重新生成 ${state.aiTags[uid].length} 个 AI 标签，旧 AI 标签已替换。`:added?`已补充 ${added} 个 AI 标签，已自动保存到本机。`:'没有新增标签，原有标签已保留。';
   if(activeTagUid===uid)$('#asset-tags-status').textContent=message;
   toast(message);
  }catch(error){toast(error.message);
  }finally{
   tagging.delete(uid);
   if(activeTagUid===uid)renderTagDialog(uid);
   updateButtons();
   document.querySelectorAll('.asset-tags').forEach(panel=>{
    if(completed&&panel.dataset.assetTags===uid)panel.querySelector('.tag-list')?.classList.add('is-ai-updated');
   });
  }
 }
 async function tagAllAssets(){
  if(tagBusy){tagAbort=true;toast('已请求停止整理');return;}
  // 已选择资产可直接重新识别；未选择时只处理标签偏少的资产，避免整库重复调用。
  const lowTags=state.models.filter(m=>state.selected.size?state.selected.has(m.uid):tagsFor(state,m).length<2);
  const candidates=lowTags.filter(m=>!!cardView.imageUrl(m));
  const skipped=lowTags.length-candidates.length;
  if(!candidates.length){toast(skipped?`${skipped} 个资产没有可用图片，已跳过；没有需要整理标签的资产`:'没有需要整理标签的资产');return;}
  if(!await askConfirm({title:'补充 AI 标签',message:`将为 ${candidates.length} 个库内资产进行视觉识别（将压缩图片发送到已配置的 AI 服务）${skipped?`，另自动跳过 ${skipped} 个没有可用图片的资产`:''}，可能较慢，继续？`,confirmText:'开始整理'}))return;
  tagBusy=true;tagAbort=false;let done=0,failed=0,lastError='';
  try{
   for(const m of candidates){
    if(tagAbort)break;
    if(tagging.has(m.uid))continue;
    tagging.add(m.uid);
    try{
     const data=await tagSuggester(await visualTagInput(m));
     if(data.tagged&&data.tags.length){addAITags(state,m,data.tags);storage.setItem(`sfx-visual-tagged:${m.uid}`,'1');persistNow();patchMetaFor(m.uid);}else{failed++;lastError=data.reason||'未识别出标签';}
    }catch(error){failed++;lastError=error.message;}finally{tagging.delete(m.uid);}
    done++;
    if(done%5===0){persist();renderGrid();toast(`已整理 ${done}/${candidates.length}`);}
   }
  }finally{tagBusy=false;}
  persistNow();renderGrid();
  if(activeTagUid){renderTagDialog(activeTagUid);refreshPreviewTags(activeTagUid);}
  toast(tagAbort?`已停止，整理 ${done} 个资产`:`完成，成功 ${done-failed} 个，失败 ${failed} 个${lastError?` · ${lastError}`:''}`);
 }
 // 展示只有网格 / 瀑布流两种（紧凑列表视图已移除）；按钮高亮由 renderGrid 从 state 推出。
 const setDisplay=view=>{state.gallery=view==='gallery'&&galleryAvailable(state);rememberDisplay(state.gallery?'gallery':'grid');contentModes?.render();renderPlatformOptions();renderGrid();};
 const displayMode=$('#display-mode');
 if(displayMode)displayMode.onclick=()=>{if(!galleryAvailable(state))return;setDisplay(state.gallery?'grid':'gallery');};
 const cardSize=$('#card-size');
 if(cardSize){
  cardSize.step='any';
  // 尺寸区间整体下调（110–240，默认 150）：原来的 140–340 在库内偏大，一屏放不下几张。
  // 顺带换 key（v2）：旧值 190/340 是按老区间调的，留着会显得「还是很大」。
  const SIZE_MIN=110,SIZE_MAX=240,SIZE_DEFAULT=150,SIZE_KEY='assetvault-card-size-v2';
  const saved=Number(localStorage.getItem(SIZE_KEY));
  if(saved>=SIZE_MIN&&saved<=SIZE_MAX)cardSize.value=String(saved);
  const paintSize=()=>{
   const size=Math.max(SIZE_MIN,Math.min(SIZE_MAX,Number(cardSize.value)||SIZE_DEFAULT));
   const style=document.documentElement.style;
   style.setProperty('--lib-col-min',`${size}px`);
   // 间距跟着卡片尺寸走，但比例调小（2026-11-18 反馈瀑布流间隔偏大）：横向 3%、纵向 3.4%。
   style.setProperty('--lib-gap-x',`${size*.03}px`);
   style.setProperty('--lib-gap-y',`${size*.034}px`);
  };
  paintSize();
  let sizeFrame=0,sizeSaveTimer=0;
  const applySize=()=>{
   sizeFrame=0;paintSize();
   window.dispatchEvent(new Event('library-card-size'));
  };
  const saveSize=()=>{clearTimeout(sizeSaveTimer);localStorage.setItem(SIZE_KEY,cardSize.value);};
  cardSize.addEventListener('input',()=>{
   if(!sizeFrame)sizeFrame=requestAnimationFrame(applySize);
   clearTimeout(sizeSaveTimer);sizeSaveTimer=setTimeout(saveSize,200);
  });
  cardSize.addEventListener('change',()=>{
   if(sizeFrame){cancelAnimationFrame(sizeFrame);applySize();}
   saveSize();
  });
 }
 // 「继续检索」推进当前平台的每个源；链接解析结果只有 web 一个源。
const more=options=>{if(state.source==='link')return requestFeed('web',state.feeds.web.request,options);return activeModes().map(mode=>requestFeed(mode,state.feeds[mode].request,options));};
$('#load-more').onclick=()=>more({more:true});$('#load-all').onclick=()=>more({more:true,all:true});
 // 批量入库：一次收完当前筛选结果。走的是和卡片收藏同一条 collect()，只写库记录、不触发下载。
 $('#collect-visible').onclick=async()=>{
  const collected=new Set(state.models.map(model=>model.uid));
  const pick=filtered().filter(model=>!collected.has(model.uid));
  if(!pick.length){toast('当前结果都已在模型库中');return;}
  if(!await askConfirm({title:'加入模型库',message:`把当前 ${pick.length} 个结果加入模型库？只保存记录，不下载文件。`,confirmText:'加入'}))return;
  collect(pick.map(model=>model.uid));
 };
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
 const requestOnlineMore=scrollIdleTask(()=>{
  if(autoLoadBusy)return;
  const f=composite();
  if(state.route!=='discover'||f.busy||f.rows.length>=1000||!(f.next||f.pending.length))return;
  const pagination=$('#pagination');
  if(!pagination||pagination.hidden||pagination.getBoundingClientRect().top>window.innerHeight+320)return;
  autoLoadBusy=true;
  Promise.all([more({more:true})]).catch(()=>{}).finally(()=>{autoLoadBusy=false;});
 });
 const autoLoad=new IntersectionObserver(entries=>{
  if(entries.some(e=>e.isIntersecting))requestOnlineMore();
 },{rootMargin:'320px 0px'});
 autoLoad.observe($('#pagination'));
 // ADR-09：按页启动后浏览器可能只持有一部分目录，先等补齐，再向服务端要全量 uid
 // 集合与本地筛选结果求交 —— 大库下 uid 只有 32 字节，比 model payload 轻两个数量级。
 $('#select-all').onclick=async()=>{
  if(state.route==='discover'){
   for(const model of filtered())if(model.uid)state.selected.add(model.uid);
   syncSelectionUI();return;
  }
  try{await storage?.catalogReady;}catch{}
  const visible=new Set(filtered().map(m=>m.uid));let serverUids=null;
  try{
   const r=await fetch('/api/library/catalog/uids',{headers:{'X-SFX-Local':'1'}});
   if(r.ok){const data=await r.json();if(Array.isArray(data.uids))serverUids=data.uids;}
  }catch{}
  (serverUids?serverUids.filter(uid=>visible.has(uid)):[...visible]).forEach(uid=>state.selected.add(uid));
  syncSelectionUI();
 };
 // 多选栏只保留「选择当前结果 / 取消选择」+ 画板与批量整理（后两个由 board-hub / batch-edit 自己挂）。
 // 原先的加入模型库 / 下载高清图 / 下载选中已按需求移除，这里写成可选链，别让按钮缺席炸掉启动。
 // 取消选择只同步选中态：走 renderGrid 的话，卡片 HTML 与缓存一致时不会重写 DOM，
 // 就地加上去的 selected 反而留在卡上（用户看到「取消了还是绿框」就是这么来的）。
 $('#deselect').onclick=()=>{state.selected.clear();rangeSelect.exitSelectionMode();syncSelectionUI();};
 // 批量删除：默认「移入回收站」（可恢复、不动磁盘）；只有选中里真的有本地文件时，
 // 才多给一颗「连文件删除」，并且必须单独确认 —— 磁盘文件删了不可恢复。
 async function deleteSelectedCards({files=false,rest=false}={}){
  const selected=[...state.selected].filter(Boolean);
  if(!selected.length)return toast('先框选或按住 Shift 选中资产');
  // 只有真正在库里的记录才谈得上删除：发现页里框中的是还没入库的搜索结果，
  // 拿它们去 trashModels 会「一条没动却提示已删除」。
  const byUid=new Map(state.models.map(model=>[model.uid,model]));
  const owned=selected.filter(uid=>byUid.has(uid));
  if(!owned.length)return toast('选中的是还没入库的搜索结果，先加入模型库才有可删的记录');
  const withFiles=owned.filter(uid=>{const model=byUid.get(uid);return model&&(model.filePath||model.root&&model.rel);});
  // 右键「删除选中的 N 个」语义是「全删掉」：有本地文件的连文件删，纯平台收藏的进回收站。
  // 批量栏的「连文件删除 (N)」只处理有文件的那些，不能顺手把其余收藏也移走。
  const restUids=rest?owned.filter(uid=>!withFiles.includes(uid)):[];
  if(files&&!withFiles.length&&!restUids.length)return toast('选中的资产没有本地文件，用「移入回收站」即可');
  const ok=await askConfirm(files?{
   title:`连本地文件一起删除 ${withFiles.length+restUids.length} 个资产`,
   message:restUids.length
    ?`${withFiles.length} 个会连磁盘文件一起删除（不可恢复）；${restUids.length} 个没有本地文件，只移入回收站。`
    :'文件会从磁盘上删除，不可恢复（资产记录同时移除）。其余选中项不受影响。',
   confirmText:'删除',danger:true,
  }:{
   title:`移入回收站 ${owned.length} 个资产`,
   message:'记录移入回收站，随时可以在筛选里选「回收站」恢复；磁盘上的文件不会被删除。',
   confirmText:'移入回收站',danger:true,
  });
  if(!ok)return;
  if(!files){
   await withRemovalMotion(removalCards({uids:owned}),async()=>{
    trashModels(state,owned);state.selected.clear();persistNow();renderGrid();counts();
    // 回收站变化必须落到 DB：只写浏览器 blob 的话，刷新时服务端目录会把记录又合并回来
    // （用户看到的「删了刷新就回来」）。asset:trash 只发 uid，model 由服务端从库还原。
    await trashOnServer(owned);
   });
   toast(`已把 ${owned.length} 个资产移入回收站`);
   return;
  }
  await withRemovalMotion(removalCards({uids:[...withFiles,...restUids]}),async()=>{
   const gone=[];let failed=0;
   for(const uid of withFiles){
    const model=byUid.get(uid);
    try{
     const response=await fetch('/api/library/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid,root:model?.root||'',rel:model?.rel||'',thumbnail:model?.thumbnail||''})});
     const data=await response.json().catch(()=>({}));
     if(!response.ok)throw Error(data.error||'删除失败');
     gone.push(uid);
    }catch{failed++;}
   }
   if(restUids.length){trashModels(state,restUids);await trashOnServer(restUids);}
   // 只摘掉真删掉的那些：失败的记录留着，否则卡片消失、文件还在，用户无从下手。
   if(gone.length){
    const set=new Set(gone);
    state.models=state.models.filter(m=>!set.has(m.uid));
    if(state.trashed)state.trashed=state.trashed.filter(m=>!set.has(m.uid));
    for(const uid of set){state.favorites?.delete(uid);state.selected?.delete(uid);if(state.userMeta)delete state.userMeta[uid];if(state.userTags)delete state.userTags[uid];if(state.aiTags)delete state.aiTags[uid];}
   }
   state.selected.clear();
   persistNow();renderGrid();counts();
   // 重扫：文件确实从盘上删了，但本地文件列表/包内清单还是旧快照，
   // 不重扫的话这些条目会以「打不开的破图卡」留在界面上，看着像没删掉。
   await scanLibraryFiles(true).catch(()=>{});
   const totalGone=gone.length+restUids.length;
   toast(failed?`已删除 ${totalGone} 个，${failed} 个没删掉（可能不在可删除目录）`:`已删除 ${totalGone} 个资产${gone.length?'与本地文件':''}`);
  });
 }
 /** 把回收站变更写进 DB。失败不拦流程：下次任何一次正常保存都会再翻译出同一批 op。 */
 async function trashOnServer(uids){
  const list=(uids||[]).filter(Boolean);
  if(!list.length)return;
  try{
   await fetch('/api/library/assets/mutate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ops:list.map(uid=>({op:'asset:trash',uid}))})});
  }catch{}
 }
 $('#delete-selected')?.addEventListener('click',()=>deleteSelectedCards());
 $('#delete-selected-files')?.addEventListener('click',()=>deleteSelectedCards({files:true}));
 bindLibraryShortcuts({enabled:()=>state.route==='library',getBindings:()=>state.options.libraryShortcuts||{},commands:{
  search:()=>{$('#asset-query')?.focus();$('#asset-query')?.select();},
  selectAll:()=>$('#select-all')?.click(),
  deselect:()=>$('#deselect')?.click(),
  back:()=>{
   $('#deselect')?.click();
   if(cardGroups?.active()){$('[data-group-back]')?.click();return;}
   if(localFiles.albumFolderActive()){$('#album-folder-nav')?.click();return;}
   if(boardHub?.store.activeId)void boardHub.openAll();
  },
  import:()=>{if(!visitor)$('#local-import')?.click();},
  newBoard:()=>{if(!visitor)$('#board-deck-new')?.click();},
  delete:()=>{if(state.selected.size&&!visitor)void deleteSelectedCards();},
  preview:()=>{if(state.selected.size===1){const uid=[...state.selected][0];const card=[...document.querySelectorAll('#grid [data-uid]')].find(card=>card.dataset.uid===uid);const hit=card?.querySelector('.preview-hit,[data-action="preview"]');if(hit)hit.click();else if(card)card.click();}},
 }});
 $('#collect-selected')?.addEventListener('click',()=>collect([...state.selected]));
 $('#download-selected')?.addEventListener('click',()=>requestDownload([...state.selected]));
 $('#download-images-selected')?.addEventListener('click',()=>imageDownload.requestImages([...state.selected]));

// 关弹窗要停掉 three.js 的渲染循环并释放 GPU 资源 —— 只清iframe 的 src 的话，Poly Haven
// 的 canvas 会继续每帧渲染，白烧 CPU/GPU 直到页面刷新。
//
// 外站 iframe 关闭时也清空文档，释放模型、WebGL 上下文和站点后台任务。
//
// close 事件是**排队异步派发**的，而「上一个弹窗还开着就点下一个资产」这条路是
// close() → showModal() → gltfPreview.load() 同步走完的：新预览的 load 先占了 loadToken，
// 这个迟到的 close 再跑一遍就会把 token 作废、canvas 藏起来，于是新资产永远等不到自己的
// 加载回调——表现就是「第一个模型能看，之后每个都是黑屏」。所以弹窗若已经重新打开，
// 这属于上一轮的收尾，一律跳过。
$('#preview-dialog').addEventListener('close',()=>{
  if($('#preview-dialog').open)return;
  resetPolyforkDetails();
  gltfPreview.close();
  // 外站viewer即使隐藏也持有独立文档和WebGL资源。
  const viewer=$('#viewer');viewer?.removeAttribute('src');viewer?.removeAttribute('srcdoc');
});
 document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
 $('#settings-button').onclick=openSettings;$('#help').onclick=()=>openHelp();
 hookDiagnostics();
 initFeedbackPanel();
 const aiSettings=createAISettings({$,toast});
 appUpdates=createAppUpdates({hasActiveTasks:()=>downloads.activeCount()>0,onState:detail=>assistant.notify({type:'update',detail})});
 const sharing=createLanSharingSettings({toast});
 // 成员 / 备份的管理入口只挂在主机：LAN 访客的设置面板整体是隐藏的（见 settings-panel.js），
 // 那里既读不到本机目录也不该改别人的权限。权限本身由服务端按会话判定，与这里是否显示无关。
const team=visitor?null:createTeamSettings({toast,ask:message=>askConfirm(message)});
// 开机自启只在桌面版存在：浏览器里打开资产库拿不到原生桥，卡片直接不出现（返回 null）。
const autostart=visitor?null:createAutostartCard({toast});
const appearance=createAppearanceCard({toast});
// 云同步是主机级配置（凭据 + 整库快照），访客不该看到，也不该能触发同步。
const cloudSync=visitor?null:createCloudSyncCard({toast});
settingsPanel=createSettingsPanel({$,libraryShortcuts:{getBindings:()=>state.options.libraryShortcuts||{},setBindings:bindings=>{state.options.libraryShortcuts=bindings;persistNow();}},ensureCanvas:enterCanvas,loadAI:()=>aiSettings.load(),updateCard:appUpdates.card,sharing,team,migrate:backupPanel?.card,stores:storePanel?.card,desktop:autostart,appearance,sync:cloudSync,platformCard:createPlatformSettingsCard({settings:platformSettings,toast}),autoSave:commitSettings});
 // 高级检索 / 合集：面板自建 DOM，只把命中集合注入 state.queryUids（见 filtered()）。
 // 局域网访客不挂本地库专用入口，避免出现点了却被服务端拒绝的死按钮。
 if(!visitor){
  const query=createAdvancedQuery({$,state,renderGrid,toast,esc,icon,resetPaging:paging.reset,formatFilter});
  // 封面探测：颜色 / 宽高比所需的主色与尺寸缓存。同源缩略图用 canvas 采样，
  // 结果写进 state.assetProbe 走既有差量写入通道；扫描进度只发事件，不反向依赖 UI。
  const probe=createAssetProbe({state,save:persistNow,
   onProgress:()=>window.dispatchEvent(new CustomEvent('assetvault:probe-progress'))});
  // 常驻筛选图标条：与高级检索共用同一份控件与状态，点击图标展开对应维度面板。
  filterDock=createFilterDock({$,state,esc,toast,controls:query.controls,probe,packages:()=>localFiles.packages()});
  // 画板中枢：右键/批量加入画板 + 智能收集规则面板 + 待合并队列合并。
  // 自建 DOM，不改 index.html；纯文件模式下画板路由 503，中枢只提示不崩。
  boardHub=createBoardHub({$,state,esc,icon,toast,storage,persistNow,renderGrid,controls:query.controls});
  // 画板卡片区挂在主网格上方：每帧 renderGrid 顺带重画它（路由切换 / 画板集合变化都要跟）。
  view.setBoardDeck(boardHub.deck);
  cardGroups=createCardGroupUI({state,localFiles,cardView,readKind:()=>state.contentKind||activeLocalKind(),findModel,esc,icon,persist:persistNow,render:()=>renderGrid(),toast,enabled:()=>!visitor&&!boardHub?.store.activeId});
  // 卡片直接拖到画板卡上 = 加入该画板。
  createBoardDrop({
    cardDrop:cardGroups,
    api: boardHub.api,
    toast,
    selected: () => state.selected,
    albumKey:card=>localFiles.packages().some(pkg=>pkg.category==='images'&&`${pkg.root}|${pkg.rel}`===card.dataset.package)?card.dataset.package:null,
    onAlbumDrop:(key,id)=>addAlbumToBoard(localFiles.packages().find(pkg=>`${pkg.root}|${pkg.rel}`===key),undefined,id),
    boards: () => boardHub.store.list(),
    onAdded: () => boardHub.store.refresh().catch(() => {}),
  }).setup();
  // 外部文件 / 文件夹拖入：弹面板选画板后上传入库。挂在画板中枢之后，直接复用它的 store。
  setupDropImport({toast,visitor,store:boardHub.store,onImported:()=>scanLibraryFiles(true)});
 }
 if(!visitor)renderExportTargets({preserve:false});
 // S3-c：订阅服务端的变更广播。别人改了标签 / 评分 / 收藏，这边的卡片跟着更新，
 // 不用整页刷新（50 万资产下整页刷新是不可接受的）。
 // 只拉「变了的那几个 uid」的用户可变部分，不搬整行模型。
 liveEvents=createLibraryEvents({
  url:'/api/library/events',
  onChange:async change=>{
   // 文件夹实时监控：磁盘上的资产根变了（拖进一个包 / 删掉一个文件），立刻按增量重扫。
   // 不传 force —— 服务端缓存层已经知道哪些路径变了，全量重扫在几十万资产下会卡住主线程。
   if(change.local)scanLibraryFiles(false);
   if(change.all){if(isDropImporting())return;state.onRemoteRefresh?.();return;}
   if(!change.uids.length)return;
   try{
    const response=await fetch('/api/library/assets/detail',{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify({uids:change.uids})});
    if(!response.ok)return;
    const {details=[]}=await response.json();
    // 覆盖后**不落盘**：落盘会写回服务端，等于把别人的改动再广播一遍，形成回环。
    const result=applyRemoteDetails(state,details);
    if(result.changed){renderGrid();counts();}
   }catch{}
  },
 });
 liveEvents.start();
 // 只有「分享真的挂了（端口冲突）」才自动掀开设置页；仅端口变更提示不打断启动。
 if(!visitor)sharing.check().then(data=>{if(data.portConflict)settingsPanel.open('sharing');}).catch(error=>toast(error.message));
 if(canManageUpdates){window.addEventListener('assetvault:open-updates',()=>appUpdates.open());appUpdates.start();}
 $('#open-setup-wizard').onclick=()=>{$('#settings-dialog').close();setupWizard?.open();};
 // 偏好设置自动保存：改完即写，没有保存键。写不进去就先出声（toast），再把错抛给设置面板标「保存失败」。
 async function commitSettings(){
  try{
   await downloads.saveSettings({concurrency:Number($('#backend-concurrency').value),retryLimit:Number($('#backend-retries').value)});
   state.options={packMode:$('#pack-mode').value,maxTextureEdge:Number($('#texture-size').value),output:'folder',format:'fbx',downloadTextures:true,pngOnly:true,fastZip:true,scanLimit:Number($('#scan-limit').value),optionsVersion:3};
   // 导出目标路径：逐个回写后端配置（空值表示清除）。
   for(const t of exportTargetsCache){if(t.kind!=='dir')continue;const inp=$(`[data-export-path="${t.id}"]`);if(!inp)continue;try{await fetch('/api/exports/configure',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({targetId:t.id,path:inp.value.trim()})});}catch{}}
   persist();
  }catch(error){toast(`设置没写进去：${error.message}`);throw error;}
 }
 $('#clear-library').onclick=async()=>{if(await askConfirm({title:'清空本地模型库',message:'清空本地模型库与收藏？在线结果、下载记录和已下载文件不会被删除。',confirmText:'清空',danger:true})){state.models=[];state.favorites.clear();state.selected.clear();persistNow();renderGrid();}};
 window.addEventListener('pagehide',persistNow);
  // 顶部那条状态栏（连接指示灯 + 头像）已撤掉，所以这里不再往元素里写状态：
 // 连上了就安静地做「首次进入自动检索」，连不上才出声（状态行 + 一条提示）。
 // Online categories, font loading and disk validation must not gate the local interface.
 Promise.allSettled([waitForInitialCategories(),artFilters]).then(()=>{
  filterTrees.refresh();mergedFilters?.refresh();renderPlatform();
 });
 filterTrees.refresh();mergedFilters?.refresh();renderPlatform();renderGrid();fillIcons();
 $('#search-panel').setAttribute('data-search-ready','');
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 syncStickyOffset();
 document.documentElement.dataset.uiReady='true';
 window.dispatchEvent(new Event('assetvault:ui-ready'));
 fetch('/api/health').then(r=>{if(!r.ok)throw Error();return r.json();}).then(async()=>{
  await Promise.allSettled([waitForInitialCategories(),artFilters]);
  if(!activeModes().length){
   // 图站没有检索流：刷新页面后仍停在这个平台时，也先铺一屏首页推荐，
   // 否则恢复出来的是一大片空白（用户 2026-11-03 反馈「选了平台却只有说明文字」）。
   if(state.route==='discover'&&isPictureSite(state.platform)){if(!state.pictureSite)feed.openPictureHome?.(state.platform);}
   else if(state.route==='discover')$('#asset-query').placeholder='所有平台已关闭，可在设置 → 平台模块中开启';
   return;
  }
  try{const warm=activeModes().some(mode=>state.feeds[mode].rows.length);if(!warm&&activeModes().every(mode=>!state.feeds[mode].request&&!state.feeds[mode].busy&&!state.feeds[mode].rows.length)&&state.route==='discover'&&!$('#asset-query').value.trim())startSearch();}
  catch(error){const feed=state.feeds[activeModes()[0]||'search'];feed.status=`初始化搜索失败：${error.message}`;feed.error=true;renderStatus();toast(feed.status);}
 },()=>{state.feeds[activeModes()[0]||'search'].status='本地服务未连接，请重新启动 Arvimo · 艺团。';state.feeds[activeModes()[0]||'search'].error=true;renderStatus();toast('本地服务未连接：卡片动作都依赖本地服务');});
}

setup().catch(error=>{
 console.error('界面初始化失败',error);
 window.dispatchEvent(new CustomEvent('assetvault:ui-error',{detail:error.message||'界面初始化失败，请刷新重试'}));
});
