import http from 'node:http';
import {createLibraryStorage} from './library-storage.mjs';
import fs from 'node:fs/promises';
import {createReadStream,writeSync} from 'node:fs';
import {DownloadManager} from './downloads.mjs';
import {browseFolders} from './folder-dialog.mjs';
import {listLocalFolder,resolveLocalFile,localMime,parseRange} from './local-browse.mjs';
import {scanLibraryPackages} from './local-assets.mjs';
import {registerPackage,patchPackageMeta} from './asset-meta.mjs';
import {findFfmpeg,probeMedia,transcodePlan,streamMp4} from './video-transcode.mjs';
import {thumbFor} from './thumb-cache.mjs';
import {streamFolderZip} from './zip-stream.mjs';
import {createLanSharing} from './lan-sharing.mjs';
import {packFolderDownload} from './folder-archive.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { scanPage, searchPage } from './catalog.mjs';
import { resolveArtstationModel, mviewerInfo } from './artstation.mjs';
import { artstationSearch, artstationFilterOptions } from './artstation-search.mjs';
import { artstationArtist, artstationArtistProfile } from './artstation-artist.mjs';
import {polyhavenSearch,polyhavenCategories} from './polyhaven.mjs';
import {polypizzaSearch} from './polypizza.mjs';
import {kenneySearch,kenneyCategories} from './kenney.mjs';
import {freestylizedSearch,freestylizedCategories,freestylizedType} from './freestylized.mjs';
import {freestylizedPreview,freestylizedPreviewFile} from './freestylized-preview.mjs';
import {createSubstanceBridge} from './substance-engine.mjs';
import {ambientcgSearch,ambientcgViewer,ambientcgCategories} from './ambientcg.mjs';
import { curlImpersonateInfo } from './curl-impersonate.mjs';
import {browserStatus,startBrowserInstallJob,browserInstallJob} from './browser-runtime.mjs';
import {dependencyReport,updateSetup,setBlenderPath,applyBlenderOverride} from './setup.mjs';
import { coverLadder, artstationRenditionUrl, ARTSTATION_COVER_RENDITIONS } from './artstation-cdn.mjs';
import { openPublic, validateUrl, isSketchfabHost, isArtstationHost } from './public-http.mjs';

