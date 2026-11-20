import {revealInFileManager} from './reveal-path.mjs';
import {cardThumbnail} from './card-thumbnail.mjs';
import {claimIndex,isClaimed,isPendingClaim} from './asset-claim.mjs';
import {auditLibrary,repairLibrary} from './library-audit.mjs';
import {createResourceUsage} from './resource-usage.mjs';
import {FORMATS} from '../src/library/format-registry.js';
import {createPlatformSettings,platformForPath} from './platform-settings.mjs';
import {createAuth} from './auth.mjs';
import {isExportWorkerRequest} from './export-worker.mjs';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {chineseError} from '../src/library/error-message.js';
import {listenPort} from './listen-port.mjs';
import {createLanListener} from './lan-listener.mjs';
import {createLibraryStorage,MAX_STATE_BYTES,MAX_CATALOG_BYTES} from './library-storage.mjs';
import {createLibraryApi} from './library-api.mjs';
import {createBackupService} from './library-backup.mjs';
import {createCollectRules} from './collect-rules.mjs';
import {createCollectPending} from './collect-pending.mjs';
import {createCollectGuard} from './collect-guard.mjs';
import {createCollectRunner} from './collect-runner.mjs';
import {COLLECT_PLATFORMS} from './collect-search.mjs';
import {createCollectScheduler} from './collect-scheduler.mjs';
import {createCollectApi} from './collect-api.mjs';
import {createCollectSearch} from './collect-search.mjs';
import fs from 'node:fs/promises';
import {createReadStream,writeSync,readFileSync,openSync,appendFileSync,writeFileSync} from 'node:fs';
import {DownloadManager} from './downloads.mjs';
import {createExports} from './exports.mjs';
import {browseFolders,nativeFolderPicker} from './folder-dialog.mjs';
import {createImportRoots} from './import-roots.mjs';
import {preflightLocalFiles} from './local-import-preflight.mjs';
import {createLocalFileImporter} from './local-file-import.mjs';
import {createFileOrganizePreflight} from './file-organize-preflight.mjs';
import {createFileOrganizer} from './file-organizer.mjs';
import {createTagBackfill} from './tag-backfill.mjs';
import {createTagManagement} from './tag-management.mjs';
import {createTaxonomyRules} from './taxonomy-rules.mjs';
import {createLocationMigration} from './location-migration.mjs';
import {repairAssetTypes} from './asset-type-repair.mjs';
import {repairAiMeta} from './ai-meta-repair.mjs';
import {createWebdavSync} from './webdav-sync.mjs';
import {createVectorIndex} from './vector-index.mjs';
import {listLocalFolder,resolveLocalFile,resolveLocalTarget,localMime,parseRange} from './local-browse.mjs';
import {listArchiveEntries,extractArchiveEntry} from './archive.mjs';
import {scanLibraryPackages,catalogUidsForRemovedPaths} from './local-assets.mjs';
import {writePictureBoardCard,isBoardUid} from './picture-board.mjs';
import {assetFolder} from './asset-folders.mjs';
import {pictureWindow,forgetPictureIndex} from './picture-index.mjs';
import {cachedScan, invalidateScanCache} from './scan-cache.mjs';
import {registerPackage,patchPackageMeta} from './asset-meta.mjs';
import {findFfmpeg,probeMedia,transcodePlan,streamMp4} from './video-transcode.mjs';
import {docStatus,convertToPdf,canConvertDoc} from './doc-convert.mjs';
import {thumbFor,saveModelThumb,LIST_THUMB_SIZE,cacheStats,trimCache,clearCache,setCacheBudget,pruneExpiredCache,modelThumbVersion,dropThumbCache} from './thumb-cache.mjs';
import {localLocator} from './file-locations.mjs';
import {ensureServerCover,isServerCoverName} from './model-cover.mjs';
import {streamFolderZip} from './zip-stream.mjs';
import {createLanSharing} from './lan-sharing.mjs';
import {packFolderDownload} from './folder-archive.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { scanPage, searchPage } from './catalog.mjs';
import { resolveArtstationModel, mviewerInfo } from './artstation.mjs';
import { artstationSearch, artstationFilterOptions } from './artstation-search.mjs';
import { artstationArtist, artstationArtistProfile, artstationAccount, artstationFollowing } from './artstation-artist.mjs';
import {polyhavenSearch,polyhavenCategories} from './polyhaven.mjs';
import {simreadySearch,simreadyPreview,isSimreadyFileUrl} from './simready.mjs';
import {polypizzaSearch} from './polypizza.mjs';
import {kenneySearch,kenneyCategories} from './kenney.mjs';
import {freestylizedSearch,freestylizedCategories,freestylizedType} from './freestylized.mjs';
import {polyforkSearch,polyforkCategories,polyforkParams,polyforkVariant,polyforkGenerator,patchGeneratorSource} from './polyfork.mjs';
import {civitaiSearch,civitaiResolve} from './civitai.mjs';
import {createPolyforkZh} from './polyfork-zh.mjs';
import {freestylizedPreview,freestylizedPreviewFile} from './freestylized-preview.mjs';
import {createSubstanceBridge} from './substance-engine.mjs';
import {ambientcgSearch,ambientcgViewer,ambientcgCategories} from './ambientcg.mjs';
import {fabSearch as fabSearchFn,fabDetail,fabExchangeCode,fabRefresh,fabLoadSession,fabSaveSession,fabAcceptEula,fabClaim,fabClaimMany} from './fab.mjs';
import { curlImpersonateInfo } from './curl-impersonate.mjs';
import {browserStatus,startBrowserInstallJob,browserInstallJob} from './browser-runtime.mjs';
// 登录态：可见浏览器窗口 → CDP 导出 cookie → 存进 jar → 之后所有纯 HTTP 请求自动带上。
import {startLogin,loginStatus,closeLogin,syncCookies,sessionStatus,capturePage,harvestCookies,releaseProfile,shutdownBrowser as shutdownBrowserSession,pendingEula,resumeLoginAfterEula} from './browser-session.mjs';
import {cookieStats,clearCookies,cookieHeaderFor,browserProfileDir,loginStateFor} from './cookie-jar.mjs';
import {warmStatus,warmHost} from './cookie-warmer.mjs';
import {renderDom} from './headless-dom.mjs';
import {dependencyReport,updateSetup,setBlenderPath,applyBlenderOverride} from './setup.mjs';
import { coverLadder, artstationRenditionUrl, ARTSTATION_COVER_RENDITIONS } from './artstation-cdn.mjs';
import { openPublic, validateUrl, isSketchfabHost, isArtstationHost } from './public-http.mjs';
import { PICTURE_PROGRESS_SITES, collectPictureAssets, isPictureSite, isPictureCdnHost, pictureRefererForHost, pictureUrlCandidates, canonicalPictureUrl, cardThumbUrl, PICTURE_SITES, PICTURE_LOGIN_URLS, xhsAlbumCommand, pictureCollectionCommand } from './picture-sites.mjs';
import { probeCollectionOps, collectionCaps, isCollectionPlatform } from './platform-collections.mjs';
import {isMusicSite} from '../src/library/music-platforms.js';
import { resolveUiverse, searchUiverse, fetchUiverseCodeOnly, uiverseSearch } from './uiverse.mjs';
import { isUiSite } from '../src/library/platforms.js';
import {collectImageAssets} from './image-sources.mjs';
import { relatedPinterest } from './pinterest-proxy.mjs';

// 客户端中途关页面/断开时，在途的代理请求会以「任务已取消」被拒绝（public-http.mjs 的
// AbortSignal 路径）。这条拒绝若没人接住，Node 会把整个服务带崩 —— 实测无头探针一断连就退出。
// 记录日志并保持运行：请求方都已经走了，崩溃没有意义。
process.on('unhandledRejection',err=>{console.error('[未处理的请求拒绝，服务保持运行]',err?.message||err);});
import { createResponseCache } from './response-cache.mjs';
import {createDragStage, REMOTE_CAP, IMAGE_MIMES_BASE, IMAGE_MIMES_FULL} from './drag-stage.mjs';
import {createAssetResolver} from './drag-asset.mjs';
import { resolveDataDir,resolveUserPaths } from './data-dir.mjs';
import { SERVER_CAPABILITIES, SERVER_VERSION } from './capabilities.mjs';
import {createAIService} from './ai.mjs';
import {createDropImporter} from './drop-import.mjs';
import {createCanvasBoards} from './canvas-boards.mjs';
import {ensureLibraryIdentity} from './asset-sidecar.mjs';
const isPolyhavenHost=host=>/(?:^|\.)polyhaven\.(?:com|org)$/i.test(host);
const isPolypizzaHost=host=>/(?:^|\.)poly\.pizza$/i.test(host);
const isKenneyHost=host=>/(?:^|\.)kenney\.nl$/i.test(host);
const isFreestylizedHost=host=>/(?:^|\.)freestylized\.com$/i.test(host);
// Polyfork 的封面在自家 /files/<id>/renders/*.png，和 API 同一个域。
const isPolyforkHost=host=>/(?:^|\.)polyfork\.dev$/i.test(host);
// ambientCG 的缩略图在自家媒体域（acg-media.struffelproductions.com），代理白名单一并放行。
const isAmbientcgHost=host=>/(?:^|\.)ambientcg\.com$/i.test(host)||/(?:^|\.)struffelproductions\.com$/i.test(host);
// Fab 的封面图在自家 / CDN 域，代理白名单一并放行。
const isFabHost=host=>/(?:^|\.)fab\.com$/i.test(host);
/** 图片代理与「拖出前落盘」共用的域名白名单：新增平台只改这一处。 */
const IMAGE_HOST_CHECKERS=[isSketchfabHost,isArtstationHost,isPolyhavenHost,isAmbientcgHost,isPolypizzaHost,isKenneyHost,isFreestylizedHost,isPolyforkHost,isFabHost,isPictureCdnHost];
const imageHostAllowed=host=>IMAGE_HOST_CHECKERS.some(check=>check(host));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
/** 响应缓存默认落在应用数据目录。运行在 node:test 里时改落进程私有临时目录 ——
 *  测试夹具（「只有一个分类」的分类表、名叫 "robot result" 的模型）以前会被写进真缓存并
 *  按 TTL 生效：2026-10-16 实测 ambientCG 侧边栏只剩一个 Tiles · 164，来源正是
 *  test/library-ambientcg.test.js 的夹具留在了 <repo>/.assetvault/http-cache（分类表 TTL 一天）。
 *  同一进程内的多次请求仍然共享这一份缓存，所以「第二次不再回源」这类断言照旧成立。 */
function defaultCacheDir(){
 if(process.env.SFX_CACHE_DIR)return process.env.SFX_CACHE_DIR;
 if(process.env.NODE_TEST_CONTEXT)return path.join(tmpdir(),`sfx-test-cache-${process.pid}`);
 return path.join(resolveDataDir(root).dir,'http-cache');
}
let httpCache=createResponseCache(defaultCacheDir());
// FreeStylized 的预览要把 ZIP 拉下来解包，缓存目录与响应缓存分开：前者是几百 MB 的二进制。
const previewCacheDir=path.join(resolveDataDir(root).dir,'preview-cache');
const IMAGE_CACHE_MS=7*24*60*60*1000;
const SEARCH_CACHE_MS=10*60*1000;
// 「只入库」远程图集：保存时后台预热每张图的缩略图到 httpCache。地址过期后画廊走 /api/image
// 仍能命中这份缓存，至少缩略图不裂。限量+低并发+短超时，避免一次存几百张卡把图站打爆 / 拖慢保存。
const THUMB_WARM_LIMIT=200;       // 单卡最多预热张数（缩略图很小，但画板动辄上千张）
const THUMB_WARM_CONCURRENCY=4;
const THUMB_WARM_TIMEOUT_MS=15000;
const THUMB_WARM_CAP=2*1024*1024; // 单张缩略图上限，超过就不是缩略图了，跳过
// 用户反馈的收集端（feedback-worker 部署后把地址填这里，末尾不带斜杠）。
// 桌面端「问题反馈」已改为跳 GitHub Issues，不再打这个接口；这里保留是为了旧前端 /
// 脚本仍能提交，没人调用就可以整段删掉。
// 也可以不填，改用环境变量 AV_FEEDBACK_ENDPOINT 覆盖 —— 方便本地联调与临时换端点。
// 前端只打同源 /api/feedback 由这里转发：页面 CSP 的 connect-src 只放行 'self'，
// 直连外部域会被浏览器拦掉；顺带也让端点地址不出现在客户端脚本里。
const FEEDBACK_ENDPOINT='';
const CATEGORY_CACHE_MS=24*60*60*1000;
const PREVIEW_CACHE_MS=6*60*60*1000;
/** UI 元素代码缓存时长：元素内容在版本号内不变，卡片却会随滚动反复进出视口。 */
const UI_CODE_TTL_MS=6*60*60*1000;
/** 预览预取：列表只返回元数据，动效要一张张按 id 取代码（实测 ~350ms/张）。
 *  等卡片滚进视口才取，首屏就是一排占位符慢慢变亮。列表一回来就先把前 12 张补进缓存，
 *  前端真正要的时候基本直接命中（10ms 量级），首屏从「一张张等」变成「一次到位」。
 *  三路并发：站点是 Cloudflare 前置，堆太多会被判异常，反而更慢。 */
const UI_WARM_LIMIT=12;
const UI_WARM_CONCURRENCY=3;
async function warmUiCode(platform, entries=[]){
  if(platform!=='uiverse')return;
  const queue=[...new Map(entries.filter(e=>e&&e[0]).map(e=>[String(e[0]),e])).values()].slice(0,UI_WARM_LIMIT);
  if(!queue.length)return;
  let cursor=0;
  const worker=async()=>{
    while(cursor<queue.length){
      const [id,version]=queue[cursor++];
      const key=`ui-code:${platform}:${id}:${Number(version)||1}`;
      try{
        if(await httpCache.json(key,UI_CODE_TTL_MS))continue;
        const d=await fetchUiverseCodeOnly(id,Number(version)||1,{});
        await httpCache.saveJson(key,{html:d.html||'',css:d.css||'',previewDocument:d.previewDocument||''});
      }catch{/* 预取失败不用管：卡片自己还会再取一次 */ }
    }
  };
  await Promise.all(Array.from({length:UI_WARM_CONCURRENCY},worker));
}
async function cachedJson(res,key,maxAge,produce){
 if(maxAge>0){
  const hit=await httpCache.json(key,maxAge);
  if(hit)return json(res,200,hit);
 }
 const data=await produce();
 if(maxAge>0)await httpCache.saveJson(key,data).catch(()=>{});
 return json(res,200,data);
}
/** 分类表（各平台侧边栏共用）按天缓存，所以一份「明显不完整」的响应会毒住侧边栏整整一天。
 *  不足 CATEGORY_MIN_ITEMS 条时只当次返回、不落盘：下一次请求就重新回源，几秒内自愈。
 *  代价很小但要知道：freestylized 的 alphas / packs / smart 本来就没有分类（合法的空表），
 *  它们同样不落盘，等于每次开侧边栏多一次抓取 —— 换来的是「空表 / 残缺表都不会被缓存一整天」。
 *  2026-10-16 实测：缓存里躺着 {"categories":[Tiles]}，ambientCG 的 95 个分类只剩 1 个，
 *  用户看到的就是侧边栏里只剩「Tiles · 164」。 */
const CATEGORY_MIN_ITEMS=3;
async function cachedCategories(res,key,produce){
 const hit=await httpCache.json(key,CATEGORY_CACHE_MS);
 if(hit)return json(res,200,hit);
 const data=await produce();
 const rows=Array.isArray(data?.categories)?data.categories:[];
 if(rows.length>=CATEGORY_MIN_ITEMS)await httpCache.saveJson(key,data).catch(()=>{});
 return json(res,200,data);
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.bmp':'image/bmp','.ico':'image/x-icon','.json':'application/json; charset=utf-8','.map':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.webmanifest':'application/manifest+json','.wasm':'application/wasm','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.mp3':'audio/mpeg','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'};
// Only these hosts may be framed by the workbench, one line per model platform. Adding a platform
// means adding its interactive-viewer host here — the CSP string is derived, never hand-edited.
// ArtStation's own embed page sits on `artstation.com` and redirects between the apex and `www`,
// so both spellings (and the CDN subdomains) must be allowed or the preview is blocked outright.
// releases.pbr.one is ambientCG's official embeddable PBR material viewer — the same one their
// asset pages embed; the texture URLs ride in the URL fragment, so nothing else to allow.
const FRAME_HOSTS=['https://sketchfab.com','https://*.artstation.com','https://artstation.com','https://releases.pbr.one'];
const CONTENT_SECURITY_POLICY=`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: data:; frame-src 'self' ${FRAME_HOSTS.join(' ')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
// Artflow 嵌入路由的 CSP：artflow 是独立应用（Vite 构建），被本机画板视图当 iframe 加载。
// 与主页面的 CSP 分开，因为需求相反：
//   - frame-ancestors 'self'（而非 'none'）：允许被同源 iframe 装载。
//   - worker-src blob:：artflow 的图片解码用 Blob worker，见 utils/image-import-worker-client。
//   - script-src 加 'unsafe-eval'：部分依赖（three.js 着色器编译等）需要。
//   - script-src 加 'unsafe-inline'：artflow 的 index.html 有内联的启动错误收集脚本，
//     被 CSP 拦掉会让它收不到自己的报错信息。
//   - connect-src 放开 https:：artflow 的 AI 供应商要直连外部 API（走它自己的配置）。
// 只作用于 /artflow/* 路径，不放宽主页面。
const ARTFLOW_CSP=`default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; connect-src 'self' blob: data: https: http:; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'`;
// Artflow 静态产物根目录：默认取静态托管目录下的 artflow/（构建脚本把 artflow 产物拷到这里）。
// 可用环境变量 SFX_ARTFLOW_ROOT 指向别处（比如直接指 artflow 工程的 dist-web）。
const ARTFLOW_ROOT=process.env.SFX_ARTFLOW_ROOT||'';
const ARTFLOW_PREFIX='/artflow/';
// doc-render.js 是独立 bundle：marked / docx-preview / epubjs 按需加载，不进 app.js 主包。
const assets=new Set(['/model-preview.html','/model-preview.js','/','/index.html','/app.js','/app.css','/viewer.css','/content-kind-tabs.css','/settings-controls.css','/engine.js','/gltf-preview.js','/image-decoders.js','/doc-render.js','/model-thumb.js','/artflow-embed.js','/favicon.svg','/worker.html','/splash.html','/splash.js','/sidebar-boot.js','/mascot.png','/login.html','/login.css','/login.js','/login-peek.js','/login-backdrop.svg','/account-chip.js']);
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data,(key,value)=>key==='error'&&typeof value==='string'?chineseError(value,{fallback:true}):value));}
// 拖入导入的批次编号：前端生成，只允许 URL 安全的短串，避免拿它当路径 / 内存键的注入面。
const validBatch = value => /^[a-z0-9][a-z0-9-]{5,63}$/i.test(String(value||''));
/** 预览条目是解出来的原始字节（FBX / PNG / HDR），不是 JSON，也不该每次回源。 */
function binary(res,status,data,type){res.writeHead(status,{'Content-Type':type,'Content-Length':data.length,'Cache-Control':'private, max-age=3600'});res.end(data);}
// 代理预览的 MIME 也从格式注册表派生：新增格式不必再来这里补一行。
const PREVIEW_MIMES=Object.fromEntries(Object.values(FORMATS).map(item=>[`.${item.ext}`,item.mime]));
const previewMime=name=>PREVIEW_MIMES[path.extname(String(name||'')).toLowerCase()]||'application/octet-stream';
/** 本地文件流只认「这个进程里真的被索引过」的根目录。
 *  <img>/<video>/<iframe> 直接请求这个地址，带不了自定义头，所以不能靠 x-sfx-local 鉴权；
 *  改成白名单：没在前端点过「索引这个文件夹」，就别想读到这台机器上的任意路径。 */
