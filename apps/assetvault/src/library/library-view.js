// The library's rendering layer: counts/status line, grid & waterfall, filter placement, preview.
//
// These five functions are one concern — turn app state into DOM — and they only ever read state
// that another module owns. Splitting them out keeps app.js responsible for *deciding* what is true
// (which feed answered, what is selected, what is queued) and this file for *drawing* it.
// Collaborators that only exist once the app has finished wiring itself arrive as getters.
import {statusText,subtitleText,pageInfoNote,describeRequest,SOURCE_LABELS} from './discovery-view.js';
import {aspectRatioStyle,displayGridClass,galleryAvailable} from './gallery-view.js';
import {platformById,isPictureSite,pictureSiteLoginable,pictureSiteSearchable,platformLabel} from './platforms.js';
import {bindSiteLogin,markSiteLogin} from './site-login.js';
import {modePresetById} from './mode-presets.js';
import {kindById} from './content-kind-tabs.js';
/** 展示区标题带上当前模式，让人一眼看出这一屏是哪一类资源（模式是显式主状态）。 */
const modeTitlePrefix=state=>{const preset=modePresetById(state.mode);return preset?`${preset.label} · `:'';};
import {findLocalJob} from './blender-send.js';
import {openExternal} from './open-url.js';
import {pictureSiteJobUid} from './platforms.js';
import {observeMasonry} from './masonry.js';
import {assetCard} from './card-shell.js';
import {openPolyforkPreview} from './polyfork-params.js';
import {previewActions} from './preview-actions.js';
import {favoriteUid,registerFavoriteTarget,favoriteButtonHtml} from './favorite-targets.js';
import {previewDocumentFor,observeUiPreviews,fetchUiCode,uiSourceText} from './ui-element-preview.js';
import {localAssetCategories} from './local-filters.js';

/**
 * 筛选始终留在侧栏容器；窄屏通过分类抽屉访问，不占用搜索卡片。
 *
 * 这份清单是「平台筛选面板」的权威名单：搬进侧栏靠它（placeFilters），
 * 显隐靠 app.js 的 renderFilters 问同一个注册表。两处各写一份早晚会打架，
 * 所以 app.js 从这里导入，不再另起一份。
 *
 * 存 DOM id（不带 #）：与 platforms.js 里 platforms[].filters 的写法一致。
 */
export const FILTER_ROWS=['filters-sketchfab','filters-artstation','filters-polyhaven','filters-ambientcg','filters-polypizza','filters-kenney','filters-freestylized','filters-polyfork','filters-uiverse','filters-fab','filters-merged','filters-all'];

export function createLibraryView(ctx){
 const {$,icon,esc,fmt,state,queuePulse,cardView,composite,filtered,activeModes,galleryActive,categories,describeArt,artstationUI,downloadsUI,filterTreesUI,mergedFiltersUI,findModel,sendControl,isVisitor=false,imageDownload,gltfPreview,extraCards=()=>[],openPictureBoard,openPictureAuthor,backToPictureBoards,toast,openImageGallery,refreshAssets=()=>{},pageRows=rows=>rows,reloadPictureSite=()=>{},openPictureUrl=()=>{}}=ctx;
 const masonry=observeMasonry($('#grid'));
// 缩略图确认加载失败的在线条目（Sketchfab 图床 404，基本等于模型已下架）：记住 uid，
// 翻页、换视图、收藏重渲染都不会再把空卡片画回来。会话级即可，下次搜索换一批结果。
const coverErrorsBound=new WeakSet(),coverRatiosBound=new WeakSet();
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
 // 检索中的进度由顶部小猫播报，取消键搬进结果头部的 .picture-site-bar；
 // 这一行只剩失败、中止，以及链接解析的返回按钮，正常搜索时整条不占位。
 const warnings=(f.warnings||[]).filter(text=>!/本轮跳过|没有对应分类|没有匹配/.test(text));
 const noteworthy=f.error||f.aborted||state.source==='link';
 el.classList.toggle('idle',!noteworthy);el.classList.toggle('error',f.error);
 el.replaceChildren();
 if(!noteworthy)return;
 const span=document.createElement('span');span.textContent=statusText({sources:f.sources,feeds:state.feeds,platform:state.platform});el.append(span);
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
 const signature=items.map(item=>item.key).join('|')+(gallery?'#g':'');
 const oldCards=[...grid.querySelectorAll(':scope > .model-card[data-uid]')];
 // 阶段 3：本地库点「加载更多」时，旧卡片正好是新窗口的前缀 —— 走增量插入，
 // 否则每次多画 60 张都要把已有卡片整块重建一遍，反倒更慢。
 const pagingPrefix=!online&&oldCards.length>0&&models.length>oldCards.length&&
  oldCards.every((card,index)=>models[index]?.uid===card.dataset.uid);
 const appending=(online||pagingPrefix)&&oldCards.length>0;
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
 // 刚写完 DOM，就在同一个任务里把坐标摆好：等到下一帧再量的话，中间那一帧卡片全叠在
 // 左上角、网格高度还是 0，切页面 / 切瀑布流 / 切内容模式时看到的那一下闪就是它。
 if(gallery)masonry.flush();
}
function renderDisplayButtons({boards=false}={}){
 const button=$('#display-mode');
 if(!button)return;
 const gallery=galleryActive(state);
 // 是否可用只看 galleryAvailable：能画网格的地方都能切瀑布流（下载页没有卡片网格）。
 const available=!boards&&galleryAvailable(state);
 button.disabled=!available;
 button.classList.toggle('active',gallery);
 button.setAttribute('aria-pressed',String(gallery));
 button.title=available?(gallery?'瀑布流，再点回到网格':'网格，再点换成瀑布流'):'网格';
 button.setAttribute('aria-label',button.title);
 button.innerHTML=icon(gallery?'masonry':'grid');
}
/** 画板卡片区由画板模块装配后注入：绘制层只负责「每帧通知它重画」，不管它画什么。 */
let boardDeckHook=null;
function setBoardDeck(deck){boardDeckHook=deck;deck?.render?.();}
/**
 * 给 UI 元素卡片挂动效预览。
 *
 * 只有 UI 元素这一类卡片需要 —— 其它平台的封面就是一张图，不用管。
 * 交给 observeUiPreviews 之后，它会在卡片滚进视口时才去取代码并渲染，
 * 几十张卡片不会一上来就全跑动画。
 */
function mountUiPreviews(rows){
 const list=(rows||[]).filter(m=>m&&(m.assetType==='uielement'||m.platform==='uiverse'));
 if(!list.length)return;
 observeUiPreviews($('#grid'),new Map(list.map(m=>[m.uid,m])));
}
/**
 * 标题行的状态胶囊：把原来单占一行的说明压成一段关键词，整句留在 title 里。
 *
 * 为什么全平台都收进这一枚胶囊：模型平台过去是「标题 / 说明」两行，图站是「标题 / 作者 / 工具条」三行，
 * 用户 2026-11-09 反馈「还是有两行、不同平台样式能不能统一点」。现在两边都是
 * 「标题 + 数量徽标 + 胶囊 … 动作 + 视图键」一条线，位置、外观、字号全部一致。
 */
