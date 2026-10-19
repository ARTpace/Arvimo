import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {blenderPath,blenderStatus} from '../server/blender.mjs';
import {convertGlbToFbx} from '../server/fbx.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {verifyArchive} from '../server/archive.mjs';
import {readFbxMedia} from './fbx-inspect.mjs';
import {twoMaterialGlb,writeTwoMaterialGlb} from './gltf-fixture.mjs';
import {writeFixtureFolder,FIXTURE_UID} from './download-fixture.mjs';

const temp=()=>fs.mkdtemp(path.join(os.tmpdir(),'sfx-fbx-'));
const wait=async fn=>{const end=Date.now()+60000;while(!fn()){if(Date.now()>end)throw Error('Test timeout');await new Promise(r=>setTimeout(r,20));}};

test('an explicit SFX_BLENDER wins, a broken one is ignored',async()=>{
 const d=await temp();const previous=process.env.SFX_BLENDER;
 const fake=path.join(d,process.platform==='win32'?'blender.exe':'blender');
 try{
  await fs.writeFile(fake,'');
  process.env.SFX_BLENDER=fake;
  assert.equal(blenderPath(),fake);
  assert.equal(blenderStatus().available,true);
  assert.equal(blenderStatus().hint,null);
  // A path that does not exist must not be handed out as if Blender were installed.
  const missing=path.join(d,'nope.exe');
  process.env.SFX_BLENDER=missing;
  assert.notEqual(blenderPath(),missing);
 }finally{
  if(previous===undefined)delete process.env.SFX_BLENDER;else process.env.SFX_BLENDER=previous;
  await fs.rm(d,{recursive:true,force:true});
 }
});

test('a missing Blender fails loudly instead of quietly returning the GLB',async()=>{
 const d=await temp();
 try{
  const glb=path.join(d,'model.glb');
  await fs.writeFile(glb,'not really a glb, but it exists');
  await assert.rejects(
   convertGlbToFbx({glb,outDir:d,workRoot:path.join(d,'work'),blender:null}),
   /未找到 Blender/
  );
  assert.equal((await fs.readdir(d)).some(name=>name.toLowerCase().endsWith('.fbx')),false);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test('a missing source GLB is reported before Blender is even started',async()=>{
 const d=await temp();
 try{
  await assert.rejects(
   convertGlbToFbx({glb:path.join(d,'absent.glb'),outDir:d,workRoot:path.join(d,'work'),blender:'/nonexistent/blender'}),
   /找不到待转换的 GLB/
  );
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

/*
 * The bug this guards: Blender's glTF importer leaves embedded images with an empty filepath, so
 * every texture collapsed onto one media path ('<model>.fbm'). All materials then pointed at the
 * first image and the exporter embedded only that one -- Unity showed the body texture on the
 * clothing too. Needs a real Blender, so it skips instead of failing when none is installed.
 */
test('each material keeps its own texture when a multi-material GLB is converted',{timeout:180000},async t=>{
 if(!blenderStatus().available){t.skip('未安装 Blender，跳过真实转换');return;}
 const d=await temp();
 try{
  const {glb}=await writeTwoMaterialGlb(d);
  const result=await convertGlbToFbx({glb,outDir:path.join(d,'delivery'),workRoot:path.join(d,'work')});
  assert.ok(result.bytes>0,'FBX 必须写出内容');
  assert.ok(result.textures.renamed>=2,'每张贴图都要被赋一个独立名字');
  // Embedded pixels are already in the glTF, so naming them must not spill files onto disk.
  assert.equal(result.textures.written,0,'内嵌贴图不应产生额外磁盘写入');

  const media=readFbxMedia(await fs.readFile(result.file));
  const bindings=media.materials.flatMap(material=>
   material.textures.filter(slot=>slot.property==='DiffuseColor').map(slot=>({material:material.name,image:slot.texture.image}))
  );
  assert.equal(bindings.length,2,'两个材质各有一个 base color 贴图');
  assert.notEqual(bindings[0].image,bindings[1].image,'不同材质不能共用同一个贴图路径');
  for(const binding of bindings){
   assert.match(binding.image,/body_diff\.png|cloth_diff\.png/,`${binding.material} 指向了意外的贴图 ${binding.image}`);
  }

  // Distinct media paths are what keeps the exporter from deduplicating the embedded pixels.
  const names=media.videos.map(video=>video.relativeFilename);
  assert.equal(new Set(names).size,names.length,`贴图媒体路径必须互不相同：${names.join(', ')}`);
  for(const video of media.videos) assert.ok(video.contentBytes>0,`${video.name} 没有嵌入图像数据`);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

/*
 * The unit test above proves the converter is right; this one proves the whole download pipeline
 * still hands it a usable tree and saves the result -- no fake fbxConverter anywhere.
 */
test('the download queue converts with real Blender and saves an FBX that keeps both materials',{timeout:180000},async t=>{
 if(!blenderStatus().available){t.skip('未安装 Blender，跳过真实转换');return;}
 const d=await temp();let m;
 const runner=async(job,{signal})=>{
  signal.throwIfAborted();
  await writeFixtureFolder(job.output,{uid:job.uid,glb:twoMaterialGlb()});
  return {zipName:'fixture.zip'};
 };
 try{
  m=await new DownloadManager({
   dataDir:path.join(d,'state'),defaultFolder:path.join(d,'downloads'),runner,
   verify:verifyArchive,browser:()=>'/fixture/browser',blender:blenderPath,
  }).init();
  m.start('http://127.0.0.1:1');
  m.enqueue({authorized:true,models:[{uid:FIXTURE_UID,name:'Fixture',author:'Test author'}],options:{output:'folder',format:'fbx'}});
  await wait(()=>['saved','failed','cancelled'].includes(m.jobs[0].state));
  const job=m.jobs[0];
  assert.equal(job.state,'saved',job.error||'任务未完成');
  assert.equal(job.verification.folder,true);
  const media=readFbxMedia(await fs.readFile(path.join(job.filePath,'model.fbx')));
  const images=media.materials.flatMap(material=>
   material.textures.filter(slot=>slot.property==='DiffuseColor').map(slot=>slot.texture.image)
  );
  assert.equal(images.length,2,'转换后的 FBX 仍应有两个材质的 base color 贴图');
  assert.notEqual(images[0],images[1],'走完整下载管线后材质也不能共用同一张贴图');
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});
