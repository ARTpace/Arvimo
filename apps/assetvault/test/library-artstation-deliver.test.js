// Delivery-shape tests for the ArtStation runner.
//
// runArtstationJob originally only ever wrote a ZIP, and `output` is a *file* path in that mode but a
// *directory* path for folder delivery. ArtStation + "不压缩输出文件夹" therefore opened a directory
// for writing and died with EISDIR. These tests pin both shapes down and prove each one satisfies the
// same verifier DownloadManager uses, so a folder export cannot drift below ZIP guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeArtstationDeliverable,artstationEntries,buildArtstationZip,prettyArtstationEntry} from '../server/artstation.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {verifyArchive} from '../server/archive.mjs';
import {fixtureGlb} from './download-fixture.mjs';

const UID='ae5f093db5bc85ee7f75d0b098b26837';
const meta={artworkUrl:'https://www.artstation.com/artwork/YK90wP',title:'Token Hammer',author:'tester',embedUrl:'https://www.artstation.com/embed/12345',mviewUrl:'https://cdn.artstation.com/p/assets/marmosets/mview/x.mview'};

async function staged(root){
 const outDir=path.join(root,'glb');
 await fsp.mkdir(outDir,{recursive:true});
 await fsp.writeFile(path.join(outDir,'scene.glb'),fixtureGlb());
 return outDir;
}

test('folder delivery writes loose files into a directory, not an archive',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-as-folder-'));
 try{
  const outDir=await staged(root);
  const output=path.join(root,'deliver','Token-Hammer.dir');
  const result=await writeArtstationDeliverable({outDir,meta,format:'glb',uid:UID,output,deliver:'folder'});
  assert.equal(result.folder,true);
  // The staging path must really be a directory - this is the case that used to throw EISDIR.
  assert.equal((await fsp.stat(output)).isDirectory(),true);
  assert.equal((await fsp.stat(path.join(output,'Token Hammer.glb'))).isFile(),true);
  assert.equal(JSON.parse(await fsp.readFile(path.join(output,'info.json'),'utf8')).uid,UID);
  assert.equal(result.fileCount,2);
  assert.ok(result.bytes>0);
  assert.equal(result.zipName,'Token Hammer - tester.zip');   // the name is reused for folder naming upstream

  // The shared folder verifier is the real acceptance criterion: if this passes, the job can be saved.
  const verification=await verifyFolder(output,{uid:UID});
  assert.equal(verification.folder,true);
  assert.equal(verification.glbs.length,1);
  assert.match(verification.sha256,/^[a-f0-9]{64}$/);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('folder delivery reports progress and honours cancellation',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-as-folder-signal-'));
 try{
  const outDir=await staged(root);
  const seen=[];
  await writeArtstationDeliverable({outDir,meta,format:'glb',uid:UID,output:path.join(root,'ok'),deliver:'folder',progress:p=>seen.push(p.stage)});
  assert.ok(seen.length>0);
  assert.equal(seen.every(stage=>stage==='transferring'),true);

  const controller=new AbortController();
  controller.abort(Error('用户取消'));
  await assert.rejects(
   writeArtstationDeliverable({outDir,meta,format:'glb',uid:UID,output:path.join(root,'cancelled'),deliver:'folder',signal:controller.signal}),
   /用户取消/,
  );
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('ZIP delivery still writes exactly one archive and verifies as one',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-as-zip-'));
 try{
  const outDir=await staged(root);
  const output=path.join(root,'staging','job-1.zip.part');
  await fsp.mkdir(path.dirname(output),{recursive:true});
  const result=await writeArtstationDeliverable({outDir,meta,format:'glb',uid:UID,output,deliver:'zip'});
  assert.equal(result.folder,false);
  assert.equal((await fsp.stat(output)).isFile(),true);
  const verification=await verifyArchive(output,{uid:UID});
  assert.equal(verification.entries,2);
  assert.equal(verification.warning,false);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('the default delivery stays ZIP so older callers keep working',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-as-default-'));
 try{
  const outDir=await staged(root);
  const output=path.join(root,'staging','job-2.zip.part');
  await fsp.mkdir(path.dirname(output),{recursive:true});
  const result=await writeArtstationDeliverable({outDir,meta,format:'glb',uid:UID,output});
  assert.equal(result.folder,false);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('mviewer texture names are mapped to semantic PBR roles with a title-only stem',()=>{
 // 包内文件只要作品标题，不带作者；外层 ZIP / 文件夹名仍用「标题 - 作者」。
 const stem='Token Hammer';
 assert.equal(prettyArtstationEntry('scene.glb',stem),'Token Hammer.glb');
 assert.equal(prettyArtstationEntry('scene.fbx',stem),'Token Hammer.fbx');
 assert.equal(prettyArtstationEntry('mat0_c_rgba.png',stem),'Token Hammer_mat0_BaseColor.png');
 assert.equal(prettyArtstationEntry('mat2_c.jpg',stem),'Token Hammer_mat2_BaseColor.jpg');
 assert.equal(prettyArtstationEntry('mat1_n.jpg',stem),'Token Hammer_mat1_Normal.jpg');
 assert.equal(prettyArtstationEntry('mat0_r_metalrough.png',stem),'Token Hammer_mat0_MetallicRoughness.png');
 assert.equal(prettyArtstationEntry('preview.jpg',stem),'preview.jpg');
 assert.equal(prettyArtstationEntry('info.json',stem),'info.json');
});

test('entry collection is flat and keeps the historical buildArtstationZip name',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-as-entries-'));
 try{
  const outDir=await staged(root);
  const {entries,zipName}=await artstationEntries({outDir,meta,format:'glb',uid:UID});
  assert.deepEqual(entries.map(e=>e.name),['Token Hammer.glb','info.json']);
  assert.equal(zipName,'Token Hammer - tester.zip');
  // Existing callers and tests read `.entries` off buildArtstationZip.
  const legacy=await buildArtstationZip({outDir,meta,format:'glb',uid:UID});
  assert.deepEqual(legacy.entries.map(e=>e.name),entries.map(e=>e.name));
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