function setHeaderNote(label,title){
 const el=$('#library-subtitle');
 if(!el)return;
 el.hidden=!label;
 el.textContent=label||'';
 el.title=title||label||'';
}
/** 胶囊里显示的关键词：能一眼看明白「加载到哪了」，细节（未自动入库 / 不会发在线搜索…）在 title。 */
function headerNoteLabel(state,{source,platform,feeds,count,pages,localCount}){
 if(state.route!=='discover')return '';
 if(source==='link')return `${count} 个 · 链接解析`;
 if(platform==='all'){
  const parts=Object.keys(feeds||{}).filter(mode=>feeds[mode].request||feeds[mode].rows.length).map(mode=>`${SOURCE_LABELS[mode]||mode} ${feeds[mode].rows.length}`);
  return parts.length?`${parts.join(' / ')}${pages>1?` · 第 ${pages} 页`:''}`:`${count||localCount||0} 个`;
 }
 return `${count} 个${pages>1?` · 第 ${pages} 页`:''}`;
}
function renderGrid(){
 renderLocalFilters();
 // 外壳（命令条 / 标题行 / 视图键）的归属先定，再走下面任何分支。
 // 命令条 #local-toolbar 只服务本地资产（类型 / 文件状态 / 颜色 / 标签 / 评分 / 收藏 / 格式 / 扫描），
 // 对发现页的平台检索完全无效 —— 所以发现页一律收起，本地库才亮。
 // 必须先于图站早退：图站视图也走本函数的前置 return，晚一步它就会带着上一屏的可见状态留在发现页。
 const online=state.route==='discover';
 const heading=document.querySelector('.library-heading');
 const displayTools=document.querySelector('.display-tools');
 // 发现页的右簇统一挂在 #heading-right：状态胶囊、分页参数、视图键是一条功能栏，
 // 本地库那几屏仍把视图键搬回 #local-toolbar（那边是本地资产的命令条）。
 const headingRight=document.getElementById('heading-right');
 if(heading&&displayTools){
  const host=online?(headingRight||heading):$('#local-toolbar');
  // ponytail: 复用同一批控件，ID / 事件 / 视图状态都不搬，只换挂载点。
  if(host&&displayTools.parentElement!==host)host.append(displayTools);
  heading.hidden=!online;
 }
 // 顶部功能栏里的分页 / 入库控件只服务发现页的模型结果；图站与本地库各有自己的一套。
 const discoveryControls=$('#discovery-controls');
 if(discoveryControls)discoveryControls.hidden=!online||!!state.pictureSite;
 $('#local-toolbar').hidden=online;
 $('#clear-library').hidden=online;
 // 图站（素材下载器整合）：粘贴图站链接进入此模式，画廊渲染整站图片而非 3D 模型卡片，
 // 复用搜索框与图片下载管线。普通模型网格逻辑一律跳过，避免两套卡片混进同一张网格。
 // 只在发现页认它：结果会跨页面保留，去资产库 / 下载页时不能把这一屏顶到本地资产前面。
 if(state.pictureSite&&state.route==='discover'){$('#result-actions').hidden=true;document.body.dataset.route=state.route;renderPictureSite();boardDeckHook?.render?.();return;}
 $('#grid').className=displayGridClass(state);
 $('#model-count').hidden=false;
 const libraryTitle=$('#library-title');
 if(libraryTitle){libraryTitle.hidden=false;if(libraryTitle.parentElement)libraryTitle.parentElement.hidden=false;}
 // 两个平台的卡片共用同一张模型网格（卡片按 platform 走各自的下载通道）。
 // 网格内容由 composite() 决定：搜索时是当前平台各流交错的结果，链接解析时是解析结果。
 const f=composite(),models=filtered(),gallery=galleryActive(state);
 const translation=$('#discovery-translation');
 translation.textContent=online&&state.source!=='link'?[...new Set(f.sources.map(mode=>state.feeds[mode].translation).filter(Boolean))].join(' · '):'';
 translation.hidden=!translation.textContent;
 $('#model-count').textContent=models.length;$('#library-title').firstChild.textContent=modeTitlePrefix(state)+(online?describeRequest({source:state.source,platform:state.platform,feeds:state.feeds,categories:categories,describeArt:request=>describeArt(request)}):state.route==='favorites'?'我的收藏':'我的模型库')+' ';
  const subtitle=online?subtitleText({source:state.source,platform:state.platform,feeds:state.feeds,count:f.rows.length,pages:f.pages,request:f.request,categories:categories}):state.search?`在本地库中匹配 “${state.search}” · 不会发起在线搜索`:`本地已保留 ${state.models.length} 个模型 · 在线结果与本地库独立`;
  // 只留关键词在标题行里，整句进 title —— 与图站的数量胶囊同一个位置、同一套外观。
  setHeaderNote(headerNoteLabel(state,{source:state.source,platform:state.platform,feeds:state.feeds,count:f.rows.length,pages:f.pages,localCount:models.length}),subtitle);
  // 左侧平台名旁边已有「N 个」，标题旁那枚数字徽标就重复了 —— 发现页撤掉它，
  // 本地库那几屏仍保留（那里徽标是「匹配数 / 总数」，胶囊只写状态）。
  $('#model-count').hidden=online;
  $('#library-author').hidden=true;
  if(online)renderModelHead({f,subtitle});else clearPictureHead();
 // 批量入库入口按 2026-11-12 反馈从顶部功能栏撤下：节点 / ID / onclick 都留着
 //（卡片级入库、契约测试与将来恢复入口都用同一条链路），只是不再点亮。
 const actions=$('#result-actions');
 if(actions)actions.hidden=true;
 // 空结果时顶部只留平台 / 数量胶囊，别摆一排点不动的分页键。
 if(discoveryControls)discoveryControls.hidden=discoveryControls.hidden||!models.length;
 $('#local-facets').hidden=online;
 if(!online){
  const total=state.filter==='trash'?(state.trashed||[]).length:state.route==='favorites'?state.models.filter(model=>state.favorites.has(model.uid)).length:state.models.length;
  $('#local-results').textContent=models.length===total?`${total} 项`:`${models.length}/${total}`;
  $('#local-results').title=downloadsUI()?.connected?'当前匹配数量 / 资产总数':'下载服务未连接，文件状态暂不可用';
  $('#local-status').disabled=!downloadsUI()?.connected;
  $('#reset-local-filters').hidden=!(state.localCategory||state.search.trim()||state.filter!=='all'||$('#local-kind').value||state.contentKind||$('#local-status').value||state.queryUids);
 }
 document.body.dataset.route=state.route;
 // ponytail: reuse the existing online selectors; local sorting stays in its own toolbar.
 $('#unified-kind-wrap').hidden=!online||state.platform!=='all';
 $('#unified-sort-wrap').hidden=!online||state.platform!=='all';
 if(!online){
  $('#library-title').firstChild.textContent=modeTitlePrefix(state)+(state.filter==='trash'?'回收站 ':state.route==='favorites'?'我的收藏 ':'我的资产库 ');
  // 本地库这几屏：徽标已经是「匹配 / 总数」，胶囊只写状态词。
  setHeaderNote(state.filter==='trash'?'回收站':state.route==='favorites'?'我的收藏':state.search?`匹配 “${state.search}”`:'本地库',
   state.filter==='trash'?'移除的资产先在这里暂存，可恢复或彻底删除':'入库保存资源记录，下载后可使用本地文件');
 }
 // 网格 / 瀑布流互斥，按钮状态只由这里的状态推导，不在点击处理里各写一遍。
 $('#grid').classList.toggle('gallery',gallery);$('#grid').classList.toggle('loading',online&&f.busy&&!models.length);$('#grid').setAttribute('aria-busy',online&&f.busy?'true':'false');
 renderDisplayButtons();
 // 只在绘制层分页：models 仍是筛选后的完整集合，计数 / 空状态 / 全选都按全量算。
 paintGrid(pageRows(models),gallery,online,f.busy);
 // UI 元素卡片挂动效预览：网格画完再挂，滚进视口才去取代码。
 mountUiPreviews(pageRows(models));
 $('#empty').hidden=models.length>0||(online&&f.busy);
 const searched=state.source==='link'?!!state.feeds.web.request:activeModes().every(mode=>!!state.feeds[mode].request);
 $('#empty h3').textContent=online?(f.error?'暂时无法获取资产':searched?'没有找到匹配的资产':'从一个关键词开始'):state.route==='favorites'?'还没有匹配的收藏':'模型库，留给真正想用的资产';
 $('#empty p').textContent=online?(f.error?'检查网络后重新搜索。旧结果不会被失败请求覆盖。':searched?`试试更短的关键词、英文关键词，或减少筛选条件。${state.platform==='artstation'?'ArtStation 上的 Marmoset Viewer 作品只占搜索结果的一部分。':''}`:'直接输入关键词，或选择上方的推荐词。'):state.search||state.filter!=='all'?'尝试清除本地搜索与筛选条件。':'去“发现资产”搜索，点击加入模型库或爱心收藏，即可在这里保留。';
 $('#empty-explore').hidden=online&&f.busy;
 // 登录键默认收起：只有「图站空状态且这个站有登录入口」那一支才点亮它，
 // 否则从图站切回 3D 平台时会留下一颗指向别的站的登录键。
 // （用可选链：老进程/老壳子里可能还没有这颗键，缺了也不该把整个网格绘制打断。）
 $('#empty-login')&&($('#empty-login').hidden=true);
 if(online&&!activeModes().length){
  // 图站没有关键词检索流，空网格要说清「这一步该做什么」——而且要先分清这个站到底能不能搜。
  // 能搜的站（小红书 / Pinterest / 花瓣…）过去被这段写死的「按链接解析」误导：展示区教人粘链接，
  // 用户就以为它搜不了关键词。现在按 pictureSiteSearchable 分两种文案，搜索/登录入口都摆在卡片里。
  const picture=isPictureSite(state.platform),current=platformById(state.platform);
  const searchable=picture&&pictureSiteSearchable(state.platform);
  const loginable=picture&&pictureSiteLoginable(state.platform);
  const loginWhy=current.loginFor?`${current.loginFor}需要先登录`:'这个站需要登录态';
  // 标题沿用图站占位符那一套说法（`输入关键词搜索 X`），不必再给中文站名硬凑一个空格。
  $('#empty h3').textContent=picture?(searchable?`搜索 ${current.label}`:`${current.label} 按链接解析`):'所有平台已关闭';
  $('#empty p').textContent=picture?(searchable
   ?`输入关键词回车即可搜索 ${current.label}${loginable?`（${loginWhy}，点下面的键扫码一次即可）`:''}；也可以粘笔记 / 作品页 / 博主主页地址。`
   :`把 ${current.label} 的作品页 / 标签页地址粘到上方搜索框，回车即可解析整站图片。`):'在设置 → 平台模块中开启需要的平台后，即可搜索在线资产。本地资产仍可使用。';
  // 「浏览热门资产」是 3D 平台的入口（写死 sort:'popular' 去检索），图站上没有对应的推荐流，
  // 点它只会打一个空请求出去 —— 图站的空状态只留登录键与说明。
  $('#empty-explore').hidden=picture;
  const loginKey=$('#empty-login');
  if(loginKey)loginKey.hidden=!loginable;
  if(loginable)bindSiteLogin(loginKey,state.platform,{toast,onClosed:async()=>{
   // 登录完原地重跑：手上那一次解析（关键词 / 链接）优先，没搜过就退回站点首页推荐。
   const reloaded=await reloadPictureSite?.();
   if(!reloaded)toast?.('登录已完成，在上方输入关键词即可搜索');
  }});
 }
// 链接解析（文本 / 视频）：没有聚合源，空状态要指出「粘链接」这条路，
// 而不是沿用上面「所有平台已关闭」的兜底文案。放在原块之后覆盖，避免改动那一大段图站分支。
if(online&&!activeModes().length&&platformById(state.platform).link){
 $('#empty h3').textContent='粘贴链接开始解析';
 $('#empty p').textContent='视频 / 文本暂无公开聚合源：把视频页、文档页或直链地址粘到上方搜索框，回车即可解析成卡片。要按类型筛本地文件，去「资产库」点同一枚图标。';
 $('#empty-explore').hidden=true;
 const linkLogin=$('#empty-login');
 if(linkLogin)linkLogin.hidden=true;
}
if(!online){
  // 图标模式选的是「文本 / 视频」这类下拉里没有的类型，它同样是一种收窄 —— 不算的话，
  // 筛到 0 条会显示「收集第一项资产」并弹出「浏览热门资产」（一点就离开资产库）。
  const narrowed=state.localCategory||state.search.trim()||state.filter!=='all'||$('#local-kind').value||state.contentKind||$('#local-status').value||state.queryUids;
  if(state.filter==='trash'){
   $('#empty h3').textContent='回收站是空的';
   $('#empty p').textContent='在模型库里点移除键，资产会先放到这里，随时可以恢复。';
  }else if(state.contentKind&&!state.search.trim()){
   // 类型模式筛空了：说清是「这一类还没有」，并指明怎么退出去，别让人以为库是空的。
   const label=kindById(state.contentKind)?.label||'这类';
   $('#empty h3').textContent=`本地还没有「${label}」资产`;
   $('#empty p').textContent='再点一次顶部同一个图标即可退出类型筛选，回到全部资产。';
  }else{
  $('#empty h3').textContent=narrowed?'没有匹配的资产':state.route==='favorites'?'还没有收藏':'为下一个项目，收集第一项资产';
  $('#empty p').textContent=narrowed?'试试其他关键词或类型，或点击“清除筛选”恢复全部资产。':'前往“发现资产”，将需要的资源加入资产库。入库记录与本地下载文件分别管理。';
  }
  $('#empty-explore').hidden=!!narrowed||state.filter==='trash';
}
 document.querySelectorAll('.thumbnail').forEach(img=>{
  if(coverErrorsBound.has(img))return;
  coverErrorsBound.add(img);
  img.addEventListener('error',()=>{
  // 缩略图的网络/代理错误不等于资产下架：保留卡片与下载入口。
  const placeholder=document.createElement('div');
  placeholder.className='image-placeholder';
  placeholder.innerHTML=`${icon('cube')}<span>缩略图加载失败</span>`;
  // 瀑布流里别让一批裂图集体塌成 CSS 的 1:1：把条目宽高（或已纠正过的比例）接到占位块上。
  const ratio=aspectRatioStyle(img.dataset.w,img.dataset.h)||img.style.aspectRatio||'';
  if(ratio)placeholder.style.aspectRatio=ratio;
  img.replaceWith(placeholder);
 },{once:true});
 });
 // 搜索结果里没有宽高，瀑布流只能先按方形占位；图片解码后再把真实比例写回，列高一次纠正到位。
 if(gallery)document.querySelectorAll('#grid .thumbnail').forEach(img=>{
  const apply=()=>{const ratio=aspectRatioStyle(img.naturalWidth,img.naturalHeight);if(ratio)img.style.aspectRatio=ratio;};
  if(img.complete)apply();else if(!coverRatiosBound.has(img)){coverRatiosBound.add(img);img.addEventListener('load',apply,{once:true});}
 });
 // 底部 #pagination 只留滚动哨兵；「已加载… / 不是平台总数」这类说明收进左侧数量的 title。
 // 手动翻页键按 2026-11-12 反馈撤下：滚到哨兵就自动续页（见 app.js 的 autoLoad），
 // 没有下一页时把哨兵一起收起即停。节点与 onclick 保留，DOM / 事件契约不变，只是不再点亮。
 const hasMore=online&&!!(f.next||f.pending.length);
 $('#pagination').hidden=!hasMore;
 $('#load-more').hidden=$('#load-all').hidden=true;
 renderStatus();counts();
 syncStickyOffset();
 // 画板卡片区跟着网格一起重画：路由切走要收起、画板集合变了要刷新封面。
 // 用钩子而不是在本文件 import 画板模块 —— 绘制层不认识画板实体。
 boardDeckHook?.render?.();
}
/** sticky 偏移同步：结果标题行钉在搜索区下面，而搜索区高度随筛选行摆放变化（宽屏在侧栏、
 *  窄屏搬回面板里），所以每次渲染量一次外层 .search-sticky 的高度（含它自己那段上间距）
 *  写进 CSS 变量。非 discover 页整块 display:none，offsetHeight 为 0，标题行直接落到
 *  「顶栏 + 内容区上边距」处——正是想要的行为。
 *
 *  测量合并到下一帧的 rAF 里，不在 renderGrid 的同一个任务里读：
 *  offsetHeight 是强制同步布局，而 renderGrid 刚刚写完几十张卡片，这一读就得把整棵树先排
 *  一遍；等这一帧真正绘制时，写 CSS 变量又把布局作废，于是同一帧排了两遍。切页实测 30ms
 *  里有 12ms（40%）都耗在这上面，肉眼就是「切页面时卡一下」。放进 rAF 后，这次布局正好
 *  就是这一帧本来要做的布局，写完变量到绘制之间还有一次增量重排（只波及标题行），不亏。
 *  rAF 仍早于本帧绘制，所以不会出现「标题行先钉在旧位置、下一帧才跳正」的闪。 */
