import path from 'node:path';
import fs from 'node:fs/promises';
import {localLocator} from './file-locations.mjs';
import {checkedOrganizePath} from './file-organize-preflight.mjs';
import {preflightLocalFiles} from './local-import-preflight.mjs';
import {requireFileWriteProtocol} from './file-write-protocol.mjs';
import {MAIN_STATE_KEY,USER_STATE_KEY} from './library-schema.mjs';

const fail=message=>Object.assign(Error(message),{status:409});
const key=value=>process.platform==='win32'?value.toLowerCase():value;
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;

/** 显式迁移旧路径，只补位置，不重键、不合并重复资产、不搬原件。 */
export function createLocationMigration({storage,importRoots,beforeMigrate=async()=>{},onChanged=()=>{}}){
 function rootOf(folder){
  if(typeof folder!=='string'||!path.isAbsolute(folder))throw fail('请选择已登记的导入目录');
  const root=path.resolve(folder);
  if(!importRoots.list().some(item=>key(path.resolve(item))===key(root)))throw fail('仅支持已登记的导入目录');
  return root;
 }
 function locatorOf(model){
  const local=localLocator(model);
  if(local)return path.join(local.root,...local.rel.split('/'));
  return typeof model.filePath==='string'&&path.isAbsolute(model.filePath)&&!model.filePath.includes('\0')?path.resolve(model.filePath):null;
 }
 function snapshot(conn,root){
  const records=[],byPath=new Map();let cursor=0,scanned=0,truncated=false;
  // ponytail: 显式审计按 rowid 分页；超过 5 万记录先拒绝迁移，避免假装已完成全库冲突核查。
  while(true){
   const rows=conn.all('SELECT rowid,uid,payload,rev FROM assets WHERE rowid>? ORDER BY rowid LIMIT 256',[cursor]);
   if(!rows.length)break;
   for(const row of rows){
    if(++scanned>50000){truncated=true;break;}
    cursor=row.rowid;let model;try{model=JSON.parse(row.payload);}catch{continue;}
    if(!model||typeof model!=='object')continue;
    const full=locatorOf(model);if(!full)continue;
    const entry={...row,model,full};
    const group=byPath.get(key(full))||[];group.push(entry);byPath.set(key(full),group);
    const rel=path.relative(root,full);
    if(rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))records.push({...entry,rel:rel.split(path.sep).join('/')});
   }
   if(truncated)break;
  }
  const locations=conn.all('SELECT l.asset_uid,l.rel,r.path FROM file_locations l JOIN file_roots r ON r.root_id=l.root_id');
  const owned=new Set(locations.map(item=>item.asset_uid));
  for(const item of locations){
   const full=key(path.resolve(item.path,...item.rel.split('/'))),group=byPath.get(full)||[];
   if(!group.some(row=>row.uid===item.asset_uid))group.push({uid:item.asset_uid});byPath.set(full,group);
  }
  const items=records.filter(row=>!owned.has(row.uid)).map(row=>{
   let code='ready';
   if(byPath.get(key(row.full)).length>1)code='path-conflict';
   else if(!localLocator({localRoot:root,localRel:row.rel}))code='invalid-path';
   else if(row.model.localRoot!==undefined||row.model.localRel!==undefined)code='invalid-legacy-location';
   else if(!/^[a-f0-9]{64}$/i.test(row.model.sha256||''))code='missing-sha256';
   return {...row,code};
  });
  return {items,scanned:Math.min(scanned,50000),truncated};
 }
 async function inspect({folder,offset=0,limit=100}={}){
  const root=rootOf(folder),start=Math.max(0,Math.floor(Number(offset)||0)),size=Math.max(1,Math.min(100,Math.floor(Number(limit)||100)));
  return storage.withDb(conn=>{
   const report=snapshot(conn,root);
   return {root,scanned:report.scanned,truncated:report.truncated,total:report.items.length,ready:report.truncated?0:report.items.filter(item=>item.code==='ready').length,
    offset:start,limit:size,items:report.items.slice(start,start+size).map(({uid,model,rel,code})=>({uid,name:model.name||path.basename(rel),rel,code}))};
  });
 }
 async function migrate({folder,uids,signal}={}){
  const root=rootOf(folder);
  if(!Array.isArray(uids)||!uids.length||uids.length>20||new Set(uids).size!==uids.length||uids.some(uid=>typeof uid!=='string'||!uid))throw fail('每次请选择 1–20 个不同的资产');
  await beforeMigrate();
  const results=[];
  // 一次备份、逐资产提交；取消或单项失败不撤销此前成功项，重复执行不会重建身份。
  for(const uid of uids){
   if(signal?.aborted)break;
   try{
    const result=await storage.withDbWrite(async conn=>{
     if(conn.all("SELECT 1 FROM file_operations WHERE state IN ('prepared','recovery-required') LIMIT 1").length)throw fail('文件整理有待恢复任务，请先恢复');
     if(!importRoots.list().some(item=>key(path.resolve(item))===key(root)))throw fail('导入目录已被移除');
     const report=snapshot(conn,root);if(report.truncated)throw fail('全库超过 5 万记录，本次审计不完整，禁止迁移');
     const item=report.items.find(row=>row.uid===uid);if(!item||item.code!=='ready')throw fail('记录已变化、已迁移或存在定位问题，请重新检查');
     const file=await checkedOrganizePath(root,item.rel),before=await fs.lstat(file);
     const [checked]=await preflightLocalFiles({files:[file],signal});
     if(checked.sha256!==item.model.sha256.toLowerCase())throw fail('文件内容与旧摘要不一致或不可读取，未认领');
     await checkedOrganizePath(root,item.rel);
     if(!same(before,await fs.lstat(file)))throw fail('文件在检查期间变化，未认领');
     if(signal?.aborted)throw fail('迁移已取消');
     const applied=conn.applyAssetOps([{op:'asset:patch',uid,rev:item.rev,patch:{localRoot:root,localRel:item.rel,fileExists:true}}],{actor:'location-migration',syncBlob:true});
     if(applied.conflicts.length)throw fail('资产版本已变化，未认领');
     const location=conn.all('SELECT location_id FROM file_locations WHERE asset_uid=?',[uid]);
     if(location.length!==1)throw fail('稳定位置认领失败');
     requireFileWriteProtocol(conn);
     return {uid,ok:true,locationId:location[0].location_id};
    });results.push(result);
   }catch(error){results.push({uid,ok:false,error:error.message});if(signal?.aborted)break;}
  }
  if(results.some(item=>item.ok))onChanged();
  return {results,cancelled:!!signal?.aborted};
 }
 async function audit(){return storage.withDb(conn=>{
  const kinds=[['favorite','favorites',false],['manual-tag','userTags',true],['automatic-tag','aiTags',true],['annotation','userMeta',true]];
  const queries=kinds.map(([kind,field,object])=>`SELECT '${kind}' kind,CAST(j.${object?'key':'value'} AS TEXT) uid FROM state_meta s,
   json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '{}' END,'$.${field}') j
   WHERE s.key IN ('${MAIN_STATE_KEY}','${USER_STATE_KEY}') AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.uid=j.${object?'key':'value'})`);
  queries.push("SELECT 'collection' kind,asset_id uid FROM collection_assets c WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.uid=c.asset_id)");
  const union=queries.join(' UNION '),total=conn.all(`SELECT count(*) n FROM (${union})`)[0].n;
  const items=conn.all(`SELECT * FROM (${union}) ORDER BY kind,uid LIMIT 100`);
  const duplicateSnapshotUids=conn.all(`SELECT json_extract(j.value,'$.uid') uid,count(*) copies FROM state_meta s,
   json_each(CASE WHEN json_valid(s.value) THEN s.value ELSE '{}' END,'$.models') j WHERE s.key='sfx-library-v2'
   AND json_valid(j.value) AND json_extract(j.value,'$.uid') IS NOT NULL GROUP BY uid HAVING count(*)>1 LIMIT 100`);
  const malformed=conn.all("SELECT uid FROM assets WHERE NOT json_valid(payload) OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.uid') IS NOT uid LIMIT 100");
  return {readOnly:true,total,items,duplicateSnapshotUids,malformed,limited:total>100,notes:['未知关联保留，不按路径、名称或内容自动合并；扫描卡片尚未认领时也可能在此出现。']};
 });}
 return {inspect,migrate,audit};
}
