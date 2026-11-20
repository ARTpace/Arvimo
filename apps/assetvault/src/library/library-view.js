import {rememberPictureSnapshot} from './discovery-feed.js';
import {mergePicturePage} from './picture-page.js';
import {isMusicSite} from './music-platforms.js';
import {isSocialMediaSite} from './short-video-platforms.js';
import {createLibraryGridCache} from './library-grid-cache.js';
import {orderedCategories} from './category-order.js';
import {syncLocalFilterMarkup,toggleLocalFilterBranch} from './local-filter-dom.js';
import {customCategoryFacets,isCustomCategory} from './custom-categories.js';
import {previewHeader,compactPreview} from './preview-sidebar.js';
import {tagPanel} from './asset-tags.js';
// The library's rendering layer: counts/status line, grid & waterfall, filter placement, preview.
//
// These five functions are one concern — turn app state into DOM — and they only ever read state
// that another module owns. Splitting them out keeps app.js responsible for *deciding* what is true
// (which feed answered, what is selected, what is queued) and this file for *drawing* it.
// Collaborators that only exist once the app has finished wiring itself arrive as getters.
import {statusText,subtitleText,pageInfoNote,describeRequest,SOURCE_LABELS} from './discovery-view.js';
import {aspectRatioStyle,displayGridClass,galleryAvailable} from './gallery-view.js';
import {platformById,isPictureSite,pictureSiteLoginable,pictureSiteSearchable,platformLabel} from './platforms.js';
import {bindSiteLogin} from './site-login.js';
import {askText} from './ask-dialog.js';
import {modePresetById} from './mode-presets.js';
import {kindById} from './content-kind-tabs.js';
import {TYPE_GROUPS,activeLocalTypeId,localTypeFacets} from './local-type-tree.js';
import {filterTagEntries,tagHitLabel} from './tag-search.js';
import {groupTagEntries,ensureFacetVocab} from './tag-facet-map.js';
import {loadingHtml} from './loading-indicator.js';
/** 展示区标题带上当前模式，让人一眼看出这一屏是哪一类资源（模式是显式主状态）。 */
const modeTitlePrefix=state=>{const preset=modePresetById(state.mode);return preset?`${preset.label} · `:'';};
import {findLocalJob} from './blender-send.js';
import {openExternal} from './open-url.js';
import {pictureSiteJobUid} from './platforms.js';
import {observeMasonry} from './masonry.js';
import {scrollIdleTask} from './scroll-performance.js';
import {assetCard} from './card-shell.js';
import {canPreviewModelInViewer} from './format-registry.js';
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
export const FILTER_ROWS=['filters-sketchfab','filters-artstation','filters-polyhaven','filters-ambientcg','filters-polypizza','filters-kenney','filters-freestylized','filters-polyfork','filters-uiverse','filters-fab','filters-merged','filters-all','filters-platform-empty'];