let stickyRO=null,stickyFrame=0,stickyHeight=-1;
function applyStickyHeight(sticky){
 const next=sticky?sticky.offsetHeight:0;
 if(next===stickyHeight)return;
 stickyHeight=next;
 document.documentElement.style.setProperty('--sticky-search',next+'px');
}
function syncStickyOffset(){
 if(stickyFrame)return;
 stickyFrame=requestAnimationFrame(()=>{
  stickyFrame=0;
  const sticky=document.querySelector('.search-sticky');
  applyStickyHeight(sticky);
  // 搜索区里有两样东西不由 renderGrid 驱动高度：筛选行在宽/窄屏之间搬进搬出、
  // 以及扫描状态行（#scan-status）文案增减。用 RO 兜住这两种变化，否则标题行会钉在
  // 旧偏移上，和搜索区之间露出一条缝、卡片从缝里透出来。
  if(sticky&&!stickyRO&&typeof ResizeObserver==='function'){
   stickyRO=new ResizeObserver(()=>{
    // 折叠动画期间 main 宽度每帧变，读 offsetHeight 会强制同步布局；冻结，结束后由 resize 补一次。
    if(globalThis.document?.documentElement?.classList?.contains('side-animating'))return;
    applyStickyHeight(sticky);
   });
   stickyRO.observe(sticky);
  }
 });
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
 const tab=panel.dataset.tab==='tags'?'tags':'types';
 panel.innerHTML=`<div class="local-filter-tabs" role="tablist" aria-label="资产库分类"><button type="button" role="tab" data-local-tab="types" aria-selected="${tab==='types'}">类型</button><button type="button" role="tab" data-local-tab="tags" aria-selected="${tab==='tags'}">标签${state.localCategory?' · 已筛选':''}</button></div><div data-local-pane="types" role="tabpanel"${tab==='types'?'':' hidden'}><div class="local-kind-options">${[...kind.options].map(option=>`<button type="button" class="ftree-leaf${kind.value===option.value?' active':''}" data-local-kind="${esc(option.value)}" aria-pressed="${kind.value===option.value}">${esc(option.textContent)}</button>`).join('')}</div></div><div data-local-pane="tags" role="tabpanel"${tab==='tags'?'':' hidden'}><div class="local-tag-chips">${button('','全部标签')}${[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'zh')).map(([value,count])=>button(value,value,count)).join('')}</div></div>`;
 panel.onclick=event=>{
  const tabButton=event.target.closest('[data-local-tab]');
  if(tabButton){panel.dataset.tab=tabButton.dataset.localTab;renderLocalFilters();return;}
  const category=event.target.closest('[data-local-category]');
  const type=event.target.closest('[data-local-kind]');
  if(type){kind.value=type.dataset.localKind;kind.dispatchEvent(new Event('change'));}
  else if(category){state.localCategory=category.dataset.localCategory;state.selected.clear();renderGrid();}
 };
}
/** 筛选始终留在侧栏容器；窄屏通过分类抽屉访问，不占用搜索卡片。
 *  清单在模块顶部（FILTER_ROWS）：搬进侧栏与显隐共用同一份，不各写一遍。 */
function placeFilters(){
 const host=$('#filter-rows');
 for(const selector of FILTER_ROWS){const row=$('#'+selector);if(row&&row.parentElement!==host)host.append(row);}
 // 模型 / 图片两个键已搬到顶部图标轨（content-kind-tabs.js），侧栏只留筛选树。
 $('#side-filters').hidden=false;
 filterTreesUI()?.setNarrow(false);
 mergedFiltersUI()?.setNarrow(false);
}
/** 舞台切换：弹窗里只有一块 canvas 和一只 iframe，index.html 里两者默认都带 hidden。
 *  Sketchfab / ArtStation / ambientCG 这类平台自带 viewer 的路径只设 src、不走 gltfPreview，
 *  所以必须自己把 iframe 放出来、把画布和 #state 那句「正在加载模型…」收掉 ——
 *  否则整个弹窗就是一片黑底加一行提示，看起来像卡住（2026-11-11 用户反馈）。 */
