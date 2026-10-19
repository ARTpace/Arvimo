import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DownloadManager,exportOptions} from '../server/downloads.mjs';import {commitFolder} from '../server/local-commit.mjs';
import {verifyArchive} from '../server/archive.mjs';
import {verifyFolder,packFolder,findStagedGlb} from '../server/folder-archive.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {fixtureZip,writeFixtureFolder,FIXTURE_UID as uid} from './download-fixture.mjs';

const model={uid,name:'Fixture',author:'Test author'};
const temp=()=>fs.mkdtemp(path.join(os.tmpdir(),'sfx-folder-'));
const wait=async fn=>{const end=Date.now()+15000;while(!fn()){if(Date.now()>end)throw Error('Test timeout');await new Promise(r=>setTimeout(r,15));}};
/** Mirrors the real worker: a directory when folder delivery was requested, otherwise a ZIP. */
const fixtureRunner=async(job,{signal})=>{
 signal.throwIfAborted();
 if(job.options.output==='folder')await writeFixtureFolder(job.output,{uid:job.uid});
 else await fs.writeFile(job.output,fixtureZip(job.uid));
 return {zipName:'fixture.zip'};
};
const fakeFbxConverter=async({glb,outDir})=>{const file=path.join(outDir,path.basename(glb).replace(/\.glb$/i,'.fbx'));await fs.writeFile(file,'FBX FIXTURE');return {file,name:path.basename(file),bytes:11};};
const manager=(base,{runner=fixtureRunner,fbxConverter=fakeFbxConverter,folder}={})=>new DownloadManager({dataDir:path.join(base,'state'),defaultFolder:folder||path.join(base,'downloads'),runner,verify:verifyArchive,browser:()=>'/fixture/browser',blender:()=>null,fbxConverter}).init();