export function createLibraryView(ctx){
 const {$,icon,esc,fmt,state,queuePulse,cardView,composite,filtered,activeModes,galleryActive,categories,describeArt,artstationUI,downloadsUI,filterTreesUI,mergedFiltersUI,findModel,sendControl,isVisitor=false,imageDownload,gltfPreview,extraCards=()=>[],openPictureBoard,openPictureAuthor,backToPictureBoards,toast,openImageGallery,refreshAssets=()=>{},pageRows=rows=>rows,reloadPictureSite=()=>{},openPictureUrl=()=>{},onFabSeller=null}=ctx;
 const masonry=observeMasonry($('#grid'));
 const libraryGridCache=createLibraryGridCache($('#grid'));
// 缩略图确认加载失败的在线条目（Sketchfab 图床 404，基本等于模型已下架）：记住 uid，
// 翻页、换视图、收藏重渲染都不会再把空卡片画回来。会话级即可，下次搜索换一批结果。
const coverErrorsBound=new WeakSet(),coverRatiosBound=new WeakSet();
function counts(){
 const activeStates=new Set(['queued','held','retry_wait','running','transferring','validating','saving','cancelling']);
 const activeJobs=(downloadsUI()?.jobs||[]).filter(j=>activeStates.has(j.state));
 // 徽标只统计后台已接受的任务；卡片的点击动画不代表入队成功。
 const queue=activeJobs.length;
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
 // 这一行现在只剩失败与中止，正常搜索时整条不占位（「返回搜索结果」入口已按 2026-11-19 反馈去掉）。
 const warnings=(f.warnings||[]).filter(text=>!/本轮跳过|没有对应分类|没有匹配/.test(text));
 const showFailure=(f.error||f.aborted)&&!f.rows.length;
 el.classList.toggle('idle',!showFailure);el.classList.toggle('error',f.error);
 el.replaceChildren();
 if(!showFailure)return;
 {const span=document.createElement('span');span.textContent=statusText({sources:f.sources,feeds:state.feeds,platform:state.platform});el.append(span);
 if(warnings.length){const warning=document.createElement('span');warning.className='warning';warning.textContent=warnings.slice(0,2).join('；');el.append(warning);}}
}
/** 网格绘制。数据集签名 = uid 序列 + 视图标志（瀑布流/紧凑）：签名不变说明这一轮只是
 *  状态变化（收藏、勾选、下载态、精度选择），逐卡比对 HTML 字符串，只替换有变化的卡片，
 *  消失的卡片移除 —— 高频重渲染不再整块重建 innerHTML，1000 张卡的模型库切状态也不卡。
 *  在线结果变动也按 uid 复用并调整位置，避免多平台陆续返回时重建所有缩略图。 */
let cardHtml=new Map(),gridSignature='',gridMode='';
// 只保留少量最近筛掉的卡片，返回搜索时复用已解码封面；上限避免持续占内存。
const parkedCards=new Map();
function parkCard(key,node){
 if(!node.querySelector('img'))return;
 node.dataset.cardCached='1';parkedCards.set(key,{node,html:cardHtml.get(key)});
 let images=0;for(const item of parkedCards.values())images+=item.node.querySelectorAll('img').length;
 while(parkedCards.size>32||images>64){const first=parkedCards.keys().next().value,item=parkedCards.get(first);const imgs=item.node.querySelectorAll('img');images-=imgs.length;for(const img of imgs)img.removeAttribute('src');parkedCards.delete(first);}
}

/** 卡片的 key 写进 DOM 属性：增量对齐要靠它认回同一个节点。只改第一个 <article 开标签，
 *  卡片内部结构一个字都不动。 */
function cardMarkup(item){
 if(!item?.html)return '';
 return item.html.replace(/^(\s*<(?:article|button)\b)/,match=>`${match} data-card-key="${esc(item.key)}"`);
}
function nodeFromMarkup(html){
 if(!html)return null;
 const template=document.createElement('template');
 template.innerHTML=html;
 return template.content.firstElementChild||null;
}
/** 卡片重绘（勾选态、下载进度、收藏）会换掉整个节点，封面 <img> 跟着重建 → 重新解码会闪一下。
 *  新旧是同一个 src、且旧图已经加载完时，把旧 <img> 直接搬进新节点：网络与解码都不重来。 */
function carryLoadedCover(from,to){
 const oldImg=from?.querySelector('img.thumbnail'),newImg=to?.querySelector('img.thumbnail');
 if(!oldImg||!newImg)return;
 if(oldImg.getAttribute('src')!==newImg.getAttribute('src'))return;
 if(!oldImg.complete||!oldImg.naturalWidth)return;
 newImg.replaceWith(oldImg);
}
// 排序 / 过滤 / 删除之后卡片是「瞬移」换位的：瀑布流重写 --masonry-left/top、网格由浏览器重排，
// 一屏几十张在同一帧里同时落到新坐标，看起来就是闪一下（用户 2026-11-14 反馈）。
// 这里按 FLIP 做：落位前记下旧位置，落位后先用 translate 反向偏移把它「拉回」旧处，
// 再放回 0，让 CSS 过渡把它平滑滑过去 —— 位置变了，视觉是连续的。
// 只处理视口附近的卡片（±240px）：屏幕外的位移看不见，没必要为此付测量代价。
let movingCards=[],movingTimer=0;
/** 无布局的夹具（vm 单测）里节点没有 getBoundingClientRect，按「量不到」处理。 */
const rectOf=node=>typeof node?.getBoundingClientRect==='function'?node.getBoundingClientRect():null;
function settleCardMoves(){
 if(movingTimer){clearTimeout(movingTimer);movingTimer=0;}
 for(const node of movingCards){node.classList.remove('is-moving');node.style.translate='';}
 movingCards=[];
}
function animateCardMoves(grid,firstRects){
 if(!firstRects.size)return;
 if(globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
 const moves=[];
 for(const [node,before] of firstRects){
  if(!node.isConnected)continue;
  const now=rectOf(node);
  if(!now)continue;
  const dx=before.left-now.left,dy=before.top-now.top;
  if(Math.abs(dx)<1&&Math.abs(dy)<1)continue;
  moves.push([node,dx,dy]);
 }
 if(!moves.length)return;
 for(const [node,dx,dy] of moves)node.style.translate=`${dx}px ${dy}px`;
 // 同一帧里改两次样式不会产生过渡：先让浏览器算一遍起始变换，再放回目标位置。
 rectOf(grid);
 for(const [node] of moves){node.classList.add('is-moving');node.style.translate='';movingCards.push(node);}
 movingTimer=setTimeout(settleCardMoves,320);
}
function paintGrid(models,gallery,online,busy){
 const grid=$('#grid');
 const restored=libraryGridCache.switchTo(online?'discover':ctx.libraryScope?.()||(ctx.activeBoardId?.()?'board':'library'),{cardHtml,gridSignature,gridMode});
 if(restored){cardHtml=restored.cardHtml;gridSignature=restored.gridSignature;gridMode=restored.gridMode;}
 // 资产库目录里那些没登记成下载任务的文件（用户自己拷进来的素材）作为额外卡片接在后面。
 // 它们不是 `state.models` 的成员——那份数据有 32 位 hex uid 的持久化校验，混不进去；
 // 所以只在绘制层按 key 拼接。「最近入库」时本地卡片带磁盘 mtime，要和模型的 addedAt
 // 按同一条时间线混排：只往后追加的话，刚下完的图片包永远排在所有卡片后面。
 const extras=online?[]:(extraCards()||[]);
 const views=[];
 for(const model of models)views.push({key:`m:${model.uid}`,t:Number(model.addedAt)||0,name:String(model.name||''),model});
 for(const extra of extras)views.push({key:`e:${extra.key}`,t:Number(extra.mtime)||0,name:String(extra.name||''),extra});
 const mixed=!online&&state.sort==='recent'&&extras.length>0;
 const ordered=!online&&state.sort==='name'?[...views].sort((a,b)=>a.name.localeCompare(b.name,'zh',{numeric:true})):mixed?[...views].sort((a,b)=>b.t-a.t):views;
 const page=typeof pageRows==='function'?pageRows(ordered):ordered;
 const visible={count:page.length,models:page.filter(view=>view.model).map(view=>view.model)};
 // 先分页再生成 HTML：隐藏的数万条资产只参与排序，不生成标签和按钮字符串。
 const items=page.map(view=>({key:view.key,html:view.model?cardView.card(view.model,{gallery}):view.extra.html}));
 const htmlOf=new Map(items.map(view=>[view.key,view.html]));
 const signature=items.map(item=>item.key).join('|')+(gallery?'#g':'');
 // 网格 ↔ 瀑布流、发现页 ↔ 本地库、首次绘制：DOM 结构与定位方式完全不同，只能整块重建。
 const mode=`${gallery?'g':'l'}${online?'o':'l'}`;
 // 一张卡片都没有、又在加载中：只画通用加载动效并直接返回。不能走下面的增量对齐——
 // 它会把上一个动效节点当成「没有 key 的旧节点」删掉，两次 busy 之后屏幕上就什么都不剩。
 // gridMode 清空是为了强制下一帧整块重建：瀑布流的卡片是绝对定位的，动效块不是，
 // 两种布局不能共用同一份 DOM（否则有数据后卡片会全部叠在原点）。
 if(!items.length&&busy){gridMode='';gridSignature='';grid.classList.remove('gallery');grid.style.removeProperty('--masonry-height');grid.innerHTML=loadingHtml('正在加载…');return visible;}
 if(mode!==gridMode||!grid.firstElementChild){
  grid.innerHTML=items.map(cardMarkup).join('')||(busy?loadingHtml('正在加载…'):'');
  gridMode=mode;gridSignature=signature;cardHtml=htmlOf;
  if(gallery)masonry.flush();
  return visible;
 }
 // 其余情况一律按 key 对齐全量增量：只新增 / 替换 / 移动真正变了的卡片。
 // 以前只有「key 序列完全相同」才走增量 —— 删掉一张卡序列就变，于是整屏 innerHTML 重建、
 // 所有封面重新解码，界面会闪一下（用户 2026-11-14 反馈「删除一个文件整个界面闪」）。
 // 删除、收藏、过滤、入库都该是原地变化，别的卡片一个字节都不该重画。
 // 兼容没有 data-card-key 的旧节点（上一版渲染留在 DOM 里的卡）：退回 uid 主键认回来，
 // 宁可保守复用，也不要把它删掉重建 —— 删了就得重新解码封面，又是一次闪。
 // 上一轮位移过渡还没走完就先收干净：卡片带着 translate 去测坐标，起点会是动画中间态。
 settleCardMoves();
 // 只有顺序真的变了才值得做位移动画。下载进度、收藏态这类重绘顺序不变，
 // 没必要每 500ms 付一次全量 getBoundingClientRect 的强制布局。
 // 量的时机必须在删节点之前：先删再量，后面的卡片已经上移，动画起点就反了。
 const firstRects=new Map();
 if(signature!==gridSignature){
  const viewportH=globalThis.window?.innerHeight||800;
 for(const node of [...grid.children]){
   const rect=rectOf(node);
   if(rect&&rect.bottom>-240&&rect.top<viewportH+240)firstRects.set(node,{left:rect.left,top:rect.top});
  }
 }
 const keyOf=node=>node.dataset?.cardKey||(node.dataset?.uid?`m:${node.dataset.uid}`:'');
 const existing=new Map();
 for(const node of [...grid.children]){
  const key=keyOf(node);
  if(key)existing.set(key,node);else node.remove();
 }
 const keep=new Set(items.map(item=>item.key));
 for(const [key,node] of existing)if(!keep.has(key)){parkCard(key,node);node.remove();existing.delete(key);}
 let cursor=grid.firstElementChild;
 for(const item of items){
  let node=existing.get(item.key);
  const parked=parkedCards.get(item.key);
  if(!node&&parked&&parked.html===item.html){node=parked.node;delete node.dataset.cardCached;parkedCards.delete(item.key);existing.set(item.key,node);cardHtml.set(item.key,item.html);}
  if(!node){
   node=nodeFromMarkup(cardMarkup(item));
   if(node){grid.insertBefore(node,cursor);existing.set(item.key,node);}
  }else if(cardHtml.get(item.key)!==item.html){
   const next=nodeFromMarkup(cardMarkup(item));
   if(next){
    // 换了节点也要接上旧位置，否则这类卡片（勾选态、下载进度）会瞬移而不是跟着滑。
    const rect=firstRects.get(node);
    carryLoadedCover(node,next);
    if(cursor===node)cursor=next;
    node.replaceWith(next);node=next;existing.set(item.key,node);
    if(rect)firstRects.set(node,rect);
   }
  }
  if(!node)continue;
  if(node!==cursor)grid.insertBefore(node,cursor);
  cursor=node.nextElementSibling;
 }
 cardHtml=htmlOf;gridSignature=signature;
 // 刚写完 DOM，就在同一个任务里把坐标摆好：等到下一帧再量的话，中间那一帧卡片全叠在
 // 左上角、网格高度还是 0，切页面 / 切瀑布流 / 切内容模式时看到的那一下闪就是它。
 if(gallery)masonry.flush();
 // 坐标都定好了再起过渡：这时新旧位置都已知，卡片从旧处滑到新处。
 animateCardMoves(grid,firstRects);
 return visible;
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
function modelThumbTarget(raw){
 try{
  const u=new URL(String(raw||''),'http://127.0.0.1');
  if(u.pathname!=='/api/local/thumb')return null;
  const root=u.searchParams.get('root'),rel=u.searchParams.get('rel');
  if(!root||!rel)return null;
  return {root,rel,width:Math.min(2048,Math.max(64,Number(u.searchParams.get('w'))||512))};
 }catch{return null;}
}
 function bindGridCovers(gallery=$('#grid').classList.contains('gallery'),root=document){
 root.querySelectorAll('.thumbnail,.model-thumb').forEach(img=>{
  if(coverErrorsBound.has(img))return;
  coverErrorsBound.add(img);
  img.addEventListener('error',function onCoverError(){
  const showPlaceholder=()=>{
   if(!img.isConnected)return;
   img.removeEventListener('error',onCoverError);
   // 缩略图的网络/代理错误不等于资产下架：保留卡片与下载入口。
   const placeholder=document.createElement('div');
   placeholder.className='image-placeholder';
   placeholder.innerHTML=`${icon('cube')}<span>缩略图加载失败</span>`;
   // 瀑布流里别让一批裂图集体塌成 CSS 的 1:1：把条目宽高（或已纠正过的比例）接到占位块上。
   const ratio=aspectRatioStyle(img.dataset.w,img.dataset.h)||img.style.aspectRatio||'';
   if(ratio)placeholder.style.aspectRatio=ratio;
   img.replaceWith(placeholder);
  };
  // 本地 3D 模型没封面时服务端回的是 415（不是瞬时失败，重试也没用）：按需加载
  // model-thumb.js 离屏渲一帧写回缩略图缓存，成功后换个 URL 让这张卡立刻显示真封面。
  if(img.classList.contains('model-thumb')&&!img.dataset.modelThumbDone){
   img.dataset.modelThumbDone='1';
   const target=modelThumbTarget(img.getAttribute('src'));
   if(target){
    import('./model-thumb.js').then(mod=>mod.ensureModelThumb(target)).then(ok=>{
     if(!img.isConnected)return;
     if(!ok){showPlaceholder();return;}
     const base=String(img.getAttribute('src')||'').replace(/[?&]_av_model=\d+/g,'').replace(/\?$/,'');
     img.setAttribute('src',`${base}${base.includes('?')?'&':'?'}_av_model=1`);
    },showPlaceholder);
    return;
   }
  }
  // 刚拖进来的文件会立刻铺卡片，这一刻服务端可能还没把缩略图缓存烤好、或 WebView2 缓存了
  // 一次瞬时失败。以前一次 error 就永久换占位，用户只能手动刷新（2026-11-14 反馈）。
  // 改成延迟重试两次并换 URL 破缓存，瞬时失败自己恢复；真坏图才落占位。
  const attempt=Number(img.dataset.thumbRetry||0);
  if(attempt<2&&img.isConnected){
   img.dataset.thumbRetry=String(attempt+1);
   const base=String(img.getAttribute('src')||'').replace(/[?&]_av_retry=\d+/g,'').replace(/\?$/,'');
   const sep=base.includes('?')?'&':'?';
   setTimeout(()=>{
    if(img.isConnected)img.setAttribute('src',`${base}${sep}_av_retry=${attempt+1}`);
   },attempt?900:300);
   return;
  }
  showPlaceholder();
 });
 });
 // 搜索结果里没有宽高，瀑布流只能先按方形占位；图片解码后再把真实比例写回，列高一次纠正到位。
 if(gallery)root.querySelectorAll('.thumbnail').forEach(img=>{
  const apply=()=>{const ratio=aspectRatioStyle(img.naturalWidth,img.naturalHeight);if(ratio)img.style.aspectRatio=ratio;};
  if(img.complete)apply();else if(!coverRatiosBound.has(img)){coverRatiosBound.add(img);img.addEventListener('load',apply,{once:true});}
 });
}

function renderGrid(){
 const albumNav=document.getElementById('album-folder-nav');if(albumNav)albumNav.hidden=true;
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
 const gridClass=displayGridClass(state);
 if($('#grid').className!==gridClass)$('#grid').className=gridClass;
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
  $('#reset-local-filters').hidden=!(state.localCategory||state.search.trim()||state.filter!=='all'||$('#local-kind').value||state.contentKind||(state.route==='library'&&state.mode)||$('#local-status').value||state.queryUids);
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
 // 首次加载（还没有旧卡片）交给居中的加载动效表达，别把动效本身也调成 55% 透明度；
 // 只有「重新搜索、旧结果还在」时才需要整体压暗提示正在换数据。
 $('#grid').classList.toggle('gallery',gallery);$('#grid').classList.toggle('loading',online&&f.busy&&models.length>0);$('#grid').setAttribute('aria-busy',online&&f.busy?'true':'false');
 renderDisplayButtons();
 // 只在绘制层分页：models 仍是筛选后的完整集合，计数 / 空状态 / 全选都按全量算。
 const visible=paintGrid(models,gallery,online,f.busy);
 // UI 元素卡片挂动效预览：网格画完再挂，滚进视口才去取代码。
 mountUiPreviews(visible.models);
 $('#empty').hidden=visible.count>0||(online&&f.busy);
 const searched=state.source==='link'?!!state.feeds.web.request:activeModes().every(mode=>!!state.feeds[mode].request);
 $('#empty h3').textContent=online?(f.error?'暂时无法获取资产':searched?'没有找到匹配的资产':'从一个关键词开始'):state.route==='favorites'?'还没有匹配的收藏':'模型库，留给真正想用的资产';
 $('#empty p').textContent=online?(f.error?'检查网络后重新搜索。旧结果不会被失败请求覆盖。':searched?`试试更短的关键词、英文关键词，或减少筛选条件。${state.platform==='artstation'?'ArtStation 上的 Marmoset Viewer 作品只占搜索结果的一部分。':''}`:'直接输入关键词，或选择上方的推荐词。'):state.search||state.filter!=='all'?'尝试清除本地搜索与筛选条件。':'去“发现资产”搜索，点击加入模型库或爱心收藏，即可在这里保留。';
 $('#empty-explore').hidden=online&&f.busy;
 $('#empty-explore').innerHTML=`浏览热门资产 ${icon('arrow-right')}`;
 // 登录键默认收起：只有「图站空状态且这个站有登录入口」那一支才点亮它，
 // 否则从图站切回 3D 平台时会留下一颗指向别的站的登录键。
 // （用可选链：老进程/老壳子里可能还没有这颗键，缺了也不该把整个网格绘制打断。）
 $('#empty-login')&&($('#empty-login').hidden=true);
 if(online&&!activeModes().length){
  // 图站没有关键词检索流，空网格要说清「这一步该做什么」——而且要先分清这个站到底能不能搜。
  // 能搜的站（小红书 / Pinterest / 花瓣…）过去被这段写死的「按链接解析」误导：展示区教人粘链接，
  // 用户就以为它搜不了关键词。现在按 pictureSiteSearchable 分两种文案，搜索/登录入口都摆在卡片里。
  const picture=isPictureSite(state.platform),current=platformById(state.platform);
  // 个人内容入口在首次进入时直接可用，无需先搜索一次才能看见。
  if(state.platform==='xiaohongshu')renderPictureHead({platform:state.platform,url:''},{items:[],boards:[],boardMode:false});
  const searchable=picture&&pictureSiteSearchable(state.platform);
  const keyword=$('#asset-query').value.trim(),keywordOnly=!!keyword&&!/^https?:\/\//i.test(keyword);
  const loginable=picture&&pictureSiteLoginable(state.platform)&&!(current.keywordNotice&&keywordOnly);
  // 标题沿用图站占位符那一套说法（`输入关键词搜索 X`），不必再给中文站名硬凑一个空格。
  $('#empty h3').textContent=picture?(searchable?`搜索 ${current.label}`:`${current.label} 按链接解析`):'所有平台已关闭';
  $('#empty p').textContent=picture?(searchable
   ?`输入关键词或粘贴链接，回车搜索${loginable?'；需要时请先登录':''}。`
   :(current.keywordNotice||'粘贴作品页或标签页链接，回车解析。')):'请在设置中开启需要的平台。';
  // 「浏览热门资产」是 3D 平台的入口（写死 sort:'popular' 去检索），图站上没有对应的推荐流，
  // 点它只会打一个空请求出去 —— 图站的空状态只留登录键与说明。
  $('#empty-explore').hidden=picture;
  if(picture&&current.searchAlternative&&keywordOnly){
   $('#empty-explore').hidden=false;
   $('#empty-explore').textContent=`用${platformById(current.searchAlternative).label}搜索「${keyword}」`;
  }
  const loginKey=$('#empty-login');
  if(loginKey)loginKey.hidden=!loginable;
  if(loginable)bindSiteLogin(loginKey,state.platform,{toast,onClosed:async()=>{
   // 登录完原地重跑：手上那一次解析（关键词 / 链接）优先，没搜过就退回站点首页推荐。
   const reloaded=await reloadPictureSite?.();
   if(!reloaded)toast?.(searchable?'登录已完成，在上方输入关键词即可搜索':'登录已完成，请粘贴作品分享链接解析');
  }});
 }
// 链接解析（文本 / 视频）：没有聚合源，空状态要指出「粘链接」这条路，
// 而不是沿用上面「所有平台已关闭」的兜底文案。放在原块之后覆盖，避免改动那一大段图站分支。
if(online&&!activeModes().length&&platformById(state.platform).link){
 $('#empty h3').textContent='粘贴链接开始解析';
 $('#empty p').textContent='粘贴页面或直链地址，回车解析。';
 $('#empty-explore').hidden=true;
 const linkLogin=$('#empty-login');
 if(linkLogin)linkLogin.hidden=true;
}
if(!online){
  // 图标模式选的是「文本 / 视频」这类下拉里没有的类型，它同样是一种收窄 —— 不算的话，
  // 筛到 0 条会显示「收集第一项资产」并弹出「浏览热门资产」（一点就离开资产库）。
  const narrowed=state.localCategory||state.search.trim()||state.filter!=='all'||$('#local-kind').value||state.contentKind||(state.route==='library'&&state.mode)||$('#local-status').value||state.queryUids;
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
/** 从 /api/local/thumb 的 URL 里取出 {root,rel,width}，交给按需加载的 3D 封面渲染器定位源文件。
 *  只解析字符串、不碰 location，无头 DOM 夹具里调用也安全。 */
 bindGridCovers(gallery);
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
 const next=sticky?sticky.getBoundingClientRect().height:0;
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
/** 折叠态是纯观感，不进 state：state 要跟着 blob 一起存盘、还要过 schema 校验，
 *  收起哪个分组不值得为它改持久化契约。 */
const openTypeGroups=new Set(TYPE_GROUPS.map(group=>group.id));
const openTypes=new Set();
let lastActiveType;
/** 标签搜索词：面板会整块重绘（切 tab、点类型、资产变动），词留在这里才不会被重绘清掉。
 *  不落 localStorage —— 搜索是一次性的临时动作，下次打开还想看到上次搜的词反而碍事。 */
let tagQuery='';
const localFilterMarkup=new WeakMap();
/** 词表只拉一次。拉到了就把标签面板从平铺升级成分组 —— 用户不用手动刷新面板。 */
let facetVocabRequested=false;
/** 侧栏「类型树」与搜索栏上方的模式轨共用同一份 CONTENT_KINDS。
 *  以前这一段读的是 #local-kind 的静态 options（只有模型 / 材质 / HDRI / 图片 / 资源包），
 *  于是顶上明明还有文本、视频、UI 元素，侧栏却一个都点不到 —— 两侧对不上（2026-11-14 用户反馈）。
 *  现在一级类型由 CONTENT_KINDS 派生、二级子分类取库内真实存在的分类/标签，都能点。 */
function renderLocalFilters(){
 const host=$('#filter-rows');
 let panel=$('#library-filters');
 if(!panel){panel=document.createElement('div');panel.id='library-filters';host.append(panel);}
 panel.hidden=state.route!=='library';
 if(panel.hidden)return;
 const tab=panel.dataset.tab==='tags'?'tags':'types';
 // 词表是分组与归一的唯一依据。晚到也没关系：先出平铺，到了原地重画成分组。
 if(!facetVocabRequested){
  facetVocabRequested=true;
  ensureFacetVocab().then(model=>{ if(model)renderLocalFilters(); });
 }
 const tagged=state.filter==='trash'?(state.trashed||[]):state.models;
 const known=new Set(tagged.map(model=>model.uid));
 // 磁盘卡片与登记资产是两条口径：资产包认 category、零散文件认 kind，各反查自己的类型，
 // 侧栏上的数字才和网格里真正画出来的卡片对得上。
 const packages=state.filter==='trash'?[]:ctx.localPackages().filter(pkg=>!pkg.uid||!known.has(pkg.uid));
 const files=state.filter==='trash'?[]:ctx.localEntries();
 const groups=tab==='types'?orderedCategories(localTypeFacets({models:tagged,packages,files}),state.options):[];
 const active=activeLocalTypeId(state,()=>$('#local-kind')?.value||'');
 if(active&&active!==lastActiveType)openTypes.add(active);
 lastActiveType=active;          // 只在切换类型时自动展开，保留用户手动折叠。
 const tagCounts=new Map();
 if(tab==='tags'){
  const countTags=model=>{for(const category of localAssetCategories(model))tagCounts.set(category,(tagCounts.get(category)||0)+1);};
  for(const model of tagged)countTags({...model,tags:ctx.localTags(model)});
  for(const model of packages)countTags(model);
  for(const model of files)countTags(model);
 }
 const selected=state.localCategory||'';
 const leaf=(value,label,count,iconName='tag')=>`<button type="button" class="ftree-leaf${selected===value?' active':''}" data-local-category="${esc(value)}" aria-pressed="${selected===value}"><span class="ftree-ic">${icon(iconName)}</span><span class="ftree-leaf-label">${esc(label)}</span><span class="ftree-count">${count}</span></button>`;
 const customRows=parent=>customCategoryFacets(state.options,parent,[...tagged,...packages,...files]).map(row=>`<div class="ftree-custom-row"><button type="button" class="ftree-leaf${selected===row.value?' active':''}" data-custom-category="${esc(row.id)}" data-custom-parent="${esc(parent)}" aria-pressed="${selected===row.value}"><span class="ftree-dot"></span><span class="ftree-leaf-label">${esc(row.label)}</span></button>${ctx.isVisitor?'':`<button type="button" class="icon-button ftree-delete-category" data-delete-custom-category="${esc(row.id)}" title="删除自定义分类" aria-label="删除${esc(row.label)}分类">${icon('trash')}</button>`}<span class="ftree-count">${row.count}</span></div>`).join('');
 const addCategory=parent=>ctx.isVisitor?'':`<button type="button" class="icon-button ftree-add-category" data-add-custom-category="${esc(parent)}" title="新增自定义子类" aria-label="新增自定义子类">${icon('plus')}</button>`;
 const typeRow=row=>{
  const custom=row.id==='unknown'?'':customRows(row.id);
  const hasChildren=row.children.length||custom;
  const open=openTypes.has(row.id);
  const on=active===row.id;
  return `<section class="ftree-sec${open?' open':''}"><div class="filter-category-row"><button type="button" class="ftree-branch${on?' active':''}" data-local-kind="${esc(row.id)}" data-local-kids="${hasChildren?1:0}" aria-pressed="${on}" aria-expanded="${open}"><span class="ftree-caret">${hasChildren?icon('chevron'):''}</span><span class="ftree-ic">${icon(row.icon)}</span><span class="ftree-name">${esc(row.label)}</span></button>${addCategory(row.id)}<span class="ftree-count">${row.count}</span></div>${hasChildren?`<div class="ftree-body"${open?'':' inert'}><div class="ftree-kids">${custom}${row.children.map(child=>leaf(child.value,child.value,child.count,child.icon)).join('')}</div></div>`:''}</section>`;
 };
 const groupBlock=group=>{
  const open=openTypeGroups.has(group.id);
  const on=state.mode===group.modeId;
  // 分组名下只挂一个同名 kind（图片/图片、文本/文本、待分类/待分类）时，那一行纯属复读：
  // 不渲染它，把它的子分类直接提到分组下；点分组仍按这个 kind 筛选，语义不变。
  const solo=group.kinds.length===1&&group.kinds[0].label===group.label?group.kinds[0]:null;
  return `<div class="ftree-group${open?' open':''}${on?' has-active':''}"><div class="ftree-group-heading"><button type="button" class="ftree-group-toggle" data-type-group="${esc(group.id)}" aria-label="${open?'收起':'展开'}${esc(group.label)}" aria-expanded="${open}"><span class="ftree-caret">${icon('chevron')}</span></button><button type="button" draggable="true" data-category-order="${esc(group.id)}" class="ftree-group-head${on&&!active?' active':''}" data-local-kind="${esc(solo?solo.id:group.id)}" aria-pressed="${on&&!active}"><span class="ftree-ic">${icon(group.icon||'folder')}</span><span class="ftree-name">${esc(group.label)}</span></button>${addCategory(group.id)}<span class="ftree-count">${group.count}</span></div><div class="ftree-body"${open?'':' inert'}><div class="ftree-kids">${customRows(group.id)}${solo?solo.children.map(child=>leaf(child.value,child.value,child.count,child.icon)).join(''):group.kinds.map(typeRow).join('')}</div></div></div>`;
 };
 const tagEntries=[...tagCounts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'zh'));
 /** 标签胶囊。分组与归一都由**词表**决定（服务端 /api/library/tags/facets 的 vocab 段）：
  *  · 同一个意思在库里常常写着三种（architecture / building / 建筑），平铺出来就是一锅粥；
  *    按词表归一到标准名再合并计数，才看得出「这是一类东西」。
  *  · 面（风格 / 题材 / 材质 …）也是词表说了算，前端不自己猜 —— 猜出来的分组过一阵就跟库里对不上。
  *  · 词表还没到（接口失败 / 内核未就绪）就退回平铺，面板绝不白屏。 */
 const tagChip=(value,label,count)=>`<button type="button" class="ftree-leaf${selected===value?' active':''}" data-local-category="${esc(value)}" aria-pressed="${selected===value}"><span class="ftree-leaf-label">${esc(label)}</span><span class="ftree-count">${count}</span></button>`;
 /** 搜的时候「全部标签」要收起来：它算「不筛选」，跟关键词一左一右摆着容易被当成搜出来的结果。 */
 const tagChipsInner=()=>{
  const hits=filterTagEntries(tagEntries,tagQuery);
  if(!hits.length)return '<p class="local-tag-empty">没有匹配的标签</p>';
  const head=tagHitLabel(hits.length,tagEntries.length,tagQuery)?'':leaf('','全部标签',tagEntries.reduce((sum,[,count])=>sum+count,0));
  // 搜索跨所有组：用户找的是词，不是组 —— 搜到了就平铺给他看，别逼他先猜词在哪一组。
  if(tagQuery)return head+`<div class="local-tag-group-items">${hits.map(([value,count])=>tagChip(value,value,count)).join('')}</div>`;
  const groups=groupTagEntries(hits);
  if(!groups.length)return head+`<div class="local-tag-group-items">${hits.map(([value,count])=>tagChip(value,value,count)).join('')}</div>`;
  return head+groups.map(group=>`<div class="local-tag-group"><div class="local-tag-group-head">${esc(group.label)}<span class="fv-count"> · ${group.items.length}</span></div><div class="local-tag-group-items">${group.items.map(item=>tagChip(item.name,item.name,item.count)).join('')}</div></div>`).join('');
 };
 const tagSearchBar=()=>{
  const hits=filterTagEntries(tagEntries,tagQuery);
  return `<div class="local-tag-search"><input type="search" id="local-tag-query" class="local-tag-input" placeholder="搜索标签…" aria-label="搜索标签" autocomplete="off" value="${esc(tagQuery)}"><span class="local-tag-hit">${esc(tagHitLabel(hits.length,tagEntries.length,tagQuery))}</span></div>`;
 };
 const markup=`<div class="local-filter-tabs" role="tablist" aria-label="资产库分类"><button type="button" role="tab" data-local-tab="types" aria-selected="${tab==='types'}">类型</button><button type="button" role="tab" data-local-tab="tags" aria-selected="${tab==='tags'}">标签${selected&&!isCustomCategory(selected)?' · 已筛选':''}</button></div><div data-local-pane="types" role="tabpanel"${tab==='types'?'':' hidden'}>${tab==='types'?`<div class="ftree">${groups.map(groupBlock).join('')}</div>`:''}</div><div data-local-pane="tags" role="tabpanel"${tab==='tags'?'':' hidden'}>${tab==='tags'?`${tagSearchBar()}<div class="local-tag-chips" data-tag-chips>${tagChipsInner()}</div>`:''}</div>`;
 if(localFilterMarkup.get(panel)!==markup){syncLocalFilterMarkup(panel,markup);localFilterMarkup.set(panel,markup);}
 /** 敲一个字母就整块重绘面板的话，正在输入的框会被重建、光标一走字就断了。
  *  所以输入只重画 chips 这一块，输入框本身不动。 */
 panel.oninput=event=>{
  const input=event.target.closest?.('#local-tag-query');
  if(!input)return;
  tagQuery=input.value;
  localFilterMarkup.delete(panel);
  const chips=panel.querySelector('[data-tag-chips]');
  if(chips)chips.innerHTML=tagChipsInner();
  const hit=panel.querySelector('.local-tag-hit');
  if(hit)hit.textContent=tagHitLabel(filterTagEntries(tagEntries,tagQuery).length,tagEntries.length,tagQuery);
 };
 /** Esc 只清关键词：文档上有「Esc 退出模式」的监听，正在搜标签时不该顺带把整屏模式也退了。 */
 panel.onkeydown=event=>{
  if(event.key!=='Escape')return;
  const input=event.target.closest?.('#local-tag-query');
  if(!input)return;
  event.stopPropagation();
  input.value='';tagQuery='';
  localFilterMarkup.delete(panel);
  const chips=panel.querySelector('[data-tag-chips]');
  if(chips)chips.innerHTML=tagChipsInner();
  const hit=panel.querySelector('.local-tag-hit');
  if(hit)hit.textContent='';
 };
 panel.onclick=event=>{
  const remove=event.target.closest('[data-delete-custom-category]');
  if(remove){Promise.resolve(ctx.onDeleteCustomCategory?.(remove.dataset.deleteCustomCategory)).then(()=>renderLocalFilters());return;}
  const add=event.target.closest('[data-add-custom-category]');
  if(add){const parent=add.dataset.addCustomCategory;Promise.resolve(ctx.onAddCustomCategory?.(parent)).then(()=>{openTypeGroups.add(parent);openTypes.add(parent);renderLocalFilters();});return;}
  const custom=event.target.closest('[data-custom-category]');
  if(custom){ctx.onPickCustomCategory?.(custom.dataset.customCategory,custom.dataset.customParent);return;}

  const tabButton=event.target.closest('[data-local-tab]');
  if(tabButton){panel.dataset.tab=tabButton.dataset.localTab;renderLocalFilters();return;}
  const groupButton=event.target.closest('[data-type-group]');
  if(groupButton){const id=groupButton.dataset.typeGroup;const open=!openTypeGroups.has(id);open?openTypeGroups.add(id):openTypeGroups.delete(id);toggleLocalFilterBranch(groupButton.closest('.ftree-group'),open);return;}
  const typeButton=event.target.closest('[data-local-kind]');
  if(typeButton){
   const id=typeButton.dataset.localKind||'';
   // 箭头只管展开收起、点行本体才是选类型：混在一起的话，想收起 3D 分组就会顺手把筛选切走。
   if(event.target.closest('.ftree-caret')&&typeButton.dataset.localKids==='1'){const open=!openTypes.has(id);open?openTypes.add(id):openTypes.delete(id);toggleLocalFilterBranch(typeButton.closest('.ftree-sec'),open);return;}
   ctx.applyLocalType(active===id||state.contentKind===id?'':id);   // 再点一次当前类型＝取消，跟顶部图标顺手
   return;
  }
  const category=event.target.closest('[data-local-category]');
  if(category){
   const value=category.dataset.localCategory||'';
   // 标签面板里点空白处才回到全部：再点一次当前标签也当取消，省得回去找「全部标签」。
   state.localCategory=selected===value?'':value;
   ctx.notifyCategory?.(state.localCategory||'全部标签');
   state.selected.clear();renderGrid();
   renderLocalFilters();   // 选中态（叶子高亮、标签页上的「· 已筛选」）跟结果一起更新，不然点了像没点上
  }
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
  // 天空盒在库里会被归一成跨平台统一的 hdris（见 server/asset-kind.mjs 的 KIND_ALIASES），
  // 而 FreeStylized 自己的类型值只有 skybox / 后端也只认 skybox —— 不先对齐就会掉进
  // 下面那个「不能渲染 → 打开官方页面」的兜底，变成点开跳到官网。
  const raw=m.assetType||'models';
  const fsType=raw==='hdris'||raw==='hdri'||raw==='env'?'skybox':raw;
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
 // 本地模型（拖入 / 导入文件夹进来的 glb、fbx…）：走「本地文件」面板同一条加载链
 // （gltf-preview.loadLocalModel → parseModelBuffer）。旧实现把非图片/视频一律 openExternal，
 // 结果就是库里明明有 3D 资产，点开却把用户甩给系统看图器 —— 等于没有预览。
 if(m.platform==='local'&&canPreviewModelInViewer(m.ext||m.name)){
  const src=m.url||m.previewUrl||'';
  if(!src)return;
  // 解析器按扩展名分发；导出文件名常带个尾点（`xxx__vectorize.`），后缀补不上就认不出格式。
  const base=String(m.name||'模型');
  const name=canPreviewModelInViewer(base)?base:`${base}.${String(m.ext||'').replace(/^\./,'')}`;
  $('#model-details').dataset.tagUid=m.uid;
  $('#viewer').removeAttribute('src');
  $('#preview-dialog').showModal();
  gltfPreview.loadLocalModel({url:src,name});
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
  const src=m.url||m.previewUrl||m.thumbnail||'';
  if(src){
   const item={...m,title:m.name||m.title,url:src,thumb:m.thumbnail||src,pageUrl:m.pageUrl||m.url,
    type:m.assetType==='video'?'video':'image',platform:m.platform};
   return openPicturePreview(item,{platform:m.platform,source:m.pageUrl||m.url,items:[item],model:m});
  }
 }
 showFrameStage();
 // 嵌入地址必须用「平台的模型 id」，不是本地 uid：已下载进库的资产 uid 是入库时重建的主键
 // （标签、收藏、画板都按它关联），平台 id 单独存在 assetId 里。拿本地 uid 去拼 embed，
 // Sketchfab 只会回一个空白 iframe —— 这就是「点开模型一片黑」的成因。
 // 在线发现的资产两者相等，assetId 为空时自动退回 uid。
 const embedId=m.assetId||uid;
 const licenseUrl=typeof m.licenseUrl==='string'&&/^https:\/\/creativecommons\.org\//.test(m.licenseUrl)?m.licenseUrl:null;
 $('#model-details').innerHTML=`<div class="eyebrow">MODEL DETAILS</div><h2>${esc(m.name)}</h2><p class="author-name">by ${esc(m.author)}</p><div class="details-stats"><div><strong>${fmt(m.faces)}</strong><span>面数</span></div><div><strong>${fmt(m.vertices)}</strong><span>顶点</span></div><div><strong>${m.animations||0}</strong><span>动画</span></div><div><strong>${fmt(m.views)}</strong><span>浏览</span></div></div><div class="detail-license"><strong>${esc(m.license)}</strong>${licenseUrl?`<a href="${esc(licenseUrl)}" target="_blank" rel="noopener noreferrer">阅读许可条款 ${icon('external')}</a>`:''}<p>${m.downloadable?'平台标记为可下载，不代表可商用；请遵循许可证的署名、非商业等要求。':'未标记为可下载，仅在拥有明确授权时导出。'}</p></div><div class="tag-list">${(m.tags||[]).slice(0,8).map(t=>`<button data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div><button class="secondary" data-action="ai-tags" data-uid="${uid}">AI 整理标签</button><button class="secondary" data-action="collect" data-uid="${uid}">${icon('folder')}加入我的模型库</button><button class="primary" data-action="download" data-uid="${uid}">${icon('download')}导出到本地</button>${sendControl({job:findLocalJob(downloadsUI()?.jobs||[],uid),className:'secondary',isVisitor})}<a class="source-link" href="https://sketchfab.com/models/${embedId}" target="_blank" rel="noopener noreferrer">打开原始模型页面 ${icon('external')}</a>`;
 // 同一个模型的 embed 地址没变就不重设 src：iframe 内容保持热态，关闭弹窗再开同一个
 // 模型是秒开（Sketchfab viewer 那几 MB JS 不用重新拉）。ArtStation / 本地 three.js
 // 预览会清掉 #viewer 的 src，那时地址不同，自然会重新加载，不会串画面。
 const embed=`https://sketchfab.com/models/${embedId}/embed?autostart=1&ui_infos=0&ui_watermark_link=0`;
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
 async function openPicturePreview(it,ps){
  const token=++picturePreviewToken;
  if(it.type==='video'&&!it.url&&isSocialMediaSite(ps?.platform)){
   try{
    toast?.('正在解析视频预览…');
    const response=await fetch('/api/picture-site/resolve?'+new URLSearchParams({platform:ps.platform,url:it.pageUrl,limit:'60'}),{headers:{'X-SFX-Local':'1'}});
    const data=await response.json();if(!response.ok)throw Error(data.error||'视频解析失败');
    if(token!==picturePreviewToken)return;
    const first=data.items?.find(item=>item.url);if(!first)throw Error('未取得可预览媒体');
    return openPicturePreview(first,{...ps,...data});
   }catch(error){if(token===picturePreviewToken)toast?.(error.message);return;}
  }
  const dlg=$('#file-preview-dialog'),stage=$('#file-preview-stage'),aside=$('#file-preview-details');
  if(!dlg||!stage||!aside)return;
  const images=ps?.items?.length?ps.items:[it];
  // 卡片点击传进来的是一份「从 data-* 还原」的新对象，和 ps.items 里的不是同一个引用，
  // 直接 indexOf 永远得 -1 → 夹到 0，于是点哪张都放大第一张。按原图地址回查真实条目。
  const found=ps?.items?.length?images.findIndex(item=>item===it||(!!it.url&&item.url===it.url)):-1;
  const index=found>=0?found:0;
  // 命中真实条目就用它：缩略图、标签、作者这些字段比 data-* 还原出来的全。
  if(found>=0)it=images[found];
  openImageGallery({title:ps?.title||it.title||'图片预览',images,index,note:false,noteLoading:!!ps?.noteLoading,onChange:(current,currentIndex,count)=>{
  it=current;
  aside.dataset.tagUid=ps?.model?.uid||'';
  // 来源平台给中文名（huaban → 花瓣 Huaban）：这里以前直接吐 platform id，
  // 「来源平台：huaban」这种半成品读起来像没翻译完。
  const rawLabel=it.platform||ps?.platform||'';
  const label=rawLabel?platformLabel(rawLabel):'';
  // 右侧信息栏
  // 作者：服务端能给出可解析的作者主页（花瓣 /user/用户名、pixiv /users/id、civitai /user/用户名）时，
  // 名字就是一个入口 —— 点了用同一套图站解析去看他的作品或画板，不用回浏览器翻。
  const authorName=it.author||ps?.author||'';
  const canJump=typeof openPictureAuthor==='function'&&!!it.authorUrl;
  // Fab 的作者是一等筛选维度（服务端 fabSearch 支持 seller 精确匹配），所以这里的名字直接
  // 做成「只看这位卖家」的入口：点了带着 seller 重搜，不再把人甩到浏览器里自己翻。
  const fabSeller=String((it.platform||ps?.platform||'')==='fab'?authorName:'').trim();
  const authorLine=fabSeller
   ?`<button class="picture-author" data-fab-seller="${esc(fabSeller)}" title="只看这位卖家在 Fab 上的资产">${esc(fabSeller)}<span class="picture-author-go" aria-hidden="true">›</span></button>`
   :it.platform==='artstation'&&it.authorUrl?`<a class="picture-author" href="${esc(it.authorUrl)}" target="_blank" rel="noopener noreferrer">${esc(authorName)}</a>`:canJump
   ?`<button class="picture-author" data-author-url="${esc(it.authorUrl)}" title="查看该作者的作品 / 画板">${esc(authorName||'查看作者')}<span class="picture-author-go" aria-hidden="true">›</span></button>`
   :`<p class="author-name">${esc(authorName||'图站抓取')}</p>`;
  const tagLine=(Array.isArray(it.tags)&&it.tags.length)
   ?`<div class="picture-tags">${it.tags.slice(0,10).map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:'';
  const model=ps?.model;
  const infoModel={...it,...model,name:it.title||model?.name||'未命名图片',platform:it.platform||ps?.platform||model?.platform,assetType:it.type==='3d'?'models':it.type==='video'?'videos':'images',author:canJump||it.authorUrl?'':authorName};
  aside.classList.add('pv-sidebar');
  aside.innerHTML=`${previewHeader(infoModel,{width:it.width,height:it.height,index:currentIndex,count})}
   ${model?tagPanel(state,model,esc):tagLine}
   ${it.description?`<details class="pv-extra"><summary>${icon('help')}<span>详细信息</span></summary><p class="picture-description">${esc(it.description)}</p></details>`:''}
   ${model?artworkActions(model):`<div class="preview-actions"><a class="primary" title="打开原图" aria-label="打开原图" href="${esc(it.embedUrl||it.url)}" target="_blank" rel="noopener noreferrer">${icon('image')}</a>${it.pageUrl?`<a title="查看原网页" aria-label="查看原网页" href="${esc(it.pageUrl)}" target="_blank" rel="noopener noreferrer">${icon('external')}</a>`:''}${it.pid?`<button title="找相似" aria-label="找相似" data-pin-similar="${esc(it.pid)}">${icon('search')}</button>`:''}</div>`}`;
  // 来源行本来就印着「Fab · 作者名」，卖家可点时就地把名字换成按钮，免得同一个名字出现两次。
  if(fabSeller){
   const origin=aside.querySelector('.pv-origin');
   if(origin){
    const label=origin.querySelector('span');if(label)label.textContent='Fab · ';
    origin.insertAdjacentHTML('beforeend',authorLine);
   }
  }else if(canJump||it.authorUrl)aside.querySelector('.pv-origin')?.insertAdjacentHTML('beforeend',authorLine);
  compactPreview(aside,infoModel);
  const authorBtn=aside.querySelector('[data-author-url]');
  if(authorBtn)authorBtn.addEventListener('click',()=>{
   const target=authorBtn.dataset.authorUrl;
   dlg.close();
   openPictureAuthor?.(target,ps?.platform);
  });
  const fabSellerBtn=aside.querySelector('[data-fab-seller]');
  if(fabSellerBtn)fabSellerBtn.addEventListener('click',()=>{
   const seller=fabSellerBtn.dataset.fabSeller;
   dlg.close();
   onFabSeller?.(seller);
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
  const tags=aside.closest('dialog')?.querySelector('.pv-info-panel .asset-tags')||aside.querySelector('.asset-tags');if(tags)tags.outerHTML=tagPanel(state,model,esc);
  compactPreview(aside,model);
 }

/** 图站单张图片/视频卡片的 HTML。首屏渲染与「加载更多」追加共用这一份模板，
 *  否则两批卡片的角标、比例、可点区域会慢慢走样。
 *
 *  结构刻意和模型卡（card-view.js）对齐：左上角类型角标、标题行（标题 + 作者 + 来源平台）、
 *  底部一排圆形图标键。以前这里只有「标题 + 作者块 + 标签行」，和模型卡并排时高度、
 *  角标、动作区全都不一样 —— 同一个资产库里两种卡片语言，看着像没做完。 */
async function downloadMediaPost(ps,url=ps.source||ps.url){
 const manager=downloadsUI();if(!manager?.enqueue){toast?.('后台服务未连接');return;}
 try{
  const song=(ps.items||[]).find(item=>item.pageUrl===url);
  const result=await manager.enqueue([{uid:pictureSiteJobUid(ps.platform,url),platform:ps.platform,name:song?.title||ps.title||'媒体作品',author:song?.author||ps.author||'',thumbnail:song?.thumb||ps.cover||'',url,assetType:isMusicSite(ps.platform)?'audio':(ps.items||[]).some(item=>item.type==='video'||item.mediaType==='video')?'video':'images'}],{output:'folder'},false,undefined,'media');
  toast?.(result.added.length?'已加入媒体下载任务':'此作品已在队列或已下载');
 }catch(error){toast?.(error.message);}
}
function pictureCardHtml(it,ps,gallery,isPin,eager=false){
 // `thumb` 是站方 CDN 的小尺寸变体（花瓣 _fw480：1.7MB → 173KB）；没有就用原图。data-url 始终是原图。
 // v=2：之前缩略图解析失败时服务端会把 4xx 连同 7 天 max-age 一起发回去，浏览器就把「裂图」记了一周。
 // 换一次 URL 绕过那些坏缓存（服务端不读 v，纯缓存键扰动）。
 // 视频投稿（Civitai 的 mp4）：没有海报图，卡片直接用 <video> 播首帧，悬停再静音播一下。
 const isAudio=it.type==='audio';
 const isVideo=it.type==='video'||it.mediaType==='video'||it.noteType==='video'||/\.(mp4|webm|mov)(\?|$)/i.test(it.url||'');
 const isLazyVideo=isVideo&&(!it.url||(ps.platform==='xiaohongshu'&&it.noteType==='video'&&!it.play));
 const audioCover=it.thumb||ps.cover||'';
 const src=isAudio?(audioCover?`/api/image?url=${encodeURIComponent(audioCover)}&card=1&v=2`:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22320%22%3E%3Crect width=%22320%22 height=%22320%22 fill=%22%23252c3a%22/%3E%3Ctext x=%22160%22 y=%22195%22 text-anchor=%22middle%22 fill=%22%23b9c6dd%22 font-size=%22100%22%3E%E2%99%AB%3C/text%3E%3C/svg%3E'):isLazyVideo?`/api/image?url=${encodeURIComponent(it.thumb||ps.cover||'')}&card=1&v=2`:isVideo?`/api/video?url=${encodeURIComponent(it.play||it.url)}`:`/api/image?url=${encodeURIComponent(it.thumb||it.url)}&card=1&v=2`;
 const tags=(it.tags||[]).filter(Boolean);
 const ratio=gallery?aspectRatioStyle(it.width,it.height):'';
 const attrs=`data-url="${esc(it.url)}" data-play="${esc(it.play||'')}" data-type="${isAudio?'audio':isVideo?'video':''}" data-pid="${esc(it.pid||'')}" data-w="${it.width||''}" data-h="${it.height||''}" data-title="${esc(it.title||'')}" data-platform="${esc(ps.platform||'')}" data-source="${esc(ps.source||'')}" data-author="${esc(it.author||'')}" data-author-url="${esc(it.authorUrl||'')}" data-page-url="${esc(it.pageUrl||'')}" data-tags="${esc(tags.join(' '))}" data-category="${esc(it.category||'')}" style="cursor:zoom-in${ratio?`;aspect-ratio:${ratio}`:''}"`;
 // 骨架、封面裁切、标题与作者排版一律交给 card-shell：图站卡片和 ArtStation 图片卡共用同一份 DOM，
 // 样式自然一致。卡片只负责「填什么」。
 const media=isAudio
  ?`<img class="thumbnail" src="${esc(src)}" alt="${esc(it.title||'音频')}" ${attrs}><audio controls preload="none" src="/api/audio?${it.url?`url=${encodeURIComponent(it.url)}`:`platform=${encodeURIComponent(ps.platform)}&amp;source=${encodeURIComponent(it.pageUrl)}`}" aria-label="试听 ${esc(it.title||'歌曲')}" style="position:absolute;bottom:8px;left:8px;width:calc(100% - 16px);z-index:4"></audio>`
  :isVideo&&!isLazyVideo
  ?`<video class="thumbnail" src="${esc(src)}" ${attrs} muted playsinline loop preload="metadata" aria-label="${esc(it.title||'视频')}"></video>`
  :`<img class="thumbnail" loading="${eager?'eager':'lazy'}" decoding="async" src="${esc(src)}" alt="${esc(it.title||'')}" ${attrs}>`;
 // 左上角类型角标：模型卡是「3D ASSET / PBR 材质 / HDRI」，图站这边按图片 / 视频分。
 const typeBadge=`<div class="card-type">${icon(isAudio?'music':isVideo?'play':'image')}${isAudio?'音频':isVideo?'视频':'图片'}</div>`;
 // 图站单图以前整张卡没有收藏键。现在按「平台 + 原图地址」生成稳定 uid，登记成可收藏目标，
 // 复用模型卡那颗心形键与 toggleFavorite -> collect 链路：点一下会真的把这张图记进资产库与收藏。
 const favUid=favoriteUid('picture',`${ps.platform}:${it.url||it.pid||it.pageUrl||it.title||''}`);
 registerFavoriteTarget(favUid,{uid:favUid,name:it.title||ps.title||'未命名图片',platform:ps.platform,
  assetType:isAudio?'audio':isVideo?'video':'image',thumbnail:it.thumb||it.url,url:it.pageUrl||it.url,
  author:it.author||'',license:'',tags});
 const heart=favoriteButtonHtml({uid:favUid,saved:state.favorites.has(favUid),icon,esc});
 // 中间热区沿用 ArtStation 图片卡的同一个 .preview-hit，hover 才浮出来；视频再给一个常驻播放角标。
 const overlay=`${isVideo?`<span class="video-badge" aria-hidden="true">${icon('play')}</span>`:''}${heart}<button class="preview-hit" data-pic-preview aria-label="查看作品图片 ${esc(it.title||'')}"></button>${typeBadge}`;
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
  (isSocialMediaSite(ps.platform)||isMusicSite(ps.platform))?`<button class="card-action-pic" data-pic-download="${esc(it.pageUrl||ps.source||ps.url)}" title="${isAudio?'下载音频':'下载作品全部媒体'}" aria-label="${isAudio?'下载音频':'下载作品全部媒体'}">${icon('download')}<span>下载作品</span></button>`:'',
  `<button class="card-action-pic" data-pic-preview title="${isAudio?'试听 / 暂停':'查看大图'}" aria-label="${isAudio?'试听 / 暂停':'查看大图'} ${esc(it.title||'')}">${icon('eye')}<span>查看大图</span></button>`,
  `<button class="card-action-pic" data-pic-tags="${esc(tags.join(' '))}" title="${esc(tagTip)}" aria-label="标签${tags.length?` ${tags.length}`:''}">${icon('tag')}<span>标签${tags.length?` ${tags.length}`:''}</span></button>`,
  openTarget?`<a class="card-action-pic" href="${esc(openTarget)}" target="_blank" rel="noopener noreferrer" title="${openLabel}" aria-label="${openLabel}">${icon('external')}<span>${openLabel}</span></a>`:'',
  isPin&&it.pid?`<button class="card-action-pic" data-pin-similar data-pid="${esc(it.pid)}" title="用这张图找相似" aria-label="用这张图找相似">${icon('search')}<span>找相似</span></button>`:'',
  (ps.collectionPlatform&&collectionState.platform===ps.collectionPlatform&&collectionState.ops.includes('removeItem')&&it.pid)?`<button class="card-action-pic" data-collection-remove-item data-pid="${esc(it.pid)}" title="从当前收藏夹移出" aria-label="从收藏夹移出">${icon('close')||'✕'}<span>移出收藏</span></button>`:'',
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
 const cover={...it,type:'image',mediaType:'image'};
 openPicturePreview(cover,{...ps,items:[cover],title:it.title,source:pageUrl,noteLoading:true});
 const token=picturePreviewToken;
 toast?.('正在读取笔记内容…');
 try{
  const response=await fetch(`/api/picture-site/resolve?platform=xiaohongshu&refresh=1&url=${encodeURIComponent(pageUrl)}`,{headers:{'X-SFX-Local':'1'}});
  const data=await response.json();
  if(token!==picturePreviewToken)return;
  if(!response.ok)throw Error(data.error||'读取笔记失败');
  const items=(data.items||[]).map(item=>({...item,platform:'xiaohongshu',thumb:item.thumb||item.url,description:item.description||''}));
  if(!items.length)throw Error('这篇笔记没有可展示的图片');
  const first=items.find(item=>item.type==='video'||item.mediaType==='video')||items[0];
  openPicturePreview(first,{platform:'xiaohongshu',source:pageUrl,title:data.title||it.title,author:data.author||it.author,items});
 }catch(error){
  if(token===picturePreviewToken)toast?.(`笔记读取失败：${error.message}`);
 }
}
function bindPictureCards(root,ps,gallery=root?.classList?.contains('gallery')){
 if(!root)return;
 root.querySelectorAll('audio').forEach(audio=>{if(audio.dataset.bound)return;audio.dataset.bound='1';audio.addEventListener('click',event=>event.stopPropagation());audio.addEventListener('error',()=>toast?.('试听失败：平台可能需要登录或未提供完整音频')); });
 root.querySelectorAll('[data-pic-download]').forEach(button=>{
  if(button.dataset.picDownloadBound)return;button.dataset.picDownloadBound='1';
  button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();downloadMediaPost(ps,button.dataset.picDownload);});
 });

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
 // 「移出收藏」：通用收藏夹契约的单条移出操作，能力位来自探测。
 root.querySelectorAll('[data-collection-remove-item]').forEach(btn=>{
  if(btn.dataset.picBound)return;
  btn.dataset.picBound='1';
  btn.addEventListener('click',async event=>{
   event.preventDefault();event.stopPropagation();
   if(!confirm?.('确定把这条从当前收藏夹移出吗？'))return;
   try{
    await collectionMutate(ps,{action:'removeItem',noteId:btn.dataset.pid,boardId:ps.boardId||''});
    toast?.('已从收藏夹移出');
    btn.closest('.model-card')?.remove();
   }catch(error){toast?.(error.message);}
  });
 });
 root.querySelectorAll('img[data-url],video[data-url]').forEach(img=>{
  if(img.dataset.picBound)return;
  img.dataset.picBound='1';
  img.addEventListener('click',()=>{
   if(img.dataset.type==='audio'){const audio=img.closest('.model-card')?.querySelector('audio');if(audio){if(audio.paused)audio.play().catch(error=>toast?.('试听失败：'+error.message));else audio.pause();}return;}
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
  if(itemRatio)return;
  const apply=()=>{
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
  // CSS 已提供 1:1 占位高度，懒加载图片可正常进入视口。
  // 不主动 decode：它会提前请求屏幕外图片，绕过 loading="lazy"。
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
const requestPictureMore=scrollIdleTask(()=>maybeLoadMorePicture());
document.addEventListener('visibilitychange',()=>{if(!document.hidden)requestPictureMore();});
/** Pinterest 的「找相似」处理器：由 renderPictureSite 注入，bindPictureCards 负责给卡片挂事件。 */
let pictureSimilarHandler=null;
/** 工具条入场动效只在该图站这一屏第一次绘制时播：切视图 / 追加卡片都别重放（会闪）。 */
let barKey='';
// 收藏夹能力位（通用契约）：平台无关，进入「我的收藏」视图时按平台拉取一次并缓存。
// ops 是探测后真实可用的写操作；首页/搜索视图为空，前端据此显示或隐藏专辑管理按钮。
let collectionState={platform:'',ops:[],signatures:{},loaded:false};

/** 拉取某平台收藏夹的真实写能力；结果写入 collectionState，供工具条和卡片渲染读取。 */
async function ensureCollectionCaps(ps){
 const platform=ps?.collectionPlatform||'';
 if(!platform)return;
 if(collectionState.loaded&&collectionState.platform===platform)return;
 collectionState={platform,ops:[...(ps.collectionOps||[])],signatures:{},loaded:false};
 try{
  const res=await fetch(`/api/platform-collections/caps?platform=${encodeURIComponent(platform)}`,{headers:{'x-sfx-local':'1'}});
  const data=await res.json().catch(()=>({}));
  if(res.ok&&data.supported){
   collectionState={platform,ops:data.live?.ops||data.collectionOps||[],signatures:data.live?.signatures||{},loaded:true};
  }else collectionState.loaded=true;
 }catch{collectionState.loaded=true;}
 // 能力位到齐后重绘当前视图（工具条 + 专辑卡 + 卡片按钮），让用户立刻看到管理入口。
 if(ps?.mode==='boards'||/\/(?:user\/collect|board\/)/.test(ps?.url||''))renderPictureSite();
}

/** 统一的收藏夹写操作调用；成功返回 data，失败抛错由调用方 toast。 */
async function collectionMutate(ps,input){
 const platform=ps?.collectionPlatform||'';
 const signature=collectionState.signatures?.[input.action];
 const res=await fetch('/api/platform-collections',{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1'},body:JSON.stringify({...input,platform,signature})});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw Error(data.error||'操作失败');
 return data;
}
/** 状态胶囊上的数字：有总数就写「已取 / 共」，否则只写已取。 */
function pictureStatText(n,total){return total>n?`${n} / ${total}`:`${n}`;}
/** 状态胶囊的 title：把原来那一整行说明（含来源）收进提示，不在界面上占位置。 */
function pictureStatTitle(ps,n){
 if(ps?.busy)return ps.status||'正在加载图片…';
 if(ps?.error)return ps.status||'图片加载失败';
 const total=Number(ps?.total)||0;
 const head=ps?.truncated?`已加载 ${n}${total>n?` / 共 ${total}`:''} 张 · 继续下滑自动加载更多`:`已加载 ${n} 张 · 当前清单已结束`;
 return `${head}；下载会抓取整站原图${ps?.source?`（来源：${ps.source}）`:''}`;
}
function pictureMoreHost(){return $('#grid')?.querySelector('.picture-site-more');}
/** 底部续页行与顶部状态胶囊跟着 items/truncated/total 走，追加卡片后必须重算一次。 */
function syncPictureMore(){
 const ps=state.pictureSite,host=pictureMoreHost(),n=(ps?.mode==='boards'?ps.boards||[]:ps?.items||[]).length;
 const unit=ps?.mode==='boards'?'位关注用户':'张';
 const total=Number(ps?.total)||0;
 const count=pictureStatText(n,total);
 const error=ps?.lastError||ps?.warning||'';
 if(host){
  host.hidden=false;
  host.innerHTML=ps?.loadingMore
   ?'<span class="picture-more-text">正在加载更多…</span>'
   :error
    ?`<span>${ps.lastError?'加载更多失败：':''}${esc(error)}</span><button type="button" class="secondary" id="picture-more-retry">重试</button>`
   :ps?.truncated
    ?`<span class="picture-more-text">${count} · 继续下滑自动加载</span><button type="button" class="secondary" id="picture-more-button">加载更多</button>`
    :`<span class="picture-more-text">已经到底了 · 共 ${n} ${unit}</span>`;
  // 滚动之外留一个显式的「加载更多」：触控板惯性不好使、或者观察器被判到视口外时，
  // 用户至少有一个能点的东西 —— 模型平台的分页按钮就是这个角色。
  const button=host.querySelector('#picture-more-button');
  if(button)button.onclick=()=>loadMorePicture();
  const retry=host.querySelector('#picture-more-retry');
  if(retry)retry.onclick=()=>{ps.retryAt=0;ps.warning='';ps.lastError='';loadMorePicture();};
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
   requestPictureMore();
  },{rootMargin:'600px 0px'});
 }
 pictureMoreObserver.disconnect();
 const host=pictureMoreHost();
 if(host&&!host.hidden)pictureMoreObserver.observe(host);
}
function maybeLoadMorePicture(){
 if(document.hidden)return;
 const ps=state.pictureSite;
 if(!ps||ps.busy||ps.controller||ps.loadingMore||ps.warning||ps.lastError||!ps.truncated||!(ps.mode==='boards'?ps.boards:ps.items)?.length)return;
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
 if(!ps||ps.busy||ps.controller||ps.loadingMore||!ps.truncated||state.route!=='discover')return;
 const next=Math.min(current+PICTURE_PAGE,PICTURE_LIMIT_MAX);
 if(next<=current){ps.truncated=false;syncPictureMore();return;}
 const controller=new AbortController();ps.moreController=controller;
 ps.loadingMore=true;ps.lastError='';
 syncPictureMore();
 try{
  const res=await fetch(`/api/picture-site/resolve?platform=${encodeURIComponent(ps.platform)}&limit=${next}&url=${encodeURIComponent(ps.url)}`,{headers:{'x-sfx-local':'1'},signal:controller.signal});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||'加载更多失败');
  // 期间切了平台/页面：这批结果只服务旧的那一屏，丢掉。
  if(controller.signal.aborted||state.pictureSite!==ps||state.route!=='discover')return;
  const previousItems=ps.items||[];
  const fresh=mergePicturePage(ps,data,next);
  const reordered=previousItems.some((item,index)=>item.url!==ps.items?.[index]?.url);
  if(fresh.length||reordered){
   if(ps.mode==='boards'||reordered)renderPictureSite();
   else appendPictureCards(fresh,ps);
  }
  ps.retryAt=!fresh.length&&ps.truncated?Date.now()+1500:0;
  rememberPictureSnapshot(ps);
 }catch(e){
  if(controller.signal.aborted)return;
  ps.retryAt=Date.now()+5000;
  ps.lastError=e.message||'网络错误';
 }finally{
  if(ps.moreController!==controller)return;
  ps.moreController=null;ps.loadingMore=false;
  if(state.pictureSite===ps&&state.route==='discover'){
   syncPictureMore();
   if(!ps.lastError&&!ps.warning){
    // 追加后如果哨兵还在视口附近（超宽屏 / 短图），接着补下一页，不用等用户再滑。
    if(ps.truncated)setTimeout(maybeLoadMorePicture,Math.max(250,(ps.retryAt||0)-Date.now()));
   }
  }
 }
}
/** 续页只追加 DOM，不整屏重绘：已加载的缩略图不重新解码，滚动位置也不会跳。 */
function appendPictureCards(items,ps){
 const root=$('#grid')?.querySelector('.picture-site-gallery');
 if(!root)return;
 const gallery=root.classList.contains('gallery');
 const batch=document.createElement('template');
 batch.innerHTML=items.map(it=>pictureCardHtml(it,ps,gallery,ps.platform==='pinterest')).join('');
 bindPictureCards(batch.content,ps,gallery);
 root.append(batch.content);
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
function renderPictureHead(ps,{items,boards,boardMode}){
 const list=Array.isArray(items)?items:[];
 const title=$('#library-title');
 const xhs=ps.platform==='xiaohongshu';
 // 收藏夹能力位（通用契约）：有 collectionPlatform 即视为可展示收藏入口，不再写死平台名。
 const cp=ps.collectionPlatform||'';
 const hasCollectionView=!!cp&&!!ps.collectionCollectUrl;
 // 兜底：小红书是首个实现，切换键常驻显示，不依赖能力位链路。
 // 服务端没重启 / 能力位没透传时，用户仍能从推荐页进收藏夹，不会被焊死入口。
 // 其他平台继续纯能力位驱动，新平台照契约接入即可，不受此兜底影响。
 const showCollectionSwitch=hasCollectionView||ps.platform==='xiaohongshu';
 const pageUrl=ps.url||ps.source||'';
 const isCollectView=xhs?/\/user\/collect|\/board\//.test(pageUrl):!!(ps.collectionCollectDetect&&new RegExp(ps.collectionCollectDetect).test(pageUrl));
 const personalView=xhs?((ps.url||'').match(/\/user\/(likes|history|following)(?:[?#/]|$)/)?.[1]||''):'';
 const huaban=ps.platform==='huaban';
 const huabanView=huaban?((ps.url||'').match(/\/me\/(boards|following)(?:[?#/]|$)/)?.[1]||''):'';
 const caps=collectionState.platform===cp?collectionState.ops:(ps.collectionOps||[]);
 const canCreate=caps.includes('create');
 title.hidden=true;
 if(title.parentElement){
  title.parentElement.hidden=false;
  title.parentElement.querySelectorAll('.psb-account,.model-count-inline').forEach(node=>node.remove());
  // 加载中不在标题旁再写一句「加载中…」：内容区正中的动效已经表达同一件事，两处重复只会显得碎。
  if(!ps.busy)title.parentElement.insertAdjacentHTML('afterbegin',`<span class="model-count-inline" id="picture-site-hint" role="status" title="${esc(personalView==='following'?'当前加载的关注用户，点击查看作品':pictureStatTitle(ps,list.length))}"><span class="psb-count">${esc(ps.error?'加载失败':personalView==='following'?String(boards.length):pictureStatText(list.length,Number(ps.total)||0))}</span>${ps.error?'':personalView==='following'?'<span>位关注用户</span>':'<span>张</span>'}</span>`);
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
   ${ps.fromBoards?`<button class="psb-icon" id="picture-site-back" title="返回上一页（画板墙）" aria-label="返回上一页">${icon('arrow-left')}</button>`:''}
   ${((isMusicSite(ps.platform)||isSocialMediaSite(ps.platform))&&isSearchQuery)||(xhs&&!/\/(?:explore|discovery\/item)\/[a-z0-9]{16,}/i.test(ps.source||ps.url||''))?'':`<button class="psb-icon" id="picture-site-download" ${canAct?'':'disabled'} title="${(isSocialMediaSite(ps.platform)||isMusicSite(ps.platform))?'下载作品的视频、图集和实况图':isSearchQuery?'把这次搜索到的图片抓进图片库':'把整站图片抓进图片库（原图，不是缩略图）'}" aria-label="${isSearchQuery?'下载这批':'下载整站'}">${icon('download')}</button>`}
   ${canCreate&&boardMode?`<form class="xhs-album-create" id="xhs-album-create"><input name="name" maxlength="20" placeholder="新${esc(ps.collectionLabel||'专辑')}" aria-label="新${esc(ps.collectionLabel||'专辑')}名称"><button type="submit">创建</button></form>`:''}
   ${xhs?'':`<button class="psb-icon" id="picture-site-bookmark" ${canAct?'':'disabled'} title="只入库不下载" aria-label="只入库不下载">${icon('save')}</button>`}
   ${showCollectionSwitch?`<span class="psb-switch" role="group" aria-label="${esc(ps.collectionLabel||'平台')}内容"><button type="button" id="xhs-view-home" class="${isCollectView||personalView?'':'active'}">${icon('compass')}<span>推荐</span></button><button type="button" id="xhs-view-collect" class="${isCollectView?'active':''}">${icon('star')}<span>收藏</span></button>${xhs?`<button type="button" id="xhs-view-following" class="${personalView==='following'?'active':''}" aria-pressed="${personalView==='following'}">${icon('user')}<span>关注</span></button><button type="button" id="xhs-view-history" class="${personalView==='history'?'active':''}" aria-pressed="${personalView==='history'}">${icon('clock')}<span>浏览</span></button><button type="button" id="xhs-view-likes" class="${personalView==='likes'?'active':''}" aria-pressed="${personalView==='likes'}">${icon('heart')}<span>赞过</span></button>`:''}</span>`:''}
   ${huaban?`<span class="psb-switch" role="group" aria-label="花瓣内容"><button type="button" id="huaban-view-home" class="${huabanView?'':'active'}">推荐</button><button type="button" id="huaban-view-boards" class="${huabanView==='boards'?'active':''}">收藏画板</button><button type="button" id="huaban-view-following" class="${huabanView==='following'?'active':''}">关注</button></span>`:''}
   ${ps.platform==='500px'?`<span class="psb-switch" role="group" aria-label="500px 精选流"><button type="button" data-px-feed="editors" class="${/\/fresh\/?(\?|$)/i.test(ps.url||'')?'':'active'}">编辑精选</button><button type="button" data-px-feed="fresh" class="${/\/fresh\/?(\?|$)/i.test(ps.url||'')?'active':''}">最新上架</button></span>`:''}
   ${ps.platform==='pinterest'?`<button class="psb-icon" id="picture-site-similar" ${canAct?'':'disabled'} title="用当前结果找相似" aria-label="用当前结果找相似">${icon('sparkle2')}</button>`:''}`;
 // 返回上一页：从导航栈弹出上一层操作（画板墙），不发请求、不丢内存里的画板列表。
 // 之前这颗按钮只渲染没绑事件，点了没反应。栈空时给个提示，别留个死键。
 const backBtn=$('#picture-site-back');
 if(backBtn)backBtn.onclick=()=>{
  if(typeof backToPictureBoards==='function'&&backToPictureBoards())return;
  toast?.('没有可返回的上一页');
 };
 const homeBtn=$('#xhs-view-home'),collectBtn=$('#xhs-view-collect');
 // URL 同样兜底：能力位未到时用小红书默认地址，保证这两个键点了真能切页。
 const homeUrl=ps.collectionHomeUrl||'https://www.xiaohongshu.com/explore';
 const collectUrl=ps.collectionCollectUrl||'https://www.xiaohongshu.com/user/collect';
 if(homeBtn)homeBtn.onclick=()=>openPictureUrl?.(homeUrl);
 if(collectBtn)collectBtn.onclick=()=>openPictureUrl?.(collectUrl);
 for(const kind of ['history','likes','following']){const button=$('#xhs-view-'+kind);if(button)button.onclick=()=>openPictureUrl?.('https://www.xiaohongshu.com/user/'+kind,'xiaohongshu');}
 const huabanHome=$('#huaban-view-home'),huabanBoards=$('#huaban-view-boards'),huabanFollowing=$('#huaban-view-following');
 if(huabanHome)huabanHome.onclick=()=>openPictureUrl?.('插画','huaban');
 if(huabanBoards)huabanBoards.onclick=()=>openPictureUrl?.('https://huaban.com/me/boards','huaban');
 if(huabanFollowing)huabanFollowing.onclick=()=>openPictureUrl?.('https://huaban.com/me/following','huaban');
 const createForm=$('#xhs-album-create');
 if(createForm)createForm.onsubmit=async event=>{
  event.preventDefault();
  const name=new FormData(createForm).get('name');
  const button=createForm.querySelector('button');
  button.disabled=true;
  try{
   await collectionMutate(ps,{action:'create',name});
   toast?.(`已在${ps.collectionLabel||'平台'}创建${ps.collectionLabel||'专辑'}「${String(name||'').trim()}」`);
   openPictureUrl?.(ps.collectionCollectUrl);
  }catch(error){toast?.(error.message);button.disabled=false;}
 };
 // 500px 精选流切换：两个流都是真实可拉的公开流，点了换 URL 走同一套解析。
 bar.querySelectorAll('[data-px-feed]').forEach(button=>{
  button.onclick=()=>openPictureUrl?.(`https://500px.com/${button.dataset.pxFeed==='fresh'?'fresh':'editors'}`);
 });
 renderPictureCategories(ps);
}
/** 500px 筛选面板（对齐原站 Fresh 筛选）：分类 8 项多选 + 摄影器材 2 项 + 仅看推荐新作。
 *  分类是 editorsChoices / freshResources 都支持的原生参数（抓官方 bundle + getFreshOptions 实测），
 *  两个精选流都能用；器材(equipments) 和 仅推荐(qualityEnabled) 是 freshResources 专属，只在
 *  「最新上架」流显示。选中后拼 ?categories=&equipments=&quality=1 走 openPictureUrl 重新拉图。 */
const PX_CATS=[['landscape','Landscape'],['city','City'],['people','People'],['nature','Nature'],['still life','Still Life'],['events','Events'],['sports','Sports'],['creative','Creative']];
const PX_GEARS=[['CAMERA','相机'],['PHONE','手机']];
// Flickr 没有官方分类接口（getHotList 空 / getClusters 失败），但 photos.search 的 tags 是原站
// 浏览标签的正式通道（实测每题材 8–11 万张）。取一组摄影题材当分类，比 500px 的官方枚举略多。
const FLICKR_CATS=[['landscape','风光'],['portrait','人像'],['nature','自然'],['architecture','建筑'],['street','街头'],['wildlife','野生动物'],['night','夜景'],['flower','花卉'],['black and white','黑白'],['travel','旅行']];
function pxFilterFromUrl(url){
 let u;try{u=new URL(url);}catch{return {cats:new Set(),gears:new Set(),quality:false};}
 const list=k=>new Set((u.searchParams.get(k)||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean));
 return {cats:list('categories'),gears:list('equipments'),quality:u.searchParams.get('quality')==='1'||u.searchParams.get('quality')==='true'};
}
/** 分类面板宿主：放在左侧「分类与筛选」抽屉里（用户要求，不再挂结果区标题栏）。
 *  复用 renderGrid 每次重绘的时机刷新，切到非图站 / 非目标平台时清掉容器。 */
function pictureCatsHost(ps){
 let host=document.getElementById('filters-picture-cats');
 if(ps.platform!=='500px'&&ps.platform!=='flickr'){host?.remove();return null;}
 if(!host){
  host=document.createElement('div');host.id='filters-picture-cats';host.className='filters-picture-cats';
  const anchor=document.getElementById('filters-platform-empty');
  if(anchor)anchor.after(host);else document.getElementById('filter-rows')?.appendChild(host);
 }
 host.innerHTML='';
 return host;
}
function renderPictureCategories(ps){
 const host=pictureCatsHost(ps);
 if(!host)return;
 if(ps.platform==='flickr'){renderFlickrCategories(ps,host);return;}
 if(ps.platform!=='500px')return;
 const url=String(ps.url||'');
 // 两个精选流路径：editorsChoices / freshResources 都支持 categories；器材与仅推荐只 fresh 支持。
 let path='/editors';
 try{const seg=new URL(url).pathname;if(/\/fresh\/?$/i.test(seg))path='/fresh';}catch{}
 const isFresh=path==='/fresh';
 const cur=pxFilterFromUrl(url);
 const row=document.createElement('div');
 row.id='picture-site-categories';row.className='picture-site-categories';
 const chip=(kind,val,label)=>`<button type="button" class="psb-cat${cur[kind].has(val.toLowerCase())?' active':''}" data-px-filter="${kind}" data-val="${esc(val)}" aria-pressed="${cur[kind].has(val.toLowerCase())}">${esc(label)}</button>`;
  row.innerHTML=`<span class="psb-cat-label">分类</span>${PX_CATS.map(([v,l])=>chip('cats',v,l)).join('')}`
  +(isFresh?`<span class="psb-cat-sep"></span><span class="psb-cat-label">器材</span>${PX_GEARS.map(([v,l])=>chip('gears',v,l)).join('')}`
   +`<span class="psb-cat-sep"></span><button type="button" class="psb-cat${cur.quality?' active':''}" data-px-filter="quality" aria-pressed="${cur.quality}">仅看推荐新作</button>`:'')
  +`<button type="button" class="psb-cat psb-cat-reset" data-px-filter="reset">重置</button>`;
 host.appendChild(row);
 row.querySelectorAll('[data-px-filter]').forEach(button=>{
  button.onclick=()=>{
   const kind=button.dataset.pxFilter;
   const next=pxFilterFromUrl(url);
   if(kind==='reset'){next.cats.clear();next.gears.clear();next.quality=false;}
   else if(kind==='quality')next.quality=!next.quality;
   else{const val=button.dataset.val.toLowerCase();const set=next[kind];set.has(val)?set.delete(val):set.add(val);}
   const parts=[];
   if(next.cats.size)parts.push('categories='+[...next.cats].join(','));
   if(isFresh){
    if(next.gears.size)parts.push('equipments='+[...next.gears].join(','));
    if(next.quality)parts.push('quality=1');
   }
   openPictureUrl?.('https://500px.com'+path+(parts.length?'?'+parts.join('&'):''));
  };
 });
}
/** Flickr 题材分类行：点题材走 flickr.photos.search 的 tags 参数（原站标签浏览通道）。
 *  单选：选中就是该题材的标签搜索页；点「全部」回探索推荐流。 */
function renderFlickrCategories(ps,host){
 if(!host)return;
 const url=String(ps.url||'');
 let picked='';
 try{picked=(new URL(url).searchParams.get('tags')||'').split(',')[0].trim().toLowerCase();}catch{}
 const row=document.createElement('div');
 row.id='picture-site-categories';row.className='picture-site-categories';
 const chip=(val,label)=>`<button type="button" class="psb-cat${picked===val?' active':''}" data-fl-tag="${esc(val)}" aria-pressed="${picked===val}">${esc(label)}</button>`;
 row.innerHTML=`<span class="psb-cat-label">分类</span>${chip('','全部')}${FLICKR_CATS.map(([v,l])=>chip(v,l)).join('')}`;
 host.appendChild(row);
 row.querySelectorAll('[data-fl-tag]').forEach(button=>{
  button.onclick=()=>{
   const tag=button.dataset.flTag;
   openPictureUrl?.(tag?`https://www.flickr.com/search/?tags=${encodeURIComponent(tag)}`:'https://www.flickr.com/explore');
  };
 });
}
/** 离开图站（回模型平台 / 本地库）要把这条工具条和分类行一起摘掉，否则会跟着标题行留在那儿。 */
function clearPictureHead(){
 document.getElementById('picture-site-toolbar')?.remove();
 document.getElementById('picture-site-categories')?.remove();
 document.getElementById('filters-picture-cats')?.remove();
 document.querySelectorAll('.psb-account,.model-count-inline').forEach(node=>node.remove());
}
/**
 * 所有发现平台共用左侧纯文字数量，右侧保留可用操作与显示设置。
 */
function renderModelHead({f,subtitle}){
 const title=$('#library-title'),host=title?.parentElement;
 if(!title||!host)return;
 title.hidden=true;host.hidden=false;
 host.querySelectorAll('.psb-account,.model-count-inline').forEach(node=>node.remove());
 const note=`${f.rows.length} 个`;
 const detail=[subtitle||note,f.pending.length?`待解析 ${f.pending.length} 个链接`:'',pageInfoNote({source:state.source,platform:state.platform})].filter(Boolean).join(' · ');
 host.insertAdjacentHTML('afterbegin',`<span class="model-count-inline" role="status" title="${esc(detail)}">${esc(note)}</span>`);
 $('#library-subtitle').hidden=true;
 document.getElementById('picture-site-toolbar')?.remove();
}

function renderPictureSite(){
 gridSignature='';gridMode='';cardHtml.clear();
 const ps=state.pictureSite||{};
 const grid=$('#grid');
 const allItems=Array.isArray(ps.items)?ps.items:[];
 // 站点分类本地筛选（500px 等图站每张图带 category）：按选中的分类过滤，不重新发请求。
 // 选中值不存在于当前批次时自动落回「全部」，避免换流/换链接后停在一个空筛选上。
 const picked=String(ps.pictureCategory||'');
 const pickedValid=!picked||allItems.some(it=>String(it.category||'')===picked);
 if(picked&&!pickedValid)ps.pictureCategory='';
 const items=!picked||!pickedValid?allItems:allItems.filter(it=>String(it.category||'')===picked);
 const isPin=ps.platform==='pinterest';
 const boards=Array.isArray(ps.boards)?ps.boards:[];
 // 两级解析的第一级：作者主页 → 画板墙（一块画板一张卡）；第二级才是它的图片。
 const boardMode=ps.mode==='boards';
 // 收藏视图（resolver 带 collectionPlatform）才探测写能力，避免普通搜索/首页为探测开浏览器。
 if(ps.collectionPlatform)ensureCollectionCaps(ps);
 $('#model-count').hidden=true;
 renderPictureHead(ps,{items,boards,boardMode});
 $('#empty').hidden=true;
 $('#pagination').hidden=true;
 renderDisplayButtons({boards:boardMode});
 // 三种「无图可看」的状态一律用普通网格：gallery 是多列瀑布流，会把单个提示块切成多栏错位。
 if(ps.busy){grid.className='model-grid';grid.innerHTML=loadingHtml(ps.status||'正在加载图片…');return;}
 if(ps.error){const askLogin=pictureSiteLoginable(ps.platform)&&(ps.platform==='xiaohongshu'?/登录已失效|请先登录|需要登录|扫码登录|验证码/:/登录|扫码|验证/).test(ps.status||'');
  const message=askLogin?'请登录后重试。':/platform|url|参数/i.test(ps.status||'')?'请粘贴有效链接后重试。':'请检查链接或网络后重试。';
  const personalError=ps.platform==='xiaohongshu';
  grid.className='model-grid';grid.innerHTML=`<div class="discovery-error" role="status"><p>${personalError?esc(ps.status||message):`解析失败，${message}`}</p>${askLogin?'<button class="secondary" id="picture-site-error-login">登录后重试</button>':''}</div>`;
  // 失败卡上也要有登录入口：'需要先登录' 这种原因，用户看得到却无处可点是最糟的。
  bindSiteLogin($('#picture-site-error-login'),ps.platform,{toast,onClosed:()=>reloadPictureSite?.()});
  return;}
 if(boardMode){
  if(!boards.length){grid.className='model-grid';grid.innerHTML='<div class="empty"><div class="empty-cube"><i data-icon="cube"></i></div><h3>没有公开画板</h3><p>这个作者还没有公开的画板。</p></div>';return;}
  // 注意：cp / caps 是 renderPictureHead 的局部变量，本函数作用域没有，必须就地重算。
  const liveCp=ps.collectionPlatform||'';
  const liveOps=collectionState.platform===liveCp?collectionState.ops:[];
  const canRename=liveOps.includes('rename'),canRemove=liveOps.includes('remove');
  grid.className=ps.platform==='xiaohongshu'&&/\/user\/following(?:[?#/]|$)/.test(ps.url||'')?'board-grid xhs-following-grid':'board-grid';
  grid.innerHTML=boards.map(board=>{
   const manage=board.id&&board.id!=='all'&&(canRename||canRemove)
    ?`<span class="board-manage">${canRename?`<button type="button" class="board-mgmt" data-board-rename="${esc(board.id)}" data-title="${esc(board.title||'')}" title="重命名" aria-label="重命名画板">✎</button>`:''}${canRemove?`<button type="button" class="board-mgmt" data-board-remove="${esc(board.id)}" data-title="${esc(board.title||'')}" title="删除" aria-label="删除画板">✕</button>`:''}</span>`:'';
   return `<figure class="board-card" data-board-id="${esc(board.id)}" data-board-url="${esc(board.url||'')}" data-board-title="${esc(board.title||'')}" role="button" tabindex="0" aria-label="${ps.platform==='xiaohongshu'&&/\/user\/following/.test(ps.url||'')?'查看关注用户':'打开画板'} ${esc(board.title||'')}">
    ${board.thumb||board.cover?`<img class="board-cover" loading="lazy" src="/api/image?url=${encodeURIComponent(board.thumb||board.cover)}&card=1" alt="">`:'<div class="board-cover board-cover-empty" aria-hidden="true"></div>'}
    ${manage}
    <figcaption><strong>${esc(board.title||'未命名画板')}</strong><span>${board.count?`${board.count} ${esc(board.unit||'张')}`:ps.platform==='xiaohongshu'&&/\/user\/following/.test(ps.url||'')?'查看作品':'空画板'}</span></figcaption>
   </figure>`;}).join('');
  // 点卡片 = 解析这块画板的图片（同一套 /api/picture-site/resolve，只是 URL 换成画板页）。
  grid.querySelectorAll('[data-board-id]').forEach(node=>{
   const open=()=>openPictureBoard?.({id:node.dataset.boardId,url:node.dataset.boardUrl,title:node.dataset.boardTitle});
   node.addEventListener('click',event=>{
    if(event.target.closest('.board-manage'))return; // 管理按钮不触发打开
    open();
   });
   node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
  });
  // 专辑重命名 / 删除：走统一写操作端点，能力位来自探测。
  grid.querySelectorAll('[data-board-rename]').forEach(btn=>btn.addEventListener('click',async event=>{
   event.stopPropagation();
   const next=await askText?.({title:'重命名画板',message:'新名称：',value:btn.dataset.title,maxLength:20});
   if(!next||next===btn.dataset.title)return;
   try{await collectionMutate(ps,{action:'rename',boardId:btn.dataset.boardRename,name:next});toast?.('已重命名');ensureCollectionCaps(ps);}catch(error){toast?.(error.message);}
  }));
  grid.querySelectorAll('[data-board-remove]').forEach(btn=>btn.addEventListener('click',async event=>{
   event.stopPropagation();
   if(!confirm?.(`确定删除画板「${btn.dataset.title}」吗？此操作不可撤销。`))return;
   try{await collectionMutate(ps,{action:'remove',boardId:btn.dataset.boardRemove});toast?.('已删除');ensureCollectionCaps(ps);}catch(error){toast?.(error.message);}
  }));
  if(ps.truncated){
   grid.insertAdjacentHTML('beforeend','<div class="picture-site-more" style="grid-column:1/-1"></div>');
   syncPictureMore();observePictureMore();setTimeout(maybeLoadMorePicture,400);
  }
  return;
 }
 if(!items.length){const personalEmpty=ps.platform==='xiaohongshu'&&/\/user\/(?:likes|history|collect)/.test(ps.url||'');grid.className='model-grid';grid.innerHTML=`<div class="empty"><div class="empty-cube">${icon('cube')}</div><h3>${personalEmpty?'没有读到内容':'没有可显示的图片'}</h3><p>${esc(personalEmpty?(ps.warning||ps.status||'网页个人主页这一栏是空的，或登录已失效。'):'该链接可能未公开或需要登录。')}</p>${pictureSiteLoginable(ps.platform)?`<button class="secondary" id="picture-site-error-login" style="margin-top:14px">${icon('user')} 登录 / 扫码后重试</button>`:''}</div>`;bindSiteLogin($('#picture-site-error-login'),ps.platform,{toast,onClosed:()=>reloadPictureSite?.()});return;}
  grid.className='picture-site-results';
  // 瀑布流按原图比例排：接口里带宽高的卡片直接写内联 aspect-ratio，列高一次就位。
 // 不带的（booru / 站酷这类只给缩略图地址）等图片解码后由下方循环补上。
 const gallery=galleryActive(state);
 const cards=items.map((it,index)=>pictureCardHtml(it,ps,gallery,isPin,index<8)).join('');
 // limit：这一屏已经取到第几张（滚动加载按 PICTURE_PAGE 递增）。从缓存恢复的旧数据没这个字段，用条目数顶上。
 if(!Number(ps.limit))ps.limit=items.length||PICTURE_PAGE;

  const more=!!ps.truncated;
  // 工具条已经在标题行里画好了（renderPictureHead），这里只铺瀑布流本体：
  // 「继续下滑自动加载」那句由底部哨兵承担，不再在顶部重复一遍。
  grid.innerHTML=`<div class="${displayGridClass(state)} picture-site-gallery">${cards}</div>`+
   `<div class="picture-site-more"${more?'':' hidden'}><span class="picture-more-text">${more?'继续下滑自动加载…':`已经到底了 · 共 ${items.length} 张`}</span></div>`;
 // 卡片事件与瀑布流比例纠正统一走 bindPictureCards：追加新卡片时只绑没绑过的节点。
 bindPictureCards(grid.querySelector('.picture-site-gallery'),ps);
 syncPictureMore();
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
  if((isSocialMediaSite(ps.platform)||isMusicSite(ps.platform)))return downloadMediaPost(ps);
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
  // 回退清单：服务端会用自己的全量解析结果覆盖；解析失败时至少能翻当前已加载的这批。
  remoteImages:(ps.items||[]).filter(it=>it&&!it.play&&it.type!=='video').map(it=>({url:it.url,thumb:it.thumb,title:it.title,pageUrl:it.pageUrl,author:it.author,width:it.width,height:it.height})),
 })});
 const data=await res.json().catch(()=>({}));
 if(!res.ok)throw Error(data.error||`写入失败（HTTP ${res.status}）`);
 toast?.(data.skipped?`资产库里已经有这个包：${data.title}`:`已记入资产库：${data.title}${data.imageCount?`（${data.imageCount} 张）`:''}`);
 await refreshAssets?.();
}
return {refreshCategories:renderLocalFilters,counts,renderStatus,renderGrid,placeFilters,preview,syncStickyOffset,refreshArtworkActions,setBoardDeck,bookmarkCurrentPicture,syncPictureMore:()=>{syncPictureMore();requestPictureMore();}};
}
