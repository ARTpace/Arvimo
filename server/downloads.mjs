import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {processIdentity,lockOwnerAlive,replaceLibraryOwner} from './process-lock.mjs';
import {runExportWorker,browserPath} from './export-worker.mjs';
import {runArtstationWorker} from './artstation-worker.mjs';
import {runPolyhavenJob} from './polyhaven.mjs';
import {runPolypizzaJob} from './polypizza.mjs';
import {runKenneyJob} from './kenney.mjs';
import {runFreestylizedJob} from './freestylized.mjs';
import {runPolyforkJob} from './polyfork.mjs';
import {runAmbientcgJob} from './ambientcg.mjs';
import {runImageJob} from './image-bundle.mjs';
import {isPictureSite} from './picture-sites.mjs';
import {inspectFolder,nativeFolderPicker} from './folder-dialog.mjs';
import {commitFolder,commitArchive,reserveFolder} from './local-commit.mjs';
import {assetStorageCategory,storageRoot} from './asset-storage.mjs';
import {canonicalPath,recoverDownloads,recoveredOptionsMatch} from './download-recovery.mjs';
import {TransferProgress} from './transfer-progress.mjs';
import {verifyArchive} from './archive.mjs';
import {verifyFolder,packFolder,findStagedGlb} from './folder-archive.mjs';
import {convertGlbToFbx} from './fbx.mjs';
import {blenderPath} from './blender.mjs';
import {launchBlenderImport,launchBlenderMaterialImport,launchBlenderHdriImport,blenderBridgeStatus,probeBridge,startBridgeInstallJob,bridgeInstallJob} from './blender-import.mjs';
export const ACTIVE=new Set(['running','transferring','validating','saving','cancelling']);
export const WAITING=new Set(['queued','held','retry_wait']);
const terminal=new Set(['saved','failed','cancelled','interrupted']);
const isFile=p=>{try{return fs.statSync(p).isFile();}catch{return false;}};
const isDir=p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}};
/** A saved job is a file (ZIP) or a directory (folder output); both count as present. */
const exists=p=>isFile(p)||isDir(p);
const uidPattern=/^[a-f0-9]{32}$/;
/** Both platforms feed one queue; the kind only decides which runner converts the model.
 *  `images` is the picture-only counterpart: no mesh, no FBX, no Blender — just the asset's pictures. */
export const JOB_KINDS=new Set(['sketchfab','artstation','images','polyhaven','ambientcg','polypizza','kenney','freestylized','polyfork']);
export const ARTSTATION_BATCH=20;
/** Pictures are small, so a picture batch may be as wide as a model batch; the ceiling is about
 *  keeping one request understandable, not about payload size. */
export const IMAGE_BATCH=50;
/** 图站（花瓣/Booru/站酷…）的「整站图片」是另一种量级：单个 3D 资产最多几十张图，
 *  而一个画板常有上千张。所以图站任务单独给上限，既不挤占 3D 资产的 60 张默认值，
 *  也不会在第一页就停下（画板页说好的「下载会抓取整站全部图片」得能兑现）。 */
export const PICTURE_SITE_IMAGE_MAX=2000;
export const PICTURE_SITE_IMAGE_BYTES=4*1024*1024*1024;
const ARTSTATION_URL=/^https:\/\/www\.artstation\.com\/artwork\/[A-Za-z0-9]{4,20}$/;
export const PACK_MODES=new Set(['model','glb','full']);
export const OUTPUT_MODES=new Set(['zip','folder']);
export const MODEL_FORMATS=new Set(['glb','fbx']);
/**
 * One place decides what a download contains: which files (packMode), how they are delivered
 * (output), and how big the textures stay (maxTextureEdge, 0 = original pixels). Textures,
 * PNG conversion and fast write are fixed on; unknown values fall back to folder + GLB/FBX.
 */
export function exportOptions(o={}){
 return {
  // "model" keeps the model and its textures only — Sketchfab's raw osgjs scene and the
  // duplicate external gltf/bin pair are skipped, which is what most imports actually need.
  packMode:PACK_MODES.has(o.packMode)?o.packMode:'model',
  // Original pixels by default: downscaling is a deliberate choice, never a silent one.
  maxTextureEdge:[0,2048,4096].includes(o.maxTextureEdge)?o.maxTextureEdge:0,
  downloadTextures:true,
  pngOnly:true,
  fastZip:true,
  output:OUTPUT_MODES.has(o.output)?o.output:'folder',
  format:MODEL_FORMATS.has(o.format)?o.format:'fbx',
  devMode:false,
 };
}
/**
 * Picture jobs get their own (much smaller) option set. Keeping the two sets disjoint means the
 * dedupe key — which compares `options` — can never mistake "these pictures of asset X" for "the
 * model export of asset X", so one asset can legitimately hold both jobs at once.
 */
export const IMAGE_OUTPUTS=new Set(['folder','zip']);
/** Which rendition to ask a source for. Only the largest one exists today; the seam is here so a
 *  lighter "preview pack" stays a configuration change rather than a rewrite. */
export const IMAGE_RENDITIONS=new Set(['max']);
export function imageOptions(o={}){
  return {output:IMAGE_OUTPUTS.has(o.output)?o.output:'folder',imageRendition:IMAGE_RENDITIONS.has(o.imageRendition)?o.imageRendition:'max'};
}
/** Material jobs (ambientCG) carry their own tiny option set: which ZIP tier to fetch and how the
 *  bundle is delivered. Keeping it disjoint from exportOptions means the dedupe key can never
 *  mistake "the 2K material of asset X" for "the model export of asset X". */