function showFrameStage(){
 const frame=$('#viewer'),canvas=document.getElementById('viewer-canvas'),state=document.getElementById('state');
 if(canvas)canvas.hidden=true;
 if(frame)frame.hidden=false;
 if(state){state.textContent='';state.className='';}
}
/** iframe 路径没有加载态可言（平台 viewer 自己会转圈），说明文字直接写在 #state 里。 */
function notePreview(text){
 const state=document.getElementById('state');
 if(state){state.textContent=text||'';state.className='';}
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
 // UI 元素（Uiverse）：不是 3D，也不是图片，是一段会动的代码。
 // 预览用 iframe + srcdoc 放一份独立文档（样式一点都漏不到主界面来），
 // sandbox 不给 allow-scripts —— 社区代码不该有执行权，但 CSS 动画不需要脚本，照跑不误。
 if(m.assetType==='uielement'||m.platform==='uiverse')return previewUiElement(m);
 // ArtStation：有 Marmoset 场景的作品开交互式 3D 查看器（0.1.15 一度改成图片画廊，导致 3D 预览消失）；
 // 纯图片作品才用站内图片画廊（比旧版直接跳官网更好）。
 if(artstationUI().isArt(m))return artstationUI().has3dScene(m)?artstationUI().openPreview(m):openArtworkPictures(m);
 // ambientCG 材质没有 3D 模型可转，但有官方的 PBR 材质查看器（releases.pbr.one，官网自己也在
 // 内嵌它）：iframe 直接给材质上色、调法线和粗糙度。没有预览地址的旧卡片退回官方页面。
 if(m.platform==='ambientcg')return previewMaterial(m);
 if(m.platform==='simready'){
  $('#model-details').innerHTML=`<div class="eyebrow">NVIDIA SIMREADY · USD</div><h2>${esc(m.name)}</h2><p class="author-name">by NVIDIA</p><div class="detail-license"><strong>CC BY 4.0</strong><p>直接预览原始 USD，可旋转与缩放。MDL 材质显示为基础材质，仿真属性不参与预览。</p></div><button class="secondary" data-action="collect" data-uid="${esc(m.uid)}">${icon('folder')}加入我的模型库</button><button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}下载完整 USD 资源</button><a class="source-link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开官方页面 ${icon('external')}</a>`;
  $('#viewer').removeAttribute('src');
  $('#preview-dialog').showModal();
  gltfPreview.loadSimready(m.assetId);
  return;
 }

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
 // Fab：在线资产没有可嵌入的 3D viewer（模型由 dope viewer 运行时渲染，拼 sketchfab embed 只会 404）。
 // 用媒体大图做预览：先异步拉详情拿多图 + 描述，再开图片画廊。注意这里给的是**原始 media.fab.com url** ——
 // 图片画廊（openImageGallery）内部会统一包成 /api/image?url=…，再自己包一层就成了双重代理、图全裂。
 // 详情拿不到就退回封面单图，保证点开一定有图、不再 404。
 if(m.platform==='fab'){
  const cover=m.thumbnail||'';
  if(!cover&&!m.assetId)return openExternal(m.url);
  const token=picturePreviewToken;
  const single={...m,title:m.name,url:cover||m.url,thumb:cover,pageUrl:m.url,type:'image',platform:'fab',author:m.author,tags:m.tags};
  const openWith=items=>openPicturePreview(items[0],{platform:'fab',source:m.url,items,model:m});
  if(!m.assetId)return openWith([single]);
  (async()=>{
   let payload=null;
   try{const r=await fetch(`/api/fab/detail?assetId=${encodeURIComponent(m.assetId)}`,{headers:{'X-SFX-Local':'1'}});if(r.ok)payload=await r.json();}catch{/* 详情拿不到就单图 */}
   if(token!==picturePreviewToken)return;                 // 拉取期间用户已点了别的卡片
   const urls=Array.isArray(payload?.images)?payload.images.filter(Boolean):[];
   if(!urls.length)return openWith([single]);
   const items=urls.map((url,index)=>({...m,title:m.name,url,thumb:cover||url,pageUrl:m.url,type:'image',platform:'fab',author:payload.author||m.author,tags:payload.tags||m.tags,description:index===0?(payload.description||''):''}));
   openWith(items);
  })();
  return;
 }
 // 本地素材（platform='local'）：这两个字节流入口都在本机，能看就直接看。不带 assetId 的模型文件
 // 没有本地渲染通道，继续往下走只会加载出一张空白 iframe，所以非图片/视频一律按原文件打开 ——
 // 至少让用户拿到文件本身，而不是一个「点了没反应」的弹窗。
 if(m.platform==='local'&&m.assetType!=='image'&&m.assetType!=='video')return openExternal(m.url||m.previewUrl);
 // 从「发现 / 采集」进库的图站资产（assetType=image|video 或来自 PICTURE_SITES）没有 Sketchfab id：
 // 拿 uid 去拼 sketchfab/models/<uid>/embed 只会加载出一张空白 iframe —— 这正是「大图预览打不开」。
 // 这类资产直接复用图站的大图预览（同一套画廊 + 右侧信息栏），单张也走它，保证点开就能看大图。
 if(m.assetType==='image'||m.assetType==='video'||isPictureSite(m.platform)){
  const src=m.url||m.thumbnail||m.previewUrl||'';
  if(src){
   const item={...m,title:m.name||m.title,url:src,thumb:m.thumbnail||src,pageUrl:m.pageUrl||m.url,
    type:m.assetType==='video'?'video':'image',platform:m.platform};
   return openPicturePreview(item,{platform:m.platform,source:m.pageUrl||m.url,items:[item],model:m});
  }
 }
 showFrameStage();
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
  $('#viewer').removeAttribute('src');$('#preview-dialog').showModal();
  if(!file){notePreview('还没有本地 SBSAR 文件');return;}
  notePreview('正在启动 Substance 引擎…');
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
     notePreview('正在按新参数渲染…');
     const next=await fetch('/api/substance/input',{method:'POST',headers:{'Content-Type':'application/json','X-SFX-Local':'1'},body:JSON.stringify({id:Number(field.dataset.sbsarId),identifier:field.dataset.sbsarIdentifier,type:field.dataset.sbsarType,value:Number(field.value)})});
     const body=await next.json().catch(()=>({}));
     if(!next.ok){notePreview(body.error||'参数更新失败');return;}
     data.images=body.images||data.images;
     await gltfPreview.loadSubstance(urls());
    },300);
   };
  }catch(e){notePreview(e.message);}
 }
 async function previewMaterial(m){
  if(m.sourceType==='substance'||(m.materialFormat||'JPG')==='SBSAR')return previewSbsar(m);
  if(m.assetType==='models'||m.assetType==='hdris'){
   $('#model-details').innerHTML=`<h2>${esc(m.name)}</h2><p>ambientCG · CC0 · ${m.assetType==='hdris'?'环境':'模型 / 地形'}</p><p>下载保留官方原始文件。${m.sourceType==='terrain'?'地形下载为 OBJ。':''}</p>${detailResolutionPicker(m)}<button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}下载</button><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开官方页面</a>`;
   $('#viewer').removeAttribute('src');$('#preview-dialog').showModal();
   if(m.viewerUrl){showFrameStage();$('#viewer').src=m.viewerUrl;}
   else notePreview('此资产没有官方交互预览，可下载原始文件或打开官方页面查看');
   return;
  }
  const maps=m.maps||[];
  $('#model-details').innerHTML=`<div class="eyebrow">PBR MATERIAL</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author)}</p><div class="details-stats"><div><strong>${maps.length||'—'}</strong><span>贴图通道</span></div><div><strong>CC0</strong><span>可商用</span></div></div><div class="detail-license"><strong>${esc(m.license)}</strong><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">在 ambientCG 打开 ${icon('external')}</a><p>预览来自 ambientCG 官方的 PBR 材质查看器；导出的材质包包含全部贴图通道，重命名后可直接拖进 Unity / Blender。</p></div><div class="tag-list">${maps.slice(0,8).map(t=>`<button data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div><button class="secondary" data-action="collect" data-uid="${esc(m.uid)}">${icon('folder')}加入我的模型库</button>${detailResolutionPicker(m)}<button class="primary" data-action="download" data-uid="${esc(m.uid)}">${icon('download')}导出材质到本地</button><a class="source-link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">打开原始材质页面 ${icon('external')}</a>`;
  $('#viewer').removeAttribute('src');$('#preview-dialog').showModal();
  if(m.viewerUrl){showFrameStage();$('#viewer').src=m.viewerUrl;return;}
  if(!m.assetId){notePreview('这个材质缺少资产标识，请到官方页面查看预览');return;}
  notePreview('正在获取官方 PBR 材质预览…');
  try{
   const response=await fetch(`/api/ambientcg/preview?id=${encodeURIComponent(m.assetId)}`,{cache:'no-store',headers:{'X-SFX-Local':'1'}});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||`HTTP ${response.status}`);
   m.viewerUrl=typeof data.viewerUrl==='string'?data.viewerUrl:'';
   if(m.viewerUrl){showFrameStage();$('#viewer').src=m.viewerUrl;}
   else notePreview('ambientCG 没有为这个材质提供可嵌入预览，请到官方页面查看');
  }catch(e){notePreview(`无法加载交互预览：${e.message}`);}
 }
 /** UI 元素（Uiverse）的预览弹窗。
 *
 * 左侧是一份独立的 HTML 文档（iframe + srcdoc）：元素的 CSS 一点都漏不到主界面，
 * 动效与交互照常 —— 鼠标按下去就是真实反馈，跟把这段代码贴进项目里的效果一致。
 *
 * sandbox 只放 allow-scripts、不给 allow-same-origin：有些组件靠 JS 才有交互，
 * 脚本得能跑；而没有 allow-same-origin 时文档处在不透明源，摸不到主界面的 DOM / 存储 / cookie。
 *
 * 右侧信息栏给的是「这个元素是什么、来自谁、怎么拿走」：
 * 元数据 + 完整代码（全部 / HTML / CSS 三个页签）+ 复制与下载两个动作。 */
 async function previewUiElement(model){
  const dlg=$('#file-preview-dialog'),stage=$('#file-preview-stage'),aside=$('#file-preview-details');
  if(!dlg||!stage||!aside)return;
  stage.innerHTML='';
  // 列表来源的条目只有元素 id，没有代码 —— 先取一份再拼文档。
  // 取不到也不该卡住弹窗：照样开，只是提示没法预览。
  let source=model;
  if(!previewDocumentFor(model)){
   const code=await fetchUiCode(model);
   if(code)source={...model,...code};
  }
  const html=typeof source.html==='string'?source.html:'';
  const css=typeof source.css==='string'?source.css:'';
  const doc=previewDocumentFor(source);
  const frame=document.createElement('iframe');
  frame.className='ui-element-frame';
  frame.title='UI 元素交互预览';
  // 只放 allow-scripts：脚本能跑（有些组件靠 JS 才有反馈），但没有 allow-same-origin，
  // 文档落在不透明源里，读不到主界面的任何东西。
  frame.setAttribute('sandbox','allow-scripts');
  if(doc)frame.srcdoc=doc;
  stage.appendChild(frame);
  const typeLabel=model.elementType||'UI 组件';
  const tags=Array.isArray(model.tags)?model.tags:[];
  const authorUrl=model.authorUrl||(model.elementUsername?`https://uiverse.io/profile/${model.elementUsername}`:'');
  const hasCode=!!(html||css);
  // 代码面板：「全部」是可直接粘走的单文件形态（HTML 一段 + <style> 一段），复制键默认给这份；
  // 只想拿一段时切到 HTML / CSS 页签，复制键跟着换目标。
  const codeAll=hasCode?uiSourceText(source,{html,css}):'';
  const codePanel=hasCode?`<details class="ui-code" open>
    <summary>代码<span class="ui-code-note">HTML + CSS，可直接粘贴</span></summary>
    <div class="ui-code-tabs" role="tablist" aria-label="代码视图">
     <button type="button" class="active" role="tab" aria-selected="true" data-ui-code-tab="all">全部</button>
     <button type="button" role="tab" aria-selected="false" data-ui-code-tab="html">HTML</button>
     <button type="button" role="tab" aria-selected="false" data-ui-code-tab="css">CSS</button>
     <button type="button" class="ui-code-copy" data-action="copy-ui-code" data-uid="${esc(model.uid)}" data-copy-mode="all">${icon('copy')}复制</button>
    </div>
    <pre class="ui-code-body"><code data-ui-code-body>${esc(codeAll)}</code></pre>
   </details>`:'';
  aside.innerHTML=`<div class="eyebrow">UIVERSE · UI 动效</div>
   <h2>${esc(model.name||'UI 元素')}</h2>
   ${authorUrl?`<a class="picture-author" href="${esc(authorUrl)}" target="_blank" rel="noopener noreferrer">${esc(model.author||model.elementUsername||'查看作者')}</a>`:`<p class="author-name">${esc(model.author||'Uiverse')}</p>`}
   <div class="details-stats">
     <div><strong>${esc(typeLabel)}</strong><span>类型</span></div>
     <div><strong>${esc(model.elementTheme||'—')}</strong><span>主题</span></div>
   </div>
   ${tags.length?`<div class="picture-tags">${tags.slice(0,12).map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:''}
   <p class="ui-interaction-note">${doc?'左侧可直接悬停 / 点击，看真实交互效果':'没有取到这个元素的代码，无法实时预览'}</p>
   <div class="detail-license"><strong>Uiverse 社区作品</strong><p>可自由复制使用；商用前请到来源页确认作者声明。</p></div>
   <div class="preview-actions">
     <button class="secondary" data-action="copy-ui-code" data-uid="${esc(model.uid)}" data-copy-mode="all">${icon('copy')}复制 HTML + CSS</button>
     <button class="primary" data-action="download" data-uid="${esc(model.uid)}">${icon('download')}下载到本地</button>
     <a class="source-link" href="${esc(model.url||'')}" target="_blank" rel="noopener noreferrer">打开官方页面 ${icon('external')}</a>
   </div>
   ${codePanel}`;
  // 页签：换 pre 里的文本，并把复制键的目标跟着切过去 —— 复制什么由当前页签决定，
  // 不用让人先想「复制的是哪一份」。
  if(hasCode){
   const body=aside.querySelector('[data-ui-code-body]');
   const copyBtn=aside.querySelector('.ui-code-copy');
   const variants={all:codeAll,html,css};
   aside.querySelectorAll('[data-ui-code-tab]').forEach(tab=>tab.addEventListener('click',()=>{
    const mode=tab.dataset.uiCodeTab;
    aside.querySelectorAll('[data-ui-code-tab]').forEach(node=>{
     const on=node===tab;
     node.classList.toggle('active',on);
     node.setAttribute('aria-selected',on?'true':'false');
    });
    if(body)body.textContent=variants[mode]??'';
    if(copyBtn)copyBtn.dataset.copyMode=mode;
   }));
  }
  if(!dlg.open)dlg.showModal();
  // 弹窗中央的提示条会正好压在组件上（它是一层绝对定位的文字），交互预览里不写它 ——
  // 「怎么操作」交给右侧那行说明，画面留干净。
  $('#file-preview-hint').textContent='';
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
  // 卡片点击传进来的是一份「从 data-* 还原」的新对象，和 ps.items 里的不是同一个引用，
  // 直接 indexOf 永远得 -1 → 夹到 0，于是点哪张都放大第一张。按原图地址回查真实条目。
  const found=ps?.items?.length?images.findIndex(item=>item===it||(!!it.url&&item.url===it.url)):-1;
  const index=found>=0?found:0;
  // 命中真实条目就用它：缩略图、标签、作者这些字段比 data-* 还原出来的全。
  if(found>=0)it=images[found];
  const noteLayout=(it.platform||ps?.platform)==='xiaohongshu';
  openImageGallery({title:ps?.title||it.title||'图片预览',images,index,note:noteLayout,noteLoading:!!ps?.noteLoading,onChange:(current,currentIndex,count)=>{
  it=current;
  aside.dataset.tagUid=ps?.model?.uid||'';
  // 来源平台给中文名（huaban → 花瓣 Huaban）：这里以前直接吐 platform id，
  // 「来源平台：huaban」这种半成品读起来像没翻译完。
  const rawLabel=it.platform||ps?.platform||'';
  const label=rawLabel?platformLabel(rawLabel):'';
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
  aside.innerHTML=noteLayout?`<div class="xhs-note">
   <div class="xhs-author">${authorLine}</div>
   <h2>${esc(it.title||ps?.title||'小红书笔记')}</h2>
   <div class="xhs-body">${it.description?esc(it.description):'正在读取这篇笔记的正文和其余图片…'}</div>
   ${tagLine}
   <div class="preview-actions">
     ${it.pageUrl?`<a class="secondary" href="${esc(it.pageUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}原页面</a>`:''}
   </div>
  </div>`:`<div class="eyebrow">PICTURE${label?` · ${esc(label)}`:''}</div>
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
     <a class="primary" href="${esc(it.embedUrl||it.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}${it.type==='3d'?'打开 3D 场景':(it.type==='video'?'打开视频':'打开原图')}</a>
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

/** 图站单张图片/视频卡片的 HTML。首屏渲染与「加载更多」追加共用这一份模板，
 *  否则两批卡片的角标、比例、可点区域会慢慢走样。
 *
 *  结构刻意和模型卡（card-view.js）对齐：左上角类型角标、标题行（标题 + 作者 + 来源平台）、
 *  底部一排圆形图标键。以前这里只有「标题 + 作者块 + 标签行」，和模型卡并排时高度、
 *  角标、动作区全都不一样 —— 同一个资产库里两种卡片语言，看着像没做完。 */
function pictureCardHtml(it,ps,gallery,isPin){
 // `thumb` 是站方 CDN 的小尺寸变体（花瓣 _fw480：1.7MB → 173KB）；没有就用原图。data-url 始终是原图。
 // v=2：之前缩略图解析失败时服务端会把 4xx 连同 7 天 max-age 一起发回去，浏览器就把「裂图」记了一周。
 // 换一次 URL 绕过那些坏缓存（服务端不读 v，纯缓存键扰动）。
 // 视频投稿（Civitai 的 mp4）：没有海报图，卡片直接用 <video> 播首帧，悬停再静音播一下。
 const isVideo=it.type==='video'||/\.(mp4|webm|mov)(\?|$)/i.test(it.url||'');
 const src=isVideo?`/api/video?url=${encodeURIComponent(it.play||it.url)}`:`/api/image?url=${encodeURIComponent(it.thumb||it.url)}&v=2`;
 const tags=(it.tags||[]).filter(Boolean);
 const ratio=gallery?aspectRatioStyle(it.width,it.height):'';
 const attrs=`data-url="${esc(it.url)}" data-play="${esc(it.play||'')}" data-type="${isVideo?'video':''}" data-pid="${esc(it.pid||'')}" data-w="${it.width||''}" data-h="${it.height||''}" data-title="${esc(it.title||'')}" data-platform="${esc(ps.platform||'')}" data-source="${esc(ps.source||'')}" data-author="${esc(it.author||'')}" data-author-url="${esc(it.authorUrl||'')}" data-page-url="${esc(it.pageUrl||'')}" data-tags="${esc(tags.join(' '))}" style="cursor:zoom-in${ratio?`;aspect-ratio:${ratio}`:''}"`;
 // 骨架、封面裁切、标题与作者排版一律交给 card-shell：图站卡片和 ArtStation 图片卡共用同一份 DOM，
 // 样式自然一致。卡片只负责「填什么」。
 const media=isVideo
  ?`<video class="thumbnail" src="${esc(src)}" ${attrs} muted playsinline loop preload="metadata" aria-label="${esc(it.title||'视频')}"></video>`
  :`<img class="thumbnail" loading="lazy" decoding="async" src="${esc(src)}" alt="${esc(it.title||'')}" ${attrs}>`;
 // 左上角类型角标：模型卡是「3D ASSET / PBR 材质 / HDRI」，图站这边按图片 / 视频分。
 const typeBadge=`<div class="card-type">${icon(isVideo?'play':'image')}${isVideo?'视频':'图片'}</div>`;
 // 图站单图以前整张卡没有收藏键。现在按「平台 + 原图地址」生成稳定 uid，登记成可收藏目标，
 // 复用模型卡那颗心形键与 toggleFavorite -> collect 链路：点一下会真的把这张图记进资产库与收藏。
 const favUid=favoriteUid('picture',`${ps.platform}:${it.url||it.pid||it.pageUrl||it.title||''}`);
 registerFavoriteTarget(favUid,{uid:favUid,name:it.title||ps.title||'未命名图片',platform:ps.platform,
  assetType:isVideo?'video':'image',thumbnail:it.thumb||it.url,url:it.pageUrl||it.url,
  author:it.author||'',license:'',tags});
 const heart=favoriteButtonHtml({uid:favUid,saved:state.favorites.has(favUid),icon,esc});
 // 中间热区沿用 ArtStation 图片卡的同一个 .preview-hit，hover 才浮出来；视频再给一个常驻播放角标。
 const overlay=`${isVideo?`<span class="video-badge" aria-hidden="true">${icon('play')}</span>`:''}${heart}<button class="preview-hit" data-pic-preview aria-label="查看作品图片 ${esc(it.title||'')}"><span>${icon('image')}查看作品图片</span></button>${typeBadge}`;
 const byline=it.author?`<button type="button" class="card-byline pic-author" data-card-author="${esc(it.authorUrl||'')}" title="${it.authorUrl?'查看该作者的作品 / 画板':'该作者没有可解析的主页'}">${esc(it.author)}</button>`:'';
 // 来源平台：模型卡用 .card-source 标「这张是从哪个平台收来的」，图站这边同样需要 ——
 // 同一个弹窗里可能并排着花瓣、Pixiv、Wallhaven 的图，不标平台只能靠记忆。
 const platformName=platformLabel(ps.platform)||'';
 const sourceBadge=platformName?`<span class="card-source" title="来源平台：${esc(platformName)}">${esc(platformName)}</span>`:'';
 // 底部动作行：与模型卡同一排圆形图标键（.card-bottom 会跟着 hover 淡入）。
 // 文字收进 <span> 由 CSS 隐藏，DOM 里留着给无障碍与测试读。
 const tagTip=tags.length?tags.join(' · '):'这张图没有平台标签';
 const openTarget=it.pageUrl||it.url;
 const openLabel=it.pageUrl?'打开原页面':'打开原图';
 const actions=[
  `<button class="card-action-pic" data-pic-preview title="查看大图" aria-label="查看大图 ${esc(it.title||'')}">${icon('eye')}<span>查看大图</span></button>`,
  `<button class="card-action-pic" data-pic-tags="${esc(tags.join(' '))}" title="${esc(tagTip)}" aria-label="标签${tags.length?` ${tags.length}`:''}">${icon('tag')}<span>标签${tags.length?` ${tags.length}`:''}</span></button>`,
  openTarget?`<a class="card-action-pic" href="${esc(openTarget)}" target="_blank" rel="noopener noreferrer" title="${openLabel}" aria-label="${openLabel}">${icon('external')}<span>${openLabel}</span></a>`:'',
  isPin&&it.pid?`<button class="card-action-pic" data-pin-similar data-pid="${esc(it.pid)}" title="用这张图找相似" aria-label="用这张图找相似">${icon('search')}<span>找相似</span></button>`:'',
  ps.platform==='xiaohongshu'&&it.pid&&(ps.albums||[]).length?`<label class="card-select xhs-pick"><input type="checkbox" data-xhs-pick="${esc(it.pid)}" aria-label="选择这篇笔记"></label>`:'',
 ].join('');
 return assetCard({keyName:'pid',keyValue:esc(it.pid||''),media,overlay,title:esc(it.title||''),titleAttrs:`data-pic-preview title="${esc(it.title||'')}"`,byline:byline+sourceBadge,actions});
}

/** 给一批图站卡片绑事件：作者跳转、标题/标签打开预览、封面点击、瀑布流比例纠正。
 *  追加新卡片时会再调用一次，靠 dataset.picBound 跳过已经绑过的节点，不会重复监听。 */
/** 搜索列表只有封面。点开小红书卡片时用笔记链接再解析一次，预览里才有正文和全部图片。 */
async function openXhsNote(it,ps){
 const pageUrl=it.pageUrl||'';
 if(ps?.platform!=='xiaohongshu'||!/\/explore\/[A-Za-z0-9]{16,}/.test(pageUrl)||pageUrl===ps?.source){
  openPicturePreview(it,ps);
  return;
 }
 openPicturePreview(it,{...ps,items:[it],title:it.title,source:pageUrl,noteLoading:true});
 const token=picturePreviewToken;
 toast?.('正在读取笔记里的图片…');
 try{
  const response=await fetch(`/api/picture-site/resolve?platform=xiaohongshu&url=${encodeURIComponent(pageUrl)}`,{headers:{'X-SFX-Local':'1'}});
  const data=await response.json();
  if(token!==picturePreviewToken)return;
  if(!response.ok)throw Error(data.error||'读取笔记失败');
  const items=(data.items||[]).map(item=>({...item,platform:'xiaohongshu',thumb:item.thumb||item.url,description:item.description||''}));
  if(!items.length)throw Error('这篇笔记没有可展示的图片');
  openPicturePreview(items[0],{platform:'xiaohongshu',source:pageUrl,title:data.title||it.title,author:data.author||it.author,items});
 }catch(error){
  if(token===picturePreviewToken)toast?.(`笔记读取失败：${error.message}`);
 }
}
function bindPictureCards(root,ps){
 if(!root)return;
 const gallery=root.classList.contains('gallery');
 root.querySelectorAll('[data-card-author]').forEach(btn=>{
  if(btn.dataset.picBound||!btn.dataset.cardAuthor)return;
  btn.dataset.picBound='1';
  btn.addEventListener('click',event=>{
   event.preventDefault();event.stopPropagation();
   openPictureAuthor?.(btn.dataset.cardAuthor,ps.platform);
  });
 });
 // 标题、底栏的「查看大图」与「标签」都指向同一个预览：直接触发封面的 click，
 // 不为卡片再写一套预览逻辑。（封面上的 .preview-hit 只做视觉层，pointer-events:none，
 // 所以拖拽和右键仍落在封面元素上。）
 root.querySelectorAll('[data-pic-preview],[data-pic-tags]').forEach(node=>{
  if(node.dataset.picBound)return;
  node.dataset.picBound='1';
  node.addEventListener('click',event=>{
   event.preventDefault();event.stopPropagation();
   node.closest('.model-card')?.querySelector('img[data-url],video[data-url]')?.click();
  });
 });
 // 「找相似」只对 Pinterest 有用，但按钮现在在底栏里（以前压在封面上），
 // 追加进来的卡片没有它的事件绑定 —— 这里统一挂，避免只有第一屏能点。
 root.querySelectorAll('[data-pin-similar]').forEach(btn=>{
  if(btn.dataset.picBound||typeof pictureSimilarHandler!=='function')return;
  btn.dataset.picBound='1';
  btn.addEventListener('click',event=>{
   event.preventDefault();event.stopPropagation();
   pictureSimilarHandler([btn.dataset.pid],btn);
  });
 });
 root.querySelectorAll('img[data-url],video[data-url]').forEach(img=>{
  if(img.dataset.picBound)return;
  img.dataset.picBound='1';
  img.addEventListener('click',()=>{
   const item={
    url:img.dataset.url,play:img.dataset.play||'',type:img.dataset.type||'',pid:img.dataset.pid||'',
    width:Number(img.dataset.w)||0,height:Number(img.dataset.h)||0,
    title:img.dataset.title||'',platform:img.dataset.platform||'',source:img.dataset.source||'',
    author:img.dataset.author||'',authorUrl:img.dataset.authorUrl||'',pageUrl:img.dataset.pageUrl||'',
    tags:(img.dataset.tags||'').split(' ').filter(Boolean)
   };
   if(ps?.platform==='xiaohongshu')openXhsNote(item,ps);
   else openPicturePreview(item,ps);
  });
 });
 // 没有宽高的图（站酷 / 通用抓取 / 小红书列表等）先按占位比例排，解码后把真实比例写回。
 // masonry.js 只观察 class 变化和 load 事件，不看 style 属性：这里改完比例要补一次捕获阶段的
 // load 通知，否则卡片位置停在「量到旧高度」那一帧，看起来就是一排等高方块。
 if(!gallery)return;
 root.querySelectorAll('.thumbnail').forEach(node=>{
  if(node.dataset.ratioBound)return;
  node.dataset.ratioBound='1';
  const isVideo=node.tagName==='VIDEO';
  // 条目自带原始宽高时**不要**用缩略图的 naturalWidth/Height 去覆盖：站方给的 thumb 常常是
  // 定宽裁档（Wallhaven 的 small 实测全是 300×200），一覆盖，原图千姿百态的比例就全被抹成
  // 同一个 3:2 —— 这就是「切了瀑布流，图片比例却都一个样」的真正原因。
  // 只有条目没给宽高的平台，才靠解码后的真实尺寸兜底。
  const itemRatio=aspectRatioStyle(node.dataset.w,node.dataset.h);
  const apply=()=>{
   if(itemRatio)return;
   // video 用 videoWidth/videoHeight，走 loadedmetadata；以前整类视频卡片被跳过，全落到 1:1。
   const ratio=isVideo
    ?aspectRatioStyle(node.videoWidth,node.videoHeight)
    :aspectRatioStyle(node.naturalWidth,node.naturalHeight);
   if(!ratio||node.style.aspectRatio===ratio)return;
   node.style.aspectRatio=ratio;
   node.dispatchEvent(new Event('load'));
  };
  if(isVideo){
   if(node.readyState>=1)apply();else node.addEventListener('loadedmetadata',apply,{once:true});
   return;
  }
  if(node.complete&&node.naturalWidth)apply();else node.addEventListener('load',apply,{once:true});
  // loading="lazy" 的卡片在绝对定位瀑布流里可能一直等不到 load（量到 0 高 → 不进视口 → 不解码）。
  // decode() 不靠滚动触发，兜底把比例补上；失败就留给 error 那条例图的占位逻辑。
  node.decode?.().then(apply).catch(()=>{});
 });
}

// ---------- 图站滚动加载更多 ----------
// 一屏 60 张，和模型平台一屏的张数（library-paging.js 的 PAGE_SIZE）对齐：同一个资产库里
// 「一屏」的概念不该有两种。滑到底再要下一屏，卡片追加进同一个网格。
//
// 与模型平台一样用 IntersectionObserver 观察底部那行哨兵，而不是监听 window.scroll：
// 滚动手动算容器位置要自己去抖，而观察器在哨兵进入视口时天然只触发一次。
// 服务端那一侧现在维护整块画板的清单（picture-index.mjs），第二屏之后是切片返回，
// 不会每屏都把第一页重翻一遍 —— 这是「滑十屏就慢十次」的根治。
const PICTURE_PAGE=60;
// 兜底上限：一块画板真有上万张也不该被滚动加载整个搬进内存（下载不受这个限制）。
const PICTURE_LIMIT_MAX=5000;
let pictureMoreObserver=null;
/** Pinterest 的「找相似」处理器：由 renderPictureSite 注入，bindPictureCards 负责给卡片挂事件。 */
let pictureSimilarHandler=null;
/** 工具条入场动效只在该图站这一屏第一次绘制时播：切视图 / 追加卡片都别重放（会闪）。 */
let barKey='';
/** 状态胶囊上的数字：有总数就写「已取 / 共」，否则只写已取。 */
function pictureStatText(n,total){return total>n?`${n} / ${total}`:`${n}`;}
/** 状态胶囊的 title：把原来那一整行说明（含来源）收进提示，不在界面上占位置。 */
function pictureStatTitle(ps,n){
 const total=Number(ps?.total)||0;
 const head=ps?.truncated?`已加载 ${n}${total>n?` / 共 ${total}`:''} 张 · 继续下滑自动加载更多`:`已加载全部 ${n} 张`;
 return `${head}；下载会抓取整站原图${ps?.source?`（来源：${ps.source}）`:''}`;
}
function pictureMoreHost(){return $('#grid')?.querySelector('.picture-site-more');}
/** 底部续页行与顶部状态胶囊跟着 items/truncated/total 走，追加卡片后必须重算一次。 */
function syncPictureMore(){
 const ps=state.pictureSite,host=pictureMoreHost(),n=(ps?.items||[]).length;
 const total=Number(ps?.total)||0;
 const count=pictureStatText(n,total);
 if(host){
  host.hidden=!ps?.truncated&&!ps?.loadingMore;
  host.innerHTML=ps?.loadingMore
   ?'<span class="picture-more-text">正在加载更多…</span>'
   :ps?.truncated
    ?`<span class="picture-more-text">${count} · 继续下滑自动加载</span><button type="button" class="secondary" id="picture-more-button">加载更多</button>`
    :`<span class="picture-more-text">已经到底了 · 共 ${n} 张</span>`;
  // 滚动之外留一个显式的「加载更多」：触控板惯性不好使、或者观察器被判到视口外时，
  // 用户至少有一个能点的东西 —— 模型平台的分页按钮就是这个角色。
  const button=host.querySelector('#picture-more-button');
  if(button)button.onclick=()=>loadMorePicture();
 }
 // 顶部状态胶囊：只改数字与状态，不重建节点（重建会把动效吃掉、也没必要重排）。
 const hint=document.getElementById('picture-site-hint');
 if(hint){
  const num=hint.querySelector('.psb-count');
  if(num&&num.textContent!==count){
   num.textContent=count;
   // 两个动画名交替：换个选择器就能重放「数字跳一下」，不读 offsetWidth（那会强制同步布局）。
   hint.dataset.tick=hint.dataset.tick==='a'?'b':'a';
  }
  hint.dataset.state=ps?.loadingMore?'loading':(ps?.truncated?'more':'done');
  hint.title=pictureStatTitle(ps,n);
 }
}
/** 重新观察当前这颗哨兵：grid.innerHTML 每次重绘都会换掉节点，观察器要跟着换目标。 */
function observePictureMore(){
 if(!pictureMoreObserver){
  pictureMoreObserver=new IntersectionObserver(entries=>{
   if(!entries.some(entry=>entry.isIntersecting))return;
   maybeLoadMorePicture();
  },{rootMargin:'600px 0px'});
 }
 pictureMoreObserver.disconnect();
 const host=pictureMoreHost();
 if(host&&!host.hidden)pictureMoreObserver.observe(host);
}
function maybeLoadMorePicture(){
 const ps=state.pictureSite;
 if(!ps||ps.busy||ps.loadingMore||!ps.truncated||ps.mode==='boards'||!ps.items?.length)return;
 if(state.route!=='discover')return;
 if(ps.retryAt&&Date.now()<ps.retryAt)return;
 const host=pictureMoreHost();
 if(!host||host.hidden)return;
 // 哨兵进入「视口下方 600px」就预取，滚到底时新卡片已经在了，不会空等。
 if(host.getBoundingClientRect().top>window.innerHeight+600)return;
 loadMorePicture();
}
async function loadMorePicture(){
 const ps=state.pictureSite,current=Number(ps?.limit)||PICTURE_PAGE;
 if(!ps||ps.busy||ps.loadingMore||!ps.truncated||ps.mode==='boards')return;
 const next=Math.min(current+PICTURE_PAGE,PICTURE_LIMIT_MAX);
 if(next<=current){ps.truncated=false;syncPictureMore();return;}
 ps.loadingMore=true;ps.lastError='';
 syncPictureMore();
 try{
  const res=await fetch(`/api/picture-site/resolve?platform=${encodeURIComponent(ps.platform)}&limit=${next}&url=${encodeURIComponent(ps.url)}`,{headers:{'x-sfx-local':'1'}});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||'加载更多失败');
  // 期间切了平台/页面：这批结果只服务旧的那一屏，丢掉。
  if(state.pictureSite!==ps)return;
  const have=new Set((ps.items||[]).map(it=>it.url));
  const fresh=(data.items||[]).filter(it=>it.url&&!have.has(it.url));
  ps.limit=next;
  // total 只在服务端把整块画板翻完之后才给（见 picture-index.mjs），中途不猜。
  if(Number(data.total)>0)ps.total=Number(data.total);
  if(fresh.length){
   ps.items=[...(ps.items||[]),...fresh];
   ps.truncated=!!data.truncated;
   appendPictureCards(fresh,ps);
  }else{
   // 站方翻到头了（服务端返回的还是同一批）：标记到底，避免每次滚动都重发同一个请求。
   ps.truncated=false;
  }
  ps.retryAt=0;
 }catch(e){
  ps.retryAt=Date.now()+5000;
  ps.lastError=e.message||'网络错误';
  const host=pictureMoreHost();
  if(host&&state.pictureSite===ps)host.innerHTML=`<span>加载更多失败：${esc(ps.lastError)}，稍后继续下滑重试</span>`;
 }finally{
  if(state.pictureSite===ps){
   ps.loadingMore=false;
   if(!ps.lastError){
    syncPictureMore();
    // 追加后如果哨兵还在视口附近（超宽屏 / 短图），接着补下一页，不用等用户再滑。
    if(ps.truncated)setTimeout(maybeLoadMorePicture,250);
   }
  }
 }
}
/** 续页只追加 DOM，不整屏重绘：已加载的缩略图不重新解码，滚动位置也不会跳。 */
function appendPictureCards(items,ps){
 const root=$('#grid')?.querySelector('.picture-site-gallery');
 if(!root)return;
 root.insertAdjacentHTML('beforeend',items.map(it=>pictureCardHtml(it,ps,root.classList.contains('gallery'),ps.platform==='pinterest')).join(''));
 bindPictureCards(root,ps);
}

