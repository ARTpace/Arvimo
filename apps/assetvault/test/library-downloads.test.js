import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {DownloadManager,cleanFilename} from '../server/downloads.mjs';import {commitArchive} from '../server/local-commit.mjs';import {verifyArchive} from '../server/archive.mjs';import {createLibraryServer} from '../server/library.mjs';import {fixtureZip,zipEntries,writeFixtureFolder,FIXTURE_UID as uid} from './download-fixture.mjs';
const model={uid,name:'Fixture',author:'Test author'};
const wait=async fn=>{const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw Error('Test timeout');await new Promise(r=>setTimeout(r,15));}};
async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'sfx-dm-test-'));}
async function writeFixture(job){if(job.options.output==='folder')await writeFixtureFolder(job.output,{uid:job.uid});else await fs.writeFile(job.output,fixtureZip(job.uid));return {zipName:job.options.output==='folder'?'fixture':'fixture.zip'};}
const fakeFbxConverter=async({glb,outDir})=>{const file=path.join(outDir,path.basename(glb).replace(/\.glb$/i,'.fbx'));await fs.writeFile(file,'FBX');return {file,name:path.basename(file),bytes:3};};
test('deduplication ignores option ordering and finds saved files behind failed history',async()=>{
 const d=await temp();let m;
 try{
  m=await manager(d);m.start('http://127.0.0.1:1');
  await m.enqueue({authorized:true,models:[model]});
  await wait(()=>m.jobs[0].state==='saved'&&m.workers.size===0);
  const saved=m.jobs[0];
  saved.options=Object.fromEntries(Object.entries(saved.options).reverse());
  assert.equal((await m.enqueue({authorized:true,models:[model]})).duplicates.length,1);
  m.jobs.push({...saved,id:'failed-history',state:'failed',filePath:undefined});
  assert.equal((await m.enqueue({authorized:true,models:[model]})).added.length,0);
  assert.throws(()=>m.action('failed-history','retry'),/已下载/);
  await fs.rm(saved.filePath,{recursive:true,force:true});
  await m.configure({paused:true});
  assert.equal((await m.enqueue({authorized:true,models:[model]})).added.length,1);
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});
async function manager(base,runner){return new DownloadManager({dataDir:path.join(base,'state'),defaultFolder:path.join(base,'downloads'),runner:runner||(async(job,{signal})=>{signal.throwIfAborted();return writeFixture(job);}),browser:()=>'/fixture/browser',fbxConverter:fakeFbxConverter}).init();}
test('snapshot reports an undetectable configured folder until it is set again',async()=>{const d=await temp();let m;try{
  // 资产根第一次启动时会被自动建出来（见下面「资产根还不存在」那条），所以「目录不存在」不再等于
  // 「不可用」。这里用普通文件当父级，mkdir 必然 ENOTDIR —— 等价于移动硬盘拔掉、盘符不存在的情形。
  await fs.writeFile(path.join(d,'blocked'),'x');
  m=await new DownloadManager({dataDir:path.join(d,'state'),defaultFolder:path.join(d,'blocked','downloads'),browser:()=>'/fixture/browser'}).init();const missing=m.snapshot().folderStatus;assert.equal(missing.ok,false);assert.equal(missing.code,'missing');assert.match(missing.message,/保存目录|下载路径/);await m.configure({folder:path.join(d,'chosen-downloads')});const ok=m.snapshot().folderStatus;assert.equal(ok.ok,true);assert.equal(ok.code,'ok');}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('native folder picker result is validated and can create the selected directory',async()=>{const d=await temp();let m;try{const picked=path.join(d,'picked-downloads');m=await new DownloadManager({dataDir:path.join(d,'state'),defaultFolder:path.join(d,'downloads'),folderPicker:async initial=>{assert.equal(path.resolve(initial),path.resolve(m.settings.folder));return picked;},browser:()=>'/fixture/browser'}).init();const result=await m.pickFolder({});assert.equal(result.cancelled,false);assert.equal(result.folder,path.resolve(picked));assert.equal((await fs.stat(picked)).isDirectory(),true);}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('download-to-blender forces a loose GLB export and launches the importer after saving',async()=>{const d=await temp();let m;const launched=[];try{m=await new DownloadManager({dataDir:path.join(d,'state'),defaultFolder:path.join(d,'downloads'),browser:()=>'/fixture/browser',blender:()=>'/fixture/blender',fbxConverter:async({glb,outDir})=>{await fs.writeFile(path.join(outDir,'model.fbx'),'FBX');return {file:path.join(outDir,'model.fbx'),name:'model.fbx',bytes:3};},blenderImporter:(file,{blender})=>{launched.push({file,blender:blender()});return {ok:true,pid:123,file:path.join(file,'model.glb'),blender:blender(),launchedAt:1};},runner:async(job)=>{assert.equal(job.options.output,'folder');assert.equal(job.options.format,'glb');await writeFixtureFolder(job.output,{uid:job.uid});return {zipName:'fixture.zip'};}}).init();m.start('http://127.0.0.1:1');await m.enqueue({authorized:true,openInBlender:true,options:{output:'zip',format:'fbx'},models:[model]});await wait(()=>m.jobs[0].state==='saved');assert.equal(m.jobs[0].openInBlender,true);assert.equal(m.jobs[0].options.output,'folder');assert.equal(m.jobs[0].options.format,'glb');assert.equal(launched.length,1);assert.equal(await fs.stat(path.join(m.jobs[0].filePath,'model.fbx')).then(()=>true,()=>false),false);assert.match(m.jobs[0].message,/Blender/);assert.equal(m.jobs[0].blender.ok,true);}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('ZIP CRC, GLB structure, provenance and SHA256 are verified',async()=>{const d=await temp();try{const p=path.join(d,'ok.zip');await fs.writeFile(p,fixtureZip());const r=await verifyArchive(p,{uid});assert.equal(r.entries,3);assert.equal(r.glbs[0].meshes,1);assert.match(r.sha256,/^[a-f0-9]{64}$/);await assert.rejects(verifyArchive(p,{uid:'a'.repeat(32)}),/不匹配/);const corrupt=fixtureZip();corrupt[55]^=1;await fs.writeFile(p,corrupt);await assert.rejects(verifyArchive(p),/校验失败/);}finally{await fs.rm(d,{recursive:true,force:true});}});
test('unsafe paths and archives without GLB cannot be marked successful',async()=>{const d=await temp();try{const p=path.join(d,'bad.zip');await fs.writeFile(p,zipEntries([['../escape','x']]));await assert.rejects(verifyArchive(p),/不安全/);await fs.writeFile(p,zipEntries([['README.txt','not a model']]));await assert.rejects(verifyArchive(p),/缺少有效/);}finally{await fs.rm(d,{recursive:true,force:true});}});
test('saving never overwrites existing file even with concurrent commits',async()=>{const d=await temp();try{const src=path.join(d,'source');await fs.writeFile(src,'valid');const folder=path.join(d,'folder');const paths=await Promise.all([commitArchive(src,folder,'same.zip'),commitArchive(src,folder,'same.zip')]);assert.notEqual(paths[0],paths[1]);assert.equal(await fs.readFile(paths[0],'utf8'),'valid');assert.equal(cleanFilename('../evil:*?.zip',uid).includes('/'),false);}finally{await fs.rm(d,{recursive:true,force:true});}});
test('authorization required, pause survives reload, duplicate queue is skipped',async()=>{const d=await temp();let m;try{m=await manager(d);await assert.rejects(new DownloadManager({dataDir:m.dataDir,defaultFolder:m.defaultFolder}).init(),/另一个/);await assert.rejects(()=>m.enqueue({models:[model]}),/授权/);await m.configure({paused:true});const r=await m.enqueue({authorized:true,models:[model]});assert.equal(r.added.length,1);assert.equal((await m.enqueue({authorized:true,models:[model]})).duplicates.length,1);await m.close();m=await manager(d);assert.equal(m.settings.paused,true);assert.equal(m.jobs.length,1);m.start('http://127.0.0.1:1');await m.configure({paused:false});await wait(()=>m.jobs[0].state==='saved');assert.equal(m.snapshot().jobs[0].fileExists,true);assert.equal((await m.enqueue({authorized:true,models:[model]})).duplicates.length,1);const forced=await m.enqueue({authorized:true,models:[model],force:true});assert.equal(forced.added.length,1);await wait(()=>m.jobs.every(j=>j.state==='saved'));assert.notEqual(m.jobs[0].filename,m.jobs[1].filename);}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('per-task hold/resume, cancellation and retry are real state transitions',async()=>{const d=await temp();let m;try{m=await manager(d,async(job,{signal})=>{await new Promise((resolve,reject)=>{const t=setTimeout(resolve,200);signal.addEventListener('abort',()=>{clearTimeout(t);reject(signal.reason);},{once:true});});await writeFixture(job);return {zipName:'fixture.zip'};});const id=(await m.enqueue({authorized:true,models:[model]})).added[0];m.action(id,'hold');m.start('http://127.0.0.1:1');assert.equal(m.jobs[0].state,'held');m.action(id,'resume');await wait(()=>m.jobs[0].state==='running');m.action(id,'cancel');await wait(()=>m.jobs[0].state==='cancelled'&&m.workers.size===0);assert.equal(m.jobs[0].filePath,undefined);m.action(id,'retry');await wait(()=>m.jobs[0].state==='saved');assert.equal(m.jobs[0].attempts,2);}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('service shutdown marks active jobs interrupted, never falsely saved',async()=>{const d=await temp();let m;try{m=await manager(d,async(_j,{signal})=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));m.start('http://127.0.0.1:1');await m.enqueue({authorized:true,models:[model]});await m.close();m=await manager(d);assert.equal(m.jobs[0].state,'interrupted');assert.equal(m.jobs[0].filePath,undefined);}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('concurrency cap and global pause apply to queued jobs, not fake active pause',async()=>{const d=await temp();let m,active=0,max=0;try{m=await manager(d,async(job)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,70));await writeFixture(job);active--;return {zipName:'fixture.zip'};});await m.configure({concurrency:2,paused:true});m.start('http://127.0.0.1:1');await m.enqueue({authorized:true,models:[model,{...model,uid:'a'.repeat(32)},{...model,uid:'b'.repeat(32)}]});assert.equal(m.workers.size,0);await m.configure({paused:false});await wait(()=>m.jobs.every(j=>j.state==='saved'));assert.equal(max,2);await assert.rejects(m.configure({concurrency:9}));}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('download HTTP endpoints reject unmarked and cross-origin writes',async()=>{const d=await temp();let m,server;try{m=await manager(d);server=createLibraryServer({downloads:m});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;m.start(base);assert.equal((await fetch(base+'/api/downloads')).status,403);assert.equal((await fetch(base+'/api/downloads/tasks',{method:'POST',headers:{'X-SFX-Local':'1',Origin:'https://evil.test'},body:'{}'})).status,403);const r=await fetch(base+'/api/downloads/tasks',{method:'POST',headers:{'X-SFX-Local':'1'},body:JSON.stringify({authorized:true,models:[model],options:{output:'zip',format:'glb'}})});assert.equal(r.status,200);const id=(await r.json()).added[0];await wait(()=>m.jobs[0].state==='saved');const file=await fetch(`${base}/api/downloads/tasks/${id}/file`);assert.equal(file.status,200);assert.equal(Buffer.from(await file.arrayBuffer()).equals(fixtureZip()),true);assert.throws(()=>m.file('../tasks.json'));}finally{await m?.close();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());await fs.rm(d,{recursive:true,force:true});}});

test('deflated ZIPs verify, malformed local headers and counts do not',async()=>{const d=await temp();try{const p=path.join(d,'zip');await fs.writeFile(p,fixtureZip(uid,{compress:true}));assert.equal((await verifyArchive(p,{uid})).glbs[0].meshes,1);const bad=fixtureZip();bad.writeUInt16LE(1,bad.length-14);await fs.writeFile(p,bad);await assert.rejects(verifyArchive(p),/结构/);const local=fixtureZip();local.writeUInt32LE(0,18);await fs.writeFile(p,local);await assert.rejects(verifyArchive(p),/本地头/);}finally{await fs.rm(d,{recursive:true,force:true});}});
test('active duplicate takes priority over old history, retries cannot bypass it',async()=>{const d=await temp();let m;try{m=await manager(d);m.start('http://127.0.0.1:1');await m.enqueue({authorized:true,models:[model]});await wait(()=>m.jobs[0].state==='saved');await m.configure({paused:true});const id=(await m.enqueue({authorized:true,models:[model],force:true})).added[0];m.action(id,'cancel');await m.enqueue({authorized:true,models:[model],force:true});assert.equal((await m.enqueue({authorized:true,models:[model],force:true})).duplicates.length,1);assert.throws(()=>m.action(id,'retry'),/相同模型/);}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('corrupt main database preserves damaged data and restores the backup',async()=>{const d=await temp();let m;try{m=await manager(d);await m.enqueue({authorized:true,models:[model]});await m.close();await fs.writeFile(m.store,'{broken');m=await manager(d);assert.equal(m.jobs.length,1);assert.match(m.warning,/恢复/);assert.ok((await fs.readdir(m.dataDir)).some(x=>x.includes('.damaged-')));assert.equal(JSON.parse(await fs.readFile(m.store+'.bak')).version,1);}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});
test('snapshot polling can be conditional and detects removed files',async()=>{const d=await temp();let m,server;try{m=await manager(d);server=createLibraryServer({downloads:m});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;m.start(base);await m.enqueue({authorized:true,models:[model],options:{output:'zip',format:'glb'}});await wait(()=>m.jobs[0].state==='saved'&&m.workers.size===0);const r=await fetch(base+'/api/downloads',{headers:{'X-SFX-Local':'1'}}),etag=r.headers.get('etag');assert.ok(etag);const headers={'X-SFX-Local':'1','If-None-Match':etag};assert.equal((await fetch(base+'/api/downloads',{headers})).status,304);await fs.unlink(m.jobs[0].filePath);const changed=await fetch(base+'/api/downloads',{headers});assert.equal(changed.status,200);assert.equal((await changed.json()).jobs[0].fileExists,false);}finally{await m?.close();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());await fs.rm(d,{recursive:true,force:true});}});
test('资产根还不存在时自动建出来，不弹「重新设置下载路径」',async()=>{const d=await temp();let m;try{m=await new DownloadManager({dataDir:path.join(d,'state'),defaultFolder:path.join(d,'资产库'),browser:()=>'/fixture/browser'}).init();assert.equal(m.folderStatus().ok,true);assert.equal((await fs.stat(path.join(d,'资产库'))).isDirectory(),true);}finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}});


test('pause all stops active work and resume completes preserved jobs',async()=>{
 const d=await temp();let m,starts=0,stopped=0;
 try{
  m=await manager(d,async(job,{signal})=>{
   starts++;
   if(starts===1)await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{stopped++;reject(signal.reason);},{once:true}));
   signal.throwIfAborted();return writeFixture(job);
  });
  m.start('http://127.0.0.1:1');
  await m.enqueue({authorized:true,models:[model,{...model,uid:'c'.repeat(32)}]});
  await wait(()=>starts===1);
  const options=JSON.stringify(m.jobs[0].options);
  await m.configure({paused:true});
  assert.equal(stopped,1);assert.equal(m.workers.size,0);
  assert.equal(m.jobs[0].state,'held');assert.equal(m.jobs[1].state,'queued');
  assert.equal(starts,1);assert.equal(m.jobs[0].finishedAt,null);
  // The paused state and resume ownership survive a service restart.
  await m.close();m=await manager(d);m.start('http://127.0.0.1:1');
  assert.equal(m.jobs[0].state,'held');assert.equal(m.settings.paused,true);
  await m.configure({paused:false});
  await wait(()=>m.jobs.every(j=>j.state==='saved')&&m.workers.size===0);
  assert.equal(JSON.stringify(m.jobs[0].options),options);
  assert.ok(m.snapshot().jobs.every(j=>j.fileExists));
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});


test('default GLB downloads skip FBX and a separate conversion preserves the original files',async()=>{
 const d=await temp();let m,calls=0;
 try{
  m=await new DownloadManager({dataDir:path.join(d,'state'),defaultFolder:path.join(d,'downloads'),browser:()=>'/fixture/browser',blender:()=>'/fixture/blender',runner:writeFixture,
   fbxConverter:async args=>{calls++;assert.notEqual(args.outDir,path.dirname(args.glb));return fakeFbxConverter(args);}}).init();
  m.start('http://127.0.0.1:1');await m.enqueue({authorized:true,models:[model],options:{output:'folder'}});
  await wait(()=>m.jobs[0].state==='saved'&&m.workers.size===0);
  const j=m.jobs[0],glb=path.join(j.filePath,'model.glb'),before=await fs.readFile(glb),verification=JSON.stringify(j.verification);
  assert.equal(j.options.format,'glb');assert.equal(calls,0);
  m.convertFbx(j.id);assert.equal(j.state,'saved');assert.throws(()=>m.convertFbx(j.id),/正在转换/);
  await wait(()=>m.fbxConversions.size===0);
  assert.equal(j.fbx.state,'saved');assert.equal(await fs.readFile(j.fbx.filePath,'utf8'),'FBX');
  assert.deepEqual(await fs.readFile(glb),before);assert.equal(JSON.stringify(j.verification),verification);assert.equal(calls,1);
  m.blender=()=>null;assert.throws(()=>m.convertFbx(j.id),/未找到 Blender/);assert.equal(j.state,'saved');
  m.blender=()=>'/fixture/blender';m.fbxConverter=async()=>{throw Error('fixture conversion failed');};
  m.convertFbx(j.id);await wait(()=>m.fbxConversions.size===0);
  assert.equal(j.fbx.state,'failed');assert.equal(j.state,'saved');assert.deepEqual(await fs.readFile(glb),before);
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});