export const MATERIAL_RESOLUTIONS=new Set(['1K','2K','4K','8K']);
export const MATERIAL_FORMATS=new Set(['JPG','PNG','SBSAR']);
export function materialOptions(o={}){
  return {
    output:OUTPUT_MODES.has(o.output)?o.output:'folder',
    resolution:MATERIAL_RESOLUTIONS.has(o.resolution)?o.resolution:'2K',
    textureFormat:MATERIAL_FORMATS.has(o.textureFormat)?o.textureFormat:'JPG',
  };
}
export function modelSnapshot(m,kind){
 if(!uidPattern.test(m?.uid))throw Error('模型 ID 无效');
 const common={uid:m.uid,name:String(m.name||m.uid).slice(0,240),author:String(m.author||'未知作者').slice(0,100),license:String(m.license||'许可请查看原页面').slice(0,200),thumbnail:typeof m.thumbnail==='string'&&m.thumbnail.startsWith('https://')?m.thumbnail.slice(0,2048):null};
 // A picture job keeps the asset's platform *alongside* its kind: the queue reads `kind` to pick a
 // runner, and the runner then reads `platform` to decide where the pictures live. Persisting both
 // means a restored queue re-dispatches to exactly the same source it was created with.
 if(kind==='images'){
  // Poly Haven 没有公开的"图片 API"——官方渲染图由 renders 接口给出、存在自家 CDN，把它拐去
  // Sketchfab 拿图必 404。这里单独分出来，平台和资产 ID 一起持久化，恢复队列时也能正确重派。
   if(m.platform==='polyhaven'){
    if(!m.assetId)throw Error('Poly Haven 资产 ID 缺失');
    return {...common,kind:'images',platform:'polyhaven',url:String(m.url||`https://polyhaven.com/a/${m.assetId}`),downloadable:false,assetId:String(m.assetId).slice(0,120)};
   }
   // ambientCG 的缩略图走自家 API，同样不能被拐去 Sketchfab 拿图。
   if(m.platform==='ambientcg'){
    if(!m.assetId)throw Error('ambientCG 资产 ID 缺失');
    return {...common,kind:'images',platform:'ambientcg',url:String(m.url||`https://ambientcg.com/a/${m.assetId}`),downloadable:false,assetId:String(m.assetId).slice(0,120)};
   }
  // 图站（素材下载器整合）：把整站 URL 作为一个图片任务，平台与链接一起持久化，恢复队列时
  // 能正确重派到图站抓取，而不是被拐去 Sketchfab 拿图（否则 url 会被写成 sketchfab 假地址）。
  if(m.platform&&isPictureSite(m.platform)){
    if(!m.url)throw Error('图站链接缺失');
    return {...common,kind:'images',platform:String(m.platform).slice(0,40),url:String(m.url).slice(0,2048),downloadable:false};
  }
  const artwork=String(m.artworkUrl||m.url||'').replace(/\/$/,'');
  const art=m.platform==='artstation'||ARTSTATION_URL.test(artwork);
  if(art&&!ARTSTATION_URL.test(artwork))throw Error('ArtStation 作品地址无效');
  return {...common,kind:'images',platform:art?'artstation':'sketchfab',url:art?artwork:`https://sketchfab.com/models/${m.uid}`,downloadable:false,artId:art?String(m.artId||'').slice(0,20):''};
 }
 // ArtStation hits share the 32-hex uid shape, so persistence, dedupe and the task list stay one path.
 if(kind==='artstation'){
  const artwork=String(m.artworkUrl||m.url||'').replace(/\/$/,'');
  if(!ARTSTATION_URL.test(artwork))throw Error('ArtStation 作品地址无效');
  return {...common,kind:'artstation',downloadable:false,url:artwork,artId:String(m.artId||'').slice(0,20),
  // 有内嵌 Marmoset 场景的作品转 GLB/FBX；没有场景的只能把作品图片存下来。这个标记决定 worker
  // 走哪条 runner，所以必须随任务一起持久化——恢复队列时不能靠再问一次网络。
  hasMarmoset:m.hasMarmoset!==false};
 }
 if(kind==='polyhaven'){
  if(!m.assetId)throw Error('Poly Haven 资产 ID 缺失');
  return {...common,kind:'polyhaven',platform:'polyhaven',downloadable:true,url:String(m.url||`https://polyhaven.com/a/${m.assetId}`),assetId:String(m.assetId).slice(0,120),assetType:m.assetType==='textures'?'textures':m.assetType==='hdris'?'hdris':'models'};
 }
 if(kind==='polypizza'){
  if(!m.assetId)throw Error('Poly Pizza 资产 ID 缺失');
  return {...common,kind:'polypizza',platform:'polypizza',downloadable:true,url:String(m.url||`https://poly.pizza/m/${m.assetId}`),assetId:String(m.assetId).slice(0,80)};
 }
 if(kind==='kenney'){
  if(!m.assetId)throw Error('Kenney 资源包 ID 缺失');
  return {...common,kind:'kenney',platform:'kenney',downloadable:true,url:String(m.url||`https://kenney.nl/assets/${m.assetId}`),assetId:String(m.assetId).slice(0,80),assetType:'pack'}; }
 if(kind==='freestylized'){
  if(!m.assetId)throw Error('FreeStylized 资产 ID 缺失');
  const assetType=['skybox','textures','packs','alphas','smart'].includes(m.assetType)?m.assetType:'models';
  return {...common,kind:'freestylized',platform:'freestylized',downloadable:true,url:String(m.url||''),assetId:String(m.assetId).slice(0,80),assetType};
 }
 // Polyfork：assetId 就是它的资产 id（`windmill-3aad49` 这种），随任务持久化，
 // 恢复队列时才能重派。glb 与 fbx 都是官方现成的，不需要本地转换。
 if(kind==='polyfork'){
  if(!m.assetId)throw Error('Polyfork 资产 ID 缺失');
  return {...common,kind:'polyfork',platform:'polyfork',downloadable:true,url:String(m.url||`https://polyfork.dev/asset/${m.assetId}`),assetId:String(m.assetId).slice(0,120)};
 }
 // ambientCG 材质与 Poly Haven 模型同构：uid 是资产 ID 的 md5，assetId 随任务持久化，
 // 恢复队列时才能正确重派给材质 runner。材质没有可另存的原始文件，downloadable 记 false。
 if(kind==='ambientcg'){
  if(!m.assetId)throw Error('ambientCG 资产 ID 缺失');
  return {...common,kind:'ambientcg',platform:'ambientcg',assetType:['hdris','models'].includes(m.assetType)?m.assetType:'textures',sourceType:String(m.sourceType||'material'),downloadable:false,url:String(m.url||`https://ambientcg.com/a/${m.assetId}`),assetId:String(m.assetId).slice(0,120)};
 }
 return {...common,kind:'sketchfab',downloadable:m.downloadable===true,url:`https://sketchfab.com/models/${m.uid}`};
}
/** Shared stem for both delivery modes: filesystem-safe, capped, always carrying the uid prefix. */
function cleanStem(name,uid){let stem=String(name||'model').replace(/\.zip$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,100)||'model';if(!stem.includes(uid.slice(0,8)))stem+='-'+uid.slice(0,8);return stem;}
export function cleanFilename(name,uid){return cleanStem(name,uid)+'.zip';}
export function cleanFolderName(name,uid){return cleanStem(name,uid);}
function optionKey(value){
 if(Array.isArray(value))return JSON.stringify(value.map(item=>JSON.parse(optionKey(item))));
 if(value&&typeof value==='object')return JSON.stringify(Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,JSON.parse(optionKey(value[key]))])));
 return JSON.stringify(value);
}
const sameFolder=(a,b)=>canonicalPath(a)===canonicalPath(b);
export class DownloadManager{
 constructor({dataDir,defaultFolder,runner=runExportWorker,artRunner=runArtstationWorker,imageRunner=runImageJob,polyRunner=runPolyhavenJob,pizzaRunner=runPolypizzaJob,kenneyRunner=runKenneyJob,freestyleRunner=runFreestylizedJob,polyforkRunner=runPolyforkJob,materialRunner=runAmbientcgJob,verify=verifyArchive,browser=browserPath,blender=blenderPath,fbxConverter=convertGlbToFbx,blenderImporter=launchBlenderImport,materialImporter=launchBlenderMaterialImport,hdriImporter=launchBlenderHdriImport,folderPicker=nativeFolderPicker,autoStart=true}={}){
  this.instanceId=randomUUID();this.dataDir=path.resolve(dataDir);this.defaultFolder=path.resolve(defaultFolder);this.runner=runner;this.artRunner=artRunner;this.imageRunner=imageRunner;this.polyRunner=polyRunner;this.pizzaRunner=pizzaRunner;this.kenneyRunner=kenneyRunner;this.freestyleRunner=freestyleRunner;this.polyforkRunner=polyforkRunner;this.materialRunner=materialRunner;this.verify=verify;this.browser=browser;this.blender=blender;this.fbxConverter=fbxConverter;this.blenderImporter=blenderImporter;this.materialImporter=materialImporter;this.hdriImporter=hdriImporter;this.folderPicker=folderPicker;this.autoStart=autoStart;this.jobs=[];this.workers=new Map();this.transfers=new Map();this.closed=false;this.baseUrl=null;this.revision=0;this.timer=null;this.persistTimer=null;this.warning='';
  this.settings={folder:this.defaultFolder,concurrency:1,retryLimit:1,paused:false};
  this.dismissedDownloads=new Set();
 }
 async init(){
  await fsp.mkdir(this.dataDir,{recursive:true});
  // Windows 旧品牌目录可能是 junction；先解析真实目录，避免排他创建误报 EEXIST。
  this.dataDir=await fsp.realpath(this.dataDir);this.lockPath=path.join(this.dataDir,'manager.lock');
  try{const fd=fs.openSync(this.lockPath,'wx');fs.writeFileSync(fd,JSON.stringify(processIdentity()));fs.closeSync(fd);}catch(e){if(e.code!=='EEXIST')throw e;let owner;try{owner=JSON.parse(fs.readFileSync(this.lockPath));}catch{throw Error('下载记录目录锁无效，请检查 manager.lock');}if(lockOwnerAlive(owner)&&!(process.env.SFX_REPLACE_LIBRARY_OWNER==='1'&&replaceLibraryOwner(owner)))throw Error('此下载记录目录已由另一个服务使用');fs.unlinkSync(this.lockPath);return this.init();}
  try{
   this.store=path.join(this.dataDir,'tasks.json');let saved;
   if(fs.existsSync(this.store)){try{saved=JSON.parse(fs.readFileSync(this.store,'utf8'));}catch{try{saved=JSON.parse(fs.readFileSync(this.store+'.bak','utf8'));this.warning='任务记录损坏，已从上次备份恢复；原损坏文件已保留。';fs.copyFileSync(this.store,this.store+'.damaged-'+Date.now());fs.copyFileSync(this.store+'.bak',this.store);}catch{throw Error('任务记录损坏，已停止启动，未覆盖原文件');}}}
   if(saved){if(saved.version!==1||!Array.isArray(saved.jobs)||!saved.settings)throw Error('任务记录格式无效，未重置');this.settings={...this.settings,...saved.settings};this.jobs=saved.jobs;
    for(const j of this.jobs){if(!uidPattern.test(j.uid)||!j.id)throw Error('任务记录含无效模型');if(ACTIVE.has(j.state)){j.state='interrupted';j.message='服务上次中断，请重试（从头下载，不是断点续传）';j.finishedAt=Date.now();}}
   }
   // Delete only known interrupted-task scratch paths, never arbitrary user directories.
   for(const j of this.jobs){if(j.state==='interrupted'&&/^[a-f0-9-]{36}$/.test(j.id)&&Number.isSafeInteger(j.attempts)&&j.attempts>0){const key=`${j.id}-${j.attempts}`;await fsp.rm(path.join(this.dataDir,'workers',key),{recursive:true,force:true,maxRetries:5,retryDelay:150}).catch(()=>{});await fsp.rm(path.join(this.dataDir,'staging',key+'.zip.part'),{force:true}).catch(()=>{});await fsp.rm(path.join(this.dataDir,'staging',key+'.dir'),{recursive:true,force:true}).catch(()=>{});}}
   this.dismissedDownloads=new Set((Array.isArray(saved?.dismissedDownloads)?saved.dismissedDownloads:[]).filter(value=>typeof value==='string').map(canonicalPath));
   const skipped=[];
   const recovered=await recoverDownloads(this.jobs,[...new Set([this.settings.folder,...this.jobs.map(storageRoot).filter(Boolean)])],{dismissed:this.dismissedDownloads,onSkipped:(file,error)=>skipped.push(`${path.basename(file)}：${error}`)});
   if(recovered&&fs.existsSync(this.store))fs.copyFileSync(this.store,this.store+'.before-recovery-'+Date.now());
   if(skipped.length)this.warning=[this.warning,`${skipped.length} 个本地文件未通过恢复校验：${skipped.slice(0,3).join('；')}`].filter(Boolean).join('；');
   await fsp.mkdir(path.join(this.dataDir,'staging'),{recursive:true});this.save();return this;
  }catch(e){fs.unlinkSync(this.lockPath);throw e;}
 }
 start(baseUrl){this.baseUrl=baseUrl;if(this.autoStart)this.pump();}
 save(){clearTimeout(this.persistTimer);this.persistTimer=null;const next=this.store+'.next';try{fs.writeFileSync(next,JSON.stringify({version:1,settings:this.settings,jobs:this.jobs,dismissedDownloads:[...this.dismissedDownloads]}));const fd=fs.openSync(next,'r+');fs.fsyncSync(fd);fs.closeSync(fd);if(fs.existsSync(this.store))fs.copyFileSync(this.store,this.store+'.bak');fs.renameSync(next,this.store);this.storageError=null;}catch(e){this.storageError='任务记录写入失败：'+e.message;throw e;}this.revision++;}
 update(job,patch,{lazy=false}={}){Object.assign(job,patch,{updatedAt:Date.now()});this.revision++;if(lazy){clearTimeout(this.persistTimer);this.persistTimer=setTimeout(()=>{try{this.save();}catch{}},180);}else this.save();}
 log(job,message){job.logs??=[];job.logs.push(`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ${String(message).slice(0,1500)}`);job.logs=job.logs.slice(-160);}
 folderStatus(){return inspectFolder(this.settings.folder);}
 snapshot(){return {version:1,revision:this.revision,settings:this.settings,defaultFolder:this.defaultFolder,folderStatus:this.folderStatus(),browserAvailable:!!this.browser(),fbxAvailable:!!this.blender(),warning:this.warning,storageError:this.storageError||null,jobs:this.jobs.map(j=>({...j,fileExists:!!j.filePath&&exists(j.filePath)}))};}
 async sendToBlender(job,filePath=job.filePath){
  // 材质交付物里没有网格，走建材质这条路；HDRI/天空盒走设世界环境；其余一律按模型导入
  //（Kenney / FreeStylized 的 pack.zip 由 resolveBlenderImport 解包后挑模型；
  //  FreeStylized 的天空盒是等距全景图、贴图/智能材质是 PBR 贴图包，各走对应路线）。
  const materialJob=job.kind==='ambientcg'&&(!job.assetType||job.assetType==='textures')||job.kind==='polyhaven'&&job.assetType==='textures'||job.kind==='freestylized'&&(job.assetType==='textures'||job.assetType==='smart');
  const hdriJob=['polyhaven','ambientcg'].includes(job.kind)&&job.assetType==='hdris'||job.kind==='freestylized'&&job.assetType==='skybox';
  const result=await (materialJob?this.materialImporter(filePath,{blender:this.blender}):hdriJob?this.hdriImporter(filePath,{blender:this.blender}):this.blenderImporter(filePath,{blender:this.blender}));
  this.log(job,materialJob?`已把材质导入已打开的 Blender：${result.name||''}`:hdriJob?'已把 HDRI 设为已打开 Blender 的世界环境':`已发送到已打开的 Blender：${result.file}`);
  return result;
 }
 /** 手动把「已下载到本地」的模型送进 Blender：不会重新下载，文件不在磁盘上就直接拒绝。 */
 async sendBlender(id){
  const job=this.jobs.find(j=>j.id===id);
  if(!job)throw Error('任务不存在');
  if(job.state!=='saved'||!exists(job.filePath||''))throw Error('这个资产还没有保存到本地，请先导出到本地再发送到 Blender。');
  // 与 sendToBlender 用同一条判定，否则材质任务的消息会写成「已发送模型文件」。
  const materialJob=job.kind==='ambientcg'&&(!job.assetType||job.assetType==='textures')||job.kind==='polyhaven'&&job.assetType==='textures'||job.kind==='freestylized'&&(job.assetType==='textures'||job.assetType==='smart');
  const hdriJob=['polyhaven','ambientcg'].includes(job.kind)&&job.assetType==='hdris'||job.kind==='freestylized'&&job.assetType==='skybox';
  try{
   const result=await this.sendToBlender(job);
   const label=materialJob?`已导入材质到 Blender：${result.name||''}`:hdriJob?'已把 HDRI 设为 Blender 世界环境':`已发送到 Blender：${path.basename(result.file||job.filePath||'')}`;
   this.update(job,{blender:result,message:label,warning:null});
   return {ok:true,...result,...this.snapshot()};
  }catch(e){
   const reason=String(e.message||e);
   job.warning='发送到 Blender 失败：'+reason;this.log(job,job.warning);this.save();
   throw e;
  }
 }
 /** 界面「Blender 连接」面板用：脚本装到哪些版本目录、Blender 开着没有、桥接是否真能应答。 */
 async blenderBridge(){
  const status=await blenderBridgeStatus();
  return {...status,bridgeOnline:status.sourceReady?await probeBridge({port:status.port}):false};
 }
 /** 手动安装 / 更新桥接脚本：安装要几十毫秒到一两秒，先起任务拿 id，界面再轮询进度。 */
 startBlenderBridgeInstall(){return {jobId:startBridgeInstallJob()};}
 /** 读安装进度；任务结束后带着一份新的桥接状态，界面不用再发第二次请求。 */
 blenderBridgeInstall(id){const job=bridgeInstallJob(String(id||''));if(!job)throw Error('安装任务不存在或已过期，请重新点击安装');return job;}
 async pickFolder({folder}={}){const selected=await this.folderPicker(folder||this.settings.folder||this.defaultFolder);if(!selected)return {cancelled:true};return {cancelled:false,folder:await this.resolveFolder(selected)};}
 async resolveFolder(value){if(typeof value!=='string'||!path.isAbsolute(value)||/^(\\\\|\/\/)/.test(value)||value.includes('\0'))throw Error('请选择本机绝对目录，不支持网络共享路径');const folder=path.resolve(value);if(folder===path.parse(folder).root)throw Error('请使用具体文件夹，不要直接使用磁盘根目录');await fsp.mkdir(folder,{recursive:true});const probe=path.join(folder,'.sfx-permission-'+randomUUID());const fd=await fsp.open(probe,'wx');await fd.close();await fsp.unlink(probe);return await fsp.realpath(folder);}
 async enqueueWithFolder(input){if(input.authorized!==true)throw Error('请先确认拥有模型下载和使用授权');const folder=input.folder===undefined?this.settings.folder:await this.resolveFolder(input.folder);return await this.enqueue(input,{folder});}
 networkRequest(token,total){return this.transfers.get(token)?.open(total)||null;}
 async configure(input){
  const next={...this.settings};
  if(input.folder!==undefined)next.folder=await this.resolveFolder(input.folder);
  if(input.concurrency!==undefined){if(![1,2].includes(input.concurrency))throw Error('并发数仅支持 1 或 2');next.concurrency=input.concurrency;}
  if(input.retryLimit!==undefined){if(![0,1,2].includes(input.retryLimit))throw Error('自动重试次数仅支持 0–2');next.retryLimit=input.retryLimit;}
  if(input.paused!==undefined){if(typeof input.paused!=='boolean')throw Error('暂停参数无效');next.paused=input.paused;}
  this.settings=next;this.save();this.pump();return this.snapshot();
 }
 async enqueue(input,{folder=this.settings.folder}={}){
  if(input.authorized===true){
   // Recover missing records, respecting explicit removals; serialize concurrent scans.
   while(this.recovery)await this.recovery;
   this.recovery=recoverDownloads(this.jobs,[folder],{dismissed:this.dismissedDownloads});
   try{if(await this.recovery)this.save();}finally{this.recovery=null;}
  }
  if(input.authorized!==true)throw Error('请先确认拥有模型下载和使用授权');
  const kind=input.kind===undefined?'sketchfab':String(input.kind);
  if(!JOB_KINDS.has(kind))throw Error('不支持的任务类型');
  const openInBlender=input.openInBlender===true;
  const batch=kind==='artstation'?ARTSTATION_BATCH:kind==='images'?IMAGE_BATCH:50;
  const polyMaterial=kind==='polyhaven'&&Array.isArray(input.models)&&input.models.length>0&&input.models.every(m=>m?.assetType==='textures');
  const polyHdri=kind==='polyhaven'&&Array.isArray(input.models)&&input.models.length>0&&input.models.every(m=>m?.assetType==='hdris');
  const polyMixed=kind==='polyhaven'&&Array.isArray(input.models)&&input.models.some(m=>m?.assetType==='textures'||m?.assetType==='hdris')&&!polyMaterial&&!polyHdri;
  if(polyMixed)throw Error('Poly Haven 的模型、材质和 HDRI 请分批下载');
  const noun=kind==='artstation'?' ArtStation 作品':kind==='images'?'资产图片':polyHdri?' Poly Haven HDRI':polyMaterial?' Poly Haven 材质':kind==='polyhaven'?' Poly Haven 模型':kind==='ambientcg'?' ambientCG 材质':kind==='polypizza'?' Poly Pizza 模型':kind==='kenney'?' Kenney 资源包':kind==='polyfork'?' Polyfork 模型':kind==='freestylized'?' FreeStylized 资产':'模型';
  if(!Array.isArray(input.models)||!input.models.length||input.models.length>batch)throw Error(`每批最多添加 ${batch} 个${noun}`);
  if(kind==='ambientcg'&&new Set(input.models.map(m=>m.sourceType||'material')).size>1)throw Error('ambientCG 不同类型的资产请分批下载');
  if(this.storageError)throw Error(this.storageError);if(this.jobs.length>=500)throw Error('任务记录已达 500 条，请清理已结束记录');
  const requestedOptions=openInBlender?{...input.options,output:'folder',format:'fbx'}:input.options;
  const options=kind==='images'?imageOptions(requestedOptions):kind==='ambientcg'||polyMaterial?materialOptions(requestedOptions):polyHdri?{output:'folder',resolution:MATERIAL_RESOLUTIONS.has(requestedOptions?.resolution)?requestedOptions.resolution:'2K',textureFormat:'HDR'}:kind==='polypizza'||kind==='kenney'?{output:'folder',format:'glb'}:kind==='polyfork'?{output:'folder',format:requestedOptions?.format==='fbx'?'fbx':'glb'}:kind==='freestylized'?{output:'folder',format:'glb',resolution:MATERIAL_RESOLUTIONS.has(requestedOptions?.resolution)?requestedOptions.resolution:'2K'}:exportOptions(kind==='artstation'?{...requestedOptions,packMode:'glb'}:requestedOptions);
  if(kind==='ambientcg'&&input.models.every(m=>m.sourceType==='substance'))options.textureFormat='SBSAR';
  const models=input.models.map(m=>modelSnapshot(m,kind)),added=[],duplicates=[],opened=[];
  // 已下载的重复项要「顺手送进 Blender」时，导入可能要几十秒，不能在循环里串行等：
  // 先把请求排进队列，循环结束后统一收结果，避免一个卡住把整批入队都拖住。
  const reopen=[];
  if(this.jobs.length+models.length>500)throw Error('任务记录将超过 500 条，请清理历史后重试');
  for(const m of models){const same=j=>j.kind===m.kind&&j.uid===m.uid&&(optionKey(j.options)===optionKey(options)||recoveredOptionsMatch(j,options))&&sameFolder(storageRoot(j),folder);const previous=this.jobs.find(j=>same(j)&&(ACTIVE.has(j.state)||WAITING.has(j.state)))||this.jobs.findLast(j=>same(j)&&j.state==='saved'&&exists(j.filePath||''))||this.jobs.findLast(same);
   if(previous&&(ACTIVE.has(previous.state)||WAITING.has(previous.state)||previous.state==='saved'&&exists(previous.filePath||'')&&!input.force)){
    if(openInBlender&&previous.state==='saved'&&exists(previous.filePath||''))reopen.push({uid:m.uid,job:previous});
    duplicates.push({uid:m.uid,name:m.name,state:previous.state});continue;
   }
   const source=input.models.find(model=>model.uid===m.uid)||m;
   const storageCategory=assetStorageCategory({...source,...m});
   const job={...m,id:randomUUID(),state:'queued',stage:'queued',message:openInBlender?'等待下载并发送到 Blender':'等待后台处理',options,downloadRoot:folder,storageCategory,downloadDir:path.join(folder,storageCategory),retryLimit:this.settings.retryLimit,attempts:0,retryCount:0,authorizedAt:Date.now(),createdAt:Date.now(),openInBlender,logs:[]};this.jobs.push(job);added.push(job.id);
  }
  for(const {uid,job} of reopen){
   try{opened.push({uid,id:job.id,...await this.sendToBlender(job)});}
   catch(e){job.warning='已保存，但发送到 Blender 失败：'+String(e.message||e);this.log(job,job.warning);this.save();}
  }
  this.save();this.pump();return {added,duplicates,opened};
 }
 action(id,action){const j=this.jobs.find(j=>j.id===id);if(!j)throw Error('任务不存在');
  if(action==='cancel'){
   if(j.state==='saving')throw Error('文件正在提交保存，请稍后查看结果');
   // Check the terminal states first: a job that already saved may still be inside workers for a
   // moment, and flipping it to 'cancelling' would strand it there with no worker left to finish.
   if(terminal.has(j.state))throw Error('此任务已结束');
   if(this.workers.has(id)){this.update(j,{state:'cancelling',message:'正在关闭此任务的后台转换进程'});this.workers.get(id).controller.abort(Error('用户取消'));}
   else if(WAITING.has(j.state))this.update(j,{state:'cancelled',finishedAt:Date.now(),message:'已取消排队'});else throw Error('此任务已结束');
  }else if(action==='hold'){if(!['queued','retry_wait'].includes(j.state))throw Error('只能暂停尚未开始的任务；转换中请使用取消');this.update(j,{state:'held',message:'已暂停排队'});
  }else if(action==='resume'){if(j.state!=='held')throw Error('任务不是暂停排队状态');this.update(j,{state:'queued',message:'等待后台处理'});
  }else if(action==='retry'){if(!['failed','cancelled','interrupted'].includes(j.state))throw Error('此任务不能重试');const same=x=>x.id!==id&&x.kind===j.kind&&x.uid===j.uid&&sameFolder(storageRoot(x),storageRoot(j))&&(optionKey(x.options)===optionKey(j.options)||recoveredOptionsMatch(x,j.options));if(this.jobs.some(x=>same(x)&&(ACTIVE.has(x.state)||WAITING.has(x.state))))throw Error('已有相同模型的任务正在处理或等待');if(this.jobs.some(x=>same(x)&&x.state==='saved'&&exists(x.filePath||'')))throw Error('此资产已下载且文件仍存在，无需重试');this.log(j,'手动重试：从头下载，沿用任务原目录和导出设置');this.update(j,{state:'queued',message:'等待重新下载',retryCount:0,nextAttemptAt:null,finishedAt:null,warning:null,bytesWritten:0,totalBytes:null,verification:null});
  }else if(action==='remove'){// Terminal state is the real guard: run() never writes state again afterwards,
   // and the worker entry can still linger for a tick after a job finishes.
   if(!terminal.has(j.state))throw Error('请先取消任务再移除记录');
   if(j.filePath)this.dismissedDownloads.add(canonicalPath(j.filePath));
   this.jobs=this.jobs.filter(x=>x.id!==id);this.save();
  }else throw Error('不支持的任务操作');this.pump();return this.snapshot();
 }
 batch(action,ids){if(!['cancel','retry','hold','resume','remove'].includes(action)||!Array.isArray(ids)||ids.length>500)throw Error('批量操作参数无效');const errors=[];for(const id of ids){try{this.action(id,action);}catch(e){errors.push({id,error:e.message});}}return {errors,...this.snapshot()};}
 pump(){
  clearTimeout(this.timer);if(this.closed||!this.baseUrl||this.settings.paused||this.storageError)return;
  while(this.workers.size<this.settings.concurrency){const j=this.jobs.find(j=>j.state==='queued'||j.state==='retry_wait'&&j.nextAttemptAt<=Date.now());if(!j)break;const controller=new AbortController();const promise=this.run(j,controller);this.workers.set(j.id,{controller,promise});promise.finally(()=>{this.workers.delete(j.id);this.pump();}).catch(()=>{});}
  const next=this.jobs.filter(j=>j.state==='retry_wait').map(j=>j.nextAttemptAt).sort((a,b)=>a-b)[0];if(next)this.timer=setTimeout(()=>this.pump(),Math.max(250,next-Date.now()));
 }
 async run(j,controller){
  const signal=controller.signal;const timeout=setTimeout(()=>controller.abort(Error('任务超过 30 分钟，已停止，请缩小模型或降低贴图尺寸')),30*60*1000);
  j.attempts++;
  // An artwork with no embedded Marmoset scene has no mesh to convert: its runner downloads the
  // author's images instead. That changes two things downstream — there is no GLB to turn into an
  // FBX, and there is no scene to send to Blender — so both are decided once, here.
   const materialJob=j.kind==='ambientcg'&&(!j.assetType||j.assetType==='textures')||j.kind==='polyhaven'&&j.assetType==='textures'||j.kind==='freestylized'&&(j.assetType==='textures'||j.assetType==='smart');
   const hdriJob=['polyhaven','ambientcg'].includes(j.kind)&&j.assetType==='hdris'||j.kind==='freestylized'&&j.assetType==='skybox';
   const bundleJob=j.kind==='ambientcg'||materialJob||hdriJob||j.kind==='kenney'||j.kind==='freestylized';
   const imageBundle=j.kind==='images'||j.kind==='artstation'&&j.hasMarmoset===false||bundleJob;
  const folderOutput=j.options.output==='folder',wantFbx=!imageBundle&&j.options.format==='fbx'&&j.kind!=='polyfork';
  // Both folder delivery and FBX conversion need the loose files, so the staging tree is a
  // directory whenever either is asked for; a ZIP is packed from it afterwards if that is what
  // the user picked. One staging shape keeps the rest of this method mode-agnostic.
  const looseStage=folderOutput||wantFbx;
  const scratch=path.join(this.dataDir,'staging',`${j.id}-${j.attempts}`);
  const staged=looseStage?scratch+'.dir':scratch+'.zip.part';
  const packed=scratch+'.zip.part';
  const profile=path.join(this.dataDir,'workers',`${j.id}-${j.attempts}`);
  const networkToken=randomUUID();this.transfers.set(networkToken,new TransferProgress(network=>{if(!signal.aborted)this.update(j,{network},{lazy:true});}));
  // 图站整站图片直接写进最终文件夹（不走暂存再搬）：第一批图片落地后，资产库就能看到这张卡，
  // 下载管理也能立刻打开文件夹，而不用等几百张全部下完。
  const directFolder=j.kind==='images'&&folderOutput;
  let liveDir=null;
  try{
   if(directFolder){
    liveDir=await reserveFolder(j.downloadDir,cleanFolderName(j.name||'图片包',j.uid));
    this.update(j,{filePath:liveDir,live:true},{lazy:true});
   }
  const art=j.kind==='artstation';
   this.log(j,`第 ${j.attempts} 次尝试，独立后台执行`);
   this.update(j,{state:'running',stage:'starting',message:materialJob?'正在启动材质下载器':j.kind==='images'?'正在启动图片下载器':art?(imageBundle?'正在启动作品图片下载器':'正在启动 Marmoset 转换器'):'正在启动后台转换器',startedAt:Date.now(),bytesWritten:0,totalBytes:null,network:null});
   const onProgress=p=>{if(signal.aborted)return;const message=String(p.message||'');if(p.stage!=='transferring')this.log(j,message);if(/MISSING_BLIT\.txt:/.test(message))j.warning='部分 CDN 贴图未经视图捕获校验，请检查外观及 MISSING_BLIT.txt';this.update(j,{message,stage:p.stage,state:p.stage==='transferring'?'transferring':'running',...(p.bytesWritten!==undefined?{bytesWritten:p.bytesWritten,totalBytes:p.totalBytes,transferRate:p.transferRate}:{})},{lazy:true});};
   // `uid` is handed to both runners: the archive verifier checks provenance by matching
   // info.json.uid against the job's uid, so the writer must not re-derive it independently.
   // A "ZIP + FBX" job still converts through a folder, so the runner is told to emit loose files.
   const runnerOptions=looseStage&&!folderOutput?{...j.options,output:'folder'}:j.options;
   // `hasMarmoset` rides along so the forked worker can pick its pipeline without re-reading the
   // artwork page first; it is persisted on the job, so a restored queue dispatches exactly the same way.
    const meta=j.kind==='images'
    ?await this.imageRunner({uid:j.uid,platform:j.platform,name:j.name,author:j.author,url:j.url,assetId:j.assetId,deliver:looseStage?'folder':'zip',output:directFolder?liveDir:staged,workRoot:profile,...(isPictureSite(j.platform)?{limit:PICTURE_SITE_IMAGE_MAX,totalBytes:PICTURE_SITE_IMAGE_BYTES}:{})},{signal,progress:onProgress})
    :j.kind==='ambientcg'
     ?await this.materialRunner({uid:j.uid,assetId:j.assetId,options:j.options,deliver:looseStage?'folder':'zip',output:staged,workRoot:profile},{signal,progress:onProgress})
    :art
    ?await this.artRunner({uid:j.uid,url:j.url,format:'glb',hasMarmoset:!imageBundle,deliver:looseStage?'folder':'zip',output:staged,workRoot:profile},{signal,progress:onProgress})
    :j.kind==='polyhaven'
     ?await this.polyRunner({uid:j.uid,options:runnerOptions,output:staged,profile,assetId:j.assetId,assetType:j.assetType},{signal,progress:onProgress})
    :j.kind==='polypizza'
     ?await this.pizzaRunner({uid:j.uid,output:staged,assetId:j.assetId},{signal,progress:onProgress})
    :j.kind==='kenney'
     ?await this.kenneyRunner({uid:j.uid,output:staged,assetId:j.assetId},{signal,progress:onProgress})
    :j.kind==='freestylized'
     ?await this.freestyleRunner({uid:j.uid,output:staged,assetId:j.assetId,assetType:j.assetType,options:j.options},{signal,progress:onProgress})
    :j.kind==='polyfork'
     ?await this.polyforkRunner({uid:j.uid,output:staged,assetId:j.assetId,options:j.options},{signal,progress:onProgress})
    :await this.runner({networkToken,uid:j.uid,options:runnerOptions,baseUrl:this.baseUrl,output:staged,profile},{signal,progress:onProgress});
   signal.throwIfAborted();

   if(wantFbx&&j.kind!=='polyhaven'){
    const glb=await findStagedGlb(staged);
    const converted=await this.fbxConverter({glb,outDir:staged,workRoot:path.join(profile,'fbx')},{signal,progress:onProgress});
    this.log(j,`已用 Blender 生成 FBX：${converted.name}（${converted.bytes} 字节）`);
   }

   // Now that the FBX is inside the tree, a "ZIP + FBX" job packs it; plain folder delivery keeps it.
   let deliverable=directFolder?liveDir:staged,folderDelivery=looseStage;
   if(looseStage&&!folderOutput){
    this.update(j,{state:'transferring',stage:'transferring',message:'正在把导出内容打包为 ZIP'},{lazy:true});
    await packFolder(staged,packed,{signal});
    await fsp.rm(staged,{recursive:true,force:true}).catch(()=>{});
    deliverable=packed;folderDelivery=false;
   }
   signal.throwIfAborted();
   this.update(j,{state:'validating',stage:'validating',message:folderDelivery?(materialJob?'校验材质贴图清单、贴图内容及内容指纹':imageBundle?'校验作品图片清单、图片内容及内容指纹':'校验 GLB 网格、来源信息及内容指纹'):(materialJob?'校验 ZIP CRC、材质贴图清单、贴图内容及 SHA-256':imageBundle?'校验 ZIP CRC、作品图片清单、图片内容及 SHA-256':'校验 ZIP CRC、GLB 网格、来源信息及 SHA-256')});
   const verification=folderDelivery?await verifyFolder(deliverable,{uid:j.uid,signal}):await this.verify(deliverable,{uid:j.uid,signal});
   signal.throwIfAborted();
   if(verification.warning)j.warning='部分 CDN 贴图需检查；文件结构校验不代表材质视觉一致';
   this.update(j,{state:'saving',stage:'saving',message:folderDelivery?'正在提交导出文件夹（不会覆盖同名文件夹）':'正在提交已校验的文件（不会覆盖同名文件）'});
   const name=folderDelivery?cleanFolderName(meta.zipName||j.name,j.uid):cleanFilename(meta.zipName||j.name,j.uid);
   const filePath=directFolder?liveDir:folderDelivery?await commitFolder(deliverable,j.downloadDir,name):await commitArchive(deliverable,j.downloadDir,name);
   let blender=null;
   if(j.openInBlender&&imageBundle&&!materialJob&&!hdriJob){
    // The user asked for a Blender import, but this asset produced pictures, not a scene.
    // Kenney / FreeStylized 的 pack.zip 与 Poly Haven HDRI 都有 Blender 去处，不在此列。
    j.warning=(j.warning?j.warning+'；':'')+'这是图片资产，没有 3D 场景可以发送到 Blender，已保存到本机';
    this.log(j,j.warning);
   }else if(j.openInBlender){
    try{this.update(j,{state:'saving',stage:'saving',message:materialJob?'正在把材质导入已打开的 Blender':hdriJob?'正在把 HDRI 设为 Blender 世界环境':'正在发送到已打开的 Blender 场景'});blender=await this.sendToBlender(j,filePath);}
    catch(e){j.warning=(j.warning?j.warning+'；':'')+'已保存，但发送到 Blender 失败：'+String(e.message||e);this.log(j,j.warning);blender={ok:false,error:String(e.message||e)};}
   }
   this.log(j,(materialJob?'材质已保存并通过校验：':imageBundle?'图片已保存并通过校验：':'导出已保存并通过校验：')+filePath);
   const savedMessage=j.openInBlender&&(!imageBundle||materialJob)?(blender?.ok?(materialJob?'已保存并已把材质导入 Blender':'已保存并已发送到 Blender'):(materialJob?'已保存到本机，但未能导入 Blender':'已保存到本机，但未能发送到 Blender')):(folderDelivery?(materialJob?'材质已保存到本机，内容校验通过':imageBundle?'图片已保存到本机，内容校验通过':'已保存到本机，内容校验通过'):'已保存到本机，文件完整性校验通过');
   this.update(j,{state:'saved',stage:'saved',message:savedMessage,filePath,filename:path.basename(filePath),bytes:verification.bytes,verification,blender,finishedAt:Date.now(),nextAttemptAt:null});
  }catch(e){
   const message=signal.aborted?String(signal.reason?.message||'任务已取消'):String(e.message||e);this.log(j,message);
   const transient=!signal.aborted&&/timeout|超时|ECONN|fetch failed|Failed to fetch|HTTP (429|502|503|504)/i.test(message);
   if(this.closed)this.update(j,{state:'interrupted',message:'本地服务已关闭；重启后可手动重试',finishedAt:Date.now()});
   else if(transient&&j.retryCount<j.retryLimit){j.retryCount++;this.update(j,{state:'retry_wait',message:`临时网络错误，等待自动重试 ${j.retryCount}/${j.retryLimit}：${message}`,nextAttemptAt:Date.now()+5000*j.retryCount});}
   else this.update(j,{state:signal.aborted?'cancelled':'failed',message,finishedAt:Date.now()});
  }finally{this.transfers.delete(networkToken);clearTimeout(timeout);await fsp.rm(staged,{recursive:true,force:true}).catch(()=>{});await fsp.rm(packed,{recursive:true,force:true}).catch(()=>{});}
 }
 file(id){const j=this.jobs.find(j=>j.id===id);if(!j||!j.filePath||path.dirname(j.filePath)!==path.resolve(j.downloadDir)||!exists(j.filePath))throw Error('文件不存在，可能已被移动或删除');return {job:j,path:j.filePath};}
 async reveal(id){if(!id)await fsp.mkdir(this.settings.folder,{recursive:true});const location=id?this.file(id).path:this.settings.folder;await fsp.access(location);const args=process.platform==='win32'?(id?['/select,',location]:[location]):[id?path.dirname(location):location];const app=process.platform==='win32'?'explorer.exe':process.platform==='darwin'?'open':'xdg-open';const child=execFile(app,args,{windowsHide:false},()=>{});child.unref();return {opened:true};}
 async close(){this.closed=true;clearTimeout(this.timer);for(const {controller} of this.workers.values())controller.abort(Error('本地服务已关闭'));await Promise.allSettled([...this.workers.values()].map(w=>w.promise));clearTimeout(this.persistTimer);this.save();if(fs.existsSync(this.lockPath))fs.unlinkSync(this.lockPath);}
}