/**
 * 图站头部：标题行里塞进作者胶囊，右侧紧跟一条工具条（数量胶囊 + 主操作 + 图标键）。
 *
 * 位置为什么放在标题行、而不是网格上方再占一行：模型平台本来就是「标题在左、动作在右」一条线，
 * 图站过去是「标题 / 作者 / 工具条」三行叠着（用户 2026-11-09 反馈"还是有两行"），
 * 跨平台看下来节奏也不一致。现在四种状态（载入中 / 解析失败 / 画板墙 / 图片）都由这里出同一套头部，
 * 换站、报错、翻页时头部结构不跳。
 */
function pictureToolbarHost(){
 const heading=document.querySelector('.library-heading');
 if(!heading)return null;
 let bar=heading.querySelector('#picture-site-toolbar');
 if(!bar){
  bar=document.createElement('div');
  bar.id='picture-site-toolbar';bar.className='picture-site-bar';
  // 图站的数量胶囊与动作键排在右簇最左，后面依次是分页参数与视图切换键；
  // 模型平台的数量已搬到左侧平台名旁，这条工具条只在检索中承载「停止检索」。
  // 视图键本地库那几屏会被搬到 #local-toolbar，所以按它的实际父节点插入，不写死 heading。
  const tools=heading.querySelector('.display-tools');
  const host=tools?.parentElement||heading;
  const controls=host.querySelector('#discovery-controls');
  const anchor=(controls&&controls.parentElement===host)?controls:(tools||null);
  host.insertBefore(bar,anchor);
 }
 return bar;
}
function accountButton(ps){
 const site=platformById(ps.platform)||{};
 const name=site.label||ps.platform||'';
 const login=pictureSiteLoginable(ps.platform);
 return `<span class="psb-account"><button type="button" class="psb-login" id="picture-site-login" data-label="${esc(name)}" ${login?'':'disabled'} title="${login?`登录 ${esc(name)}`:esc(name)}" aria-label="登录 ${esc(name)}">${icon('user')}</button><span class="psb-name">${esc(name)}</span></span>`;
}
function renderPictureHead(ps,{items,boards,boardMode}){
 const list=Array.isArray(items)?items:[];
 const title=$('#library-title');
 const xhs=ps.platform==='xiaohongshu';
 title.hidden=true;
 if(title.parentElement){
  title.parentElement.hidden=false;
  title.parentElement.querySelectorAll('.psb-account,.model-count-inline').forEach(node=>node.remove());
  title.parentElement.insertAdjacentHTML('afterbegin',accountButton(ps));
 }
 const authorChip=$('#library-author');
 if(authorChip)authorChip.hidden=true;
 $('#library-subtitle').hidden=true;

 const bar=pictureToolbarHost();
 if(!bar)return;
 const downloadOk=!!downloadsUI()?.enqueue;
 const busy=!!ps.busy,error=!!ps.error;
 // 关键词搜索（ps.url 是词不是网址）和粘链接是两种来源：搜索没有「整站」概念。
 const isSearchQuery=!/^https?:\/\//i.test(ps.url||'');
 const canAct=downloadOk&&!busy&&!error&&!boardMode;
 const enter=barKey!==`${ps.platform}|${ps.url}`;
 barKey=`${ps.platform}|${ps.url}`;
 bar.className=`picture-site-bar${enter?' enter':''}`;
 bar.innerHTML=`
   ${ps.fromBoards?`<button class="psb-icon" id="picture-site-back" title="返回画板墙（不发请求，画板列表还在内存里）" aria-label="返回画板墙">${icon('arrow-left')}</button>`:''}
   <span class="psb-stat" id="picture-site-hint" data-state="${busy?'loading':(ps.truncated?'more':'done')}" role="status" title="${busy?'正在解析…':esc(pictureStatTitle(ps,list.length))}"><span class="psb-dot" aria-hidden="true"></span><span class="psb-count">${busy?'…':esc(pictureStatText(list.length,Number(ps.total)||0))}</span><span class="psb-unit">张</span></span>
   ${xhs?'':`<button class="psb-icon" id="picture-site-download" ${canAct?'':'disabled'} title="${isSearchQuery?'把这次搜索到的图片抓进图片库':'把整站图片抓进图片库（原图，不是缩略图）'}" aria-label="${isSearchQuery?'下载这批':'下载整站'}">${icon('download')}</button>`}
   ${ps.platform==='xiaohongshu'&&ps.mode==='boards'?`<form class="xhs-album-create" id="xhs-album-create"><input name="name" maxlength="20" placeholder="新专辑" aria-label="新专辑名称"><button type="submit">创建</button></form>`:''}
   ${xhs?'':`<button class="psb-icon" id="picture-site-bookmark" ${canAct?'':'disabled'} title="只入库不下载" aria-label="只入库不下载">${icon('save')}</button>`}
   ${ps.platform==='xiaohongshu'?`<span class="psb-switch" role="group" aria-label="小红书内容"><button type="button" id="xhs-view-home" class="${/\/user\/collect/.test(ps.url||'')?'':'active'}">推荐</button><button type="button" id="xhs-view-collect" class="${/\/user\/collect/.test(ps.url||'')?'active':''}">我的收藏</button></span>`:''}
   ${ps.platform==='pinterest'?`<button class="psb-icon" id="picture-site-similar" ${canAct?'':'disabled'} title="用当前结果找相似" aria-label="用当前结果找相似">${icon('sparkle2')}</button>`:''}`;
 const loginButton=$('#picture-site-login');
 if(pictureSiteLoginable(ps.platform))bindSiteLogin(loginButton,ps.platform,{toast,onClosed:()=>{markSiteLogin(loginButton,(platformById(ps.platform)?.hosts||[])[0]||'');reloadPictureSite?.();}});
 const loginHost=(platformById(ps.platform)?.hosts||[])[0]||'';
 if(loginButton&&loginHost)markSiteLogin(loginButton,loginHost);
 const homeBtn=$('#xhs-view-home'),collectBtn=$('#xhs-view-collect');
 if(homeBtn)homeBtn.onclick=()=>openPictureUrl?.('https://www.xiaohongshu.com/explore');
 if(collectBtn)collectBtn.onclick=()=>openPictureUrl?.('https://www.xiaohongshu.com/user/collect');
 const createForm=$('#xhs-album-create');
 if(createForm)createForm.onsubmit=async event=>{
  event.preventDefault();
  const name=new FormData(createForm).get('name');
  const button=createForm.querySelector('button');
  button.disabled=true;
  try{
   const response=await fetch('/api/xhs/album',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({action:'create',name})});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||'创建失败');
   toast?.(`已在小红书创建专辑「${String(name||'').trim()}」`);
   openPictureUrl?.('https://www.xiaohongshu.com/user/collect');
  }catch(error){toast?.(error.message);button.disabled=false;}
 };
}
/** 离开图站（回模型平台 / 本地库）要把这条工具条和左侧平台头摘掉，否则会跟着标题行留在那儿。 */
function clearPictureHead(){
 document.getElementById('picture-site-toolbar')?.remove();
 document.querySelectorAll('.psb-account,.model-count-inline').forEach(node=>node.remove());
}
/**
 * 模型 / 3D 平台的头部：左侧「平台名胶囊 + 纯文字数量」，右侧只有视图键 / 每批条数。
 * 2026-11-12 反馈：数量不再带「第 N 页」、不要外边框，且要紧跟在平台标识右边；
 * 原来底部那一整行说明（数量口径、待解析链接、未自动入库）不删信息，收进数量的 title。
 * 检索中的「停止检索」仍挂在右簇，只有那一刻才创建 .picture-site-bar。
 */