// 客户端中途关页面/断开时，在途的代理请求会以「任务已取消」被拒绝（public-http.mjs 的
// AbortSignal 路径）。这条拒绝若没人接住，Node 会把整个服务带崩 —— 实测无头探针一断连就退出。
// 记录日志并保持运行：请求方都已经走了，崩溃没有意义。
process.on('unhandledRejection',err=>{console.error('[未处理的请求拒绝，服务保持运行]',err?.message||err);});
import { createResponseCache } from './response-cache.mjs';
import { resolveDataDir } from './data-dir.mjs';
import { SERVER_CAPABILITIES, SERVER_VERSION } from './capabilities.mjs';
import {createAIService} from './ai.mjs';
const isPolyhavenHost=host=>/(?:^|\.)polyhaven\.(?:com|org)$/i.test(host);
const isPolypizzaHost=host=>/(?:^|\.)poly\.pizza$/i.test(host);
const isKenneyHost=host=>/(?:^|\.)kenney\.nl$/i.test(host);
const isFreestylizedHost=host=>/(?:^|\.)freestylized\.com$/i.test(host);
// ambientCG 的缩略图在自家媒体域（acg-media.struffelproductions.com），代理白名单一并放行。
const isAmbientcgHost=host=>/(?:^|\.)ambientcg\.com$/i.test(host)||/(?:^|\.)struffelproductions\.com$/i.test(host);
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
const SEARCH_CACHE_MS=2*60*60*1000;
const CATEGORY_CACHE_MS=24*60*60*1000;
const PREVIEW_CACHE_MS=6*60*60*1000;
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
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
// Only these hosts may be framed by the workbench, one line per model platform. Adding a platform
// means adding its interactive-viewer host here — the CSP string is derived, never hand-edited.
// ArtStation's own embed page sits on `artstation.com` and redirects between the apex and `www`,
// so both spellings (and the CDN subdomains) must be allowed or the preview is blocked outright.
// releases.pbr.one is ambientCG's official embeddable PBR material viewer — the same one their
// asset pages embed; the texture URLs ride in the URL fragment, so nothing else to allow.
const FRAME_HOSTS=['https://sketchfab.com','https://*.artstation.com','https://artstation.com','https://releases.pbr.one'];
const CONTENT_SECURITY_POLICY=`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: data:; frame-src 'self' ${FRAME_HOSTS.join(' ')}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
const assets=new Set(['/','/index.html','/app.js','/app.css','/engine.js','/favicon.svg','/worker.html','/splash.html','/splash.js','/mascot.png']);
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
/** 预览条目是解出来的原始字节（FBX / PNG / HDR），不是 JSON，也不该每次回源。 */
function binary(res,status,data,type){res.writeHead(status,{'Content-Type':type,'Content-Length':data.length,'Cache-Control':'private, max-age=3600'});res.end(data);}
const PREVIEW_MIMES={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.hdr':'image/vnd.radiance','.exr':'image/x-exr','.gltf':'model/gltf+json','.glb':'model/gltf-binary','.fbx':'model/fbx','.obj':'model/obj','.mtl':'text/plain; charset=utf-8','.stl':'model/stl','.ply':'model/ply','.3mf':'model/3mf'};
const previewMime=name=>PREVIEW_MIMES[path.extname(String(name||'')).toLowerCase()]||'application/octet-stream';
/** 本地文件流只认「这个进程里真的被索引过」的根目录。
 *  <img>/<video>/<iframe> 直接请求这个地址，带不了自定义头，所以不能靠 x-sfx-local 鉴权；
 *  改成白名单：没在前端点过「索引这个文件夹」，就别想读到这台机器上的任意路径。 */
const localRoots=new Set();
const allowLocalRoot=folder=>{if(folder)localRoots.add(path.resolve(folder));};
const isLocalRootAllowed=folder=>{try{return localRoots.has(path.resolve(String(folder||'')));}catch{return false;}};
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
/** Ask for each candidate in order and keep the first response that is not a failure. When every
 *  candidate fails the last attempt is handed back, so the caller still reports the real status. */
async function firstAvailable(candidates,request){
  if(!candidates.length)throw Error('缺少可用的图片地址');
  let remote;
  for(const [index,candidate] of candidates.entries()){
    remote=await request(candidate);
    if(remote.status<400||index===candidates.length-1)return remote;
    try{remote.stream.destroy();}catch{}
  }
}
export function createLibraryServer({scan=scanPage,search=searchPage,open=openPublic,staticRoot=process.env.SFX_STATIC_ROOT||path.join(root,'dist/library'),downloads=null,artstation={},artsearch=artstationSearch,artfilters=artstationFilterOptions,artartist=artstationArtist,artprofile=artstationArtistProfile,polyhaven=polyhavenSearch,polyhavenCats=polyhavenCategories,polypizza=polypizzaSearch,kenney=kenneySearch,kenneyCats=kenneyCategories,freestylized=freestylizedSearch,freestylizedCats=freestylizedCategories,ambientcg=ambientcgSearch,ambientcgPreview=ambientcgViewer,ambientcgCats=ambientcgCategories,cacheDir=null}={}) {
  // cacheDir：把响应缓存指到别处（测试与脚本传临时目录），免得夹具写进应用数据目录的真缓存。
  // 一个进程同时只会跑一个服务端实例，所以这里直接换掉模块级那一份。
  if(cacheDir)httpCache=createResponseCache(cacheDir);
  const ai=createAIService({file:path.join(resolveDataDir(root).dir,'ai-settings.json')});
  const substance=createSubstanceBridge();
  const libraryStorage=createLibraryStorage(downloads?.dataDir||resolveDataDir(root).dir,downloads);
  const lan=createLanSharing({file:path.join(downloads?.dataDir||resolveDataDir(root).dir,'lan-sharing.json')});
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    const controller=new AbortController();req.on('aborted',()=>controller.abort());res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try {
      if(await lan.handle(req,res))return;
      const u=new URL(req.url,`http://${req.headers.host}`);
      if(u.pathname==='/api/library-state'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(req.method==='GET')return json(res,200,await libraryStorage.load());
        if(req.method==='POST'){
          let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>12*1024*1024)throw Error('资产库状态过大');}
          await libraryStorage.save(JSON.parse(text));return json(res,200,{saved:true});
        }
      }
      if(u.pathname==='/api/health'&&req.method==='GET')return json(res,200,{name:'assetvault-local-library',version:SERVER_VERSION,mode:'local',engine:'existing-exporter'});
      if(u.pathname.startsWith('/api/ai/')){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(req.method==='GET'&&u.pathname==='/api/ai/settings')return json(res,200,await ai.settings());
        if(req.method==='POST'){
          const input=await body(req);
          if(u.pathname==='/api/ai/key'){res.setHeader('Cache-Control','no-store');return json(res,200,await ai.key());}
          if(u.pathname==='/api/ai/settings')return json(res,200,await ai.configure(input));
          if(u.pathname==='/api/ai/models')return json(res,200,await ai.models(input,controller.signal));
          if(u.pathname==='/api/ai/test')return json(res,200,await ai.test(controller.signal));
          // expand=true 走合并调用：一次 LLM 推理同时返回英文翻译和扩展词，
          // 中文搜索不再串行等两次推理（旧 /expand 端点保留，行为不变）。
          if(u.pathname==='/api/ai/translate')return json(res,200,input.expand===true?await ai.translateSearch(input.query):await ai.translate(input.query));
          if(u.pathname==='/api/ai/expand')return json(res,200,await ai.expand(input.query));
          if(u.pathname==='/api/ai/parse-local')return json(res,200,await ai.parseLocal(input.query));
          if(u.pathname==='/api/ai/brainstorm')return json(res,200,await ai.brainstorm(input.query));
          if(u.pathname==='/api/ai/tags')return json(res,200,await ai.tagAssets(input));
        }
        return json(res,404,{error:'AI 接口不存在'});
      }
      // 浏览器运行时：chrome-headless-shell 不再随安装包分发（236MB，占安装包九成体积），
      // 改成首次用到时按需下载。三条接口 —— 读状态 / 起下载 / 轮询进度，守卫与下载队列同级。
      if(u.pathname.startsWith('/api/browser')){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        if(req.method==='GET'&&u.pathname==='/api/browser')return json(res,200,browserStatus());
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
      // 资产库自己的目录里有什么，就是资产库里有什么：这些根是后台服务自己的下载目录与
      // 各任务的下载根，不是用户随手传进来的路径，所以不需要「本地请求标识」；取文件那条
      // 仍然只认扫描时登记过的根，别的路径一律 403。
      if(u.pathname==='/api/library/scan'){
        if(req.method!=='POST')return json(res,405,{error:'只支持 POST'});
        if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
        const roots=[...new Set([downloads.defaultFolder,...downloads.jobs.map(job=>job.downloadRoot)].filter(Boolean))];
        // 已经登记成下载任务的条目有自己的卡片，这里只补「资产库原本看不见的那部分」。
        const claimed=downloads.jobs.map(job=>job.filePath).filter(Boolean).map(file=>path.resolve(file));
        // 以包为单位扫描：目录里有 info.json 就算一个资产，整棵子树归它，不再逐文件出卡片。
        const scanned=await scanLibraryPackages({roots});
        for(const root of roots)allowLocalRoot(root);
        const files=scanned.files.filter(file=>{
          // 只收素材：readme、日志、脚本、LICENSE 这些是目录里的附带文件，不是资产。
          if(file.kind==='other'||file.kind==='document')return false;
          const absolute=path.resolve(file.root,file.rel);
          return !claimed.some(entry=>absolute===entry||absolute.startsWith(entry+path.sep));
        });
        return json(res,200,{roots,packages:scanned.packages,files,truncated:scanned.truncated});
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
          return json(res,200,{ok:true,skipped:result.skipped,uid:result.uid,meta:result.meta});
        }catch(error){
          const code=String(error?.code||'');
          const message=/EACCES|EPERM/.test(code)?'这个文件夹没有写入权限（只读或被占用），info.json 写不进去'
           :/ENOSPC/.test(code)?'磁盘空间不足，info.json 写不进去'
           :`登记失败：${error.message}`;
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
      if(u.pathname==='/api/local/file'&&req.method==='GET'){
        const root=u.searchParams.get('root');
        if(!isLocalRootAllowed(root))return json(res,403,{error:'请先索引这个文件夹，再预览里面的文件'});
        let target=null;
        try{target=resolveLocalFile({root,rel:u.searchParams.get('rel')});}
        catch(e){return json(res,400,{error:e.message});}
        return streamLocalFile(req,res,target);
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
        const width=Math.min(2048,Math.max(64,Number(u.searchParams.get('w'))||512));
        try{
          const out=await thumbFor(target.file,{width});
          res.writeHead(200,{'Content-Type':'image/png','Content-Length':out.buffer.length,'Cache-Control':'private,max-age=604800'});
          return res.end(out.buffer);
        }catch(error){
          // PSD 生成不了就是生成不了，直接说清楚，退回原文件只会得到一张破图；
          // 其它格式（SVG / 没装 ffmpeg 的 jpg）退回原文件，缩略图位置上显示原图，功能不断。
          if(/\.psd$/i.test(target.file))return json(res,415,{error:`缩略图生成失败：${error.message}`});
          return streamLocalFile(req,res,target);
        }
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
      // 桥接插件本体：主机装过的那份只对主机的 Blender 生效，局域网访客要装到自己电脑上，
      // 所以这份文件得能被访客下载（登录态由 lan-sharing 把关，这里只管发文件）。
      if(u.pathname==='/api/lan/blender-addon'&&req.method==='GET'){
        const bytes=await fs.readFile(path.join(root,'server/blender-bridge.py'));
        res.writeHead(200,{'Content-Type':'text/x-python; charset=utf-8','Content-Length':bytes.length,'Content-Disposition':'attachment; filename="assetvault_blender_bridge.py"','Cache-Control':'no-store'});
        res.end(bytes);return;
      }
      if(u.pathname.startsWith('/api/downloads')){
        if(!downloads)return json(res,503,{error:'后台下载服务未启动'});
        const match=u.pathname.match(/^\/api\/downloads\/tasks\/([a-f0-9-]{36})\/(action|file|reveal|send-blender)$/);
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
        if(req.method==='GET'&&u.pathname==='/api/downloads'){const snapshot=downloads.snapshot(),folderFlag=`${snapshot.folderStatus?.ok?1:0}:${snapshot.folderStatus?.code||''}`,etag=`"${downloads.instanceId}-${snapshot.revision}-${snapshot.jobs.map(j=>j.fileExists?1:0).join('')}-${snapshot.browserAvailable?1:0}-${snapshot.storageError?1:0}-${folderFlag}"`;res.setHeader('ETag',etag);if(req.headers['if-none-match']===etag){res.writeHead(304,{'Cache-Control':'no-store'});return res.end();}return json(res,200,snapshot);}
        if(req.method==='POST'){
          const input=await body(req);
          if(u.pathname==='/api/downloads/tasks'){
            if(req.lanVisitor&&input.folder!==undefined)return json(res,403,{error:'访客不能指定主机下载目录'});
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
          if(match?.[2]==='send-blender')return json(res,200,await downloads.sendBlender(match[1]));
        }
        return json(res,404,{error:'下载接口不存在'});
      }
      if(u.pathname.startsWith('/api/artstation')){
        // 搜索与筛选字段只读 ArtStation 公开数据，不依赖任务注册表，先于下面的守卫处理。
        if(req.method==='GET'&&u.pathname==='/api/artstation/filters')return json(res,200,await artfilters({signal:controller.signal}));
        // 艺术家资料卡：只在进入浏览时取一次，失败不阻塞作品列表（前端按 null 处理）。
        if(req.method==='GET'&&u.pathname==='/api/artstation/artist')return json(res,200,{artist:await artprofile(u.searchParams.get('username'),{signal:controller.signal})});
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
      // 旧收藏卡片没有 viewerUrl：前端开预览时按 assetId 现取一次（ArtStation embedUrl 同款懒加载）。
      if(req.method==='GET'&&u.pathname==='/api/substance/status'){
        if(req.headers['x-sfx-local']!=='1')return json(res,403,{error:'缺少本地请求标识'});
        return json(res,200,await substance.status());
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
        const target=validateUrl(u.searchParams.get('url'));
        const targetHost=target.hostname;
        if(!isSketchfabHost(targetHost)&&!isArtstationHost(targetHost)&&!isPolyhavenHost(targetHost)&&!isAmbientcgHost(targetHost)&&!isPolypizzaHost(targetHost)&&!isKenneyHost(targetHost)&&!isFreestylizedHost(targetHost))throw Error('仅支持 Sketchfab、ArtStation、Poly Haven、ambientCG、Poly Pizza、Kenney 或 FreeStylized 的图床地址');
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
        const imageKey=image?`${wanted}|${rendition}`:'';
        if(image){
          const cached=await httpCache.image(imageKey,IMAGE_CACHE_MS);
          if(cached){res.writeHead(200,{'Content-Type':cached.mime,'Cache-Control':'private, max-age=604800'});res.end(cached.bytes);return;}
        }
        const remote=await firstAvailable(image?coverLadder(wanted):[target.href],
          candidate=>open(candidate,{artstation:isArtstationHost(targetHost),signal:controller.signal,timeout:45000}));
        const mime=String(remote.headers['content-type']||'').split(';')[0];
        if(image&&!['image/png','image/jpeg','image/webp','image/gif','image/avif'].includes(mime)){remote.stream.destroy();return json(res,502,{error:'缩略图不可用'});}
        if(image){
          const chunks=[];let bytes=0;
          for await(const chunk of remote.stream){bytes+=chunk.length;if(bytes>8*1024*1024)break;chunks.push(chunk);}
          const bodyBytes=Buffer.concat(chunks);
          if(remote.status>=200&&remote.status<300)await httpCache.saveImage(imageKey,bodyBytes,mime).catch(()=>{});
          res.writeHead(remote.status,{'Content-Type':mime,'Cache-Control':'private, max-age=604800'});
          res.end(bodyBytes);return;
        }
        res.writeHead(remote.status,{'Content-Type':'application/octet-stream'});
        const encoding=String(remote.headers['content-encoding']||'identity');const tracking=!image&&downloads?downloads.networkRequest(req.headers['x-sfx-transfer'],encoding==='identity'?Number(remote.headers['content-length']):null):null;
        let bytes=0;const limit=image?20*1024*1024:512*1024*1024;
        const limiter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;tracking?.chunk(chunk.length);callback(bytes>limit?new Error('远程文件超过大小限制'):null,chunk);}});
        let success=false;try{await pipeline(remote.stream,limiter,res,{signal:controller.signal});success=remote.status>=200&&remote.status<300;}finally{tracking?.finish(success);}return;
      }
      if(req.method==='GET'&&assets.has(u.pathname)){
        res.setHeader('Content-Security-Policy',CONTENT_SECURITY_POLICY);
        const file=u.pathname==='/'?'/index.html':u.pathname;
        const bytes=await fs.readFile(path.join(staticRoot,file));res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(bytes);return;
      }
      json(res,404,{error:'不存在的页面或接口'});
    }catch(e){
      if(res.headersSent){res.destroy();return;}
      if(!controller.signal.aborted)json(res,e.status===429?429:400,{error:e.message||'操作失败'});
    }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const port=Number(process.env.SFX_PORT||4178);
  if(Number(process.versions.node.split('.')[0])<22)throw Error('后台下载需要 Node.js 22 或更高版本');
  const {dir:dataDir,migrated}=resolveDataDir(root);
  if(migrated)console.log(`  已把旧的 .sketchvault 数据目录迁移为 .assetvault\n`);
  const downloads=await new DownloadManager({dataDir:process.env.SFX_DATA_DIR||dataDir,defaultFolder:process.env.SFX_DOWNLOAD_DIR||path.join(root,'downloads')}).init();
  // 用户在「首次准备」里手动指过 blender.exe 的话，趁服务还没开始接活把它接回环境变量。
  applyBlenderOverride();
  const server=createLibraryServer({downloads});server.on('error',async error=>{await downloads.close();console.error(error.code==='EADDRINUSE'?`端口 ${port} 已占用。可打开已有工作台，或设置 SFX_PORT 使用其他端口。`:error);process.exitCode=1;});
  let closing=false;async function shutdown(reason){if(closing)return;closing=true;console.log(`\n  收到 ${reason}，正在关闭服务…`);await downloads.close();server.closeAllConnections();server.close(()=>process.exit(0));}
  process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
  // 留痕：服务自己退出会写下这一行；日志里没有这一行却断了，就说明进程是被外部强杀的
  // （控制台被关闭、进程树被回收等），两种情况排查方向完全不同。
  process.on('exit',code=>{try{writeSync(1,`\n  [服务进程退出 code=${code}] ${new Date().toLocaleString()}\n`);}catch{}});
  server.listen(port,'0.0.0.0',()=>{
    const url=`http://127.0.0.1:${port}`;downloads.start(url);console.log(`\n  ASSETVAULT · 本地 3D 模型库\n  ${url}\n  局域网共享默认关闭，可在设置中开启。关闭此窗口将停止服务。\n`);
    // 打开的是启动画面而不是工作台：这个页面由本服务自己提供，跳转时端口一定在监听，
    // 不会出现「跳到打不开的地址」那种情况。
    if(process.argv.includes('--open')&&process.platform==='win32')execFile('cmd.exe',['/c','start','',`${url}/splash.html`],{windowsHide:true});
  });
}
