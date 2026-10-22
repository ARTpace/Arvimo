import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DownloadManager} from '../server/downloads.mjs';
import {canonicalPath} from '../server/download-recovery.mjs';
import {fixturePng,fixtureZip,FIXTURE_UID as uid} from './download-fixture.mjs';

test('cleared records stay cleared on enqueue and restart without deleting assets',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'asset-cleared-history-'));let manager;
 try{
  const root=path.join(dir,'downloads'),dataDir=path.join(dir,'data');
  await fs.mkdir(root,{recursive:true});
  const oldUid='b'.repeat(32),newUid='c'.repeat(32),queuedUid='d'.repeat(32),folderUid='e'.repeat(32);
  const oldFile=path.join(root,'old.zip');await fs.writeFile(oldFile,fixtureZip(oldUid));
  const folder=path.join(root,'material');await fs.mkdir(path.join(folder,'textures'),{recursive:true});
  await fs.writeFile(path.join(folder,'textures','Color.png'),fixturePng());
  await fs.writeFile(path.join(folder,'info.json'),JSON.stringify({uid:folderUid,kind:'material',platform:'polyhaven',assetId:'old-material',resolution:'2K',format:'PNG',textures:[{file:'textures/Color.png'}]}));
  const options={dataDir,defaultFolder:root,autoStart:false};
  manager=await new DownloadManager(options).init();assert.equal(manager.jobs.length,2);
  const cleared=manager.batch('remove',manager.jobs.map(job=>job.id));
  assert.equal(cleared.jobs.length,0);assert.equal(cleared.errors.length,0);
  assert.ok((await fs.stat(oldFile)).isFile(),'clearing history must preserve assets');
  await fs.writeFile(path.join(root,'new.zip'),fixtureZip(newUid));
  const request={authorized:true,models:[{uid:queuedUid,name:'new task'}],options:{output:'zip',format:'glb'}};
  assert.equal((await manager.enqueue(request)).added.length,1);
  assert.ok(!manager.jobs.some(job=>[oldUid,folderUid].includes(job.uid)),'enqueue must not resurrect cleared ZIP or folder records');
  assert.ok(manager.jobs.some(job=>job.uid===newUid),'genuinely missing records can still recover');
  await manager.close();manager=await new DownloadManager(options).init();
  assert.ok(!manager.jobs.some(job=>[oldUid,folderUid].includes(job.uid)),'cleared records must stay hidden after restart');
  const alias=path.join(dir,'alias');await fs.symlink(root,alias,process.platform==='win32'?'junction':'dir');
  await manager.enqueue(request,{folder:alias});
  assert.ok(!manager.jobs.some(job=>[oldUid,folderUid].includes(job.uid)),'a directory alias must not bypass cleared history');
  const redownload=await manager.enqueue({...request,models:[{uid:oldUid,name:'download again'}]});
  assert.equal(redownload.added.length,1,'explicitly downloading the same asset remains allowed');
 }finally{await manager?.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('empty history recovers categorized material and ZIP; aliases dedupe without mixing resolutions',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'asset-recovery-'));let manager;
 try{
  const root=path.join(dir,'downloads'),asset=path.join(root,'材质','existing');
  await fs.mkdir(path.join(asset,'textures'),{recursive:true});
  await fs.writeFile(path.join(asset,'textures','Color.png'),fixturePng());
  await fs.writeFile(path.join(asset,'info.json'),JSON.stringify({uid,kind:'material',platform:'polyhaven',assetId:'test',title:'Test',resolution:'2K',format:'PNG',textures:[{file:'textures/Color.png'}]}));
  await fs.writeFile(path.join(root,'model.zip'),fixtureZip('a'.repeat(32)));
  await fs.mkdir(path.join(root,'broken'));await fs.writeFile(path.join(root,'broken','info.json'),'{broken');
  const alias=path.join(dir,'alias');await fs.symlink(root,alias,process.platform==='win32'?'junction':'dir');
  assert.equal(canonicalPath(root),canonicalPath(alias));
  manager=await new DownloadManager({dataDir:path.join(dir,'data'),defaultFolder:root,autoStart:false}).init();
  assert.equal(manager.jobs.length,2);assert.ok(manager.snapshot().jobs.every(j=>j.fileExists));
  const request={authorized:true,kind:'polyhaven',models:[{uid,name:'Test',assetId:'test',assetType:'textures'}],options:{resolution:'2K',textureFormat:'PNG'}};
  assert.equal((await manager.enqueue(request,{folder:alias})).duplicates.length,1);
  manager.jobs.push({id:'failed-history',uid,kind:'polyhaven',state:'failed',downloadRoot:alias,options:{output:'folder',resolution:'2K',textureFormat:'PNG'}});
  assert.throws(()=>manager.action('failed-history','retry'),/已下载/);
  manager.jobs=manager.jobs.filter(j=>j.id!=='failed-history');
  manager.jobs=[];
  assert.equal((await manager.enqueue(request)).duplicates.length,1);
  assert.equal((await manager.enqueue({...request,options:{resolution:'4K',textureFormat:'PNG'}})).added.length,1);
  await manager.close();manager=await new DownloadManager({dataDir:path.join(dir,'data'),defaultFolder:root,autoStart:false}).init();
  assert.equal(manager.jobs.length,3);
 }finally{await manager?.close();await fs.rm(dir,{recursive:true,force:true});}
});