function renderModelHead({f,subtitle}){
 const title=$('#library-title'),host=title?.parentElement;
 if(!title||!host)return;
 title.hidden=true;host.hidden=false;
 host.querySelectorAll('.psb-account,.model-count-inline').forEach(node=>node.remove());
 const label=state.source==='link'?'链接解析':platformLabel(state.platform);
 const note=`${f.rows.length} 个`;
 const detail=[subtitle||note,f.pending.length?`待解析 ${f.pending.length} 个链接`:'',pageInfoNote({source:state.source,platform:state.platform})].filter(Boolean).join(' · ');
 host.insertAdjacentHTML('afterbegin',`<span class="psb-account"><span class="psb-name">${esc(label)}</span></span><span class="model-count-inline" role="status" title="${esc(detail)}">${esc(note)}</span>`);
 $('#library-subtitle').hidden=true;
 const bar=pictureToolbarHost();
 if(!bar)return;
 // 平时右簇不留一条空的 30px 工具条；检索中才点亮「停止检索」。
 if(!f.busy){bar.remove();return;}
 bar.className='picture-site-bar';
 bar.innerHTML=`<button class="psb-icon" id="cancel-discovery" type="button" title="停止检索" aria-label="停止检索">${icon('x')}</button>`;
 bar.querySelector('#cancel-discovery').onclick=()=>f.controller?.abort();
}

