// Project-aware migration: move whole asset deliveries and update recorded absolute paths.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assetStorageCategory} from '../server/asset-storage.mjs';
import {lockOwnerAlive} from '../server/process-lock.mjs';

const inside=(root,file)=>{const relative=path.relative(root,file);return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);};
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function assertOffline(dataDir){
 const file=path.join(dataDir,'manager.lock');
 if(fs.existsSync(file)&&lockOwnerAlive(readJson(file)))throw Error('请先退出 AssetVault 后台，再整理下载目录');
}
function persist(file,data){
 const temp=file+'.migration-'+randomUUID();
 fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
 fs.renameSync(temp,file);
}
function replacePaths(value,moves){
 if(typeof value==='string'){
  for(const {from,to} of moves){if(path.isAbsolute(value)&&(path.resolve(value)===from||inside(from,path.resolve(value))))return path.join(to,path.relative(from,path.resolve(value)));}
  return value;
 }
 if(Array.isArray(value))return value.map(item=>replacePaths(item,moves));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replacePaths(item,moves)]));
 return value;
}

export function planOrganization(root,store){
 root=fs.realpathSync(root);
 const moves=[],skipped=[];
 const categories=new Set(['模型','材质','环境','图片','资源包']);
 for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(categories.has(entry.name))continue;
  const from=path.join(root,entry.name);
  if(entry.isSymbolicLink()||entry.name.startsWith('.')||!entry.isDirectory()&&!/\.zip$/i.test(entry.name)){skipped.push(entry.name);continue;}
  let info={};try{info=readJson(path.join(from,'info.json'));}catch{}
  const job=store.jobs.find(job=>job.filePath&&path.resolve(job.filePath)===from);
  const category=assetStorageCategory({...info,...job,name:job?.name||info.title||info.assetId||entry.name});
  const to=path.join(root,category,entry.name);
  if(!inside(root,to)||fs.existsSync(to))throw Error(`目标存在或超出下载目录，未移动：${to}`);
  moves.push({from,to,category});
 }
 return {root,moves,skipped};
}

export function organizeDownloads({root,dataDir,apply=false}){
 dataDir=fs.realpathSync(dataDir);assertOffline(dataDir);
 const storePath=path.join(dataDir,'tasks.json');
 const original=readJson(storePath),plan=planOrganization(root,original);
 if(!apply)return plan;
 const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();
 const backup=path.join(dataDir,`tasks.before-organization-${id}.json`);
 const journalPath=path.join(dataDir,`organization-${id}.json`);
 fs.copyFileSync(storePath,backup,fs.constants.COPYFILE_EXCL);
 const journal={version:1,root:plan.root,storePath,backup,state:'moving',moves:plan.moves.map(move=>({...move,state:'pending'})),skipped:plan.skipped};
 persist(journalPath,journal);
 try{
  for(const move of journal.moves){
   assertOffline(dataDir);
   if(!inside(plan.root,move.from)||!inside(plan.root,move.to)||fs.existsSync(move.to))throw Error('迁移目标冲突');
   fs.mkdirSync(path.dirname(move.to),{recursive:true});
   // Save intent before rename so interrupted moves can be recovered.
   move.state='moving';persist(journalPath,journal);
   fs.renameSync(move.from,move.to);move.state='moved';persist(journalPath,journal);
  }
  const updated=replacePaths(original,journal.moves);
  updated.jobs=updated.jobs.map((job,index)=>{
   const move=journal.moves.find(move=>original.jobs[index].filePath&&path.resolve(original.jobs[index].filePath)===move.from);
   return move?{...job,downloadRoot:plan.root,storageCategory:move.category,downloadDir:path.dirname(move.to)}:job;
  });
  persist(storePath,updated);journal.state='complete';persist(journalPath,journal);
 }catch(error){journal.state='needs_recovery';journal.error=error.message;persist(journalPath,journal);throw Error(`${error.message}；恢复日志：${journalPath}`);}
 return {...plan,journalPath,backup};
}

export function rollbackOrganization(journalPath){
 const journal=readJson(journalPath);assertOffline(path.dirname(journal.storePath));
 if(journal.state==='rolled_back')return;
 // Refuse to discard downloads or edits recorded after migration.
 const current=readJson(journal.storePath),before=readJson(journal.backup);
 if(journal.state==='complete'){
  const expected=replacePaths(before,journal.moves);
  expected.jobs=expected.jobs.map((job,index)=>{
   const move=journal.moves.find(move=>before.jobs[index].filePath&&path.resolve(before.jobs[index].filePath)===move.from);
   return move?{...job,downloadRoot:journal.root,storageCategory:move.category,downloadDir:path.dirname(move.to)}:job;
  });
  if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('下载记录在整理后已变化，不能整表回撤，请按日志逐项恢复');
 }
 for(const move of [...journal.moves].reverse()){
  if(!inside(journal.root,move.from)||!inside(journal.root,move.to))throw Error('恢复路径无效');
  if(!fs.existsSync(move.to))continue;
  if(fs.existsSync(move.from))throw Error(`原位置已有内容，停止回撤：${move.from}`);
  fs.renameSync(move.to,move.from);
 }
 persist(journal.storePath,before);journal.state='rolled_back';persist(journalPath,journal);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args[0]==='--rollback'){rollbackOrganization(path.resolve(args[1]));console.log('已回撤整理');}
 else{
  if(!args[0]||!args[1])throw Error('用法：node scripts/organize-downloads.mjs <下载目录> <数据目录> [--apply]');
  console.log(JSON.stringify(organizeDownloads({root:args[0],dataDir:args[1],apply:args.includes('--apply')}),null,2));
 }
}