test('folder output saves a directory instead of a ZIP',async()=>{
 const d=await temp();let m;
 try{
  m=await manager(d);
  m.start('http://127.0.0.1:1');
  m.enqueue({authorized:true,models:[model],options:{output:'folder'}});
  await wait(()=>m.jobs[0].state==='saved');
  const job=m.jobs[0];
  assert.equal(job.options.output,'folder');
  assert.equal((await fs.stat(job.filePath)).isDirectory(),true);
  assert.equal(job.filename.endsWith('.zip'),false);
  assert.equal(job.verification.folder,true);
  assert.equal(job.verification.entries,4);
  assert.deepEqual((await fs.readdir(job.filePath)).sort(),['info.json','model.fbx','model.glb','textures']);
  assert.equal(m.snapshot().jobs[0].fileExists,true);
  assert.equal(m.file(job.id).path,job.filePath);
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});

test('ZIP output keeps delivering a verified archive',async()=>{
 const d=await temp();let m;
 try{
  m=await manager(d);
  m.start('http://127.0.0.1:1');
  m.enqueue({authorized:true,models:[model],options:{output:'zip',format:'glb'}});
  await wait(()=>m.jobs[0].state==='saved');
  const job=m.jobs[0];
  assert.equal(job.options.output,'zip');
  assert.equal(job.filePath.endsWith('.zip'),true);
  assert.equal(job.verification.folder,undefined);
  assert.equal((await fs.stat(job.filePath)).isFile(),true);
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});

test('fbx format converts the staged GLB and lands beside it in the folder',async()=>{
 const d=await temp();let m,seen=null;
 const fbxConverter=async({glb,outDir})=>{
  seen=glb;
  const name=path.basename(glb).replace(/\.glb$/i,'')+'.fbx';
  const file=path.join(outDir,name);
  await fs.writeFile(file,'FBX FIXTURE');
  return {file,name,bytes:11};
 };
 try{
  m=await manager(d,{fbxConverter});
  m.start('http://127.0.0.1:1');
  m.enqueue({authorized:true,models:[model],options:{output:'folder',format:'fbx'}});
  await wait(()=>m.jobs[0].state==='saved');
  const job=m.jobs[0];
  // The converter must be handed the loose GLB the runner just wrote, not the staging folder.
  assert.equal(path.basename(seen),'model.glb');
  assert.deepEqual((await fs.readdir(job.filePath)).sort(),['info.json','model.fbx','model.glb','textures']);
  assert.equal((await fs.readFile(path.join(job.filePath,'model.fbx'),'utf8')),'FBX FIXTURE');
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});

test('fbx with ZIP output packs the converted tree, so the FBX is inside the archive',async()=>{
 const d=await temp();let m;
 const fbxConverter=async({glb,outDir})=>{
  const name=path.basename(glb).replace(/\.glb$/i,'')+'.fbx';
  await fs.writeFile(path.join(outDir,name),'FBX FIXTURE');
  return {file:path.join(outDir,name),name,bytes:11};
 };
 try{
  m=await manager(d,{fbxConverter});
  m.start('http://127.0.0.1:1');
  m.enqueue({authorized:true,models:[model],options:{output:'zip',format:'fbx'}});
  await wait(()=>m.jobs[0].state==='saved');
  const job=m.jobs[0];
  // A ZIP was asked for, so the loose staging tree must not survive as the deliverable.
  assert.equal(job.filePath.endsWith('.zip'),true);
  assert.equal(job.verification.folder,undefined);
  const verified=await verifyArchive(job.filePath,{uid});
  assert.equal(verified.entries,4);
  assert.equal(verified.glbs.length,1);
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});

test('folder verification rejects missing provenance, a foreign uid and a missing GLB',async()=>{
 const d=await temp();
 try{
  await writeFixtureFolder(path.join(d,'no-info'),{files:['model.glb','textures/a.png']});
  await assert.rejects(verifyFolder(path.join(d,'no-info')),/info\.json/);
  await writeFixtureFolder(path.join(d,'wrong'),{uid:'a'.repeat(32)});
  await assert.rejects(verifyFolder(path.join(d,'wrong'),{uid}),/不匹配/);
  await writeFixtureFolder(path.join(d,'no-glb'),{files:['info.json','textures/a.png']});
  await assert.rejects(verifyFolder(path.join(d,'no-glb')),/缺少有效 GLB/);
  await assert.rejects(verifyFolder(path.join(d,'absent')),/不存在/);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test('folder commits never merge into an existing folder',async()=>{
 const d=await temp();
 try{
  const out=path.join(d,'out');
  await writeFixtureFolder(path.join(d,'a'));
  const first=await commitFolder(path.join(d,'a'),out,'Fixture-01234567');
  await writeFixtureFolder(path.join(d,'b'));
  const second=await commitFolder(path.join(d,'b'),out,'Fixture-01234567');
  assert.notEqual(first,second);
  assert.equal(path.basename(first),'Fixture-01234567');
  assert.match(path.basename(second),/\(1\)$/);
  assert.deepEqual((await fs.readdir(first)).sort(),['info.json','model.glb','textures']);
  assert.deepEqual((await fs.readdir(second)).sort(),['info.json','model.glb','textures']);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test('export options default to the lean scope and keep explicit choices',()=>{
 assert.equal(exportOptions().packMode,'model');
 assert.equal(exportOptions().maxTextureEdge,0);
 assert.equal(exportOptions().output,'folder');
 assert.equal(exportOptions().format,'fbx');
 assert.equal(exportOptions({downloadTextures:false,pngOnly:false,fastZip:false}).downloadTextures,true);
 assert.equal(exportOptions({packMode:'full'}).packMode,'full');
 assert.equal(exportOptions({packMode:'glb'}).packMode,'glb');
 assert.equal(exportOptions({maxTextureEdge:4096}).maxTextureEdge,4096);
 assert.equal(exportOptions({output:'folder',format:'fbx'}).output,'folder');
 // Unknown values fall back instead of reaching the converter.
 assert.equal(exportOptions({output:'tar',format:'obj'}).output,'folder');
 assert.equal(exportOptions({format:'obj'}).format,'fbx');
 assert.equal(exportOptions({maxTextureEdge:999}).maxTextureEdge,0);
 assert.equal(exportOptions({packMode:'everything'}).packMode,'model');
});

test('folder helpers locate the GLB and re-pack the tree as a verified archive',async()=>{
 const d=await temp();
 try{
  const staged=path.join(d,'stage');
  await writeFixtureFolder(staged);
  assert.equal(path.basename(await findStagedGlb(staged)),'model.glb');
  const packed=path.join(d,'packed.zip');
  const result=await packFolder(staged,packed);
  assert.equal(result.entries,3);
  assert.equal((await verifyArchive(packed,{uid})).entries,3);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test('the file endpoint refuses to stream a folder and the snapshot reports Blender status',async()=>{
 const d=await temp();let m,server;
 try{
  m=await manager(d);
  server=createLibraryServer({downloads:m});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  m.start(base);
  const snapshot=await (await fetch(base+'/api/downloads',{headers:{'X-SFX-Local':'1'}})).json();
  assert.equal(snapshot.fbxAvailable,false);
  m.enqueue({authorized:true,models:[model],options:{output:'folder'}});
  await wait(()=>m.jobs[0].state==='saved');
  const response=await fetch(`${base}/api/downloads/tasks/${m.jobs[0].id}/file`);
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/导出文件夹/);
 }finally{await m?.close();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());await fs.rm(d,{recursive:true,force:true});}
});
