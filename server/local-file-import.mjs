// 单文件导入；沿用 Serpent prepareOrExecuteImport 的 duplicate=skip/name=keep-both，
// 适配 Eagle 的复制→portable merge 入库，不覆盖或移动源文件。
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {formatKind} from '../src/library/format-registry.js';
import {preflightLocalFiles} from './local-import-preflight.mjs';
import {importLibrary,PORTABLE_FORMAT,PORTABLE_VERSION} from './library-portable.mjs';

const reject = (message,status=400) => Object.assign(Error(message),{status});
const cancelled = signal => {if(signal?.aborted)throw Object.assign(Error('导入已取消'),{name:'AbortError'});};

export function createLocalFileImporter({storage,importRoots,dataDir,allowLocalRoot=()=>{},onImported=()=>{}}) {
 let queue=Promise.resolve();
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
  const {folder,rel,mode,duplicate='skip',nameConflict='keep-both'}=input||{};
  if(!['linked','managed'].includes(mode)||!['skip','keep-both'].includes(duplicate)||nameConflict!=='keep-both')throw reject('导入模式或冲突策略无效');
  const {root,source,check}=await validateSource(folder,rel,signal);
  const candidates=await storage.withDb(conn=>conn.all("SELECT uid, payload FROM assets WHERE state = 'active'"));
  if(!candidates)throw reject('资产库内核不可用',409);
  const known=candidates.flatMap(row=>{try{return [{...JSON.parse(row.payload),uid:row.uid}];}catch{return [];}});
  const samePath=known.find(item=>item.storageMode==='linked'&&item.filePath===source);
  const exact=known.filter(item=>item.sha256===check.sha256&&item.bytes===check.bytes);
  if(mode==='linked'&&samePath)return {ok:true,status:'skipped',reason:'same-linked-path',mode,asset:samePath};
  if(exact.length&&duplicate==='skip')return {ok:true,status:'skipped',reason:'exact-duplicate',mode,asset:exact[0],matches:exact.map(({uid,name})=>({uid,name}))};
  const uid=randomBytes(16).toString('hex');
  const imports=path.join(dataDir,'imports'),owned=path.join(imports,uid);
  let filePath=source,created=false,registered=false;
  try {
   if(mode==='managed') {
    await fs.mkdir(imports,{recursive:true});
    if((await fs.lstat(imports)).isSymbolicLink()||path.resolve(await fs.realpath(imports))!==path.resolve(imports))throw reject('托管目录不允许链接',403);
    await fs.mkdir(owned);created=true;
    const safe=path.basename(source).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,180)||'asset';
    filePath=path.join(owned,safe);
    await fs.copyFile(source,filePath,constants.COPYFILE_EXCL);
    cancelled(signal);
    const checks=await preflightLocalFiles({files:[source,filePath],signal});
    if(checks.some(row=>row.sha256!==check.sha256||row.bytes!==check.bytes))throw reject('复制期间源文件变化或校验失败',409);
    registered=!importRoots.list().includes(imports);
    importRoots.add(imports);allowLocalRoot(imports);
   }
   cancelled(signal);
   if(mode==='linked')allowLocalRoot(root);
   const locationRoot=mode==='managed'?imports:root,locationRel=path.relative(locationRoot,filePath).split(path.sep).join('/');
   const query=`root=${encodeURIComponent(locationRoot)}&rel=${encodeURIComponent(locationRel)}`;
   const asset={uid,url:`/api/local/file?${query}`,previewUrl:`/api/local/file?${query}`,thumbnail:`/api/local/thumb?w=512&${query}`,assetType:formatKind(path.basename(source)),localRoot:locationRoot,localRel:locationRel,name:path.basename(source),platform:'local',source:'local-import',storageMode:mode,sourceRoot:root,sourceRel:rel,filePath,fileExists:true,sha256:check.sha256,bytes:check.bytes,ext:path.extname(source).slice(1).toLowerCase(),addedAt:Date.now(),downloadable:false};
   const report=await importLibrary({storage,payload:{format:PORTABLE_FORMAT,version:PORTABLE_VERSION,assets:[asset]},mode:'merge',actor:'local-file-import'});
   if(!report)throw reject('资产入库失败',409);
   // 提交后取消不能撤销已提交事务；广播失败也不能清掉成功托管的原件。
   try{onImported(asset);}catch{}
   return {ok:true,status:'imported',mode,asset,report};
  } catch(error) {
   if(created)await fs.rm(owned,{recursive:true,force:true});
   if(registered)importRoots.remove(imports);
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
   const query=`root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel.split(/[\\/]/).join('/'))}`;
   const patch={filePath:source,sourceRoot:root,sourceRel:rel,localRoot:root,localRel:rel.split(/[\\/]/).join('/'),fileExists:true,url:`/api/local/file?${query}`,previewUrl:`/api/local/file?${query}`,thumbnail:`/api/local/thumb?w=512&${query}`};
   const applied=conn.applyAssetOps([{op:'asset:patch',uid,patch}],{actor:'local-file-relink'});
   if(applied.applied!==1||applied.conflicts?.length)throw reject('重新定位提交冲突',409);
   return {...asset,...patch,uid};
  });
  if(!result)throw reject('资产库内核不可用',409);
  allowLocalRoot(root);try{onImported(result);}catch{}
  return {ok:true,status:'relinked',asset:result};
 }
 function enqueue(fn){const pending=queue.then(fn);queue=pending.catch(()=>{});return pending;}
 return {importFile(input,{signal}={}){return enqueue(()=>execute(input,signal));},relinkFile(input,{signal}={}){return enqueue(()=>relink(input,signal));}};
}
