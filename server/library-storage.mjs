import fs from 'node:fs/promises';
import path from 'node:path';

const allowed=new Set(['sfx-library-v2','sfx-discovery-v1','sfx-library-ui']);
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
   return {values,recovered:jobs.map(job=>({...job,addedAt:job.finishedAt||Date.now(),downloadable:true}))};
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