let xhsPicked=new Set(),xhsPickUrl='';
function paintXhsDropbar(ps,grid){
 document.getElementById('xhs-dropbar')?.remove();
 if(ps.platform!=='xiaohongshu'||!(ps.albums||[]).length)return;
 if(xhsPickUrl!==ps.url){xhsPicked=new Set();xhsPickUrl=ps.url||'';}
 const targets=(ps.albums||[]).filter(album=>album.id&&album.id!=='all'&&album.id!==ps.boardId);
 if(!targets.length)return;
 const bar=document.createElement('div');
 bar.id='xhs-dropbar';bar.className='xhs-dropbar';
 bar.innerHTML=`<span>勾选多张后拖到专辑</span>${targets.map(album=>`<button type="button" class="xhs-drop" data-board-id="${esc(album.id)}">${esc(album.title)}</button>`).join('')}`;
 grid.before(bar);
 bar.addEventListener('dragover',event=>{
  if(![...event.dataTransfer.types].includes('application/x-xhs-notes'))return;
  const chip=event.target.closest('[data-board-id]');
  if(!chip)return;
  event.preventDefault();
  bar.querySelectorAll('.is-over').forEach(node=>node.classList.remove('is-over'));
  chip.classList.add('is-over');
 });
 bar.addEventListener('dragleave',event=>{if(!bar.contains(event.relatedTarget))bar.querySelectorAll('.is-over').forEach(node=>node.classList.remove('is-over'));});
 bar.addEventListener('drop',async event=>{
  const chip=event.target.closest('[data-board-id]');
  bar.querySelectorAll('.is-over').forEach(node=>node.classList.remove('is-over'));
  if(!chip)return;
  event.preventDefault();
  let ids=[];
  try{ids=JSON.parse(event.dataTransfer.getData('application/x-xhs-notes')||'[]');}catch{ids=[];}
  ids=ids.filter(Boolean);
  if(!ids.length)return;
  chip.disabled=true;
  try{
   const response=await fetch('/api/xhs/album',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({action:'add',boardId:chip.dataset.boardId,noteIds:ids})});
   const data=await response.json().catch(()=>({}));
   if(!response.ok)throw Error(data.error||'移动失败');
   const failed=data.failed?.length||0;
   toast?.(failed?`放入 ${data.ok||0} 篇，${failed} 篇没放进去`:`${ids.length} 篇已放入「${chip.textContent}」`);
   for(const id of ids)xhsPicked.delete(id);
   grid.querySelectorAll('.model-card.is-picked').forEach(card=>{
    if(!xhsPicked.has(card.dataset.pid)){card.classList.remove('is-picked');const box=card.querySelector('[data-xhs-pick]');if(box)box.checked=false;}
   });
  }catch(error){toast?.(error.message);}
  chip.disabled=false;
 });
}
function renderPictureSite(){
 gridSignature='';cardHtml.clear();
 document.getElementById('xhs-dropbar')?.remove();
 const ps=state.pictureSite||{};
 const grid=$('#grid');
 const items=Array.isArray(ps.items)?ps.items:[];
 const isPin=ps.platform==='pinterest';
 const boards=Array.isArray(ps.boards)?ps.boards:[];
 // 两级解析的第一级：作者主页 → 画板墙（一块画板一张卡）；第二级才是它的图片。
 const boardMode=ps.mode==='boards';
 $('#model-count').hidden=true;
 renderPictureHead(ps,{items,boards,boardMode});
 $('#empty').hidden=true;
 $('#pagination').hidden=true;
 renderDisplayButtons({boards:boardMode});
 // 三种「无图可看」的状态一律用普通网格：gallery 是多列瀑布流，会把单个提示块切成多栏错位。
 if(ps.busy){grid.className='model-grid';grid.innerHTML='<div class="skeleton"></div>'.repeat(6);return;}
 if(ps.error){const askLogin=pictureSiteLoginable(ps.platform)&&/登录|扫码|验证/.test(ps.status||'');grid.className='model-grid';grid.innerHTML=`<div class="empty"><div class="empty-cube">${icon('cube')}</div><h3>解析失败</h3><p>${esc(ps.status||'抓取失败')}</p><p class="hint">若提示「该图站暂不支持抓取」，说明后台服务仍是旧进程，重启 Arvimo · 艺团 后重试。</p>${askLogin?`<button class="secondary" id="picture-site-error-login" style="margin-top:14px">${icon('user')} 登录 / 扫码后重试</button>`:''}</div>`;
  // 失败卡上也要有登录入口：'需要先登录' 这种原因，用户看得到却无处可点是最糟的。
  bindSiteLogin($('#picture-site-error-login'),ps.platform,{toast,onClosed:()=>reloadPictureSite?.()});
  return;}
 if(boardMode){
  document.getElementById('xhs-dropbar')?.remove();
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
 if(!items.length){document.getElementById('xhs-dropbar')?.remove();grid.className='model-grid';grid.innerHTML=`<div class="empty"><div class="empty-cube">${icon('cube')}</div><h3>没有可显示的图片</h3><p>该链接可能未公开或需要登录。</p>${pictureSiteLoginable(ps.platform)?`<button class="secondary" id="picture-site-error-login" style="margin-top:14px">${icon('user')} 登录 / 扫码后重试</button>`:''}</div>`;bindSiteLogin($('#picture-site-error-login'),ps.platform,{toast,onClosed:()=>reloadPictureSite?.()});return;}
 paintXhsDropbar(ps,grid);
  grid.className='picture-site-results';
  // 瀑布流按原图比例排：接口里带宽高的卡片直接写内联 aspect-ratio，列高一次就位。
 // 不带的（booru / 站酷这类只给缩略图地址）等图片解码后由下方循环补上。
 const gallery=galleryActive(state);
 const cards=items.map(it=>pictureCardHtml(it,ps,gallery,isPin)).join('');
 // limit：这一屏已经取到第几张（滚动加载按 PICTURE_PAGE 递增）。从缓存恢复的旧数据没这个字段，用条目数顶上。
 if(!Number(ps.limit))ps.limit=items.length||PICTURE_PAGE;

  const more=!!ps.truncated;
  // 工具条已经在标题行里画好了（renderPictureHead），这里只铺瀑布流本体：
  // 「继续下滑自动加载」那句由底部哨兵承担，不再在顶部重复一遍。
  grid.innerHTML=`<div class="${displayGridClass(state)} picture-site-gallery">${cards}</div>`+
   `<div class="picture-site-more"${more?'':' hidden'}><span class="picture-more-text">${more?'继续下滑自动加载…':`已经到底了 · 共 ${items.length} 张`}</span></div>`;
 // 卡片事件与瀑布流比例纠正统一走 bindPictureCards：追加新卡片时只绑没绑过的节点。
 bindPictureCards(grid.querySelector('.picture-site-gallery'),ps);
 grid.querySelectorAll('.model-card[data-pid]').forEach(card=>{
  if(ps.platform!=='xiaohongshu'||!(ps.albums||[]).length)return;
  card.draggable=true;
  if(!xhsPicked.has(card.dataset.pid))return;
  card.classList.add('is-picked');
  const box=card.querySelector('[data-xhs-pick]');
  if(box)box.checked=true;
 });
 // 滚动到底自动续页：观察底部那颗哨兵，机制与模型平台的分页行完全一致。
 // 首帧不要立刻判断哨兵：瀑布流此时还没排完版（--masonry-height 为 0），哨兵会误落在视口里，
 // 一进页面就白抓一页。等排版稳定再看一眼，屏幕够高时仍然会自动补满。
 observePictureMore();
 setTimeout(maybeLoadMorePicture,400);
 // 缩略图挂了（站方 404 / 限流 / 原图档取不到）不能留一颗撕裂图标：先退回原图地址试一次，
 // 再失败才压成占位块 —— 卡片本身仍可点开大图、拖拽和右键，功能不跟着图一起废。
 // 监听挂在 #grid 上并且只挂一次：每次重绘 grid.innerHTML 会换掉子节点，但 #grid 本身没换。
 if(!grid.dataset.brokenHook){
  grid.dataset.brokenHook='1';
  grid.addEventListener('error',event=>{
   const node=event.target;
   // 视频卡片取不到源（站方限流 / 转码档不存在）：同样别留一块黑，走同一套占位。
   if(node instanceof HTMLVideoElement){node.closest('.card-media')?.classList.add('is-broken');return;}
   if(!(node instanceof HTMLImageElement)||!node.dataset.url||node.dataset.failed)return;
   if(!node.dataset.fallback){
    node.dataset.fallback='1';
    node.src=`/api/image?url=${encodeURIComponent(node.dataset.url)}&full=1`;
    return;
   }
   node.dataset.failed='1';
   node.closest('.card-media')?.classList.add('is-broken');
  },true);
 }
 // 视频卡片悬停时静音播一下（首帧往往看不出是视频），移开就暂停回到开头，不占带宽太久。
 if(!grid.dataset.xhsAlbum){
  grid.dataset.xhsAlbum='1';
  grid.addEventListener('click',event=>{
   const box=event.target.closest('[data-xhs-pick]');
   if(!box)return;
   event.stopPropagation();
   const card=box.closest('.model-card');
   const id=box.dataset.xhsPick;
   if(!id)return;
   if(box.checked)xhsPicked.add(id);else xhsPicked.delete(id);
   card?.classList.toggle('is-picked',xhsPicked.has(id));
  });
  grid.addEventListener('dragstart',event=>{
   const card=event.target.closest('.model-card[data-pid]');
   if(!card||!xhsPicked)return;
   const id=card.dataset.pid;
   const ids=xhsPicked.has(id)?[...xhsPicked]:[id];
   event.dataTransfer.setData('application/x-xhs-notes',JSON.stringify(ids));
   event.dataTransfer.effectAllowed='copy';
  });
 }
 if(!grid.dataset.videoHook){
  grid.dataset.videoHook='1';
  grid.addEventListener('mouseover',event=>{
   const video=event.target.closest?.('video.thumbnail');
   if(video)video.play?.().catch(()=>{});
  });
  grid.addEventListener('mouseout',event=>{
   const video=event.target.closest?.('video.thumbnail');
   if(!video)return;
   video.pause?.();
   try{video.currentTime=0;}catch{/* 还没拿到 metadata 时赋值会抛 */ }
  });
 }
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
 const bookmark=$('#picture-site-bookmark');
 if(bookmark)bookmark.onclick=()=>bookmarkCurrentPicture();
 // Pinterest 相似推荐：把选中 pin 的 id 列表丢给后台 /api/pinterest/related（pin-grabber 独有），
 // 它从当前 STATE.images 采「更多类似图案」推荐流并追加进画廊。代理层已做单飞串行，避免 STATE 被覆盖。
  if(isPin){
   const similarHandler=async(pids,btn)=>{
    if(!pids.length){toast?.('没有可用的图片 id');return;}
    const saved=btn?btn.innerHTML:null;
    // 工具条那颗是纯图标键（没有文字位置），忙碌态换成转圈图标；卡片底栏那颗带文字，照旧换文字。
    const iconOnly=!!btn?.classList?.contains('psb-icon');
    if(btn){
     btn.disabled=true;
     if(iconOnly){btn.classList.add('is-busy');btn.innerHTML=icon('refresh');}
     else btn.innerHTML='相似中…';
    }
    try{
    const res=await fetch('/api/pinterest/related',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({pin_ids:pids,count:24})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'相似推荐失败');
    const urls=new Set((ps.items||[]).map(i=>i.url));
    const added=(data.items||[]).filter(i=>i.url&&!urls.has(i.url));
    if(!added.length){toast?.('没有更多相似图片了');return;}
    ps.items=[...(ps.items||[]),...added];renderGrid();toast?.(`已追加 ${added.length} 张相似图片`);
    }catch(e){toast?.(e.message);}
    finally{if(btn){btn.disabled=false;btn.classList.remove('is-busy');btn.innerHTML=saved;}}
   };
  // 「找相似」按钮在卡片底栏里（以前压在封面上），事件统一由 bindPictureCards 挂：
  // 这里只把处理器交出去，追加进来的第二屏、第三屏卡片也能点。
  pictureSimilarHandler=similarHandler;
  bindPictureCards(grid.querySelector('.picture-site-gallery'),ps);
  const all=$('#picture-site-similar');
  if(all)all.onclick=()=>{const pids=(ps.items||[]).map(i=>i.pid).filter(Boolean);similarHandler(pids,all);};
 }
}
async function bookmarkCurrentPicture(){
 const ps=state.pictureSite;
 if(!ps||ps.busy||ps.error||ps.mode==='boards')return;
 const res=await fetch('/api/library/picture-board',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({
  uid:pictureSiteJobUid(ps.platform,ps.url),
  platform:ps.platform,
  url:ps.url,
  title:ps.title||ps.author||ps.platform,
  author:ps.author||'',
  cover:ps.cover||'',
  imageCount:(ps.items||[]).length,
 })});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw Error(data.error||`写入失败（HTTP ${res.status}）`);
 toast?.(data.skipped?`资产库里已经有这个包：${data.title}`:`已记入资产库：${data.title}${data.imageCount?`（${data.imageCount} 张）`:''}`);
 await refreshAssets?.();
}
return {counts,renderStatus,renderGrid,placeFilters,preview,syncStickyOffset,refreshArtworkActions,setBoardDeck,bookmarkCurrentPicture};
}
