import fs from 'node:fs/promises';
import path from 'node:path';

const allowed=new Set(['sfx-library-v2','sfx-discovery-v1','sfx-library-ui']);
// Export manifests identify the asset but older ones omit its platform cover.
// Reuse saved catalog metadata without network requests or importing unrelated assets.
export async function restoreLibraryCovers(values,recovered=[],cacheDir){
 const result={...values};let state;
 try{state=JSON.parse(result['sfx-library-v2']||'{}');}catch{return {values:result,recovered};}
 const models=Array.isArray(state.models)?state.models:[];
 const missing=new Set([...models,...recovered].filter(m=>m?.uid&&!m.thumbnail).map(m=>m.uid));
 if(!missing.size)return {values:result,recovered};
 const source=model=>String(model?.url||model?.artworkUrl||'').replace(/\/$/,'');
 const wantedSources=new Set([...models,...recovered].filter(m=>missing.has(m.uid)).map(source).filter(Boolean));
 const covers=new Map(),sourceCovers=new Map();
 const remember=model=>{if(typeof model?.thumbnail==='string'&&model.thumbnail.startsWith('https://')){covers.set(model.uid,model.thumbnail);if(source(model))sourceCovers.set(source(model),model.thumbnail);}};
 for(const model of [...models,...recovered])remember(model);
 let files=[];try{files=await fs.readdir(cacheDir);}catch{}
 for(const name of files){
  if([...models,...recovered].filter(m=>missing.has(m.uid)).every(m=>covers.has(m.uid)||sourceCovers.has(source(m))))break;
  if(!/^[a-f0-9]{64}$/.test(name))continue;
  try{
   const file=path.join(cacheDir,name);if((await fs.stat(file)).size>12*1024*1024)continue;
   const data=JSON.parse(await fs.readFile(file,'utf8'));
   for(const model of data.models||[])if(missing.has(model.uid)||wantedSources.has(source(model)))remember(model);
  }catch{/* A damaged cache entry must not prevent opening the library. */}
 }
 const fill=model=>!model.thumbnail&&(covers.has(model.uid)||sourceCovers.has(source(model)))?{...model,thumbnail:covers.get(model.uid)||sourceCovers.get(source(model))}:model;
 if(models.some(m=>fill(m)!==m))result['sfx-library-v2']=JSON.stringify({...state,models:models.map(fill)});
 return {values:result,recovered:recovered.map(fill)};
}
export function createLibraryStorage(dataDir,downloads){
 const file=path.join(dataDir,'library-state.json');
 let queue=Promise.resolve();
 async function read(){
  try{return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw Error('资产库状态无法读取，已保留原文件，请检查 library-state.json');return {};}
 }
 return {
  async load(){
   await queue;
   const values=await read();
   const jobs=(downloads?.snapshot().jobs||[]).filter(job=>job.state==='saved'&&job.fileExists);
   return restoreLibraryCovers(values,jobs.map(job=>({...job,addedAt:job.finishedAt||Date.now(),downloadable:true})),path.join(dataDir,'http-cache','json'));
  },
  save(values){
   if(!values||typeof values!=='object'||Array.isArray(values)||Object.entries(values).some(([key,value])=>!allowed.has(key)||typeof value!=='string'||value.length>4*1024*1024))throw Error('资产库状态格式无效');
   const write=queue.then(async()=>{
    const current=await read();
    await fs.mkdir(dataDir,{recursive:true});
    await fs.writeFile(file+'.tmp',JSON.stringify({...current,...values}));
    await fs.rename(file+'.tmp',file);
   });
   queue=write.catch(()=>{});return write;
  }
 };
}
