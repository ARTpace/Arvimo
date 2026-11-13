import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {DownloadManager} from '../server/downloads.mjs';import {createLibraryServer} from '../server/library.mjs';
async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'sfx-blender-send-'));}
async function manager(base,blenderImporter){return new DownloadManager({dataDir:path.join(base,'state'),defaultFolder:path.join(base,'downloads'),browser:()=>'/fixture/browser',blender:()=>'/fixture/blender',blenderImporter}).init();}
const importer=calls=>(file,{blender})=>{calls.push({file,blender:blender()});return {ok:true,mode:'existing-blender',file:path.join(file,'model.glb'),imported:1};};
/** 造一条「已保存到本地」的任务：目录里放一个 GLB，file 为 false 时模拟文件被删掉。 */
async function savedJob(m,{state='saved',file=true}={}){
 const dir=path.join(m.defaultFolder,'fixture-model');
 await fs.mkdir(dir,{recursive:true});
 if(file)await fs.writeFile(path.join(dir,'model.glb'),'glTF');
 const job={uid:'u'.repeat(32),id:randomUUID(),name:'Fixture',state,filePath:dir,options:{output:'folder',format:'fbx'},downloadDir:m.defaultFolder,logs:[]};
 m.jobs.push(job);m.save();return job;
}
test('已下载到本地的模型会被交给已打开的 Blender，并记录结果',async()=>{const d=await temp();let m;try{
 const calls=[];m=await manager(d,importer(calls));const job=await savedJob(m);
 const result=await m.sendBlender(job.id);
 assert.equal(result.ok,true);assert.equal(result.jobs.length,1);
 assert.equal(calls.length,1);assert.equal(path.resolve(calls[0].file),path.resolve(job.filePath));
 assert.equal(job.blender.ok,true);assert.match(job.message,/Blender/);
 assert.ok(job.logs.some(l=>l.includes('已发送到已打开的 Blender')));
}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('没有下载到本地的模型不能发送：不进队列，也不启动 Blender',async()=>{const d=await temp();let m;try{
 const calls=[];m=await manager(d,importer(calls));
 const queued=await savedJob(m,{state:'queued'});
 await assert.rejects(()=>m.sendBlender(queued.id),/先导出到本地/);
 const failed=await savedJob(m,{state:'failed'});
 await assert.rejects(()=>m.sendBlender(failed.id),/先导出到本地/);
 await assert.rejects(()=>m.sendBlender(randomUUID()),/任务不存在/);
 assert.equal(calls.length,0);
}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('文件被移走后即使状态仍是已保存也拒绝发送',async()=>{const d=await temp();let m;try{
 const calls=[];m=await manager(d,importer(calls));const job=await savedJob(m);await fs.rm(job.filePath,{recursive:true,force:true});
 await assert.rejects(()=>m.sendBlender(job.id),/先导出到本地/);assert.equal(calls.length,0);
}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('桥接失败保留真实原因，不会假装发送成功',async()=>{const d=await temp();let m;try{
 m=await manager(d,()=>{throw Error('未发现正在监听的 AssetVault Blender Bridge');});
 const job=await savedJob(m);
 await assert.rejects(()=>m.sendBlender(job.id),/Blender Bridge/);
 assert.match(job.warning,/Blender Bridge/);assert.equal(job.blender,undefined);
}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('HTTP 接口只在文件存在时发送，其余按错误处理',async()=>{const d=await temp();let m,server;try{
 m=await manager(d,importer([]));server=createLibraryServer({downloads:m});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`,headers={'X-SFX-Local':'1','Content-Type':'application/json'};
 const ready=await savedJob(m),missing=await savedJob(m,{file:true,state:'queued'});
 const ok=await fetch(`${base}/api/downloads/tasks/${ready.id}/send-blender`,{method:'POST',headers,body:'{}'});
 assert.equal(ok.status,200);const okData=await ok.json();assert.equal(okData.ok,true);assert.equal(okData.jobs[0].blender.ok,true);
 const bad=await fetch(`${base}/api/downloads/tasks/${missing.id}/send-blender`,{method:'POST',headers,body:'{}'});
 assert.equal(bad.status,400);assert.match((await bad.json()).error,/先导出到本地/);
 const anon=await fetch(`${base}/api/downloads/tasks/${ready.id}/send-blender`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(anon.status,403);
}finally{await m?.close();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());await fs.rm(d,{recursive:true,force:true});}});
