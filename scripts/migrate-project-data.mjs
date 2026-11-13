// Explicit one-time relocation: preserve profiles, verify SHA-256 before removing originals.
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolveUserPaths} from '../server/data-dir.mjs';
import {lockOwnerAlive} from '../server/process-lock.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
async function inventory(dir,rel=''){
 const files=[];
 for(const e of await fs.readdir(path.join(dir,rel),{withFileTypes:true})){
  const key=path.join(rel,e.name);
  if(e.isSymbolicLink())throw Error(`Linked entry: ${key}`);
  if(e.isDirectory())files.push(...await inventory(dir,key));
  else if(e.isFile())files.push({key,size:(await fs.stat(path.join(dir,key))).size});
 }
 return files;
}
async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function mergeLegacyLibrary(current,old){
 const result={...old,...current};
 const a=JSON.parse(old['sfx-library-v2']||'{}'),b=JSON.parse(current['sfx-library-v2']||'{}');
 const trash=new Set((b.trashed||[]).map(m=>m.uid));
 const models=new Map((a.models||[]).filter(m=>!trash.has(m.uid)).map(m=>[m.uid,m]));
 for(const m of b.models||[])models.set(m.uid,{...models.get(m.uid),...m});
 const state={...a,...b,models:[...models.values()],favorites:[...new Set([...(a.favorites||[]),...(b.favorites||[])])].filter(id=>!trash.has(id))};
 for(const key of ['aiTags','userMeta','userTags'])state[key]={...a[key],...b[key]};
 result['sfx-library-v2']=JSON.stringify(state);delete result['sfx-local-index-v1'];
 return result;
}
export async function migrateProjectData(project,paths,{apply=false}={}){
 const actual=await fs.realpath(project),user=await fs.realpath(paths.base);
 if(user===actual||user.startsWith(actual+path.sep))throw Error('Destination must be outside the project');
 const label='project-'+createHash('sha256').update(actual.toLowerCase()).digest('hex').slice(0,12);
 const archive=path.join(user,'legacy-imports',label),assets=path.join(paths.downloadDir,label);
 const plans=[];
 for(const name of ['downloads','.assetvault','data']){
  const source=path.join(actual,name),destination=name==='downloads'?assets:path.join(archive,name);
  let stat;try{stat=await fs.lstat(source);}catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(source)!==source)throw Error(`Unsafe source: ${source}`);
  if(destination===source||destination.startsWith(source+path.sep))throw Error('Destination inside source');
  plans.push({source,destination,files:await inventory(source)});
 }
 const summary=()=>plans.map(p=>({source:p.source,destination:p.destination,files:p.files.length,bytes:p.files.reduce((n,f)=>n+f.size,0)}));
 if(!apply)return summary();
 for(const folder of [paths.dataDir,path.join(actual,'.assetvault')]){
  const owner=await readJson(path.join(folder,'manager.lock'));
  if(owner&&lockOwnerAlive(owner))throw Error('Close the AssetVault backend before migration');
 }
 await fs.mkdir(archive,{recursive:true});
 // Do not overwrite a partial prior migration: identical files may be reused, conflicts stop.
 for(const p of plans){
  console.log(`Copying and verifying ${p.source} (${p.files.length} files)`);
  for(const f of p.files){
   const from=path.join(p.source,f.key),to=path.join(p.destination,f.key);
   await fs.mkdir(path.dirname(to),{recursive:true});
   try{await fs.copyFile(from,to,1);}catch(e){if(e.code!=='EEXIST')throw e;}
   if(await hash(from)!==await hash(to))throw Error(`Hash mismatch; originals preserved: ${from}`);
  }
 }
 await fs.mkdir(paths.dataDir,{recursive:true});
 for(const name of ['library-state.json','tasks.json'])try{await fs.copyFile(path.join(paths.dataDir,name),path.join(archive,'current-'+name),1);}catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}
 function rewrite(value){
  if(typeof value==='string'){
   const normalized=value.replaceAll('\\','/'),prefix=path.join(actual,'downloads').replaceAll('\\','/');
   if(normalized.toLowerCase()===prefix.toLowerCase()||normalized.toLowerCase().startsWith(prefix.toLowerCase()+'/'))return assets+normalized.slice(prefix.length).replaceAll('/',path.sep);
   return value;
  }
  if(Array.isArray(value))return value.map(rewrite);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)]));
  return value;
 }
 const old=await readJson(path.join(archive,'.assetvault/library-state.json'));
 if(old){
  for(const [key,value] of Object.entries(old))if(typeof value==='string')try{old[key]=JSON.stringify(rewrite(JSON.parse(value)));}catch{}
  const file=path.join(paths.dataDir,'library-state.json');
  const merged=mergeLegacyLibrary(await readJson(file)||{},old);
  await fs.writeFile(file+'.migration',JSON.stringify(merged));await fs.rename(file+'.migration',file);
 }
 const oldTasks=await readJson(path.join(archive,'.assetvault/tasks.json'));
 const taskFile=path.join(paths.dataDir,'tasks.json'),currentTasks=await readJson(taskFile);
 if(oldTasks&&currentTasks){
  const jobs=new Map(oldTasks.jobs.filter(j=>['saved','failed','cancelled','interrupted'].includes(j.state)).map(j=>[j.id,rewrite(j)]));
  for(const job of currentTasks.jobs)jobs.set(job.id,rewrite(job));
  await fs.writeFile(taskFile+'.migration',JSON.stringify({...currentTasks,jobs:[...jobs.values()]}));await fs.rename(taskFile+'.migration',taskFile);
 }
 // Recheck every original before removing its exact, fixed project child directory.
 for(const p of plans){
  if(JSON.stringify(await inventory(p.source))!==JSON.stringify(p.files))throw Error('Source changed; originals preserved');
  for(const f of p.files)if(await hash(path.join(p.source,f.key))!==await hash(path.join(p.destination,f.key)))throw Error('Source changed; originals preserved');
  if(path.dirname(p.source)!==actual||await fs.realpath(p.source)!==p.source)throw Error('Unsafe source');
  await fs.rm(p.source,{recursive:true,force:false});
  console.log(`Verified and relocated: ${p.source} -> ${p.destination}`);
 }
 const report={migratedAt:new Date().toISOString(),plans:summary()};
 await fs.writeFile(path.join(archive,'migration-report.json'),JSON.stringify(report,null,2));return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 for(const arg of process.argv.slice(2))if(arg!=='--apply')throw Error(`Unknown option: ${arg}`);
 console.log(JSON.stringify(await migrateProjectData(root,resolveUserPaths(),{apply:process.argv.includes('--apply')}),null,2));
}