const localRoots=new Set();
let localRootsFile='';
let localRootsTimer=null;
/** 一次扫描会连着放行好几个根：合并成一次写，避免并发写把后加进来的根覆盖掉。 */
const flushLocalRoots=()=>{
  localRootsTimer=null;
  if(!localRootsFile)return;
  fs.writeFile(localRootsFile,JSON.stringify([...localRoots]),{mode:0o600}).catch(()=>{});
};
/** 白名单要跨进程记住：进程一重启（装新版、双击启动器、崩了重启）内存里就空了，
 *  可前端是从 localStorage 的索引直接恢复卡片的 —— 卡片先铺出来，缩略图当场去要，
 *  那一刻服务端还没收到任何扫描，于是整排图集 403 裂开，非得手动重扫一次才活。
 *  把放行过的根落一份小文件，重启后照样认得（仍然只有用户点过「索引」的根会进来）。 */
const allowLocalRoot=folder=>{
  if(!folder)return;
  let abs='';
  try{abs=path.resolve(folder);}catch{return;}
  if(localRoots.has(abs))return;
  localRoots.add(abs);
  if(localRootsFile&&!localRootsTimer)localRootsTimer=setTimeout(flushLocalRoots,50);
};
function loadLocalRoots(file){
  localRootsFile=file;
  try{
    const list=JSON.parse(readFileSync(file,'utf8'));
    for(const item of list)if(typeof item==='string'&&item)localRoots.add(path.resolve(item));
  }catch{}
}
const isLocalRootAllowed=folder=>{try{return localRoots.has(path.resolve(String(folder||'')));}catch{return false;}};
/** 把任意图片字节缩到指定长边并转 WebP（压缩包内封面用）。转不了就返回 null，调用方发原图。 */
async function shrinkImageBuffer(bytes,{width=384}={}){
 try{
  const sharp=(await import('sharp')).default;
  const out=await sharp(bytes,{limitInputPixels:268402689}).rotate()
   .resize(width,width,{fit:'inside',withoutEnlargement:true})
   .webp({quality:78,alphaQuality:100}).toBuffer();
  return out?.length?{bytes:out,mime:'image/webp'}:null;
 }catch{return null;}
}
/** 预览用的读文件接口。支持 Range —— 视频/音频拖进度需要 206，否则只能从头播。 */
async function streamLocalFile(req,res,target){
 const headers={'Content-Type':localMime(target.file),'Accept-Ranges':'bytes','Cache-Control':'private, max-age=60'};
 const range=parseRange(req.headers.range,target.bytes);
 if(range?.invalid){res.writeHead(416,{...headers,'Content-Range':`bytes */${target.bytes}`});return res.end();}
 if(range){
  const {start,end}=range;
  res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${target.bytes}`,'Content-Length':end-start+1});
  return pipeline(createReadStream(target.file,{start,end}),res);
 }
 res.writeHead(200,{...headers,'Content-Length':target.bytes});
 return pipeline(createReadStream(target.file),res);
}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>65536)throw new Error('请求过大');}try{return JSON.parse(text);}catch{throw new Error('无效的 JSON 请求');}}
/** 图搜要传 base64 图片，64KB 的 body() 装不下；单独开一个上限给这条路由用。 */
async function bodyLarge(req,limit=8*1024*1024){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw new Error('图片过大，请换一张更小的图');chunks.push(Buffer.from(chunk));}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('无效的 JSON 请求');}}
/** Ask for each candidate in order and keep the first response that is not a failure. When every
 *  candidate fails the last attempt is handed back, so the caller still reports the real status. */
async function firstAvailable(candidates,request){
  if(!candidates.length)throw Error('缺少可用的图片地址');
  let remote=null;let lastError=null;
  for(const [index,candidate] of candidates.entries()){
    const last=index===candidates.length-1;
    try{
      remote=await request(candidate);
    }catch(e){
      // 旧图床主机可能根本连不通（连接超时 / TLS 被拒），这时拿到的是异常而不是错误状态码。
      // 必须继续试后面的候选，否则「修正地址」永远轮不到，裂图就一直是裂图。
      lastError=e;
      if(last)break;
      continue;
    }
    if(remote.status<400||last)return remote;
    try{remote.stream.destroy();}catch{}
  }
  throw lastError||Error('缺少可用的图片地址');
}
const defaultPictureCollect=(platform,args,options)=>(platform==='artstation'?collectImageAssets:collectPictureAssets)(platform,args,options);
export function createLibraryServer({scan=scanPage,search=searchPage,open=openPublic,staticRoot=process.env.SFX_STATIC_ROOT||path.join(root,'dist/library'),downloads=null,libraryDbImporter=null,boardCollect=collectPictureAssets,pictureCollect=defaultPictureCollect,artstation={},artsearch=artstationSearch,artfilters=artstationFilterOptions,artartist=artstationArtist,artprofile=artstationArtistProfile,polyhaven=polyhavenSearch,polyhavenCats=polyhavenCategories,simready=simreadySearch,polypizza=polypizzaSearch,kenney=kenneySearch,kenneyCats=kenneyCategories,freestylized=freestylizedSearch,freestylizedCats=freestylizedCategories,polyfork=polyforkSearch,polyforkCats=polyforkCategories,polyforkP=polyforkParams,polyforkV=polyforkVariant,polyforkGen=polyforkGenerator,ambientcg=ambientcgSearch,ambientcgPreview=ambientcgViewer,ambientcgCats=ambientcgCategories,fab=fabSearchFn,cacheDir=null,archiveRoot=null,lanSharing=null,platformSettingsFile=null,collect=true,backup=true,auth=null,onRestart=null}={}) {
  // cacheDir：把响应缓存指到别处（测试与脚本传临时目录），免得夹具写进应用数据目录的真缓存。
  // 一个进程同时只会跑一个服务端实例，所以这里直接换掉模块级那一份。
  if(cacheDir)httpCache=createResponseCache(cacheDir);
  // 本地文件白名单落盘/回读：重启后不用等前端再扫一遍，恢复出来的卡片也能直接出缩略图。
  loadLocalRoots(path.join(cacheDir||downloads?.dataDir||resolveDataDir(root).dir,'local-roots.json'));
  // 用户登记的导入根：启动时就放进白名单，重启后旧卡片的缩略图不会先裂一下。
  const importRoots=createImportRoots(cacheDir||downloads?.dataDir||resolveDataDir(root).dir);
  // 画板文档（Artflow 工程格式）落在同一个用户数据目录里 —— 换库/切库也跟着走。
  const boardStoreDir=cacheDir||downloads?.dataDir||resolveDataDir(root).dir;
  for(const folder of importRoots.list())allowLocalRoot(folder);
  // 图片回源策略只留一份：/api/image 代理和「拖出到外部软件前的原图落盘」都走它，
  // 免得 CDN 阶梯 / Referer / cookie 规则在两条链路里慢慢长成两套。
  const imageRequest=(wanted,host,{signal,useLadder=true,fallbackUrl=null}={})=>{
    // 图床换域名后，已收藏/已下载的老卡片里存的还是旧主机地址（如花瓣的 hbimg.huaban.com）；
    // 抓得急时现役主机也会限流（HTTP 567），这时只能退到边缘缓存的缩放档。
    // 这一串「先要哪个、再要哪个」由 picture-sites.mjs 的 pictureUrlCandidates 统一给，别在这里另猜一套。
    const ladder=useLadder?coverLadder(wanted):[wanted];
    const primary=[...pictureUrlCandidates(wanted),...ladder];
    // fallbackUrl：xhscdn 缩略参数在个别子域失效（403/404）时退回原图，避免缩略图直接裂掉。
    const candidates=fallbackUrl
      ?[...new Set([...primary,...pictureUrlCandidates(fallbackUrl),...(useLadder?coverLadder(fallbackUrl):[fallbackUrl])])]
      :[...new Set(primary)];
    return firstAvailable(candidates,
      candidate=>open(candidate,{artstation:isArtstationHost(host),signal,timeout:45000,
        ...(isPictureCdnHost(host)?{headers:{Referer:pictureRefererForHost(host)}}:{})}));
  };
  // 「只入库」远程图集：把每张图的缩略图提前抓进 /api/image 的磁盘缓存。签名地址过期后，
  // 画廊走 /api/image 仍能命中这份缓存（key 与缩略图请求完全一致：validateUrl(url).href + '|'），
  // 至少缩略图不裂。低并发 + 限量 + 短超时，且用独立 signal（保存响应返回后 controller 会 abort）。
  const warmRemoteThumbs=(items, cover)=>{
    const urls=[];
    const add=u=>{const s=String(u||'').trim();if(/^https?:\/\//i.test(s)&&!urls.includes(s))urls.push(s);};
    add(cover);
    for(const item of Array.isArray(items)?items:[])add(item?.thumb||item?.url);
    const targets=[];
    for(const raw of urls.slice(0,THUMB_WARM_LIMIT)){
      try{
        const t=validateUrl(raw);
        // 只预热允许出图的图床：非法主机既不该缓存，也过不了 /api/image 的白名单。
        if(!imageHostAllowed(t.hostname))continue;
        const key=`${t.href}|`; // 与 /api/image imageKey 的缩略图分支一致（rendition/card 为空）
        targets.push({wanted:t.href,host:t.hostname,key});
      }catch{}
    }
    if(!targets.length)return;
    let cursor=0;
    const worker=async()=>{
      while(cursor<targets.length){
        const {wanted,host,key}=targets[cursor++];
        try{
          // 已经缓存过（含过期副本）就不重复下：过期兜底正是要有这份旧字节。
          if(await httpCache.image(key,Infinity))continue;
          const remote=await imageRequest(wanted,host,{signal:AbortSignal.timeout(THUMB_WARM_TIMEOUT_MS)});
          if(remote.status<200||remote.status>=300){try{remote.stream.destroy();}catch{}continue;}
          const mime=String(remote.headers['content-type']||'').split(';')[0];
          if(!IMAGE_MIMES_BASE.includes(mime)){try{remote.stream.destroy();}catch{}continue;}
          const chunks=[];let bytes=0;
          for await(const chunk of remote.stream){bytes+=chunk.length;if(bytes>THUMB_WARM_CAP)break;chunks.push(chunk);}
          if(bytes>0&&bytes<=THUMB_WARM_CAP)await httpCache.saveImage(key,Buffer.concat(chunks),mime);
        }catch{} // 后台预热：任何失败都不影响卡片本身，静默跳过。
      }
    };
    void Promise.all(Array.from({length:THUMB_WARM_CONCURRENCY},worker));
  };
  // 资产解析单独留一份：拖放（/api/drag/files）与网页版兜底（/api/drag/urls）共用同一套取文件规则。
  // 路径只从自己的下载任务 / 扫描结果里取，前端给不出也不该给绝对路径。
  const assetResolver=createAssetResolver({
    jobs:()=>downloads?.jobs||[],
    findAsset:uid=>libraryStorage.withDb(conn=>{
      const row=conn.all("SELECT payload FROM assets WHERE uid = ? AND state = 'active'",[uid])[0];
      try{return row ? JSON.parse(row.payload) : null;}catch{return null;}
    }),
    resolveImported:async model=>{
      const folder=model.localRoot;
      if(!folder||!model.localRel)throw Error('资产缺少原文件定位信息，请重新导入');
      const registered=importRoots.list().some(item=>path.resolve(item)===path.resolve(folder));
      if(!registered&&!isLocalRootAllowed(folder))throw Error('原文件所在目录未登记');
      const file=resolveLocalFile({root:folder,rel:model.localRel}).file;
      if(path.resolve(file)!==path.resolve(model.filePath))throw Error('资产文件定位不一致，请重新定位');
      return file;
    },
    roots:()=>[...new Set([downloads?.defaultFolder,...(downloads?.jobs||[]).map(item=>item.downloadRoot),...(downloads?.legacyRoots||[])].filter(Boolean))],
    scanPackages:async list=>(await cachedScan(JSON.stringify(list),{roots:list,compute:options=>scanLibraryPackages({roots:list,...options})})).packages||[],
  });
  // CF_HDROP 只认磁盘路径：把前端的 {root,rel} / 原图 URL 在这里换成绝对路径。
  const dragStage=createDragStage({
    dir:path.join(cacheDir||resolveDataDir(root).dir,'drag-cache'),
    fetchRemote:(url,{signal})=>imageRequest(url,new URL(url).hostname,{signal}),
    resolveLocal:async ({root:folder,rel})=>{
      if(!isLocalRootAllowed(folder)){
        // 前端能从 localStorage 恢复索引后立刻开拖，这时 /api/library/scan 还没把 root 记进
        // 白名单。用与 scan 同一份 roots 来源兜一次：仍只放行资产库自己的下载根目录。
        const roots=[downloads?.defaultFolder,...(downloads?.jobs||[]).map(job=>job.downloadRoot),...(downloads?.legacyRoots||[])].filter(Boolean);
        if(!roots.some(item=>path.resolve(item)===path.resolve(folder)))throw Error('请先索引这个文件夹');
        allowLocalRoot(folder);
      }
      return resolveLocalFile({root:folder,rel}).file;
    },
    // 资产库卡片：前端只说「哪个 uid」，路径由这里从自己的下载任务 / 扫描结果里取。
    // 图片包（kind:'images'）落盘是一层目录，摊成里面的每一张图；3D 导出包是单个文件，原样给。
    resolveAsset:assetResolver,
    isAllowedHost:imageHostAllowed,
  });
  const resourceUsage=createResourceUsage();
  const ai=createAIService({file:path.join(resolveDataDir(root).dir,'ai-settings.json')});
  // 参数译名单独存一目录：它是纯缓存，删掉只会让面板退回规则词表，不影响任何其它数据。
  const polyforkZh=createPolyforkZh({dir:path.join(resolveDataDir(root).dir,'polyfork-zh'),complete:ai.complete});
  const substance=createSubstanceBridge();
  // libraryDbImporter 只给测试 / 特殊部署注入驱动用；默认走惰性 import('better-sqlite3')，
  // 桌面安装包由 sidecar-server/node_modules 提供原生模块，也可用 AV_SQLITE_MODULE 覆盖。
  // 缺原生依赖时存储层自动退回纯文件模式，细粒度查询仍可走内存引擎。
  // ADR-09：真实服务端启用 DB 单一写入权威（纯逻辑测试不传，保持旧双轨契约）。
  const libraryStorage=createLibraryStorage(downloads?.dataDir||resolveDataDir(root).dir,downloads,{dbImporter:libraryDbImporter,catalogSingleWriter:true});
  const fileOrganizePreflight=createFileOrganizePreflight({storage:libraryStorage,importRoots});
  // S3-d：自动备份。定时器不拖住进程退出，失败只告警 —— 备份挂了不影响主流程。
  const libraryBackups=createBackupService({storage:libraryStorage,onWarn:message=>console.warn(`[AssetVault] ${message}`)});
  if(backup!==false)libraryBackups.start();
  // ADR-12：资源库注册表固定在 %APPDATA%/AssetVault（base），不能放进 dataDir ——
  // 否则切到别的库之后就再也列不出清单了。
  // archiveRoot：把「资产根」也指到别处。生产不传，跟着当前库走；测试/脚本传了 cacheDir
  // （临时缓存目录）时默认落到 <cacheDir>/assets —— 否则测试里的导入会写进用户真实资产目录。
  const basePaths=resolveUserPaths();
  const userPaths=archiveRoot?{...basePaths,archiveRoot:path.resolve(archiveRoot)}
   :cacheDir?{...basePaths,archiveRoot:path.join(cacheDir,'assets')}:basePaths;
  // 资产根是受管目录：下载与导入的卡片都从这里取文件，必须放行。
  // 否则换库 / 改过资产目录之后，卡片先铺出来、缩略图整排 403，必须手动重扫才活。
  allowLocalRoot(userPaths.archiveRoot);
  // 资产根自带说明书：.assetvault/library.json（库身份，换机器/换工具能认出是哪个库）
  // 和 desktop.ini（资源管理器里显示库名 + 图标）。幂等，内容没变就不落盘。
  try {
    ensureLibraryIdentity(userPaths.archiveRoot, {
      name: path.basename(userPaths.archiveRoot),
      dataDir: userPaths.dataDir,
      importType: 'copy',
    });
  } catch (error) { console.warn(`[AssetVault] 资产库标识写入失败：${error.message}`); }
  // ADR-15：语义索引。向量住独立表，随 embedding 模型重建，绝不改资产权威表。
  const semantic=createVectorIndex({storage:libraryStorage,ai,onWarn:message=>console.warn(`[AssetVault] ${message}`)});
  const libraryApi=createLibraryApi({storage:libraryStorage,backups:libraryBackups,importRoots,dataDir:cacheDir||downloads?.dataDir||resolveDataDir(root).dir,downloadDir:userPaths.downloadDir,archiveRoot:userPaths.archiveRoot,storeBase:userPaths.base,semantic,allowLocalRoot:folder=>allowLocalRoot(folder),onWarn:message=>console.warn(`[AssetVault] ${message}`)});
  // 智能收集画板：规则 / 待合并队列 / 守卫 / 执行器 / 调度器。
  // 规则与队列放独立文件，不碰主状态 blob —— 采集失败或内核缺失都不该影响资产库本身。
  const collectDir=downloads?.dataDir||resolveDataDir(root).dir;
  // 托管副本目录（拖入导入 / 导入文件夹的「复制进库」都落在这里）。它是库的内部存储：
  // 里面的文件已经由资产记录代表，绝不能再被「磁盘扫描」当成用户没有入库的零散文件列一遍，
  // 否则同一个文件会出现两张卡（一张资产卡 + 一张零散文件卡）。
  const managedImportDir=path.resolve(collectDir,'imports');
  const isManagedImportPath=folder=>{const full=path.resolve(folder);return full===managedImportDir||full.startsWith(managedImportDir+path.sep);};
  // 批量导入（拖 100 个文件 / 整包文件夹）时每个文件都会回调一次；不去抖就是 100 次
  // 「重新拉整个资产库」的 SSE，前端会卡到没法用。攒 400ms 只广播一次。
  let assetsEventTimer=0;
  const notifyAssets=()=>{
    if(assetsEventTimer)return;
    assetsEventTimer=setTimeout(()=>{assetsEventTimer=0;try{libraryApi.events.emit({kind:'assets'});}catch{}},400);
    if(assetsEventTimer.unref)assetsEventTimer.unref();
  };
  const localImporter=createLocalFileImporter({storage:libraryStorage,importRoots,dataDir:collectDir,archiveRoot:userPaths.archiveRoot,allowLocalRoot,onImported:notifyAssets});
  const fileOrganizer=createFileOrganizer({storage:libraryStorage,importRoots,
    beforeEnable:()=>libraryBackups.runNow({cleanup:false}),
    onChanged:()=>{invalidateScanCache();notifyAssets();}});
  const tagBackfill=createTagBackfill({storage:libraryStorage,onChanged:notifyAssets});
  const tagManagement=createTagManagement({storage:libraryStorage,onChanged:notifyAssets,beforeMerge:()=>libraryBackups.runNow({cleanup:false})});
  const taxonomyRules=createTaxonomyRules({storage:libraryStorage,onChanged:notifyAssets});
  const locationMigration=createLocationMigration({storage:libraryStorage,importRoots,onChanged:()=>{invalidateScanCache();notifyAssets();},beforeMigrate:()=>libraryBackups.runNow({cleanup:false})});
  // 导入是「先落盘、后 flush」，进程中途被杀可能留下没人认领的副本目录。
  // 起来 10 秒后跑一次维护：先修老记录的格式识别（无扩展名的老资产一直是 other），
  // 再清孤儿目录（只删「无资产记录 + 超过 1 小时」的旧结构残留）。
  let maintenanceTimer=setTimeout(()=>{
    repairAssetTypes({storage:libraryStorage})
      .then(result=>{if(result.repaired)console.log(`[AssetVault] 按文件头修正了 ${result.repaired} 条资产的格式识别`);})
      .catch(()=>{})
      .then(()=>repairAiMeta({storage:libraryStorage}))
      .then(result=>{if(result.repaired)console.log(`[AssetVault] 识别了 ${result.repaired} 张 AI 生成图的提示词`);})
      .catch(()=>{})
      .then(()=>localImporter.sweepOrphanDirs())
      .then(result=>{if(result.removed)console.log(`[AssetVault] 清理了 ${result.removed} 个未入库的临时导入目录`);})
      .catch(()=>{});
  },10*1000);
  if(maintenanceTimer.unref)maintenanceTimer.unref();
  const dropImporter=createDropImporter({dataDir:collectDir,archiveRoot:userPaths.archiveRoot,importRoots,allowLocalRoot,localImporter});
  const canvasBoards=createCanvasBoards({storage:libraryStorage,dataDir:boardStoreDir,dropImporter,localImporter,onChanged:()=>libraryApi.events.emit({kind:'assets'})});
  const collectRules=createCollectRules({file:path.join(collectDir,'collect-rules.json')});
  const collectPendingStore=createCollectPending({file:path.join(collectDir,'collect-pending.json')});
  const collectGuard=createCollectGuard();
  const platforms=createPlatformSettings(platformSettingsFile||path.join(downloads?.dataDir||resolveDataDir(root).dir,'platform-settings.json'));
  const collectSearch=createCollectSearch({open,civitaiKey:platforms.civitaiKey()});
  const collectRunner=createCollectRunner({rules:collectRules,pending:collectPendingStore,guard:collectGuard,storage:libraryStorage,search:collectSearch.search,platformEnabled:id=>platforms.enabled(id),onWarn:message=>console.warn(`[AssetVault] ${message}`)});
  const collectScheduler=createCollectScheduler({rules:collectRules,runner:collectRunner,onWarn:message=>console.warn(`[AssetVault] ${message}`)});
  const collectApi=createCollectApi({rules:collectRules,runner:collectRunner,pending:collectPendingStore,scheduler:collectScheduler,storage:libraryStorage,platformEnabled:id=>platforms.enabled(id)});
  // WebDAV 云同步：整库快照推到用户自己的网盘，多设备之间按 rev 收敛。
  // 定时器自己 unref，且「没配地址」时根本不起，不会给纯本地用户留后台空转。
  const webdavSync=createWebdavSync({storage:libraryStorage,dataDir:collectDir,onSynced:()=>libraryApi.events.emit({kind:'assets'}),onWarn:message=>console.warn(`[AssetVault] ${message}`)});
  if(collect!==false)webdavSync.start().catch(error=>console.warn(`[AssetVault] 云同步启动失败：${error.message}`));
  // collect:false 只给测试用：不装心跳，避免后台定时器在断言之间插进来。
  if(collect!==false)collectScheduler.start();
  const lan=lanSharing||createLanSharing({file:path.join(downloads?.dataDir||resolveDataDir(root).dir,'lan-sharing.json')});
  lan.attachMembers?.(libraryApi.members);
  // 多目标「发送到…」：把已下载的成品交付给 Blender（桥接）或引擎 / DCC（复制到工程目录）。
  const exportsApi=createExports({downloads,dataDir:downloads?.dataDir||resolveDataDir(root).dir});
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    const controller=new AbortController();req.on('aborted',()=>controller.abort());res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      if(await lan.handle(req,res))return;
      const u=new URL(req.url,`http://${req.headers.host}`);
      if(!await libraryApi.authorizeRequest(req,res,u))return;
      // 账号闸门：只有 server 主入口注入了 auth 才生效（测试 / 内部脚本不传，行为完全不变）。
      // 放在 exportsApi / 各平台分支之前，任何数据接口都不会漏过去。
      if(auth){
        if(await auth.handle(req,res,u))return;
        if(!isExportWorkerRequest(req,u,downloads?.transfers)&&auth.gate(req,res,u))return;
      }
      await fileOrganizer.ready;
      // 未恢复的日志期间禁止其它写入口绕过位置保护；整理面板仍可读状态并重试恢复。
      if(req.method==='POST'&&u.pathname.startsWith('/api/library')&&!u.pathname.startsWith('/api/library/file-organize/')
        &&(await fileOrganizer.pending()).length)return json(res,409,{error:'文件整理操作尚待恢复，请在整理文件面板中重试恢复后再写入资产库'});
      if(await exportsApi.handle(req,res,u))return;
      if(u.pathname==='/api/platforms'){
        if(req.method==='GET')return json(res,200,platforms.get());
        if(req.method==='POST'){
          if(req.lanVisitor||req.headers['x-sfx-local']!=='1')return json(res,403,{error:'仅主机可以修改平台模块'});
          return json(res,200,await platforms.save(await body(req)));
        }
        return json(res,405,{error:'不支持的请求方式'});
      }
      const moduleId=platformForPath(u.pathname);
      if(moduleId&&!platforms.enabled(moduleId))return json(res,403,{error:'该平台已关闭，请在设置 → 平台模块中开启'});
      // ADR-09：按页目录 / 全选 uid 集合。纯读轻量路由，同源 + 本地标识守卫。
      if(u.pathname==='/api/library/catalog/page'||u.pathname==='/api/library/catalog/uids'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(req.method!=='GET')return json(res,405,{error:'只支持 GET'});
        const data=u.pathname.endsWith('/uids')
          ? await libraryStorage.catalogUids()
          : await libraryStorage.catalogPage(u.searchParams.get('offset'),u.searchParams.get('limit'));
        if(!data)return json(res,503,{error:'资产库内核不可用，请刷新页面重试'});
        return json(res,200,data);
      }
      if(u.pathname==='/api/library-state'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(req.method==='GET')return json(res,200,{...await libraryStorage.load({catalogPaged:u.searchParams.get('catalog')==='paged'}),fileWriteProtocol:'1'});
        if(req.method==='POST'){
          // JSON 转义会让请求体比单个 key 略大，留出余量；上限统一由存储层常量决定。
          // 目录域可以很大（50 万资产实测 209MB），旧版按 16MB 小域定的上限会把正常保存挡掉。
          // 逐 key 的体积校验在存储层，这里只兜住整个请求体的量级。
          const bodyLimit=MAX_CATALOG_BYTES+MAX_STATE_BYTES*8;
          let text='',overflow=false;
          for await(const chunk of req){
            // 超限后继续把剩余数据读完再报错：提前 throw 会让还在上传的浏览器永远等不到答复。
            if(overflow)continue;
            text+=chunk;
            if(Buffer.byteLength(text)>bodyLimit){overflow=true;text='';}
          }
          if(overflow)return json(res,413,{error:'资产库状态过大'});
          try{await libraryStorage.save(JSON.parse(text),{clientProtocol:req.headers['x-av-file-protocol']??null});return json(res,200,{saved:true});}
          catch(error){return json(res,error.status||400,{error:error.message,code:error.code,requiredProtocol:error.requiredProtocol});}
        }
      }
      // 阶段 2 的细粒度接口：布尔/字段检索、多维过滤、合集与智能合集。
      // 自己认路径，未命中的（scan / register 等）交回下面的原有分支。
      // ADR-12：切库后重启。单列一条，不进 libraryApi 的 ROUTES —— 它需要「让进程退出」，
      // 那个能力只有 main 里的 shutdown 有，通过 onRestart 回调转交。
      if(u.pathname==='/api/library/stores/restart'&&req.method==='POST'){
        if(req.lanVisitor||req.headers['x-sfx-local']!=='1')return json(res,403,{error:'仅主机可以重启服务'});
        if(!onRestart)return json(res,503,{error:'当前启动方式不支持自动重启，请手动停止后重新启动'});
        json(res,202,{restarting:true});
        // 等答复真的写出去再动手，否则前端拿到的是「连接已断开」而不是「正在重启」。
        setTimeout(()=>{try{onRestart();}catch(error){console.warn(`[AssetVault] 重启失败：${error.message}`);}},400);
        return;
      }
      if(await libraryApi.handle(req,res,u))return;
      if(await collectApi.handle(req,res,u))return;
      if(u.pathname==='/api/resource-usage'&&req.method==='GET'){
        const peer=req.socket.remoteAddress||'';
        if(req.lanVisitor||req.headers['x-sfx-local']!=='1'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer))return json(res,403,{error:'资源占用仅供本机查看'});
        res.setHeader('Cache-Control','no-store');
        try{return json(res,200,await resourceUsage.sample());}
        catch{return json(res,503,{error:'无法读取系统进程信息，请稍后重试'});}
      }
      if(u.pathname==='/api/health'&&req.method==='GET')return json(res,200,{name:'assetvault-local-library',version:SERVER_VERSION,mode:'local',engine:'existing-exporter',storage:libraryStorage.dbStatus()});
      // 图站抓取（素材下载器整合）：给定图站 URL，返回整站图片清单。复用 collectImageAssets 下游链路。
      // 用户反馈：前端打同源 /api/feedback，这里转发到收集端。
      // GET 用来告诉面板「服务端配没配收集地址」，没配就退化成复制内容，不至于点了没反应。
      if(u.pathname==='/api/feedback'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const endpoint=String(process.env.AV_FEEDBACK_ENDPOINT||FEEDBACK_ENDPOINT||'').replace(/\/+$/,'');
        if(req.method==='GET')return json(res,200,{configured:!!endpoint});
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        if(!endpoint)return json(res,503,{error:'反馈服务未配置'});
        try{
          const payload=await body(req);
          const remote=await fetch(`${endpoint}/v1/feedback`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
          const data=await remote.json().catch(()=>({}));
          return json(res,remote.status,data);
        }catch(e){return json(res,502,{error:`反馈提交失败：${e.message}`});}
      }
      if(req.method==='GET'&&u.pathname==='/api/picture-site/resolve'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const platform=u.searchParams.get('platform'); const url=u.searchParams.get('url');
        if(!platform||!url)return json(res,400,{error:'需要 platform 与 url 参数'});
        if(!isPictureSite(platform)&&platform!=='artstation')return json(res,400,{error:'该图站暂不支持抓取'});
        // 图站开关与 3D 平台同一个设置存储（设置 → 平台模块里那排卡片），关掉就拒绝解析。
        if(!platforms.enabled(platform))return json(res,403,{error:'该图站已关闭，请在设置 → 平台模块中开启'});
        // 预览只要「前 limit 张」，但解析本身是整块画板一次翻完的（花瓣 1923 张 ≈ 20 次 API）。
        // 滚动加载的每一屏都从同一个清单里切片，不再从第一页重翻 —— 否则越往后越慢，
        // 用户看到的就是「滑了半天只多出几十张」。清单与窗口见 picture-index.mjs。
        // 真正下载走 /api/downloads/tasks → runImageJob，不经过这里，仍按整站全量抓取。
        const limit=Math.min(Math.max(Number(u.searchParams.get('limit'))||60,1),5000);
        try{
          // 平台设置里填的 Pixabay key 随每次解析下发；resolve 内部再回落到环境变量。
          const refresh=platform==='xiaohongshu'&&u.searchParams.get('refresh')==='1';
          if(refresh)forgetPictureIndex(platform,url);
          const collectWithKeys=(p,a,o)=>pictureCollect(p,a,{...o,refresh,apiKey:platforms.pixabayKey()});
          const controller=new AbortController();
          const disconnect=()=>{if(!res.writableEnded)controller.abort();};
          res.once('close',disconnect);
          try {
            const data=await pictureWindow(platform,url,limit,{collect:collectWithKeys,open,signal:controller.signal,progressive:pictureCollect===defaultPictureCollect&&PICTURE_PROGRESS_SITES.includes(platform)});
            if(!res.destroyed)return json(res,200,data);
            return;
          } finally {res.off('close',disconnect);}
        }catch(e){return json(res,400,{error:e.message||'抓取失败'});}
      }
      // 通用收藏夹能力探测：进入收藏页时前端调一次，拿真实可用的写操作位 + 接口签名。
      // 只有注册过的平台才有；探测要开浏览器，别在普通搜索/首页调用。
      if(req.method==='GET'&&u.pathname==='/api/platform-collections/caps'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const platform=u.searchParams.get('platform');
        if(!platform||!isCollectionPlatform(platform))return json(res,200,{supported:false});
        try{
          const live=await probeCollectionOps(platform);
          return json(res,200,{supported:true,...collectionCaps(platform),live});
        }catch(e){return json(res,200,{supported:true,...collectionCaps(platform),live:{ops:collectionCaps(platform)?.collectionOps||[]}});}
      }
      // 通用收藏夹写操作：平台差异收敛在服务端契约层，前端只发这一个端点。
      if(req.method==='POST'&&u.pathname==='/api/platform-collections'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        try{
          const input=await body(req);
          const platform=String(input?.platform||'');
          if(!platform)return json(res,400,{error:'缺少 platform'});
          return json(res,200,await pictureCollectionCommand(platform,input||{}));
        }catch(e){return json(res,400,{error:e.message||'收藏夹操作失败'});}
      }
      // 旧端点保留兼容（老前端 / 外部调用），内部转给统一入口。
      if(req.method==='POST'&&u.pathname==='/api/xhs/album'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        try{
          const input=await body(req);
          return json(res,200,await xhsAlbumCommand(input||{}));
        }catch(e){return json(res,400,{error:e.message||'专辑操作失败'});}
      }
      // UI 元素解析（Uiverse）：粘元素页 / 创作者主页 / 分类页都能取到一批元素。
      // 与图站分开端点：产出的是代码不是图片，字段形状也不同（多一份预览文档）。
      if(req.method==='GET'&&u.pathname==='/api/ui-site/resolve'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const platform=u.searchParams.get('platform'); const url=u.searchParams.get('url');
        if(!platform||!url)return json(res,400,{error:'需要 platform 与 url 参数'});
        if(!isUiSite(platform))return json(res,400,{error:'该 UI 平台暂不支持抓取'});
        if(!platforms.enabled(platform))return json(res,403,{error:'该平台已关闭，请在设置 → 平台模块中开启'});
        const limit=Math.min(Math.max(Number(u.searchParams.get('limit'))||40,1),200);
        try{
          const data=await resolveUiverse({url},{signal:controller.signal,limit});
          return json(res,200,{items:data.items||[],title:data.title||'',author:data.author||'',source:data.source||'',total:data.total||0});
        }catch(e){return json(res,400,{error:e.message||'抓取失败'});}
      }
      // UI 元素关键词搜索。
      if(req.method==='GET'&&u.pathname==='/api/ui-site/search'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const platform=u.searchParams.get('platform')||'uiverse'; const q=u.searchParams.get('q')||'';
        if(!isUiSite(platform))return json(res,400,{error:'该 UI 平台暂不支持搜索'});
        if(!platforms.enabled(platform))return json(res,403,{error:'该平台已关闭，请在设置 → 平台模块中开启'});
        const limit=Math.min(Math.max(Number(u.searchParams.get('limit'))||40,1),100);
        try{
          const data=await searchUiverse({query:q,theme:u.searchParams.get('theme')||'',elementType:u.searchParams.get('type')||''},{signal:controller.signal,limit});
          return json(res,200,{items:data.items||[],total:data.total||0});
        }catch(e){return json(res,400,{error:e.message||'搜索失败'});}
      }
      // UI 元素的发现页检索流：POST /api/uiverse/search，形状与其它平台的检索端点一致。
      // 走平台的开关守卫（platformForPath），关掉 Uiverse 就搜不动。
      if(u.pathname==='/api/uiverse/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        return cachedJson(res,`uiverse:${JSON.stringify(input)}`,SEARCH_CACHE_MS,async()=>{
          const data=await uiverseSearch(input,{signal:controller.signal});
          // 列表已经拿到手，先在后台把首屏那张张要单独取的代码补进缓存（不阻塞本次响应）。
          warmUiCode('uiverse',(data.models||[]).map(m=>[m.elementId,m.elementVersion])).catch(()=>{});
          return data;
        });
      }
      // UI 元素代码：卡片上的动效预览是懒加载的，滚进视口才来取代码。
      // 单独一条轻通道：只回 html + css + 预览文档，不带详情元数据。
      if(req.method==='GET'&&u.pathname==='/api/ui-site/code'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const platform=u.searchParams.get('platform')||'uiverse';
        if(!isUiSite(platform))return json(res,400,{error:'该 UI 平台暂不支持预览'});
        if(!platforms.enabled(platform))return json(res,403,{error:'该平台已关闭，请在设置 → 平台模块中开启'});
        const id=String(u.searchParams.get('id')||'').slice(0,64);
        if(!id)return json(res,400,{error:'需要元素 id 参数'});
        const version=Math.min(Math.max(Number(u.searchParams.get('version'))||1,1),999);
        try{
          // 元素的 html/css 在版本号内是**不变的**，而卡片预览会随滚动反复进出视口。
          // 不缓存的话每次滚回来都要重新 spawn 一次 curl-impersonate（实测 ~550ms/张），
          // 24 张卡就是十几秒。按 id+version 缓存 6 小时：第一次仍然要取，之后秒开。
          return await cachedJson(res,`ui-code:${platform}:${id}:${version}`,UI_CODE_TTL_MS,
            () => fetchUiverseCodeOnly(id,version,{signal:controller.signal})
              .then(d=>({html:d.html||'',css:d.css||'',previewDocument:d.previewDocument||''})));
        }catch(e){return json(res,400,{error:e.message||'读取元素代码失败'});}
      }
      // 画布与普通资产库画板共用身份及成员，文档与成员变更在 SQLite 同事务提交。
      if(u.pathname==='/api/library/artflow-board'){
        if(req.lanVisitor||req.headers['x-sfx-local']!=='1'||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'仅主机同源页面可以同步画布'});
        if(req.method==='GET'){
          try{
            const result=await canvasBoards.readVersioned(req.headers['if-none-match']);
            res.setHeader('ETag',result.etag);res.setHeader('Cache-Control','no-cache');
            if(result.unchanged){res.writeHead(304);return res.end();}
            return json(res,200,result.document);
          }catch(error){
            return json(res,500,{error:error.message});
          }
        }
        if(req.method==='PUT'){
          try{
            // 画板文档比普通 body 大得多（图片是 data URL），单独给一条 64MB 的路。
            const chunks=[];let bytes=0;
            for await(const chunk of req){
              bytes+=chunk.length;
              if(bytes>64*1024*1024)throw new Error('画板存档过大');
              chunks.push(Buffer.from(chunk));
            }
            const raw=Buffer.concat(chunks).toString('utf8');
            return json(res,200,await canvasBoards.save(JSON.parse(raw)));
          }catch(error){
            return json(res,400,{error:'画板存档写入失败：'+error.message});
          }
        }
        return json(res,405,{error:'只支持 GET / PUT'});
      }
      // 「只入库」：把图站画板 / 作品页记进资产库，**一张图都不下载**。
      // 卡片靠 info.json 里的 thumbnail（平台远程封面）出图，由 /api/image 代理（绕开防盗链）；
      // 以后想要原图，在卡片上点「下载原图」，队列会接管同一个目录继续下（见 findRemoteBoardDir）。
      // 只写下载根下的固定分类目录，前端传不了任意路径 —— 这个端点不接受 root 参数。
      if(u.pathname==='/api/library/picture-board'){
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
        const input=await body(req);
        const platform=String(input?.platform||'').slice(0,40);
        if(!isPictureSite(platform)&&platform!=='artstation')return json(res,400,{error:'该图站暂不支持入库'});
        if(!platforms.enabled(platform))return json(res,403,{error:'该图站已关闭，请在设置 → 平台模块中开启'});
        const uid=String(input?.uid||'').toLowerCase();
        if(!isBoardUid(uid))return json(res,400,{error:'资产标识无效'});
        const source=String(input?.url||'').trim();
        if(!/^https?:\/\//i.test(source)||source.length>2048)return json(res,400,{error:'来源链接无效'});
        let cover=String(input?.cover||'').trim();
        if(cover&&(!/^https?:\/\//i.test(cover)||cover.length>2048))cover='';
        let title=String(input?.title||''), author=String(input?.author||'');
        // 张数只能靠一次全量解析拿到：预览那 48 张不是总数，写成「48 张」等于骗人。
        // 解析失败（限流 / 需要登录 / 太慢）不猜：这张卡先只记「远程收藏」，下次点重试再补。
        let imageCount=Math.min(1_000_000,Math.max(0,Math.floor(Number(input?.imageCount)||0)));
        let counted=false;
        // 全量解析拿到的每张图地址：写进远程卡供「不下载翻图集」用。解析失败时回退前端传来的那批。
        let remoteItems=Array.isArray(input?.remoteImages)?input.remoteImages:[];
        try{
          // 与预览共用同一个响应缓存目录，但 key 标 full：预览那份是前 48 张，不能拿来当总数。
          // 同一块画板第二次点「只入库」应该是秒回，而不是再翻一遍页。
          const cacheKey=`picture:v1:${platform}:full:${source}`;
          let plan=await httpCache.json(cacheKey,SEARCH_CACHE_MS).catch(()=>null);
          if(!plan){
            plan=await boardCollect(platform,{url:source},{open,signal:AbortSignal.timeout(120000)});
            await httpCache.saveJson(cacheKey,plan).catch(()=>{});
          }
          const items=Array.isArray(plan?.items)?plan.items:[];
          if(items.length)remoteItems=items;
          imageCount=items.length+(plan?.skipped?.length||0);
          title=String(plan?.title||title);
          author=String(plan?.author||author);
          // 封面必须存**稳定地址**：图站给的首图常是带 auth_key 的签名地址，几小时后就过期，
          // 存它等于让卡片过一晚变破图 —— 而这张卡唯一的内容就是那张封面。
          // 有缩放档就优先它：花瓣原图 3.9MB、缩放档 1.6MB，卡片墙不该为一张小图拉原图。
          const coverCandidates=pictureUrlCandidates(plan?.cover||'');
          cover=coverCandidates.find(url=>/_fw\d{3,4}/i.test(url))
           ||canonicalPictureUrl(plan?.cover)
           ||String(plan?.cover||cover);
          counted=true;
        }catch{/* 解析不到就保留前端给的下限值，卡片仍能建起来 */}
        try{
          const card=await writePictureBoardCard({
            folder:downloads.settings.folder,
            // 与下载任务的落点用同一套分类（assetFolder）：否则「下载原图」会算到 图片/插画，
            // 而远程卡写在 图片/，原地接管失败 → 同一个画板裂成两张卡。
            category:assetFolder({title,platform,assetType:'images'}),
            uid,
            platform,
            url:source,
            title:title.slice(0,200),
            author:author.slice(0,120),
            cover:cover||null,
            imageCount:counted?imageCount:0,
            tags:Array.isArray(input?.tags)?input.tags.slice(0,40).map(tag=>String(tag).slice(0,60)):[],
            remoteImages:remoteItems,
          });
          // info.json 落在包目录内部，扫描缓存的根签名探不到 → 显式失效，前端刷新就能看见。
          invalidateScanCache();
          // 后台预热缩略图：远程签名地址会过期，存卡时先把图抓到 /api/image 的磁盘缓存，
          // 以后地址失效了画廊仍能从缓存取到缩略图。不 await，保存响应不被拖慢。
          void warmRemoteThumbs(remoteItems, cover);
          return json(res,200,{ok:true,...card});
        }catch(error){return json(res,500,{error:`写入资产库失败：${error.message}`});}
      }
      // Pinterest 相似推荐（pin-grabber 独有 /api/related）：把选中的 pin id 列表丢给 pin-grabber，
      // 它从当前 STATE.images 取原图、采「更多类似图案」推荐流并追加。需要 STATE.images 已有内容
      // （即用户先做过一次搜索），否则 pin-grabber 会拒绝。
      if(u.pathname==='/api/pinterest/related'&&req.method==='POST'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        try{
          const input=await body(req);
          const items=await relatedPinterest(input.pin_ids,Number(input.count)||24);
          return json(res,200,{items});
        }catch(e){return json(res,400,{error:e.message||'相似推荐失败'});}
      }
      if(u.pathname.startsWith('/api/ai/')){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(['/api/ai/hunt-plan','/api/ai/rank-sheet'].includes(u.pathname)){
          if(req.lanVisitor)return json(res,403,{error:'仅主机可使用 AI 找资产'});
          if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return json(res,403,{error:'跨站请求被拒绝'});
        }
        if(req.method==='GET'&&u.pathname==='/api/ai/settings')return json(res,200,await ai.settings());
        if(req.method==='POST'){
          // 图搜的请求体带 base64 图片，先走大上限的解析器，再进入常规 JSON 分支。
          if(u.pathname==='/api/ai/tags')return json(res,200,await ai.tagAssets(await bodyLarge(req)));
          if(u.pathname==='/api/ai/rank-sheet')return json(res,200,await ai.rankSheet(await bodyLarge(req)));
          if(u.pathname==='/api/ai/vision-search')return json(res,200,await ai.visionSearch(await bodyLarge(req)));
          const input=await body(req);
          if(u.pathname==='/api/ai/hunt-plan')return json(res,200,await ai.huntPlan(input,COLLECT_PLATFORMS.filter(p=>p.searchable&&platforms.enabled(p.id)).map(p=>p.id)));
          if(u.pathname==='/api/ai/key'){res.setHeader('Cache-Control','no-store');return json(res,200,await ai.key());}
          if(u.pathname==='/api/ai/settings')return json(res,200,await ai.configure(input));
          if(u.pathname==='/api/ai/models')return json(res,200,await ai.models(input,controller.signal));
          if(u.pathname==='/api/ai/probe-models')return json(res,200,await ai.probeModels(input,controller.signal));
          if(u.pathname==='/api/ai/probe')return json(res,200,await ai.probeChat(input,controller.signal));
          if(u.pathname==='/api/ai/test')return json(res,200,await ai.test(input?.role,controller.signal));
          // expand=true 走合并调用：一次 LLM 推理同时返回英文翻译和扩展词，
          // 中文搜索不再串行等两次推理（旧 /expand 端点保留，行为不变）。
          if(u.pathname==='/api/ai/translate')return json(res,200,input.expand===true?await ai.translateSearch(input.query):await ai.translate(input.query));
          if(u.pathname==='/api/ai/expand')return json(res,200,await ai.expand(input.query));
          if(u.pathname==='/api/ai/parse-local')return json(res,200,await ai.parseLocal(input.query));
          if(u.pathname==='/api/ai/brainstorm')return json(res,200,await ai.brainstorm(input.query));
        }
        return json(res,404,{error:'AI 接口不存在'});
      }
      // 浏览器运行时：chrome-headless-shell 不再随安装包分发（236MB，占安装包九成体积），
      // 改成首次用到时按需下载。三条接口 —— 读状态 / 起下载 / 轮询进度，守卫与下载队列同级。
      if(u.pathname.startsWith('/api/browser')){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(req.method==='GET'&&u.pathname==='/api/browser')return json(res,200,browserStatus());
        // ---- 登录态 / cookie ----
        if(req.method==='GET'&&u.pathname==='/api/browser/session')return json(res,200,sessionStatus());
        // 带 ?domain= 时额外返回该站的 Cookie 头原文（设置页「复制」按钮用，值只回给本机）。
        if(req.method==='GET'&&u.pathname==='/api/browser/cookies'){
          const domain=String(u.searchParams.get('domain')||'').trim();
          const stats=cookieStats();
          if(!domain)return json(res,200,stats);
          const header=cookieHeaderFor(domain);
          return json(res,200,{...stats,domain,header,cookies:header?header.split('; ').length:0,login:loginStateFor(domain)});
        }
        // 挑战 cookie 保活：GET 看各站还活着多久 / 是不是该续了，POST 立刻续一次（排查用）。
        if(req.method==='GET'&&u.pathname==='/api/browser/warm')return json(res,200,warmStatus());
        if(req.method==='POST'&&u.pathname==='/api/browser/warm'){
          const input=await body(req);
          const host=String(input?.host||'');
          if(!host)return json(res,400,{error:'需要 host，例如 www.zcool.com.cn'});
          try{return json(res,200,{...await warmHost(host),warm:warmStatus()});}
          catch(e){return json(res,500,{error:e.message});}
        }
        if(req.method==='DELETE'&&u.pathname==='/api/browser/cookies')return json(res,200,{removed:clearCookies(u.searchParams.get('domain')||''),...cookieStats()});
        if(u.pathname==='/api/browser/login'&&req.method==='POST'){
          const input=await body(req);
          const platform=String(input?.platform||'');
          const url=String(input?.url||PICTURE_LOGIN_URLS[platform]||'');
          if(!url)return json(res,400,{error:'这个站点没有登记登录入口，请直接传 url'});
          // Fab 用 Epic OAuth：登录窗口落到 /id/api/redirect 显示授权码 JSON，这里给出提取规则，
          // 登录成功后换 token 存 fab/session.json —— 和 cookie 登录共用同一套可见登录窗口。
          const capture=platform==='fab'?{
            test:value=>/\bepicgames\.com\/id\/api\/redirect\b/i.test(value),
            extract:text=>{const m=String(text||'').match(/"authorizationCode"\s*:\s*"([A-Za-z0-9]+)"/);return m?m[1]:'';},
            onExtract:async code=>{const session=await fabExchangeCode(code,{open});await fabSaveSession(root,session);},
          }:null;
          try{return json(res,200,{...await startLogin({url,platform,capture}),login:loginStatus()});}
          catch(e){return json(res,500,{error:e.message});}
        }
        if(u.pathname==='/api/browser/login'&&req.method==='GET')return json(res,200,loginStatus());
        // 哪些平台有登录入口：平台下拉给每一项画登录图标时查这里，避免前端硬编码一份会和
        // PICTURE_LOGIN_URLS 脱节的名单（新接一个站只改后端即可）。
        if(u.pathname==='/api/browser/logins'&&req.method==='GET')return json(res,200,{platforms:PICTURE_LOGIN_URLS});
        if(u.pathname==='/api/browser/login/close'&&req.method==='POST'){
          try{return json(res,200,{...await closeLogin(),login:loginStatus(),cookies:cookieStats()});}
          catch(e){return json(res,500,{error:e.message});}
        }
        if(u.pathname==='/api/browser/sync'&&req.method==='POST'){
          try{return json(res,200,{...await syncCookies(),cookies:cookieStats()});}
          catch(e){return json(res,500,{error:e.message});}
        }
        // 兜底抓图：真浏览器打开页面，把网络里加载过的图片全捞回来（不依赖站点 HTML 结构）。
        if(u.pathname==='/api/browser/capture'&&req.method==='POST'){
          const input=await body(req);
          const url=String(input?.url||'').trim();
          if(!/^https?:\/\//i.test(url))return json(res,400,{error:'需要 http(s) 地址'});
          try{
            const timeout=Math.min(60000,Number(input?.timeout)||30000);
            const cap=await capturePage(url,{timeout,quiet:1200});
            let html=cap.html;let imgs=cap.images||[];let via='cdp';
            // CDP 普通模式跑不完阿里云那类人机验证，会停在 68KB 挑战页（体积不算小，但一张真图都没有）。
            // 判据取「体量小 + 没有真实图片」两个条件，再换 --dump-dom + virtual-time 试一次；
            // 它没有网络事件，图片从 DOM 里的 URL 抽。
            const realImgs=imgs.filter(x=>/^https?:/i.test(String(x.url))&&(x.bytes===0||x.bytes>15000)).length;
            if(html.length<100000&&realImgs<3){
              await releaseProfile().catch(()=>{});
              const dumped=await renderDom(url,{timeout:35000,budget:9000,profileDir:browserProfileDir()}).catch(()=>'');
              if(dumped&&dumped.length>html.length){
                html=dumped;via='dump-dom';
                const flat=html.replace(/&amp;/g,'&').replace(/\\u0026/g,'&').replace(/\\u003d/g,'=').replace(/\\u002f/gi,'/').replace(/\\\//g,'/');
                const seen=new Set();
                imgs=[...flat.matchAll(/https?:\/\/[^"'\s<>()\\]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'\s<>\\]*)?/gi)]
                  .map(m=>({url:m[0],mime:'image',bytes:0}))
                  .filter(x=>!seen.has(x.url)&&seen.add(x.url));
                await harvestCookies({host:new URL(url).hostname}).catch(()=>{});
              }
            }
            const picked=imgs.filter(x=>!String(x.url).startsWith('data:')).filter(x=>x.bytes===0||x.bytes>15000)
              .map(x=>({url:x.url,thumb:x.url,mime:x.mime,bytes:x.bytes,pageUrl:url}));
            return json(res,200,{ok:true,url,via,title:(html.match(/<title[^>]*>([^<]*)/i)||[])[1]||'',images:picked,count:picked.length,bytes:html.length});
          }catch(e){return json(res,500,{error:e.message});}
        }
        if(u.pathname==='/api/browser/install'){
          if(req.method==='GET'){const job=browserInstallJob(u.searchParams.get('id'));if(!job)return json(res,404,{error:'安装任务不存在或已过期，请重新点击下载'});return json(res,200,job);}
          if(req.method==='POST')return json(res,200,{jobId:startBrowserInstallJob()});
        }
        return json(res,404,{error:'浏览器接口不存在'});
      }
      // 首次运行的依赖准备：一次问清缺什么（后台浏览器 / Blender / 桥接脚本），逐项就地补上。
      // 这里只负责起任务并告诉前端去哪儿轮询，进度仍由各自那条老接口出，不复制第二套。
      if(u.pathname.startsWith('/api/setup')){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(req.method==='GET')return json(res,200,await dependencyReport({downloads}));
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        const input=await body(req);
        const action=String(input?.action||'');
        if(action==='install-browser')return json(res,200,{jobId:startBrowserInstallJob(),poll:'/api/browser/install'});
        if(action==='install-bridge'){
          if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
          return json(res,200,{...downloads.startBlenderBridgeInstall(),poll:'/api/downloads/blender-bridge/install'});
        }
        if(action==='set-blender'){
          try{const state=setBlenderPath(input.path);return json(res,200,{...state,report:await dependencyReport({downloads})});}
          catch(e){return json(res,400,{error:e.message});}
        }
        // 「完成」只记下用户已经看过这份清单，不是校验通过——缺的依赖之后还能在设置里补。
        if(action==='dismiss')return json(res,200,updateSetup({dismissedAt:new Date().toISOString()}));
        if(action==='finish'){
          const report=await dependencyReport({downloads});
          const state=updateSetup({done:true,finishedAt:new Date().toISOString(),dismissedAt:report.pending>0?new Date().toISOString():null});
          return json(res,200,{done:true,state,report});
        }
        return json(res,404,{error:'依赖接口不存在'});
      }
      // 「导入文件夹」：用户显式登记的本机目录，持久化为扫描根，重启后仍生效。
      // 只放行主机（局域网访客不能改主机目录），路径由服务端自己校验并 stat。
      if(u.pathname==='/api/library/file-organize/preflight'){
        const ip=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
        const trusted=!req.lanVisitor&&['127.0.0.1','::1'].includes(ip)&&[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(req.headers.host);
        if(!trusted||req.headers['x-sfx-local']!=='1'||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'仅主机同源页面可以预检真实目录'});
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        try{
          const input=await body(req);
          if(!['inspect','plan'].includes(input.action))return json(res,400,{error:'未知预检操作'});
          return json(res,200,await (input.action==='plan'?fileOrganizePreflight.plan(input):fileOrganizePreflight.inspect(input.folder)));
        }catch(error){return json(res,error.status||400,{error:error.message});}
      }
      if(u.pathname==='/api/library/file-organize/action'){
        const ip=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
        const trusted=!req.lanVisitor&&['127.0.0.1','::1'].includes(ip)&&[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(req.headers.host);
        if(!trusted||req.headers['x-sfx-local']!=='1'||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'仅主机同源页面可以整理源文件'});
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        try{
          const input=await body(req);
          if(input.action==='identity-inspect')return json(res,200,await locationMigration.inspect(input));
          if(input.action==='identity-audit')return json(res,200,await locationMigration.audit());
          if(input.action==='identity-migrate'){
            const controller=new AbortController(),cancel=()=>controller.abort();
            res.once('close',cancel);
            try{return json(res,200,await locationMigration.migrate({...input,signal:controller.signal}));}
            finally{res.off('close',cancel);}
          }
          const actions={'terms-rejections':()=>tagManagement.rejections(input),'terms-restore-rejection':()=>tagManagement.restoreRejection(input),'terms-list':()=>tagManagement.list(input),'terms-write':()=>tagManagement.mutate(input.change||{}),'rules-list':()=>taxonomyRules.list(),'rules-write':()=>taxonomyRules.write(input.change||{}),'labels-status':()=>tagBackfill.status(input),'labels-start':()=>tagBackfill.start(input),'labels-pause':()=>tagBackfill.pause(input),list:()=>fileOrganizer.list(input),permission:()=>fileOrganizer.setWritable(input),
            preview:()=>fileOrganizer.preview(input),move:()=>fileOrganizer.move(input),
            history:()=>fileOrganizer.history(),undo:()=>fileOrganizer.undo(input.operationId),recover:()=>fileOrganizer.recover(),
            'cache-stats':()=>cacheStats(),'cache-clear':async()=>({removed:await clearCache(),...await cacheStats()}),
            'cache-prune':async()=>{
              const sources=await libraryStorage.withDb(conn=>conn.all('SELECT r.path,l.rel FROM file_locations l JOIN file_roots r ON r.root_id=l.root_id LIMIT 50001')
                .map(row=>{const locator=localLocator({localRoot:row.path,localRel:row.rel});return locator?{file:path.join(locator.root,...locator.rel.split('/')),root:locator.root}:null;}).filter(Boolean));
              if(!sources)throw Error('数据库不可用，无法核验源文件位置');
              return {...await pruneExpiredCache({files:sources.map(item=>item.file),roots:new Map(sources.map(item=>[item.file,item.root]))}),...await cacheStats()};
            },
            'cache-trim':async()=>({removed:await trimCache(),...await cacheStats()}),'cache-budget':()=>setCacheBudget(input.bytes)};
          if(!Object.hasOwn(actions,input.action))return json(res,400,{error:'未知整理操作'});
          return json(res,200,await actions[input.action]());
        }catch(error){return json(res,error.status||400,{error:error.message,operationId:error.operationId});}
      }
      if(u.pathname==='/api/library/import-roots'){
        if(req.lanVisitor)return json(res,403,{error:'访客不能修改主机导入目录'});
        // 托管副本目录是库的内部存储（拖入导入时自动登记，只为了让 importFile 的根校验通过），
        // 不属于用户「导入目录」，列出来只会让人想移除它、移除后缩略图就 403。
        if(req.method==='GET')return json(res,200,{roots:importRoots.list().filter(folder=>!isManagedImportPath(folder)),entries:importRoots.status().filter(entry=>!isManagedImportPath(entry.path))});
        if(req.method!=='POST')return json(res,405,{error:'只支持 GET / POST'});
        const ip=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
        if(!['127.0.0.1','::1'].includes(ip)||![`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(req.headers.host)
          ||req.headers['x-sfx-local']!=='1'||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'仅主机同源页面可以修改导入目录'});
        const input=await body(req);
        try{
          const action=String(input?.action||'add');
          if(action==='relink'&&(await libraryStorage.withDb(conn=>conn.all('SELECT 1 FROM file_roots r JOIN file_locations l ON l.root_id=r.root_id WHERE r.path=? LIMIT 1',[path.resolve(String(input.from||''))])))?.length)
            return json(res,409,{error:'此目录已有稳定资产定位；整根重新定位尚未开放，请使用单文件重新定位，避免破坏原有身份关联'});
          if(action==='remove')await libraryStorage.withDbWrite(conn=>conn.run('UPDATE file_roots SET writable=0 WHERE path=?',[path.resolve(String(input.folder||''))]));
          const result=action==='remove'?importRoots.remove(input?.folder)
            :action==='relink'?importRoots.relink(input?.from,input?.to)
            :importRoots.add(input?.folder);
          if(result.added)allowLocalRoot(result.root);
          // 换根后新位置要进白名单，否则重扫认出包了、缩略图却被 403 挡住。
          if(result.relinked)allowLocalRoot(result.to);
          // 用户明确导入目录时，为图片图集自动补固定身份；日常扫描仍然只读。
          if(action==='add'){
            const root=result.root||String(input.folder||'');
            if(root){const scanned=await scanLibraryPackages({roots:[root]});
              for(const pkg of scanned.packages)if(pkg.category==='images'&&pkg.type==='folder'&&!pkg.hasMeta)
                await registerPackage(path.join(pkg.root,...pkg.rel.split('/')),pkg);
            }
          }
          invalidateScanCache();
          return json(res,200,{ok:true,...result,entries:importRoots.status()});
        }catch(error){return json(res,400,{error:error.message});}
      }
      // 外部文件拖入：二进制流直接落盘 → 复用 importFile 入库。单独一条路由，不能走
      // body(req)（它把请求体限死 64KB，装不下模型 / 贴图），也不做 JSON 包装。
      // `/drop-import/flush` 是同一批的收尾：文件挨个进来（每个只落盘 + 校验），最后一次性入库。
      if(u.pathname==='/api/library/drop-import'||u.pathname==='/api/library/drop-import/flush'){
        const ip=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
        const trusted=!req.lanVisitor&&['127.0.0.1','::1'].includes(ip)&&[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(req.headers.host);
        if(!trusted||req.headers['x-sfx-local']!=='1'||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'仅主机同源页面可以拖入导入'});
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        try{
          if(u.pathname.endsWith('/flush')){
            const input=await body(req);
            const batch=String(input?.batch||'');
            if(!validBatch(batch))return json(res,400,{error:'批次编号无效'});
            const action=String(input?.action||'flush')==='abort'?'abort':'flush';
            const result=action==='abort'?await dropImporter.abort(batch):await dropImporter.flush(batch);
            // 图集在盘上新建了带 info.json 的目录：扫描缓存还持着旧签名，不显式失效的话
            // 紧跟着的前端重扫可能拿旧结果，图集卡就不出现。
            if(result?.albums?.length)invalidateScanCache();
            return json(res,200,result);
          }
          const name=decodeURIComponent(String(req.headers['x-av-drop-name']||''));
          // 图集模式：前端把「整包当一个图集」的选择放在这个头里，落盘时同一批进同一个目录。
          const album=decodeURIComponent(String(req.headers['x-av-album']||''));
          const batch=String(req.headers['x-av-batch']||'');
          const canvasBoard=decodeURIComponent(String(req.headers['x-av-canvas-board']||'')).slice(0,200);
          return json(res,200,await dropImporter.save({name,stream:req,size:Number(req.headers['content-length']||0),batch:validBatch(batch)?batch:'',album,canvasBoard}));
        }catch(error){return json(res,error.status||400,{error:error.message});}
      }
      // 显式只读检查已登记根：仅批内比较，不与全库索引比较，不做导入提交。
      if(u.pathname==='/api/library/import-preflight'||u.pathname==='/api/library/import-file'||u.pathname==='/api/library/relink-file'){
        const ip=String(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
        const trusted=!req.lanVisitor&&['127.0.0.1','::1'].includes(ip)&&[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`].includes(req.headers.host);
        if(!trusted||req.headers['x-sfx-local']!=='1'||req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'仅主机同源页面可以检查导入目录'});
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        const input=await body(req),folder=typeof input.folder==='string'?path.resolve(input.folder):'';
        if(!importRoots.list().includes(folder))return json(res,403,{error:'仅可检查已登记的导入目录'});
        if(!importRoots.valid().includes(folder))return json(res,409,{error:'导入目录当前离线或不可读取'});
        if(u.pathname==='/api/library/import-file'||u.pathname==='/api/library/relink-file'){
          try{return json(res,200,await localImporter[u.pathname.endsWith('/relink-file')?'relinkFile':'importFile'](input,{signal:controller.signal}));}
          catch(error){if(error.name==='AbortError')throw error;return json(res,error.status||400,{error:error.message});}
        }
        const scan=await listLocalFolder({folder,limit:4000});
        const results=await preflightLocalFiles({files:scan.files.map(file=>path.join(folder,...file.rel.split('/'))),signal:controller.signal});
        const stats={total:results.length};
        for(const row of results)stats[row.status]=(stats[row.status]||0)+1;
        return json(res,200,{results,stats,truncated:scan.truncated,scanned:scan.scanned,scope:'directory-batch',limit:4000});
      }
      // WebDAV 云同步：配置 / 连通性测试 / 立即同步。密码只进不出（status 只回答有没有存过），
      // 访客一律拒绝 —— 这是主机的网盘凭据，不是共享内容。
      if(u.pathname==='/api/library/sync'){
        if(req.lanVisitor)return json(res,403,{error:'访客不能管理主机的云同步'});
        if(req.method==='GET')return json(res,200,await webdavSync.status());
        if(req.method!=='POST')return json(res,405,{error:'只支持 GET / POST'});
        const input=await body(req);
        try{
          const action=String(input?.action||'');
          if(action==='save')return json(res,200,{ok:true,...await webdavSync.saveConfig(input)});
          if(action==='test')return json(res,200,{ok:true,...await webdavSync.test(input)});
          if(action==='run')return json(res,200,{ok:true,...await webdavSync.run({manual:true})});
          return json(res,400,{error:'未知操作'});
        }catch(error){return json(res,400,{error:error.message});}
      }
      // 选目录 / 只读浏览：local-browse.mjs 早就实现的两个能力，以前只有测试在调。
      if(u.pathname==='/api/library/pick-folder'){
        if(req.lanVisitor)return json(res,403,{error:'访客不能选择主机目录'});
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        const input=await body(req);
        try{return json(res,200,{folder:await nativeFolderPicker(input?.folder||'')});}
        catch(error){return json(res,400,{error:error.message});}
      }
      if(u.pathname==='/api/library/browse-folder'){
        if(req.lanVisitor)return json(res,403,{error:'访客不能浏览主机目录'});
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        const input=await body(req);
        try{return json(res,200,await listLocalFolder({folder:input?.folder||'',limit:Number(input?.limit)||undefined}));}
        catch(error){return json(res,400,{error:error.message});}
      }
      // 资产检查：库内「目录 ↔ 记录」一致性。GET 只读体检，POST 做安全修复。
      // 修复只碰两类（补 packageDir / 多余重复记录进回收站），规则在 server/library-audit.mjs，
      // 与 scripts/audit-library-links.mjs 共用一份 —— 界面和脚本各写一套，迟早对不上。
      if(u.pathname==='/api/library/audit'){
        if(!libraryStorage)return json(res,503,{error:'资产库内核未启用，无法体检'});
        try{
          if(req.method==='GET'){
            const report=await auditLibrary({storage:libraryStorage,archiveRoot:userPaths.archiveRoot});
            return json(res,200,report);
          }
          if(req.method==='POST'){
            const input=await body(req);
            const wanted=Array.isArray(input?.kinds)?input.kinds.filter(kind=>kind==='anchors'||kind==='duplicates'):['anchors','duplicates'];
            if(!wanted.length)return json(res,400,{error:'没有要修的项目'});
            const result=await repairLibrary({storage:libraryStorage,archiveRoot:userPaths.archiveRoot,kinds:wanted});
            // 补了锚点 / 移走重复记录都会改变「哪些包已经有主」，扫描缓存必须跟着失效。
            invalidateScanCache();
            return json(res,200,result);
          }
          return json(res,405,{error:'只支持 GET / POST'});
        }catch(error){
          return json(res,500,{error:`资产检查失败：${error.message}`});
        }
      }
      // 资产库的扫描根 = 后台下载目录 + 各任务下载根 + 用户显式导入的本机目录。
      // 全部归一成绝对路径，避免同一目录因斜杠写法不同在 Set / 扫描缓存 key 里分裂。
      // 取文件与缩略图仍只认登记过的根，别的路径一律 403。
      if(u.pathname==='/api/library/scan'){
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
        const roots=[...new Set([downloads.defaultFolder,...downloads.jobs.map(job=>job.downloadRoot),...(downloads.legacyRoots||[]),...importRoots.valid()].filter(Boolean).map(folder=>path.resolve(folder)))];
        // 托管副本目录不参与「零散文件」扫描：它里面的每个文件都已经是一条资产记录，
        // 再列一遍就是重复卡片（拖入导入后会同时出现资产卡和磁盘文件卡）。取文件的权限另走
        // allowLocalRoot，摘掉扫描不影响缩略图与预览。
        const scanRoots=roots.filter(folder=>!isManagedImportPath(folder));
        // 已经登记成下载任务的条目有自己的卡片，这里只补「资产库原本看不见的那部分」。
        const claimed=downloads.jobs.map(job=>job.filePath).filter(Boolean).map(file=>path.resolve(file));
        // 以包为单位扫描：目录里有 info.json 就算一个资产，整棵子树归它，不再逐文件出卡片。
        // 重复请求不再无条件全量重建：scan-cache 按根目录签名 + TTL 失效，写操作成功后显式清缓存。
        const scanned=await cachedScan(JSON.stringify(scanRoots),{roots:scanRoots,force:u.searchParams.get('force')==='1',compute:options=>scanLibraryPackages({roots:scanRoots,...options})});
        for(const root of roots)allowLocalRoot(root);
        // 已入库的本地文件不再进「零散文件」列表：导入副本与下载产物现在都落在资产根下的分类目录里，
        // 扫描一定会扫到它们，不滤掉就是同一张图两张卡（一张资产卡 + 一张磁盘文件卡）。
        // 回收站仍持有文件身份：只软删除、不删文件，不能被扫描重新显示为散文件。
        const indexed=new Set();
        try{
          const rows=await libraryStorage.withDb(conn=>conn.all("SELECT payload FROM assets WHERE state IN ('active','trashed')"));
          for(const row of rows){
            try{const file=JSON.parse(row.payload)?.filePath;if(file)indexed.add(path.resolve(String(file)).toLowerCase());}catch{}
          }
        }catch{/* 读不到资产表就不过滤：宁可多一张文件卡，也不要整片文件消失 */}
        const files=scanned.files.filter(file=>{
          // 只收素材：readme、日志、脚本、LICENSE 这些是目录里的附带文件，不是资产。
          if(file.kind==='other'||file.kind==='document')return false;
          const absolute=path.resolve(file.root,file.rel);
          if(indexed.has(absolute.toLowerCase()))return false;
          return !claimed.some(entry=>absolute===entry||absolute.startsWith(entry+path.sep));
        });
        // 资产包同理：一个已经登记成资产的目录，不应该再作为「素材包」出一张卡。
        // 两套数据源各出一张，就是「一张有正确缩略图、另一张是图集样式」的重复卡
        // （2026-11-16 反馈）。目录本身不删，资产卡点开照样能看包内文件。
        // 判据集中在 server/asset-claim.mjs，巡检脚本用同一份，避免两边规则漂移。
        let index=null;
        try{
          const rows=await libraryStorage.withDb(conn=>conn.all("SELECT uid, payload FROM assets WHERE state IN ('active','trashed')"));
          index=claimIndex(rows);
        }catch{/* 读不到资产表就不过滤：宁可多一张包卡，也不要整片包消失 */}
        const packages=scanned.packages
          .filter(pkg=>!isClaimed(pkg,index))
          // 剩下的包里，凡是带包内身份（uid / info.json）却没被认领的，就是「漏登记」：
          // 明说，别让它伪装成普通素材包 —— 那正是这次重复卡的观感来源。
          .map(pkg=>isPendingClaim(pkg)?{...pkg,pendingClaim:true}:pkg);
        return json(res,200,{roots,packages,files,truncated:scanned.truncated,limits:scanned.limits});
      }
      // 登记：给「用户自己拷进来的素材包」补一个 info.json（uid + 事实字段 + 包统计）。
      // 只认扫描结果里真实存在的包根，前端传不了任意路径；已有 info.json 的包一律不改写。
      if(u.pathname==='/api/library/register'){
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
        const input=await body(req);
        const root=String(input?.root||''),rel=String(input?.rel||'');
        if(!root||!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再登记里面的资产'});
        const scanned=await scanLibraryPackages({roots:[root]});
        const pkg=scanned.packages.find(item=>item.root===root&&item.rel===rel);
        if(!pkg)return json(res,404,{error:'没找到这个资产包，先刷新一下资产库'});
        if(pkg.type==='zip')return json(res,400,{error:'ZIP 包内部写不进 info.json，先解压成文件夹再登记'});
        try{
          const result=await registerPackage(path.join(root,...rel.split('/')),pkg);
          // info.json 落在既有包目录内部，扫描缓存的根签名探不到 → 显式失效。
          invalidateScanCache();
          return json(res,200,{ok:true,skipped:result.skipped,uid:result.uid,meta:result.meta});
        }catch(error){
          const code=String(error?.code||'');
          const message=/EACCES|EPERM/.test(code)?'这个文件夹没有写入权限（只读或被占用），info.json 写不进去'
           :/ENOSPC/.test(code)?'磁盘空间不足，info.json 写不进去'
           :`登记失败：${error.message}`;
          return json(res,500,{error:message});
        }
      }
      // 删卡片：目录合并不会因为 blob 里少了 uid 就删掉它，所以这里直接摘目录、清数据库，并删掉下载目录里的文件。
      if(u.pathname==='/api/library/delete'){
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
        try{
          const input=await body(req);
          const uid=String(input?.uid||'');
          const roots=[...new Set([downloads.settings?.folder,downloads.defaultFolder,...downloads.jobs.map(job=>job.downloadRoot),...(downloads.legacyRoots||[])].filter(Boolean))].map(folder=>path.resolve(folder));
          // 可删除范围 = 下载目录 + 已登记的导入目录 + 托管副本目录。少了后两类，
          // 拖入导入 / 导入文件夹出来的卡片点删除会「静默什么都不做」，但前端仍然弹「已删除」。
          const deletable=[...new Set([...roots,...importRoots.valid().map(folder=>path.resolve(folder)),managedImportDir])];
          const inside=file=>deletable.some(root=>{const full=path.resolve(file);return full!==root&&full.startsWith(root+path.sep);});
          const removed=[];
          const rmAsset=async file=>{
            const full=path.resolve(file);
            if(!inside(full))return;
            // 派生缩略图必须在删文件之前清：缓存名靠「设备号:inode:创建时间」算，
            // 文件一落地删掉就再也对不上了，这些图只会白占几十 MB 直到过期。
            await dropThumbCache(full).catch(()=>{});
            await fs.rm(full,{recursive:true,force:true});
            // 连带删掉同名说明书：<文件名>.info.json 与目录资产的 __info.json。
            // 只删主文件会把空壳说明书留在盘上，下次扫描它又变成一张打不开的破图卡，
            // 用户看到的就成「删了刷新又回来」。
            await fs.rm(`${full}.info.json`,{force:true}).catch(()=>{});
            await fs.rm(path.join(full,'__info.json'),{force:true}).catch(()=>{});
            // 删掉资产后顺手收掉空的分类子目录（如 imports/图片/图片）；非空时 rmdir 自然失败。
            const parent=path.dirname(full);
            if(parent!==managedImportDir&&isManagedImportPath(parent))await fs.rmdir(parent).catch(()=>{});
            downloads.dismissedDownloads?.add(process.platform==='win32'?full.toLowerCase():full);
            removed.push(full);
          };
          for(const job of downloads.jobs.filter(item=>item.filePath&&(item.id===input?.jobId||(uid&&item.uid===uid)))){
            if(!['saved','failed','cancelled','interrupted'].includes(job.state))continue;
            await rmAsset(job.filePath);
          }
          const root=String(input?.root||''),rel=String(input?.rel||'').replace(/\\/g,'/');
          if(root&&rel&&!rel.split('/').some(part=>!part||part==='..')){
            const full=path.resolve(root,...rel.split('/'));
            if(inside(full))await rmAsset(full);
          }
          if(uid){
            const visit=async(dir,depth)=>{
              if(depth>4)return;
              let entries=[];try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
              for(const entry of entries){
                if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
                const file=path.join(dir,entry.name);
                if(!entry.isDirectory())continue;
                try{
                  const info=JSON.parse(await fs.readFile(path.join(file,'info.json'),'utf8'));
                  if(info?.uid===uid){await rmAsset(file);continue;}
                }catch{/* 没有清单就继续往下找 */}
                await visit(file,depth+1);
              }
            };
            for(const folder of roots)await visit(folder,0);
            // 托管副本（拖入导入 / 复制进库）既不是下载任务、也没有 info.json 包目录，
            // 上面两条路径都摸不到它 —— 只有资产记录自己记着 filePath。
            try{
              const row=await libraryStorage.withDb(conn=>conn.all('SELECT payload FROM assets WHERE uid = ?',[uid])[0]);
              const filePath=row?JSON.parse(row.payload)?.filePath:'';
              if(filePath)await rmAsset(filePath);
            }catch{/* 记录读不到就只按目录规则删，别拦住后面的清库 */}
            const thumb=String(input?.thumbnail||'');
            if(/^https?:\/\//i.test(thumb)){
              const cacheDir=path.join(resolveDataDir(root).dir,'http-cache','images');
              for(const key of [thumb,`${thumb}|`]){
                const name=createHash('sha256').update(key).digest('hex');
                await fs.rm(path.join(cacheDir,name),{force:true}).catch(()=>{});
              }
            }

          }
          // Path-only deletion must also remove registered catalog cards, not only disk files.
          const removedUids=await libraryStorage.withDb(conn=>catalogUidsForRemovedPaths(conn.all('SELECT uid, payload FROM assets'),removed));
          if(uid)removedUids.push(uid);
          await libraryStorage.dropCatalog(removedUids);
          downloads.jobs=downloads.jobs.filter(item=>!removedUids.includes(item.uid)&&item.id!==input?.jobId&&!removed.includes(item.filePath));
          downloads.save();
          invalidateScanCache();
          return json(res,200,{ok:true,removed,removedUids});
        }catch(error){
          const code=String(error?.code||'');
          const message=/EPERM|EACCES|EBUSY/.test(code)?'文件被占用或没有删除权限':error.message;
          return json(res,500,{error:message});
        }
      }
      // 资产信息补写：AI 标签与用户评分/备注异步落进 info.json（包即真相，浏览器状态仍是主存储）。
      // 与登记同一条校验链：只认扫描结果里的包根、拒绝 ZIP、已有 info.json 才准写。
      if(u.pathname==='/api/local/meta-patch'){
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
        const input=await body(req);
        const root=String(input?.root||''),rel=String(input?.rel||'');
        if(!root||!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再写入资产信息'});
        const scanned=await scanLibraryPackages({roots:[root]});
        const pkg=scanned.packages.find(item=>item.root===root&&item.rel===rel);
        if(!pkg)return json(res,404,{error:'没找到这个资产包，先刷新一下资产库'});
        if(pkg.type==='zip')return json(res,400,{error:'ZIP 包内部写不进 info.json，先解压成文件夹'});
        try{
          const meta=await patchPackageMeta(path.join(root,...rel.split('/')),{ai:input?.ai,user:input?.user});
          if(!meta)return json(res,409,{error:'这个资产还没有登记（缺 info.json），先登记再写信息'});
          // 元信息写进了包目录内部，根签名探不到 → 显式失效扫描缓存。
          invalidateScanCache();
          return json(res,200,{ok:true,meta});
        }catch(error){
          const code=String(error?.code||'');
          const message=/EACCES|EPERM/.test(code)?'这个文件夹没有写入权限（只读或被占用），info.json 写不进去'
           :/ENOSPC/.test(code)?'磁盘空间不足，info.json 写不进去'
           :`写入失败：${error.message}`;
          return json(res,500,{error:message});
        }
      }
      // 资产包整包下载：点卡片上的下载键，把整个素材文件夹现场打包成 ZIP 推给浏览器。
      // 不落临时文件（320MB 的 PSD 包落一份再删等于白写一次盘），也不改磁盘上的任何东西。
      if(u.pathname==='/api/local/package-zip'&&req.method==='GET'){
        const root=u.searchParams.get('root'),rel=String(u.searchParams.get('rel')||'');
        if(!root||!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再下载里面的资产'});
        let pkg=null;
        try{
          const scanned=await scanLibraryPackages({roots:[root]});
          pkg=scanned.packages.find(item=>item.root===root&&item.rel===rel);
        }catch(error){
          return json(res,500,{error:`读目录失败：${error.message}`});
        }
        if(!pkg)return json(res,404,{error:'没找到这个资产包，先刷新一下资产库'});
        // ZIP 包本身就是压缩包，直接发原文件，没必要再套一层。
        if(pkg.type==='zip'){
          let target=null;
          try{target=resolveLocalFile({root,rel});}
          catch(e){return json(res,400,{error:e.message});}
          const zipName=target.file.split(/[\\/]/).pop()||'asset.zip';
          // 不用 streamLocalFile：它只给预览头（inline + octet-stream），下载要 attachment 才有文件名。
          res.writeHead(200,{
            'Content-Type':'application/zip',
            'Content-Length':target.bytes,
            'Content-Disposition':`attachment; filename="asset.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
            'Cache-Control':'no-store',
          });
          return pipeline(createReadStream(target.file),res).catch(()=>{try{res.destroy();}catch{/* 已经断了 */}});
        }
        const dir=path.resolve(root,...rel.split('/').filter(Boolean));
        const base=path.resolve(root);
        if(dir!==base&&!dir.startsWith(base+path.sep))return json(res,400,{error:'路径不合法'});
        const fileName=`${(pkg.title||rel.split('/').pop()||'asset').replace(/[\\/:*?"<>|]/g,'_')}.zip`;
        try{
          await streamFolderZip(res,{dir,name:fileName});
        }catch(error){
          // 头已经发出去了就只能截断，浏览器会把它当失败下载；没发出去才回 JSON。
          if(!res.headersSent)return json(res,500,{error:`打包失败：${error.message}`});
          try{res.destroy();}catch{/* 已经断了 */ }
        }
        return;
      }
      if(u.pathname==='/api/local/reveal'&&req.method==='POST'){
        const peer=req.socket.remoteAddress||'';
        if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer)||req.headers['x-sfx-local']!=='1')return json(res,403,{error:'仅支持本机打开文件夹'});
        let input=null;
        try{input=await body(req);}catch(error){return json(res,400,{error:error.message});}
        if(!isLocalRootAllowed(input.root))return json(res,403,{error:'请先索引这个文件夹'});
        try{
          // rel 现在既可能是文件，也可能是一个素材包目录：目录就打开目录本身，
          // 文件则在资源管理器里选中它（打开的还是它所在的文件夹）。
          const resolved=resolveLocalTarget({root:input.root,rel:input.rel});
          if(!await revealInFileManager(resolved.path,{isDir:resolved.isDir}))return json(res,500,{error:'调不起系统文件管理器'});
          return json(res,200,{opened:true,folder:resolved.isDir?resolved.path:path.dirname(resolved.path),selected:resolved.rel});
        }catch(error){
          // 目标被改名 / 删掉时，用户要的其实还是「那个地方」：父目录还在就打开父目录，
          // 比回一句「文件不存在」有用得多。父目录必须仍在已索引的根里面，不许借机越界。
          const base=path.resolve(String(input.root||''));
          const parent=path.dirname(path.resolve(base,String(input.rel||'')));
          const inScope=parent.startsWith(base+path.sep)&&parent!==base;
          if(inScope&&fs.existsSync(parent)&&await revealInFileManager(parent,{isDir:true}))
            return json(res,200,{opened:true,folder:parent,fellBack:true});
          return json(res,404,{error:`打不开这个位置：${error.message}`});
        }
      }
      if(u.pathname==='/api/local/file'&&req.method==='GET'){
        const root=u.searchParams.get('root');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let target=null;
        try{target=resolveLocalFile({root,rel:u.searchParams.get('rel')});}
        catch(e){return json(res,400,{error:e.message});}
        return streamLocalFile(req,res,target);
      }
      // 拖出到外部软件：前端给的是卡片描述（{root,rel} 或原图 URL），这里换成 CF_HDROP 要的
      // 磁盘绝对路径。只有桌面版会调它 —— 网页版没有原生拖放，走 picture-drag.js 的兜底。
      if(u.pathname==='/api/drag/files'&&req.method==='POST'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        let input=null;
        try{input=await body(req);}catch(error){return json(res,400,{error:error.message});}
        try{
          const result=await dragStage.resolve(input?.items,{signal:controller.signal});
          return json(res,200,result);
        }catch(error){return json(res,400,{error:error.message});}
      }
      // 网页版兜底：浏览器拿不到磁盘路径，这里按 uid 给出「可抓取的同源 URL」清单。
      // 前端据此预取原图字节塞进 HTML5 拖拽 —— 拖到 ArtStation 这类网页上传只认 dataTransfer.files。
      if(u.pathname==='/api/drag/urls'&&req.method==='POST'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        let input=null;
        try{input=await body(req);}catch(error){return json(res,400,{error:error.message});}
        const uid=String(input?.uid||'');
        if(!uid)return json(res,400,{error:'缺少资产 ID'});
        try{
          const files=await assetResolver({uid});
          const list=[];
          for(const [index,file] of files.entries()){
            let size=0;
            try{size=(await fs.stat(file)).size;}catch{continue;}
            list.push({name:path.basename(file),mime:localMime(file),size,url:`/api/drag/file?uid=${encodeURIComponent(uid)}&i=${index}`});
          }
          return json(res,200,{files:list});
        }catch(error){return json(res,400,{error:error.message});}
      }
      // 按 uid + 序号把该资产的原文件流给浏览器：前端 fetch 成 Blob（网页上传用），
      // DownloadURL 也指到这里（拖到资源管理器 / PS 时由浏览器按 URL 下载成本地文件）。
      // 不加 x-sfx-local：DownloadURL 由浏览器直接取地址，带不上自定义头。
      if(u.pathname==='/api/drag/file'&&req.method==='GET'){
        const uid=String(u.searchParams.get('uid')||'');
        const index=Number(u.searchParams.get('i'));
        if(!uid||!Number.isInteger(index)||index<0)return json(res,400,{error:'参数无效'});
        let files;
        try{files=await assetResolver({uid});}catch(error){return json(res,404,{error:error.message});}
        const file=files[index];
        if(!file)return json(res,404,{error:'文件不存在'});
        let stat;
        try{stat=await fs.stat(file);}catch{return json(res,404,{error:'文件不存在'});}
        if(!stat.isFile())return json(res,404,{error:'文件不存在'});
        return streamLocalFile(req,res,{file,bytes:stat.size});
      }
      // 浏览器放不了的视频容器在这里转成 fMP4 再发：先拷流（换容器不换编码，近乎瞬时），
      // 编码也不认才重编码。没有 ffmpeg 就明确回 501，让前端能说出「装个 ffmpeg」而不是空屏。
      // 浏览器显示不了的图片格式（PSD）在这里转成 PNG 再发：素材包里常是几十张 2048 的
      // .psd，让前端逐张下载再解码等于搬几百 MB，缩略图这一层就转了才合理。其它格式原样透传。
      if(u.pathname==='/api/local/thumb'&&req.method==='GET'){
        const root=u.searchParams.get('root');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let target=null;
        try{target=resolveLocalFile({root,rel:u.searchParams.get('rel')});}
        catch(e){return json(res,400,{error:e.message});}
        const width=u.searchParams.get('purpose')==='tags'?1536:LIST_THUMB_SIZE;
        try{
          const original=u.searchParams.get('full')==='1';
          const out=await thumbFor(target.file,{width,format:original?'png':'webp',root,original});
          const etag='"'+createHash('sha1').update(out.buffer).digest('hex')+'"';
          const cacheHeaders={'ETag':etag,'Cache-Control':Number(u.searchParams.get('v'))>0?'private,max-age=86400':'private,max-age=0,must-revalidate'};
          if(req.headers['if-none-match']===etag){res.writeHead(304,cacheHeaders);return res.end();}
          res.writeHead(200,{...cacheHeaders,'Content-Type':out.mime||'image/png','Content-Length':out.buffer.length});
          return res.end(out.buffer);
        }catch(error){
          // A card must never decode the full source as a thumbnail fallback.
          // The client retries transient failures, then keeps an actionable placeholder.
          res.setHeader('Cache-Control','no-store');
          return json(res,415,{error:`缩略图生成失败：${error.message}`});
        }
      }
      // 服务端 3D 封面：.blend / .usd* 浏览器解析不了，由服务端出图并写进同一份缩略图缓存。
      if(u.pathname==='/api/local/thumb/version'&&req.method==='GET'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const root=u.searchParams.get('root');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        try{const target=resolveLocalFile({root,rel:u.searchParams.get('rel')});return json(res,200,{version:await modelThumbVersion(target.file,{root})});}
        catch(error){return json(res,error.status||409,{error:error.message});}
      }
      // 与上面的回传接口分开，是因为这条要真的渲染（.blend 先读内嵌预览，毫秒级；USD 走 Blender）。
      if(u.pathname==='/api/local/thumb/render'&&req.method==='POST'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        let input=null;
        try{input=await bodyLarge(req,64*1024);}catch(error){return json(res,400,{error:error.message});}
        const root=String(input?.root||''),rel=String(input?.rel||'');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let target=null;
        try{target=resolveLocalFile({root,rel});}catch(e){return json(res,400,{error:e.message});}
        if(!isServerCoverName(target.file))return json(res,415,{error:'这个格式不走服务端渲染'});
        try{
          const width=LIST_THUMB_SIZE;
          return json(res,200,{ok:true,...await ensureServerCover(target.file,{width,format:'webp'})});
        }catch(error){return json(res,415,{error:`封面生成失败：${error.message}`});}
      }
      // 3D 封面回传：Node 侧没有 WebGL，由前端 model-thumb.js 离屏渲一帧后写进缩略图缓存。
      // 与 GET 共用 root 白名单 + 路径解析，且要求本地请求标识；访客只读总闸也会挡掉非 GET。
      if(u.pathname==='/api/local/thumb/model'&&req.method==='POST'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        let input=null;
        try{input=await bodyLarge(req,4*1024*1024);}catch(error){return json(res,400,{error:error.message});}
        const root=String(input?.root||''),rel=String(input?.rel||'');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let target=null;
        try{target=resolveLocalFile({root,rel});}catch(e){return json(res,400,{error:e.message});}
        const match=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(input?.png||''));
        if(!match)return json(res,400,{error:'封面不是 PNG 图片'});
        try{
          const width=LIST_THUMB_SIZE;
          if(/\.(gltf|glb)$/i.test(target.file)&&typeof input.coverVersion!=='string')return json(res,409,{error:'glTF/GLB 封面需要源版本，请刷新页面后重试'});
          await saveModelThumb(target.file,Buffer.from(match[1],'base64'),{width,format:'webp',root,coverVersion:input.coverVersion});
          return json(res,200,{ok:true});
        }catch(error){return json(res,error.status||415,{error:`3D 封面保存失败：${error.message}`});}
      }
      // ZIP 内嵌浏览：只读中央目录，不落盘、不解压整包。
      if(u.pathname==='/api/local/archive'&&req.method==='GET'){
        const root=u.searchParams.get('root');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let target=null;
        try{target=resolveLocalFile({root,rel:u.searchParams.get('rel')});}
        catch(e){return json(res,400,{error:e.message});}
        try{
          const limit=Math.max(1,Math.min(Number(u.searchParams.get('limit'))||600,2000));
          return json(res,200,await listArchiveEntries(target.file,{limit}));
        }catch(error){return json(res,400,{error:`读不懂这个 ZIP：${error.message}`});}
      }
      if(u.pathname==='/api/local/archive/entry'&&req.method==='GET'){
        const root=u.searchParams.get('root');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let target=null;
        try{target=resolveLocalFile({root,rel:u.searchParams.get('rel')});}
        catch(e){return json(res,400,{error:e.message});}
        try{
          const entry=await extractArchiveEntry(target.file,u.searchParams.get('entry'));
          // 传了 w 就当卡片封面用：压缩包里的原图常有十几 MB（4K 底色图），原样发给网格会把首屏拖垮。
          // 这里缩到长边 w 再转 WebP；转码失败（不是图片）就退回原字节，不让封面整块消失。
          const width=Math.max(0,Math.min(2048,Number(u.searchParams.get('w'))||0));
          const shrunk=width?await shrinkImageBuffer(entry.bytes,{width}):null;
          const body=shrunk?.bytes||entry.bytes;
          const mime=(shrunk?.mime)||localMime(entry.name)||'application/octet-stream';
          const etag='"'+createHash('sha1').update(body).digest('hex')+'"';
          const headers={'Content-Type':mime,'Content-Length':body.length,'ETag':etag,'Cache-Control':shrunk?'private,max-age=3600':'private,max-age=300'};
          if(req.headers['if-none-match']===etag){res.writeHead(304,headers);return res.end();}
          res.writeHead(200,headers);
          return res.end(body);
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(u.pathname==='/api/local/play'&&req.method==='GET'){
        const root=u.searchParams.get('root');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let file=null;
        // resolveLocalFile 返回的是 {file,bytes,rel}，交给 ffmpeg 的必须是 file 这个绝对路径。
        try{file=resolveLocalFile({root,rel:u.searchParams.get('rel')}).file;}
        catch(e){return json(res,400,{error:e.message});}
        const ffmpeg=findFfmpeg();
        if(!ffmpeg)return json(res,501,{error:'没找到 ffmpeg，装一个或把它放进 vendor/ffmpeg/bin 才能播这个容器'});
        const probe=probeMedia(ffmpeg,file);
        const plan=transcodePlan(probe);
        if(u.searchParams.get('probe')==='1'){
          return json(res,200,{available:true,plan,codecs:{video:probe?.video?.codec_name||null,audio:probe?.audio?.codec_name||null}});
        }
        return streamMp4({res,file,ffmpeg,plan});
      }
      // 文档预览（本地资产库，与 RSS 无关）：pptx / xlsx / rtf 等由本机 LibreOffice 转 PDF，
      // 再复用现有 pdf iframe。status 是内部 UI 接口要 x-sfx-local；pdf 由 <iframe> 直接请求，
      // 带不了自定义头，所以与 /api/local/thumb 一样按「索引过的 root」白名单鉴权。
      if(u.pathname==='/api/doc/status'&&req.method==='GET'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        return json(res,200,docStatus());
      }
      if(u.pathname==='/api/doc/pdf'&&req.method==='GET'){
        const folder=u.searchParams.get('root');
        if(!isLocalRootAllowed(folder))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let target=null;
        try{target=resolveLocalFile({root:folder,rel:u.searchParams.get('rel')});}
        catch(e){return json(res,400,{error:e.message});}
        if(!canConvertDoc(target.file))return json(res,415,{error:'这个格式不需要转换，或暂不支持'});
        try{
          const {buffer}=await convertToPdf(target.file);
          res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':buffer.length,'Cache-Control':'private,max-age=600'});
          return res.end(buffer);
        }catch(e){
          // 没装 LibreOffice 是「可安装」，其余是转换失败；前端据此给不同提示。
          return json(res,/没找到 LibreOffice/.test(e.message)?501:500,{error:e.message});
        }
      }
      // 桥接插件本体：主机装过的那份只对主机的 Blender 生效，局域网访客要装到自己电脑上，
      // 所以这份文件得能被访客下载（登录态由 lan-sharing 把关，这里只管发文件）。
      if(u.pathname==='/api/lan/blender-addon'&&req.method==='GET'){
        const bytes=await fs.readFile(path.join(root,'server/blender-bridge.py'));
        res.writeHead(200,{'Content-Type':'text/x-python; charset=utf-8','Content-Length':bytes.length,'Content-Disposition':'attachment; filename="assetvault_blender_bridge.py"','Cache-Control':'no-store'});
        res.end(bytes);return;
      }
      if(u.pathname.startsWith('/api/downloads')){
        if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
        const match=u.pathname.match(/^\/api\/downloads\/tasks\/([a-f0-9-]{36})\/(action|file|reveal|send-blender|convert-fbx)$/);
        if(match?.[2]==='file'&&req.method==='GET'){
          const {job,path:file}=downloads.file(match[1]);let target=file,temp;
          try{
            const stat=await fs.lstat(file);
            if(stat.isSymbolicLink())throw Error('不支持下载符号链接');
            if(stat.isDirectory()){
              temp=await fs.mkdtemp(path.join(tmpdir(),'assetvault-delivery-'));target=path.join(temp,'asset.zip');
              await packFolderDownload(file,target,{signal:controller.signal});
            }else if(!stat.isFile())throw Error('不支持下载此文件类型');
            const size=(await fs.stat(target)).size,name=job.filename+(temp?'.zip':'');
            res.writeHead(200,{'Content-Type':'application/zip','Content-Length':size,'Content-Disposition':`attachment; filename="model.zip"; filename*=UTF-8''${encodeURIComponent(name)}`});
            await pipeline(createReadStream(target),res);
          }finally{if(temp)await fs.rm(temp,{recursive:true,force:true});}
          return;
        }
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        // 启动器靠这份回答判断「正在跑的进程是不是这一版」——所以它必须原样来自能力契约，
        // 不能在这里手写一份，否则又变回两处要同步、漏一处就永远不重启的老问题。
        if(req.method==='GET'&&u.pathname==='/api/downloads/capabilities')return json(res,200,SERVER_CAPABILITIES);
        // 「Blender 连接」面板：脚本装到哪些版本目录、Blender 开着没有、桥接是否真能应答。
        if(req.method==='GET'&&u.pathname==='/api/downloads/blender-bridge')return json(res,200,await downloads.blenderBridge());
        // 安装进度：界面按 id 轮询，读到的每一步都对应后端真实执行的动作。
        if(req.method==='GET'&&u.pathname==='/api/downloads/blender-bridge/install')return json(res,200,downloads.blenderBridgeInstall(u.searchParams.get('id')));
        if(req.method==='GET'&&u.pathname==='/api/downloads'){const snapshot=await (downloads.snapshotAsync?.()??downloads.snapshot()),folderFlag=`${snapshot.folderStatus?.ok?1:0}:${snapshot.folderStatus?.code||''}`,etag=`"${downloads.instanceId}-${snapshot.revision}-${snapshot.jobs.map(j=>j.fileExists?1:0).join('')}-${snapshot.browserAvailable?1:0}-${snapshot.storageError?1:0}-${folderFlag}"`;res.setHeader('ETag',etag);if(req.headers['if-none-match']===etag){res.writeHead(304,{'Cache-Control':'no-store'});return res.end();}return json(res,200,snapshot);}
        if(req.method==='POST'){
          const input=await body(req);
          if(u.pathname==='/api/downloads/tasks'){
            if(req.lanVisitor&&input.folder!==undefined)return json(res,403,{error:'访客不能指定主机下载目录'});
            const ids=['images','media'].includes(input.kind)?(input.models||[]).map(m=>m.platform||'sketchfab'):[input.kind||'sketchfab'];
            // 图站与 3D 平台共用一份开关：关掉图站卡片后解析和整站下载都会被拒。
            if(ids.some(id=>!platforms.enabled(id)))return json(res,403,{error:'下载来源平台已关闭，请在设置中开启'});
            return json(res,200,await downloads.enqueueWithFolder(input));
          }
          if(u.pathname==='/api/downloads/pick-folder')return json(res,200,await downloads.pickFolder(input));
          if(u.pathname==='/api/downloads/browse-folders')return json(res,200,await browseFolders(input));
          if(u.pathname==='/api/downloads/settings')return json(res,200,await downloads.configure(input));
          if(u.pathname==='/api/downloads/blender-bridge/install')return json(res,200,downloads.startBlenderBridgeInstall());
          if(u.pathname==='/api/downloads/actions')return json(res,200,downloads.batch(input.action,input.ids));
          if(u.pathname==='/api/downloads/reveal')return json(res,200,await downloads.reveal());
          if(match?.[2]==='action')return json(res,200,downloads.action(match[1],input.action));
          if(match?.[2]==='reveal')return json(res,200,await downloads.reveal(match[1]));
          if(match?.[2]==='convert-fbx'){if(req.lanVisitor)return json(res,403,{error:'仅主机可以转换 FBX'});return json(res,200,downloads.convertFbx(match[1]));}
          if(match?.[2]==='send-blender')return json(res,200,await downloads.sendBlender(match[1]));
        }
        return json(res,404,{error:'下载接口不存在'});
      }
      if(u.pathname.startsWith('/api/artstation')){
        // 搜索与筛选字段只读 ArtStation 公开数据，不依赖任务注册表，先于下面的守卫处理。
        if(req.method==='GET'&&u.pathname==='/api/artstation/filters')return json(res,200,await artfilters({signal:controller.signal}));
        // 艺术家资料卡：只在进入浏览时取一次，失败不阻塞作品列表（前端按 null 处理）。
        if(req.method==='GET'&&u.pathname==='/api/artstation/artist')return json(res,200,{artist:await artprofile(u.searchParams.get('username'),{signal:controller.signal})});
        if(req.method==='GET'&&u.pathname==='/api/artstation/me')return json(res,200,{artist:await artstationAccount({signal:controller.signal})});
        if(req.method==='GET'&&u.pathname==='/api/artstation/following')return json(res,200,await artstationFollowing(u.searchParams.get('username'),{signal:controller.signal}));
        if(u.pathname==='/api/artstation/search'){
          if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
          if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
          const input=await body(req);
          // body 里带 artist 就是"按艺术家浏览"。复用同一个端点，前端因此只有一个结果流、
          // 一套分页与卡片，不需要为浏览模式再加一条平行的管线。
          // 翻页时 body 里只有 cursor，所以还要从游标的形状再判一次——艺术家的分页地址是
          // /users/<name>/(projects|likes).json，而搜索的是 /api/v2/search/projects.json，
          // 两者不会混（各自的 validate*Cursor 还会把它严格校验回自己的地址）。
          const browsing=!!(input?.artist&&typeof input.artist==='object')
            ||(typeof input?.cursor==='string'&&/^https:\/\/www\.artstation\.com\/users\/[A-Za-z0-9_-]{1,64}\/(?:projects|likes)\.json/.test(input.cursor));
          const payload=browsing
            ?{username:input?.artist?.username,tab:input?.artist?.tab,page:input?.page,cursor:input?.cursor}
            :input;
          return json(res,200,await (browsing?artartist:artsearch)(payload,{signal:controller.signal}));
        }
        // health 顺带报出站层的实际状态：装了没有、用的哪个二进制、指纹顺序是什么。
        // 详情接口被 Cloudflare 拦掉时，这三项就是排查的第一站。
        if(req.method==='GET'&&u.pathname==='/api/artstation/health')return json(res,200,{...await mviewerInfo(),outbound:curlImpersonateInfo()});
        // Conversion jobs are ordinary download tasks (`kind: 'artstation'`), so queueing,
        // persistence, retry, cancel, verification and saving all go through /api/downloads.
        if(req.method!=='POST'||req.headers['x-sfx-local']!=='1')return json(res,405,{error:'方法或请求标识不允许'});
        const input=await body(req);
        if(u.pathname==='/api/artstation/resolve')return json(res,200,await (artstation.resolve||resolveArtstationModel)(input.url,{signal:controller.signal}));
        return json(res,404,{error:'ArtStation 接口不存在'});
      }
      // 平台自检（设置页卡片上的「测试」）：用各平台的真实搜索/解析入口发一次请求，
      // 把「现在到底能不能用」如实返回，省得用户去发现页反复试错。
      // 图站解析必须要具体页面，前端会把卡片上的示例链接一起带上来。
      if(u.pathname==='/api/platforms/test'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const {id:platform,url:target}=await body(req);
        if(!platform)return json(res,400,{error:'缺少平台标识'});
        // 冷启动比别的站慢的几家，给足窗口，别把「能连上」误判成超时：
        // Kenney 目录要翻多页（约 16s）；Pinterest 首次要拉起 pin-grabber（实测 12s+）；
        // 小红书首页要过浏览器通道（实测 13s+）；站酷偶尔要等 WAF。
        const TEST_TIMEOUTS={kenney:32000,pinterest:45000,xiaohongshu:35000,zcool:25000};
        const limit=TEST_TIMEOUTS[platform]||15000;
        const signal=AbortSignal.timeout(limit),started=Date.now();
        // 每个探测都走平台自己的入口，返回什么就先看条目数——连得上但零结果也能区分出「站点在、内容空」。
        const probes={
          sketchfab:()=>search({},{signal}),
          artstation:()=>artsearch({},{signal}),
          polyhaven:()=>polyhaven({},{signal,open}),
          ambientcg:()=>ambientcg({},{signal,open}),
          simready:()=>simready({},{signal,open}),
          polypizza:()=>polypizza({},{signal,open}),
          kenney:()=>kenney({},{signal,open}),
          freestylized:()=>freestylized({},{signal,open}),
          polyfork:()=>polyfork({},{signal,open}),
          uiverse:()=>uiverseSearch({},{signal}),
        };
        try{
          let items=[];
          if(isPictureSite(platform)){
            const site=PICTURE_SITES[platform];
            // 设置面板的「测试」按钮会带 example；直接调 API 时不带 url 就用这张表兜底。
            // 服务端 resolver 不带官网地址，原来会拼出 `https:///`，让 10 个图站一律假失败。
            // 与 src/library/platforms.js 的 PICTURE_SITES.example 保持同步。
            const PROBE_URLS={
              pixiv:'https://www.pixiv.net/artworks/151233234',
              safebooru:'https://safebooru.org/index.php?page=post&s=list&tags=landscape',
              yandere:'https://yande.re/post?tags=touhou',
              konachan:'https://konachan.net/post?tags=landscape',
              wallhaven:'https://wallhaven.cc/search?q=nature',
              civitai:'https://civitai.com/',
              zcool:'https://www.zcool.com.cn/u/ZNjMyMjY0MDg=',
              designspiration:'https://www.designspiration.com/',
              huaban:'https://huaban.com/boards/102664553',
              pinterest:'https://www.pinterest.com/search/pins/?q=nature',
              pexels:'https://www.pexels.com/photo/4161958/',
              flickr:'https://www.flickr.com/photos/nasa/',
              '500px':'https://500px.com/kellan',
              xiaohongshu:'https://www.xiaohongshu.com/explore',
            };
            const url=target||PROBE_URLS[platform]||site.referer||site.home||`https://${(site.host||'')}/`;
            if(!/^https?:\/\/[^\s/]+\.[^\s/]+/.test(url))throw Error('这个平台需要合法的页面地址才能测试');
            const data=await collectPictureAssets(platform,{url},{maxItems:1,signal});
            items=Array.isArray(data.items)?data.items:[];
          }else{
            const probe=probes[platform];
            if(!probe)throw Error('这个平台暂不支持自检');
            const data=await probe();
            items=data?.items||data?.models||data?.results||(Array.isArray(data)?data:[]);
          }
          const first=items[0]||{};
          return json(res,200,{ok:true,ms:Date.now()-started,count:items.length,sample:String(first.title||first.name||first.label||'')});
        }catch(error){
          const timedOut=error?.name==='TimeoutError'||error?.name==='AbortError';
          return json(res,200,{ok:false,ms:Date.now()-started,error:timedOut?`超时 ${Math.round(limit/1000)}s 无响应`:String(error?.message||'连接失败')});
        }
      }
      if(u.pathname==='/api/polyhaven/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        // v3：关键词匹配从「上游查询」（上游根本不认，等于没过滤）改成服务端本地匹配，
        // 旧缓存里存的是未过滤的热门列表，带版本号让历史缓存整体作废。
        // v2：normalize 曾把 hdris 折成 models，旧缓存里的卡片类型全错；带版本号让历史缓存整体作废。
        return cachedJson(res,`polyhaven:v3:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>polyhaven(input,{signal:controller.signal,open}));
      }
      if(req.method==='GET'&&u.pathname==='/api/polyhaven/categories'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const requested=u.searchParams.get('type');
        const type=requested==='textures'||requested==='hdris'?requested:'models';
        return cachedCategories(res,`polyhaven-cats:v2:${type}`,async()=>({categories:await polyhavenCats(type,{signal:controller.signal,open})}));
      }
      if(u.pathname==='/api/simready/preview'){
        if(req.method!=='GET')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        return cachedJson(res,`simready-preview:${u.searchParams.get('id')}`,SEARCH_CACHE_MS,()=>simreadyPreview(u.searchParams.get('id'),{signal:controller.signal,open}));
      }
      if(u.pathname==='/api/simready/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        return cachedJson(res,`simready:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>simready(input,{signal:controller.signal,open}));
      }
      if(u.pathname==='/api/polypizza/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        return cachedJson(res,`polypizza:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>polypizza(input,{signal:controller.signal,open}));
      }
      if(u.pathname==='/api/kenney/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        return cachedJson(res,`kenney:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>kenney(input,{signal:controller.signal,open}));
      }
      if(req.method==='GET'&&u.pathname==='/api/kenney/categories'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        return cachedCategories(res,'kenney-cats:v2',()=>kenneyCats({signal:controller.signal,open}));
      }
      if(u.pathname==='/api/freestylized/search'){
        if(req.method!=='POST'||req.headers['x-sfx-local']!=='1')return json(res,405,{error:'方法或请求标识不允许'});
        const input=await body(req);
        return cachedJson(res,`freestylized:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>freestylized(input,{signal:controller.signal,open}));
      }
      if(req.method==='GET'&&u.pathname==='/api/freestylized/categories'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const type=freestylizedType(u.searchParams.get('type'));
        return cachedCategories(res,`freestylized-cats:v2:${type}`,()=>freestylizedCats(type,{signal:controller.signal,open}));
      }
      // Polyfork：唯一一个走官方 JSON 接口、不需要任何解析的源，搜索即一次 GET 转发。
      if(u.pathname==='/api/polyfork/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        return cachedJson(res,`polyfork:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>polyfork(input,{signal:controller.signal,open}));
      }
      // Civitai 模型：关键词检索与链接解析共用平台设置里的 API key；key 只留在服务端。
      if(u.pathname==='/api/civitai/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(!platforms.enabled('civitai'))return json(res,403,{error:'Civitai 模型平台已关闭，请在设置中开启'});
        const input=await body(req);
        return cachedJson(res,`civitai:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>civitaiSearch(input,{signal:controller.signal,open,apiKey:platforms.civitaiKey()}));
      }
      if(u.pathname==='/api/civitai/resolve'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(!platforms.enabled('civitai'))return json(res,403,{error:'Civitai 模型平台已关闭，请在设置中开启'});
        const input=await body(req);
        try{return json(res,200,await civitaiResolve(input.url,{signal:controller.signal,apiKey:platforms.civitaiKey()}));}
        catch(error){return json(res,400,{error:error.message||'链接解析失败'});}
      }
      if(req.method==='GET'&&u.pathname==='/api/polyfork/categories'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        return cachedCategories(res,'polyfork-cats:v1',()=>polyforkCats({signal:controller.signal}));
      }
      // 参数化预览的两条腿：清单（颜色/几何旋钮分类）与变体（几何改动必须在服务端重建）。
      // 清单按天缓存 —— 它是资产的静态契约，同一天里反复开预览没必要每次回源。
      if(req.method==='GET'&&u.pathname==='/api/polyfork/params'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const id=String(u.searchParams.get('id')||'').trim();
        if(!id)return json(res,400,{error:'缺少资产 ID'});
        return cachedJson(res,`polyfork-params:v1:${id}`,CATEGORY_CACHE_MS,()=>polyforkP(id,{signal:controller.signal,open}));
      }
      // 参数中文名：磁盘有就用磁盘，没有就让模型翻一遍存回去。前端异步要这份字典，
      // 拿到后只替换文字、不重建控件 —— 所以这里慢一点不挡面板打开。
      if(req.method==='GET'&&u.pathname==='/api/polyfork/zh'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const id=String(u.searchParams.get('id')||'').trim();
        if(!id)return json(res,400,{error:'缺少资产 ID'});
        const schema=await polyforkP(id,{signal:controller.signal,open});
        // 资产名给翻译当上下文：风车的 sail 是风帆，不是船帆。
        const name=String(u.searchParams.get('n')||'').slice(0,80);
        return json(res,200,await polyforkZh.get(id,schema,{signal:controller.signal,name}));
      }
      // 变体是二进制，不能走缓存那套 JSON；响应头允许浏览器缓存，同一组参数不会再去烧烘焙额度。
      if(req.method==='GET'&&u.pathname==='/api/polyfork/variant'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const id=String(u.searchParams.get('id')||'').trim();
        if(!id)return json(res,400,{error:'缺少资产 ID'});
        let params={};
        try{params=JSON.parse(u.searchParams.get('p')||'{}');}catch{return json(res,400,{error:'参数不是合法 JSON'});}
        const remote=await polyforkV(id,params,{signal:controller.signal,open});
        res.writeHead(200,{'content-type':'model/gltf-binary','cache-control':'public, max-age=86400'});
        return pipeline(remote.stream,res).catch(()=>{try{res.destroy();}catch{/* 客户端已断开 */}});
      }
      // Polyfork 生成器源码：前端拿回去在浏览器里跑 createAsset()，改参数几毫秒出新几何，
      // 不用再走 -remix.glb（那要 1.5~2 秒，还吃每小时 40 次的烘焙额度）。
      // 拿不到（资产没给源码 / 格式不认识）就报 404，前端自动退回服务端烘焙。
      if(req.method==='GET'&&u.pathname==='/api/polyfork/module'){
        // 这一条不能查 X-SFX-Local：浏览器 import() 无法附加自定义请求头。
        // 内容本身是 Polyfork CDN 上公开的生成器源码，不涉及本机数据，放宽没有风险。
        const id=String(u.searchParams.get('id')||'').trim();
        if(!id)return json(res,400,{error:'缺少资产 ID'});
        try{
          const raw=await polyforkGen(id,{cacheDir:previewCacheDir,signal:controller.signal,open});
          const code=patchGeneratorSource(raw);
          // 页面的 CSP 是 script-src 'self'，blob: 脚本会被拒；所以这里直接把它当同源模块发出去，
          // 前端 import('/api/polyfork/module?id=…') 就能跑，three 由 globalThis 注入共用。
          if(!code)return json(res,415,{error:'生成器依赖不止 three，浏览器里跑不起来'});
          res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});
          return res.end(code);
        }catch(err){
          return json(res,404,{error:err.message||'生成器源码不可用'});
        }
      }
      // FreeStylized 预览：ZIP 里的模型/贴图由服务端解出来，前端按清单逐条取（见 freestylized-preview.mjs）。
      if(req.method==='GET'&&u.pathname==='/api/freestylized/preview'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const slug=u.searchParams.get('slug'),type=freestylizedType(u.searchParams.get('type'));
        const key=`fs-preview:${type}:${slug}`;
        const hit=await httpCache.json(key,PREVIEW_CACHE_MS);
        if(hit)return json(res,200,hit);
        const data=await freestylizedPreview({slug,type},{cacheDir:previewCacheDir,signal:controller.signal,open});
        // 只有成功的清单才缓存：下载失败/网络抖动不该被钉 6 小时。
        if(data.ok)await httpCache.saveJson(key,data).catch(()=>{});
        return json(res,200,data);
      }
      if(req.method==='GET'&&u.pathname==='/api/freestylized/preview-file'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        try{
          const {data,name}=await freestylizedPreviewFile({slug:u.searchParams.get('slug'),type:u.searchParams.get('type'),index:u.searchParams.get('i')},{cacheDir:previewCacheDir});
          return binary(res,200,data,previewMime(name));
        }catch(e){return json(res,404,{error:e.message});}
      }
      if(u.pathname==='/api/ambientcg/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        return cachedJson(res,`ambientcg:v2-types:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>ambientcg(input,{signal:controller.signal,open}));
      }
      // Fab 关键词搜索：走网页端 /i/listings/search（cookie 认证），下载走独立的 /e/ 私有端点。
      if(u.pathname==='/api/fab/search'){
        if(req.method!=='POST')return json(res,405,{error:'方法不允许'});
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        return cachedJson(res,`fab:${JSON.stringify(input)}`,SEARCH_CACHE_MS,()=>fab(input,{signal:controller.signal,open}));
      }
      // Fab 资产详情：GET /i/listings/<uid>，返回描述、媒体图、许可、评分，供卡片预览面板用。
      if(u.pathname==='/api/fab/detail'&&req.method==='GET'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const assetId=String(u.searchParams.get('assetId')||u.searchParams.get('id')||'').trim();
        if(!assetId)return json(res,400,{error:'缺少资产 ID'});
        try{return json(res,200,await fabDetail({assetId},{signal:controller.signal,open}));}
        catch(e){return json(res,400,{error:e.message||'Fab 详情获取失败'});}
      }
      // 旧收藏卡片没有 viewerUrl：前端开预览时按 assetId 现取一次（ArtStation embedUrl 同款懒加载）。
      if(req.method==='GET'&&u.pathname==='/api/substance/status'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        return json(res,200,await substance.status());
      }
        // ---- Fab / Epic OAuth 登录（授权码换 token，与 cookie 登录是不同的链路）----
        if(u.pathname==='/api/fab/accept-eula'&&req.method==='POST'){
          if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
          const pending=pendingEula();
          if(!pending)return json(res,400,{error:'当前没有待接受的 Epic 协议，请重新点一次登录'});
          try{
            // 走到这里说明用户已经在界面上点过「同意」，这里只负责提交 + 把 OAuth 接回去。
            await fabAcceptEula(pending,{open});
            const resumed=await resumeLoginAfterEula();
            return json(res,200,{ok:true,...resumed});
          }catch(e){return json(res,400,{error:e.message||'接受协议失败'});}
        }
        if(u.pathname==='/api/fab/claim'&&req.method==='POST'){
          if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
          const input=await body(req);
          const ids=(Array.isArray(input?.ids)?input.ids:(input?.id?[input.id]:[])).map(x=>String(x||'').trim()).filter(Boolean);
          if(!ids.length)return json(res,400,{error:'缺少要入库的资产 ID'});
          try{
            // 单条时把失败原因原样抛给界面；批量时逐条记账，不因为一条失败中断整批。
            if(ids.length===1){const one=await fabClaim(ids[0],{open});return json(res,200,{total:1,added:1,failed:0,results:[{...one,ok:true}]});}
            const out=await fabClaimMany(ids,{open});
            return json(res,200,out);
          }catch(e){return json(res,400,{error:e.message||'入库失败'});}
        }
        if(u.pathname==='/api/fab/session'&&req.method==='GET'){
          const saved=await fabLoadSession(root);
          if(saved&&saved.refreshToken&&saved.expiresAt){
            const ms=new Date(saved.expiresAt).getTime();
            if(Number.isFinite(ms)&&ms-Date.now()<10*60*1000){
              try{const next=await fabRefresh(saved.refreshToken,{open});await fabSaveSession(root,next);return json(res,200,{loggedIn:true,displayName:next.displayName,accountId:next.accountId});}
              catch{return json(res,200,{loggedIn:false,expired:true,error:'Epic 登录已过期，请重新登录'});}
            }
          }
          return json(res,200,{loggedIn:!!(saved&&saved.accessToken&&saved.accountId),displayName:saved?.displayName||'',accountId:saved?.accountId||''});
        }
        if(u.pathname==='/api/fab/session'&&req.method==='POST'){
          if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
          const input=await body(req);
          const code=String(input?.code||'').trim();
          if(!code)return json(res,400,{error:'缺少 Epic authorizationCode'});
          try{const session=await fabExchangeCode(code,{open});await fabSaveSession(root,session);return json(res,200,{loggedIn:true,displayName:session.displayName,accountId:session.accountId});}
          catch(e){return json(res,400,{error:e.message||'Epic 登录失败'});}
        }
        if(u.pathname==='/api/fab/session'&&req.method==='DELETE'){
          const dir=path.join(resolveDataDir(root).dir,'fab');
          await fs.rm(path.join(dir,'session.json'),{force:true}).catch(()=>{});
          return json(res,200,{loggedIn:false});
        }
        if(req.method==='POST'&&(u.pathname==='/api/substance/open'||u.pathname==='/api/substance/input')){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        const data=u.pathname.endsWith('/open')?await substance.open(input.file):await substance.setInput(input);
        return json(res,200,data);
      }
      if(req.method==='GET'&&u.pathname==='/api/substance/image'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const {data,name}=await substance.readImage(u.searchParams.get('name'));
        return binary(res,200,data,/\.jpe?g$/i.test(name)?'image/jpeg':'image/png');
      }
      if(req.method==='GET'&&u.pathname==='/api/ambientcg/preview'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        return json(res,200,{viewerUrl:await ambientcgPreview(u.searchParams.get('id'),{signal:controller.signal,open})});
      }
      // 材质分类侧栏：官方 facets 按资产数排序，前端只做一次缓存。
      if(req.method==='GET'&&u.pathname==='/api/ambientcg/categories'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const type=u.searchParams.get('type')||'material';
        return cachedCategories(res,`ambientcg-cats:v3:${type}`,async()=>({categories:await ambientcgCats({signal:controller.signal,open,type})}));
      }
      if(['/api/scan','/api/search'].includes(u.pathname)&&req.method==='POST'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        const input=await body(req);
        const route=u.pathname==='/api/search'?search:scan;
        // 键里带策略版本：浏览态刚改成「最新精选」（2026-10-16），老条目里躺的还是那份固定的
        // 历史点赞榜。换键一次绕过，不必等 2 小时过期，也不用用户手动清缓存。
        // （只有 /api/search 会落盘，其他路径 maxAge=0，换键没有任何副作用。）
        return cachedJson(res,`${u.pathname}:v2:${JSON.stringify(input)}`,u.pathname==='/api/search'?SEARCH_CACHE_MS:0,()=>route(input,{signal:controller.signal}));
      }
      if(['/api/proxy','/api/image'].includes(u.pathname)&&req.method==='GET'){
        if(u.pathname==='/api/proxy'&&req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        // 图站整合：各图站 CDN 经 /api/image 代理出图（直接嵌 <img> 会被 Referer / hotlink 策略拦 403）。
        const target=validateUrl(u.searchParams.get('url'));
        const targetHost=target.hostname;
        if(!isSimreadyFileUrl(target)&&!imageHostAllowed(targetHost))throw Error('仅支持 Sketchfab、ArtStation、Poly Haven、ambientCG、Poly Pizza、Kenney、FreeStylized、Polyfork 或各图站（Pixiv / Safebooru / Yande.re / Konachan / Wallhaven / Civitai 等）的图床地址');
        const image=u.pathname==='/api/image';
        // The gallery lays covers out at their own aspect ratio and needs a lighter file than the
        // grid, so a caller may name a rendition. Only whitelisted names are honoured: an unknown
        // one has no bucket object behind it and would fail the request instead of the thumbnail.
        const rendition=image?String(u.searchParams.get('rendition')||''):'';
        const wanted=rendition&&isArtstationHost(targetHost)&&ARTSTATION_COVER_RENDITIONS.includes(rendition)
          ?artstationRenditionUrl(target.href,rendition)?.href||target.href
          :target.href;
        // Covers exist in several renditions and a missing one comes back as 403/404 with an XML
        // body, so try the ladder (the requested URL first) before calling the thumbnail unavailable.
        // full=1：拖拽 / 下载原图专用。缩略图那 8MB 上限对 4K 原图不够用，而原图也不该塞进
        // 缩略图缓存（一张十几 MB，缓存目录会迅速膨胀），所以 full 请求既不读缓存也不写缓存。
        const full=image&&u.searchParams.get('full')==='1';
        const card=image&&!full&&u.searchParams.get('card')==='1';
        // 卡片缩略图 CDN 直出（规则表在 picture-sites.mjs 的 CARD_THUMB_RULES）：
        // 命中规则时让 CDN 直接出小图，省掉整张原图下载（小红书实测 171KB→33KB）。
        // 只作用于回源 URL；缓存 key 仍用原始 wanted（已有缓存不失效），sharp 二次缩放和
        // stale 兜底保留——某子域不支持参数退回原图时仍能缩到 384。
        const cdnCardUrl=card?cardThumbUrl(target.href)||null:null;
        const imageKey=image&&!full?`${wanted}|${rendition}${card?'|card384-v1':''}`:'';
        // ETag：图片响应没有验证器时，浏览器 F5 会把它当成「不确定是否最新」整张重下；
        // 带上 ETag 后同一张图只换一次 304，刷新不再重复传输几 MB 的图片。
        const etag=imageKey?`W/"${createHash('sha1').update(imageKey).digest('hex').slice(0,20)}"`:'';
        // 卡片封面走 ETag 复验，不套一周的 max-age：封面尺寸属于可调的内存预算（512→384），
        // 长缓存会让浏览器一直用旧尺寸的封面，改了等于没改，而且下次调更小的尺寸又会卡住一周。
        // 复验命中的是本地服务，只回一条 304，代价远小于重新下一张图。
        const imageCacheControl=card?'private, max-age=86400':'private, max-age=604800';
        // 远程地址过期 / 限流 / 临时故障时，回退到磁盘缓存里的旧缩略图（忽略 max-age）。
        // 预热过的图集缩略图正是靠这条兜底：地址挂了也至少显示缩略图，而不是整片裂图。
        // full=1（原图）imageKey 为空，不兜底——原图本就不缓存，前端有 thumbUrl 降级钩子切到缩略图。
        const serveStale=async()=>{
          if(!imageKey)return false;
          const stale=await httpCache.image(imageKey,Infinity).catch(()=>null);
          if(!stale)return false;
          res.writeHead(200,{'Content-Type':stale.mime,'Cache-Control':'no-store',...(etag?{ETag:etag}:{})});
          res.end(stale.bytes);return true;
        };
        if(etag&&req.headers['if-none-match']===etag){res.writeHead(304,{'Cache-Control':imageCacheControl,ETag:etag});res.end();return;}
        if(imageKey){
          const cached=await httpCache.image(imageKey,IMAGE_CACHE_MS);
          if(cached){res.writeHead(200,{'Content-Type':cached.mime,'Cache-Control':imageCacheControl,...(etag?{ETag:etag}:{})});res.end(cached.bytes);return;}
        }
        const sourcePlatform=[[(host=>['hf-mirror.com','huggingface.co'].includes(host)),'simready'],[isSketchfabHost,'sketchfab'],[isArtstationHost,'artstation'],[isPolyhavenHost,'polyhaven'],[isAmbientcgHost,'ambientcg'],[isPolypizzaHost,'polypizza'],[isKenneyHost,'kenney'],[isFreestylizedHost,'freestylized'],[isPolyforkHost,'polyfork'],[isFabHost,'fab'],[isPictureCdnHost,'picture']].find(([matches])=>matches(targetHost))?.[1];
        // picture 是图站大类（非模型模块、由各站 routeLink 控制开关），跳过平台 enabled 校验；其余平台照常校验。
        if(sourcePlatform&&sourcePlatform!=='picture'&&!platforms.enabled(sourcePlatform))return json(res,403,{error:'该平台已关闭，请在设置中开启'});
        let remote;
        try{
          remote=await imageRequest(cdnCardUrl||wanted,targetHost,{signal:controller.signal,useLadder:image,fallbackUrl:cdnCardUrl?wanted:null});
        }catch(error){
          // 全部候选都连不上（地址过期 / 下线 / 超时）：有旧缩略图就顶上，否则照常报错。
          if(await serveStale())return;
          throw error;
        }
        let mime=String(remote.headers['content-type']||'').split(';')[0];
        if(image&&!(full?IMAGE_MIMES_FULL:IMAGE_MIMES_BASE).includes(mime)){
          remote.stream.destroy();
          if(await serveStale())return;
          return json(res,502,{error:'缩略图不可用'});
        }
        if(image){
          const chunks=[];let bytes=0;const cap=full?REMOTE_CAP:8*1024*1024;
          for await(const chunk of remote.stream){bytes+=chunk.length;if(bytes>cap)break;chunks.push(chunk);}
          let bodyBytes=Buffer.concat(chunks);
          if(card&&remote.status>=200&&remote.status<300){
            try{const thumbnail=await cardThumbnail(bodyBytes);bodyBytes=thumbnail.bytes;mime=thumbnail.mime;}
            catch{return json(res,502,{error:'无法生成卡片缩略图'});}
          }
          if(imageKey&&remote.status>=200&&remote.status<300)await httpCache.saveImage(imageKey,bodyBytes,mime).catch(()=>{});
          // 只有 2xx 才配长缓存。以前这里不分状态码一律 max-age=604800，一次临时的 404/403
          // 会被浏览器记上一周，图从此一直裂着 —— 站方恢复、服务端修好都不会自己好。
          const okImage=remote.status>=200&&remote.status<300;
          // 站方返回 403/404/567（签名过期、限流）：有旧缩略图就顶上，不让整片图裂掉。
          if(!okImage&&await serveStale())return;
          res.writeHead(remote.status,okImage
            ?{'Content-Type':mime,'Cache-Control':imageCacheControl,...(etag?{ETag:etag}:{})}
            :{'Content-Type':mime,'Cache-Control':'no-store'});
          res.end(bodyBytes);return;
        }
        res.writeHead(remote.status,{'Content-Type':'application/octet-stream'});
        const encoding=String(remote.headers['content-encoding']||'identity');const tracking=!image&&downloads?downloads.networkRequest(req.headers['x-sfx-transfer'],encoding==='identity'?Number(remote.headers['content-length']):null):null;
        let bytes=0;const limit=image?20*1024*1024:512*1024*1024;
        const limiter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;tracking?.chunk(chunk.length);callback(bytes>limit?new Error('远程文件超过大小限制'):null,chunk);}});
        let success=false;try{await pipeline(remote.stream,limiter,res,{signal:controller.signal});success=remote.status>=200&&remote.status<300;}finally{tracking?.finish(success);}return;
      }
      // 图站视频（Civitai 的 mp4 投稿等）：<video> 标签发不了自定义头，所以和 /api/image 一样
      // 走同源代理、不校验 x-sfx-local；必须原样转发 Range，否则播放器既没有时长也没法拖进度。
      if(['/api/video','/api/audio'].includes(u.pathname)&&req.method==='GET'){
        let mediaUrl=u.searchParams.get('url');
        if(u.pathname==='/api/audio'&&!mediaUrl){
          const platform=u.searchParams.get('platform'),source=u.searchParams.get('source');
          if(!isMusicSite(platform)||!platforms.enabled(platform)||!/^https?:\/\//i.test(source||''))throw Error('需要已启用音乐平台的单曲链接');
          const plan=await pictureWindow(platform,source,1,{collect:pictureCollect,open});
          mediaUrl=plan.items?.find(item=>item.type==='audio')?.url;
        }
        const target=validateUrl(mediaUrl);
        if(!isPictureCdnHost(target.hostname))throw Error('只支持已登记平台的媒体地址');
        const remote=await open(target.href,{signal:controller.signal,timeout:60000,headers:{Referer:pictureRefererForHost(target.hostname),...(req.headers.range?{Range:req.headers.range}:{})}});
        const ok=remote.status>=200&&remote.status<300;
        const headers={'Content-Type':String(remote.headers['content-type']||(u.pathname==='/api/audio'?'audio/mpeg':'video/mp4')).split(';')[0],'Accept-Ranges':remote.headers['accept-ranges']||'bytes','Cache-Control':ok?'private, max-age=86400':'no-store'};
        for(const [key,label] of [['content-length','Content-Length'],['content-range','Content-Range'],['etag','ETag'],['last-modified','Last-Modified']]){
          if(remote.headers[key])headers[label]=remote.headers[key];
        }
        res.writeHead(remote.status,headers);
        await pipeline(remote.stream,res,{signal:controller.signal}).catch(()=>{});
        return;
      }
      // Artflow 静态产物：独立的 iframe 应用，用自己的 CSP。
      // 路径前缀剥离后读 ARTFLOW_ROOT 下的文件；目录请求落到 index.html。
      if(req.method==='GET'&&u.pathname.startsWith(ARTFLOW_PREFIX)){
        let rel=decodeURIComponent(u.pathname.slice(ARTFLOW_PREFIX.length));
        if(rel===''||rel.endsWith('/'))rel+='index.html';
        // 防目录穿越：解析后必须仍在产物根目录之内。
        const flowRoot=ARTFLOW_ROOT||path.join(staticRoot,'artflow');
        const abs=path.resolve(flowRoot,rel);
        const rootAbs=path.resolve(flowRoot);
        if(abs!==rootAbs&&!abs.startsWith(rootAbs+path.sep)){json(res,403,{error:'非法路径'});return;}
        try{
          const bytes=await fs.readFile(abs);
          const type=types[path.extname(abs).toLowerCase()]||'application/octet-stream';
          res.setHeader('Content-Security-Policy',ARTFLOW_CSP);
          // 入口文档必须永远拿最新的：chunk 文件名带内容哈希，index.html 缓存住就会
          // 去请求上一版已被清理掉的 chunk → iframe 白屏。带哈希的产物照旧长缓存。
          const cache=rel==='index.html'?'no-store':'private, max-age=3600';
          res.writeHead(200,{'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':cache});
          res.end(bytes);return;
        }catch(e){
          json(res,404,{error:'artflow 产物未构建：请先在 artflow 工程执行 vite build'});
          return;
        }
      }
      if(req.method==='GET'&&assets.has(u.pathname)){
        // The canvas embeds this same-origin viewer; other library pages remain unframable.
        const policy=u.pathname==='/model-preview.html'
          ?CONTENT_SECURITY_POLICY.replace("frame-ancestors 'none'","frame-ancestors 'self'")
          :CONTENT_SECURITY_POLICY;
        res.setHeader('Content-Security-Policy',policy);
        const file=u.pathname==='/'?'/index.html':u.pathname;
        const bytes=await fs.readFile(path.join(staticRoot,file));
        // 代码文件一律「每次校验」：以前这里没写 Cache-Control，WebView2 会按 URL 做
        // 启发式缓存，动态 import 的分块（如 artflow-embed.js）改了刷新也不生效，
        // 还会把新 app.js 和旧分块配在一起跑。index.html 已经带 ?v= 指纹，照样走 no-store。
        const ext=path.extname(file).toLowerCase();
        const cache=ext==='.html'?'no-store':(ext==='.js'||ext==='.css'||ext==='.mjs'?'no-cache':'private, max-age=600');
        res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':cache});
        res.end(bytes);return;
      }
      json(res,404,{error:'不存在的页面或接口'});
    }catch(e){
      if(res.headersSent){res.destroy();return;}
      if(!controller.signal.aborted)json(res,e.status===429?429:400,{error:e.message||'操作失败'});
    }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const port=Number(process.env.SFX_PORT||4179);
  if(Number(process.versions.node.split('.')[0])<22)throw Error('后台下载需要 Node.js 22 或更高版本');
  const {dataDir,downloadDir,archiveRoot,accountsDir}=resolveUserPaths();
  // 下载落到「归档根」= <库名>/图片/…，和分类树一一对应，用户改名磁盘跟着改。
  // 旧 downloads 目录只作为历史扫描根，保证之前下载的卡片不会因为换根而消失。
  const downloads=await new DownloadManager({dataDir,defaultFolder:archiveRoot,legacyRoots:[downloadDir],civitaiKeyProvider:()=>{try{return JSON.parse(fs.readFileSync(path.join(dataDir,'platform-settings.json'),'utf8')).civitaiKey||'';}catch{return '';}}}).init();
  // 用户在「首次准备」里手动指过 blender.exe 的话，趁服务还没开始接活把它接回环境变量。
  applyBlenderOverride();
  const sharing=createLanSharing({file:path.join(downloads.dataDir,'lan-sharing.json')});
  let previousPort=4178;
  try{const saved=JSON.parse(await fs.readFile(path.join(downloads.dataDir,'server-port.json'),'utf8')).port;if(Number.isInteger(saved)&&saved>0&&saved<=65535)previousPort=saved;}catch{}
  sharing.startupPort(previousPort);
  // ADR-12：切库重启。不借外部启动器 —— 用自己的 argv 拉起一个同参数的新进程，
  // 顺序必须是「先放端口、再放 manager.lock、最后 spawn」：两样资源任何一个还占着，
  // 新进程都会 EADDRINUSE 或撞「下载记录目录已由另一个服务使用」然后退出，服务就真没了。
  const restartServer=async()=>{
    try{server.close();server.closeAllConnections();}catch{}
    try{await lanListener.close();}catch{}
    try{await downloads.close();}catch{}
    const log=path.join(downloads.dataDir,'library-server.log');
    const args=process.argv.slice(1).filter(arg=>arg!=='--open');
    let failure=null;
    try{
      const out=openSync(log,'a');
      // 日志写进同一个文件：新进程起不来时用户能在 library-server.log 里看到原因。
      appendFileSync(log,`\n===== 切换资源库后重启 ${new Date().toLocaleString()} =====\n`);
      const child=spawn(process.execPath,args,{cwd:process.cwd(),detached:true,stdio:['ignore',out,out],windowsHide:true,env:{...process.env}});
      child.on('error',error=>{failure=error;});
      child.unref();
      // 与启动器同一条约定：pid 文件写在当前数据目录里，排查时不用靠猜。
      try{writeFileSync(path.join(downloads.dataDir,'library-server.pid'),String(child.pid));}catch{}
    }catch(error){failure=error;}
    if(failure)console.error(`[AssetVault] 重启失败：${failure.message}。请手动重新启动。`);
    setTimeout(()=>process.exit(0),1500);
  };
  // ADR-13：账号文件放在库外面（accountsDir），切库后仍是同一个人，不用重新注册。
  const server=createLibraryServer({downloads,lanSharing:sharing,auth:createAuth({file:path.join(accountsDir,'auth-users.json')}),onRestart:restartServer});
  const lanListener=createLanListener(server,sharing);
  let closing=false;async function shutdown(reason){if(closing)return;closing=true;console.log(`\n  收到 ${reason}，正在关闭服务…`);await lanListener.close();await downloads.close();server.closeAllConnections();server.close(()=>process.exit(0));}
  process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
  // 留痕：服务自己退出会写下这一行；日志里没有这一行却断了，就说明进程是被外部强杀的
  // （控制台被关闭、进程树被回收等），两种情况排查方向完全不同。
  process.on('exit',code=>{try{writeSync(1,`\n  [服务进程退出 code=${code}] ${new Date().toLocaleString()}\n`);}catch{}});
  try{
    const actualPort=await listenPort(server,{port,host:'127.0.0.1',fallback:process.env.SFX_PORT_FALLBACK!=='0',dataDir:downloads.dataDir,reservedPort:sharing.status().sharingPort});
    const url=`http://127.0.0.1:${actualPort}`;downloads.start(url);
    await lanListener.sync();
    if(process.env.SFX_PORT_FALLBACK==='1')console.log(`ASSETVAULT_READY_PORT=${actualPort}`);
    console.log(`\n  ASSETVAULT · 本地 3D 模型库\n  ${url}\n  局域网共享默认关闭，可在设置中开启。关闭此窗口将停止服务。\n`);
    // 打开的是启动画面而不是工作台：这个页面由本服务自己提供，跳转时端口一定在监听，
    // 不会出现「跳到打不开的地址」那种情况。
    if(process.argv.includes('--open')&&process.platform==='win32')execFile('cmd.exe',['/c','start','',`${url}/splash.html`],{windowsHide:true});
  }catch(error){await lanListener.close();await downloads.close();server.closeAllConnections();if(server.listening)server.close();console.error(error.code==='EADDRINUSE'?`端口 ${port} 已占用，请设置 SFX_PORT 使用其他端口。`:error);process.exitCode=1;}
}
