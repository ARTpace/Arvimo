import {classifyAsset} from '../src/library/asset-classification.js';
// 单文件导入；沿用 Serpent prepareOrExecuteImport 的 duplicate=skip/name=keep-both，
// 适配 Eagle 的复制→portable merge 入库，不覆盖或移动源文件。
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {formatKind, extensionOf} from '../src/library/format-registry.js';
import {inspectAssetFormat} from './image-sniff.mjs';
import {preflightLocalFiles} from './local-import-preflight.mjs';
import {importLibrary,PORTABLE_FORMAT,PORTABLE_VERSION} from './library-portable.mjs';
import {assetFolder, uniqueTarget, pruneEmptyDirs} from './asset-folders.mjs';
import {writeSidecar} from './asset-sidecar.mjs';
import {locationModel} from './file-locations.mjs';

const reject = (message,status=400) => Object.assign(Error(message),{status});
/** 元数据写到资产旁边（<资产名>.info.json）；写失败只当没写，绝不影响导入结果。 */
const saveSidecar = asset => { try { writeSidecar(asset?.filePath, asset); } catch {} };
const cancelled = signal => {if(signal?.aborted)throw Object.assign(Error('导入已取消'),{name:'AbortError'});};

export function createLocalFileImporter({storage,importRoots,dataDir,archiveRoot,allowLocalRoot=()=>{},onImported=()=>{}}) {
 // 托管副本的落点：资产根（与平台下载同一套「分组/子类型」目录），
 // 没有 archiveRoot 时才退回历史的 dataDir/imports（旧测试与旧数据靠它）。
 const managedRoot=path.resolve(archiveRoot||path.join(dataDir,'imports'));
 let queue=Promise.resolve();
 // ── 批量入库 ───────────────────────────────────────────────────────────────
 // 拖入导入是「一个 HTTP 请求一个文件」，但 importLibrary 每入库一次都要 readCatalog+readUserDomain
 // 把整库序列化写回 state_meta。一次拖 1000 个文件就是 1000 次全库重写（库里 736 条资产时实测
 // 45ms/文件，而且随库增长线性变慢）。批量模式下 asset 模型先攒在内存里，flush 时一次落库，
 // 全库重写只付一次。整库快照与去重集合同理：批次开头取一次，全批复用。
const BATCH_TTL=10*60*1000;
const batches=new Map();
// 批次报废（flush 失败 / 用户取消 / 超时）：只删本批写进库里的副本，用户原文件一直没动过。
// 老结构是 drop-* 独占目录（整目录删），新结构是 imports/<日期>/ 共用目录 —— 只删自己那几个
// 文件，再顺手收掉因此变空的文件夹，绝不碰同一天另一批的文件。
const sweepBatch=async batch=>{
 const prune=async file=>{
  let dir=path.dirname(file);
  try{await fs.rm(file,{force:true});}catch{return;}
  // rmdir 只对空目录成功：撞到还有别的东西的目录就停，不会误删同一天的其它批次。
  for(let i=0;i<4;i++){
   try{await fs.rmdir(dir);}catch{return;}
   dir=path.dirname(dir);
  }
 };
 await Promise.all([...batch.dirs].map(dir=>fs.rm(dir,{recursive:true,force:true}).catch(()=>{})));
 await Promise.all([...batch.files].map(file=>prune(file).catch(()=>{})));
};
function batchOf(token){
 const existing=batches.get(token);
 if(existing){existing.touched=Date.now();return existing;}
 const now=Date.now();
 for(const [key,stale] of batches){
  if(now-stale.touched>BATCH_TTL){batches.delete(key);sweepBatch(stale).catch(()=>{});}
 }
 const fresh={known:null,staged:[],hashes:new Map(),dirs:new Set(),files:new Set(),touched:now};
 batches.set(token,fresh);
 return fresh;
}
 async function snapshotKnown(){
  const candidates=await storage.withDb(conn=>conn.all("SELECT uid, payload FROM assets WHERE state = 'active'"));
  if(!candidates)throw reject('资产库内核不可用',409);
  return candidates.flatMap(row=>{try{return [{...JSON.parse(row.payload),uid:row.uid}];}catch{return [];}});
 }
 async function validateSource(folder,rel,signal) {
  if(typeof folder!=='string'||!path.isAbsolute(folder)||folder.includes('\0')||typeof rel!=='string'||!rel||rel.includes('\0')||path.isAbsolute(rel)||rel.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'||part.includes(':')))throw reject('源路径无效');
  const root=path.resolve(folder);
  if(!importRoots.list().includes(root))throw reject('仅可导入已登记目录内的文件',403);
  if(!importRoots.valid().includes(root))throw reject('源目录离线或不可读取',409);
  // 检查根及全部祖先，不跟随链接/Windows junction；realpath 再核对物理位置。
  const source=path.resolve(root,...rel.split(/[\\/]/));
  const parsed=path.parse(source);let current=parsed.root;
  for(const segment of source.slice(parsed.root.length).split(path.sep)) {
   current=path.join(current,segment);const stat=await fs.lstat(current);
   if(stat.isSymbolicLink())throw reject('源路径不允许符号链接',403);
  }
  if(path.resolve(await fs.realpath(source))!==source)throw reject('源路径解析不一致',403);
  const [check]=await preflightLocalFiles({files:[source],signal});
  if(!check.sha256)throw reject('源文件不可读取或读取期间变化：'+check.reason,409);
  cancelled(signal);
  return {root,source,check};
 }
 async function execute(input,signal) {
  const {folder,rel,mode,duplicate='skip',nameConflict='keep-both',batch:batchToken,ownedCopy=false}=input||{};
  if(!['linked','managed','move'].includes(mode)||!['skip','keep-both'].includes(duplicate)||nameConflict!=='keep-both')throw reject('导入模式或冲突策略无效');
  // 剪切（move）= 复制入库 + 校验通过后删原件。批量走拖入那条路时没有真实源路径，
  // 硬要求单文件串行，避免「一批里删一半」这种没法回滚的中间态。
  if(mode==='move'&&batchToken)throw reject('剪切模式不支持批量导入，请逐个导入');
  const {root,source,check}=await validateSource(folder,rel,signal);
  const batch=batchToken?batchOf(batchToken):null;
  const known=batch?(batch.known??=await snapshotKnown()):await snapshotKnown();
  const samePath=known.find(item=>item.storageMode==='linked'&&item.filePath===source);
  const exact=known.filter(item=>item.sha256===check.sha256&&item.bytes===check.bytes);
  if(mode==='linked'&&samePath)return {ok:true,status:'skipped',reason:'same-linked-path',mode,asset:samePath};
  if(exact.length&&duplicate==='skip')return {ok:true,status:'skipped',reason:'exact-duplicate',mode,asset:exact[0],matches:exact.map(({uid,name})=>({uid,name}))};
  // 同一批里出现两次同样的内容（拖了重复文件 / 文件夹嵌套）：库里还看不到，只能比批次内集合。
  if(batch&&duplicate==='skip'){
   const same=batch.hashes.get(`${check.sha256}:${check.bytes}`);
   if(same)return {ok:true,status:'skipped',reason:'batch-duplicate',mode,asset:same};
  }
  const uid=randomBytes(16).toString('hex');
  let filePath=source,storedDir='',created=false,registered=false;
  try {
   // move 走和托管副本完全相同的复制 + 校验，区别只在入库成功后才删原件（见下面）。
   if(mode!=='linked') {
    // 副本落进「分组/子类型」，和平台下载摆在同一个位置 —— 导入完就能在资源管理器里按分类找到，
    // 不再是 imports/<uid>/ 里一堆认不出来的目录。同名靠 uniqueTarget 加 (2)/(3)，绝不覆盖。
    storedDir=path.join(managedRoot,assetFolder({filename:path.basename(source)}));
    await fs.mkdir(storedDir,{recursive:true});
    if((await fs.lstat(managedRoot)).isSymbolicLink()||path.resolve(await fs.realpath(managedRoot))!==path.resolve(managedRoot))throw reject('资产根不允许链接',403);
    const safe=path.basename(source).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,180)||'asset';
    filePath=await uniqueTarget(path.join(storedDir,safe));
    // 并发导入同名文件时 uniqueTarget 的结果可能被另一个请求抢先占位：EXCL 失败就再取一个名字。
    for(let attempt=0;;attempt+=1){
     try{await fs.copyFile(source,filePath,constants.COPYFILE_EXCL);break;}
     catch(error){
      if(error.code!=='EEXIST'||attempt>=3)throw error;
      filePath=await uniqueTarget(filePath);
     }
    }
    created=true;
    cancelled(signal);
    const checks=await preflightLocalFiles({files:[source,filePath],signal});
    if(checks.some(row=>row.sha256!==check.sha256||row.bytes!==check.bytes))throw reject('复制期间源文件变化或校验失败',409);
    registered=!importRoots.list().includes(managedRoot);
    importRoots.add(managedRoot);allowLocalRoot(managedRoot);
   }
   cancelled(signal);
   if(mode==='linked')allowLocalRoot(root);
   const locationRoot=mode==='linked'?root:managedRoot,locationRel=path.relative(locationRoot,filePath).split(path.sep).join('/');
   const query=`root=${encodeURIComponent(locationRoot)}&rel=${encodeURIComponent(locationRel)}`;
   // 无扩展名的图（浏览器另存、生成器导出）：按内容补扩展名，别把真图记成 other。
   const formatCheck=inspectAssetFormat(filePath);
   const formatName=`${path.basename(filePath)}.${formatCheck.effective}`;
   const asset={uid,formatCheck,url:`/api/local/file?${query}`,previewUrl:`/api/local/file?${query}`,thumbnail:`/api/local/thumb?w=512&${query}`,assetType:formatKind(formatName),localRoot:locationRoot,localRel:locationRel,name:path.basename(source),platform:'local',source:'local-import',storageMode:mode==='linked'?'linked':'managed',importMode:mode,sourceRoot:root,sourceRel:rel,filePath,fileExists:true,sha256:check.sha256,bytes:check.bytes,ext:extensionOf(formatName),addedAt:Date.now(),downloadable:false};
   if(classifyAsset(asset).kind==='hdris')asset.assetType='env';
   // 批量模式：只验资产、不落库，留给 flush 一次提交。
   if(batch){
    batch.staged.push(asset);
    batch.hashes.set(`${asset.sha256}:${asset.bytes}`,asset);
    // 只登记「为本次导入临时落盘的副本」；linked 模式下删它不影响用户原文件。
    // ownedCopy 由拖入管道显式声明（它自己写的文件，批次报废时可以删）；没有这个标记时
    // 绝不按路径猜 —— 导入文件夹的 linked 资产 filePath 就是用户原文件，猜错等于删用户素材。
    const dir=path.dirname(filePath);
    if(mode==='linked'&&ownedCopy)batch.files.add(filePath);
    else if(mode==='linked'&&path.basename(dir).startsWith('drop-'))batch.dirs.add(dir);
    return {ok:true,status:'staged',mode,asset};
   }
   const report=await importLibrary({storage,payload:{format:PORTABLE_FORMAT,version:PORTABLE_VERSION,assets:[asset]},mode:'merge',actor:'local-file-import'});
   if(!report)throw reject('资产入库失败',409);
   // 剪切（move）：入库成功之后才删原件。删除失败也绝不回滚已入库的副本 ——
   // 宁可原件和副本都在（用户自己再删），也不能两头都没有。
   let sourceRemoved=false,warning='';
   if(mode==='move'){
    try{
     await fs.rm(source,{force:true});
     sourceRemoved=true;
    }catch(error){
     warning=`已复制入库，但删除原件失败：${error.message}。原件仍在 ${source}`;
    }
   }
   // 提交后取消不能撤销已提交事务；广播失败也不能清掉成功托管的原件。
   saveSidecar(asset);
   try{onImported(asset);}catch{}
   return {ok:true,status:'imported',mode,asset,report,...(mode==='move'?{sourceRemoved,warning}:{})};
  } catch(error) {
   if(created){await fs.rm(filePath,{force:true}).catch(()=>{});await pruneEmptyDirs(storedDir,managedRoot);}
   if(registered)importRoots.remove(managedRoot);
   throw error;
  }
 }
 async function relink(input,signal) {
  const {uid,folder,rel}=input||{};
  if(typeof uid!=='string'||!/^[a-f0-9]{32}$/.test(uid))throw reject('资产编号无效');
  const {root,source,check}=await validateSource(folder,rel,signal);
  const result=await storage.withDbWrite(conn=>{
   cancelled(signal);
   const row=conn.all('SELECT uid,state,payload FROM assets WHERE uid = ?',[uid])[0];
   if(!row||row.state!=='active')throw reject('仅可重新定位活跃链接资产',409);
   const asset=JSON.parse(row.payload);
   if(asset.storageMode!=='linked')throw reject('仅可重新定位链接资产',409);
   if(!asset.sha256||asset.sha256!==check.sha256||asset.bytes!==check.bytes)throw reject('新位置内容与原资产不一致',409);
   const occupied=conn.all("SELECT uid,payload FROM assets WHERE state = 'active' AND uid <> ?",[uid])
    .some(other=>{const model=JSON.parse(other.payload);return model.storageMode==='linked'&&model.filePath===source;});
   if(occupied)throw reject('新位置已被其他链接资产引用',409);
   const relocated=locationModel(asset,{path:root,rel:rel.split(/[\\/]/).join('/'),availability:'online'});
   const patch={filePath:source,sourceRoot:root,sourceRel:rel,localRoot:root,localRel:relocated.localRel,fileExists:true,url:relocated.url,previewUrl:relocated.previewUrl,thumbnail:relocated.thumbnail};
   conn.rebindFileLocation({...asset,...patch});
   const applied=conn.applyAssetOps([{op:'asset:patch',uid,patch}],{actor:'local-file-relink'});
   if(applied.applied!==1||applied.conflicts?.length)throw reject('重新定位提交冲突',409);
   return {...asset,...patch,uid};
  });
  if(!result)throw reject('资产库内核不可用',409);
  allowLocalRoot(root);saveSidecar(result);try{onImported(result);}catch{}
  return {ok:true,status:'relinked',asset:result};
 }
 function enqueue(fn){const pending=queue.then(fn);queue=pending.catch(()=>{});return pending;}
// 启动期清一次「落了盘但没入库」的副本：进程中途崩掉时，那批文件等不到 flush，
// 库里也没有任何资产记录指向它们，不扫就永远占着磁盘。两类结构分别处理：
//   旧：imports/drop-<hex>/ 是批次独占目录 → 整目录删；
//   新：imports/<日期>/<原文件夹>/ 是多个批次共用的 → 只删「无记录引用 + 超龄」的单个文件。
// 判据一律收紧，读不到资产表就一个都不删。
async function sweepOrphanDirs({olderThanMs = 60 * 60 * 1000} = {}) {
 const imports = path.join(dataDir, 'imports');
 let names = [];
 try { names = await fs.readdir(imports); } catch { return {removed: 0, kept: 0}; }
 const legacy = names.filter(name => /^drop-[0-9a-f]+$/i.test(name));
 const dated = names.filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));
 if (!legacy.length && !dated.length) return {removed: 0, kept: 0};
 let rows;
 try { rows = await storage.withDb(conn => conn.all('SELECT payload FROM assets')); } catch { rows = null; }
 // 读不到资产表就宁可不删：这个清理是省磁盘，不是修数据，删错了没法还原。
 if (!rows) return {removed: 0, kept: legacy.length + dated.length};
 const used = new Set(), usedFiles = new Set();
 const norm = value => { try { return path.resolve(String(value)).toLowerCase(); } catch { return ''; } };
 for (const row of rows) {
  try {
   const model = JSON.parse(row.payload);
   const match = /[\\/](drop-[0-9a-f]+)[\\/]/i.exec(String(model.filePath || model.sourceRel || ''));
   if (match) used.add(match[1]);
   if (model.filePath) usedFiles.add(norm(model.filePath));
  } catch { /* 坏记录不参与判断 */ }
 }
 const now = Date.now();
 let removed = 0, kept = 0;
 for (const name of legacy) {
  if (used.has(name)) { kept++; continue; }
  const full = path.join(imports, name);
  let stat;
  try { stat = await fs.lstat(full); } catch { continue; }
  if (!stat.isDirectory() || now - Number(stat.mtimeMs || 0) < olderThanMs) { kept++; continue; }
  try { await fs.rm(full, {recursive: true, force: true}); removed++; } catch { kept++; }
 }
 // 新结构：日期目录本身不删（可能还有别的批次的东西），只清没被任何记录引用的文件。
 for (const name of dated) {
  const base = path.join(imports, name);
  const dirs = [];
  const walk = async dir => {
   let entries;
   try { entries = await fs.readdir(dir, {withFileTypes: true}); } catch { return; }
   dirs.push(dir);
   for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(full); continue; }
    if (!entry.isFile() || usedFiles.has(norm(full))) { kept++; continue; }
    let stat;
    try { stat = await fs.lstat(full); } catch { continue; }
    if (now - Number(stat.mtimeMs || 0) < olderThanMs) { kept++; continue; }
    try { await fs.rm(full, {force: true}); removed++; } catch { kept++; }
   }
  };
  await walk(base);
  // 自底向上收空目录（先深后浅）；日期目录本身留着，别的批次可能刚 mkdir 还没写文件。
  for (const dir of dirs.reverse()) {
   if (path.resolve(dir) === path.resolve(base)) continue;
   try { await fs.rmdir(dir); } catch { /* 非空就留着 */ }
  }
 }
 return {removed, kept};
}
 // flush / abort 也走同一条队列：不能和还在飞的 importFile 抢 staged 数组。
 function flushBatch(token){return enqueue(async()=>{
  const batch=batches.get(token);
  batches.delete(token);
  if(!batch||!batch.staged.length)return {ok:true,applied:0,assets:[]};
  try{
   const report=await importLibrary({storage,payload:{format:PORTABLE_FORMAT,version:PORTABLE_VERSION,assets:batch.staged},mode:'merge',actor:'local-file-import-batch'});
   if(!report)throw reject('资产入库失败',409);
   for(const staged of batch.staged) saveSidecar(staged);
   try{onImported(batch.staged[0]);}catch{}
   return {ok:true,applied:Number(report.added)||0,conflicts:Number(report.conflicts)||0,
    assets:batch.staged.map(({uid,name,bytes,ext})=>({uid,name,bytes,ext}))};
  }catch(error){await sweepBatch(batch);throw error;}
 })}
 function abortBatch(token){return enqueue(async()=>{
  const batch=batches.get(token);
  batches.delete(token);
  if(batch)await sweepBatch(batch);
  return {ok:true,aborted:Boolean(batch)};
 })}
 return {importFile(input,{signal}={}){return enqueue(()=>execute(input,signal));},
  relinkFile(input,{signal}={}){return enqueue(()=>relink(input,signal));},
  flushBatch,abortBatch,sweepOrphanDirs};
}
