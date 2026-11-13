// Image-works pipeline tests.
//
// Most of ArtStation is 2D illustration: those artworks have no `.mview`, so before this pipeline
// the download button simply failed on them. These tests pin the replacement behaviour on both ends
// — the staged bundle the runner produces, and the relaxed-but-still-strict checks the shared
// verifiers apply to it — plus the dispatch that keeps image jobs in the same shared queue.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {
 planImages,artstationImageEntries,writeArtstationImageDeliverable,runArtstationImageJob,ARTSTATION_IMAGE_MAX,
} from '../server/artstation-image.mjs';
// downloadImage moved to the shared image layer; this pipeline now borrows it like every other caller.
import {downloadImage} from '../server/image-store.mjs';
import {projectImageAssets,fetchProjectJson,artstationUid,artstationHash} from '../server/artstation-project.mjs';
import {downloadUrl,coverUrl} from '../server/artstation-cdn.mjs';
import {imageFormat,inspectImage,verifyArchive} from '../server/archive.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {artstationRunnerFor} from '../server/artstation-worker.mjs';
import {runArtstationJob} from '../server/artstation.mjs';
import {fixturePng} from './download-fixture.mjs';

const HASH='R3N22D';
const ARTWORK=`https://www.artstation.com/artwork/${HASH}`;
const UID=artstationUid(HASH);
const IMG='https://cdna.artstation.com/p/assets/images/images/032/829/644/large/stadium.jpg?1607593104';
/** A URL whose square rendition nests a timestamp folder — the shape that used to break rewriting. */
const STAMPED='https://cdna.artstation.com/p/assets/images/images/013/225/918/20181004021932/smaller_square/name.jpg';

const PROJECT={
 title:'Clash Royale Illustrations',
 user:{username:'bricelavillesaintmartin'},
 cover_url:'https://cdna.artstation.com/p/assets/covers/images/032/830/012/medium/keyframe.jpg?1607593592',
 assets:[
  {id:32829644,asset_type:'image',has_image:true,title:'',width:3380,height:1900,image_url:IMG,position:0},
  {id:32830012,asset_type:'cover',has_image:false,title:null,image_url:'https://cdna.artstation.com/p/assets/covers/images/032/830/012/large/keyframe.jpg?1',position:1},
  {id:32829675,asset_type:'image',has_image:true,title:'Mother Witch',width:3179,height:1401,image_url:'https://cdnb.artstation.com/p/assets/images/images/032/829/675/large/motherwitch.jpg?1607592089',position:2},
  {id:32829000,asset_type:'image',has_image:true,title:'Stamped',width:900,height:600,image_url:STAMPED,position:3},
  {id:32829111,asset_type:'video',has_image:true,title:'Trailer',image_url:'https://cdnb.artstation.com/p/assets/images/images/032/900/000/large/trailer.jpg',position:4},
  {id:32829222,asset_type:'image',has_image:true,title:'off-site',image_url:'https://evil.example.com/p/assets/images/images/032/1/large/x.jpg',position:5},
 ],
};
/** Every image URL this project can legitimately fetch, in run order. */
const FETCHABLE=[IMG,PROJECT.assets[2].image_url,STAMPED].map(u=>downloadUrl(u));

/** A stand-in outbound layer: the JSON endpoint plus one canned body per image URL. */
function fakeOpen({project=PROJECT,bodies={}}={}){
 const send=body=>({
  status:200,
  headers:{'content-type':'image/png','content-length':String(body.length)},
  stream:Readable.from([body]),
  url:'about:fixture',
 });
 return async url=>{
  if(/\/projects\/[A-Za-z0-9]+\.json$/.test(url))return send(Buffer.from(JSON.stringify(project),'utf8'));
  if(bodies[url])return send(bodies[url]);
  return {status:404,headers:{},stream:Readable.from([]),url};
 };
}
/** The payload every happy-path run downloads: one real PNG per fetchable URL. */
const pngBodies=()=>Object.fromEntries(FETCHABLE.map(u=>[u,fixturePng()]));
const temp=()=>fsp.mkdtemp(path.join(os.tmpdir(),'sfx-asimg-'));
const waitState=async(m,id,states,ms=8000)=>{
 const end=Date.now()+ms;
 while(Date.now()<end){const j=m.snapshot().jobs.find(x=>x.id===id);if(j&&states.includes(j.state))return j;await new Promise(r=>setTimeout(r,25));}
 throw Error('任务未在预期时间内到达状态：'+states.join('/'));
};

test('project JSON images become ordered, sniffable assets and never a derived rendition',()=>{
 const images=projectImageAssets(PROJECT);
 // The `cover` asset repackages another asset's file, and the `video` asset is not an illustration,
 // so neither is an upload this pipeline should store.
 assert.deepEqual(images.map(i=>i.id),['32829644','32829675','32829000','32829222']);
 assert.equal(images[2].url,STAMPED);
 assert.equal(images[1].title,'Mother Witch');
 assert.equal(images[1].width,3179);
 assert.equal(projectImageAssets(undefined).length,0);
});

test('the download URL is the largest fetchable rendition, and only on the ArtStation CDN',()=>{
 assert.equal(downloadUrl(IMG),IMG);
 // `original` is 403 for everyone but the author, which is why `large` is the target rendition.
 assert.equal(downloadUrl(IMG).includes('/original/'),false);
 // The timestamp folder around the square rendition has to go, or the bucket answers 403 XML.
 assert.equal(downloadUrl(STAMPED),'https://cdna.artstation.com/p/assets/images/images/013/225/918/large/name.jpg');
 assert.equal(downloadUrl('https://evil.example.com/a/large/b.jpg'),null);
 assert.equal(downloadUrl('http://cdna.artstation.com/a/large/b.jpg'),null);
 assert.equal(coverUrl(PROJECT.cover_url),PROJECT.cover_url);
});

test('planning keeps only fetchable images and reports what it dropped',()=>{
 const all=planImages(projectImageAssets(PROJECT));
 assert.deepEqual(all.items.map(i=>i.id),['32829644','32829675','32829000']);
 assert.equal(all.items.every(i=>i.url.startsWith('https://cdn')),true);
 assert.deepEqual(all.skipped.map(s=>s.reason),['not-cdn']);

 const capped=planImages(projectImageAssets(PROJECT),{limit:2});
 assert.equal(capped.items.length,2);
 assert.deepEqual(capped.skipped.map(s=>s.reason),['over-limit','not-cdn']);
 assert.equal(ARTSTATION_IMAGE_MAX,60);
});

test('image containers are told apart by their leading bytes',()=>{
 assert.equal(imageFormat(fixturePng()),'png');
 assert.equal(imageFormat(Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0])),'jpeg');
 assert.equal(imageFormat(Buffer.from('GIF89a........','latin1')),'gif');
 assert.equal(imageFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 ','latin1')),'webp');
 assert.equal(imageFormat(Buffer.from('....ftypavif....','latin1')),'avif');
 assert.equal(imageFormat(Buffer.from('BM..........','latin1')),'bmp');
 assert.equal(imageFormat(Buffer.from('not an image at all','utf8')),null);
 assert.equal(inspectImage(fixturePng(),'a.png',99).extension,'png');
 // The extension the writer uses comes from this rule, not from the URL.
 assert.equal(inspectImage(Buffer.from([0xff,0xd8,0xff,0xe0]),'a.jpg',4).extension,'jpg');
 assert.throws(()=>inspectImage(Buffer.from('<!doctype html>','utf8'),'a.jpg',15),/不是可识别的图片/);
});

test('downloadImage streams to disk and refuses anything past the per-file ceiling',async()=>{
 const root=await temp();
 try{
  const png=fixturePng();
  const url=downloadUrl(IMG);
  const seen=[];
  const dest=path.join(root,'one');
  const result=await downloadImage(url,dest,{open:fakeOpen({bodies:{[url]:png}}),onProgress:p=>seen.push(p.bytes)});
  assert.equal(result.bytes,png.length);
  assert.equal(seen.at(-1),png.length);
  assert.deepEqual(await fsp.readFile(dest),png);

  await assert.rejects(
   downloadImage(url,path.join(root,'big'),{open:fakeOpen({bodies:{[url]:png}}),maxBytes:4}),
   /限制/,
  );
  // A rejected download must not leave half a file behind for the next stage to pick up.
  assert.deepEqual(await fsp.readdir(root),['one']);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('a full run produces a verified ZIP whose manifest matches the archive exactly',async()=>{
 const root=await temp();
 try{
  const output=path.join(root,'staging','job.zip.part');
  const stages=[];
  const result=await runArtstationImageJob(
   {uid:UID,url:ARTWORK,output,deliver:'zip',workRoot:root,open:fakeOpen({bodies:pngBodies()})},
   {progress:p=>stages.push(p.stage)},
  );
  assert.equal(result.folder,false);
  assert.equal(result.imageCount,3);
  assert.equal(result.title,'Clash Royale Illustrations');
  assert.equal(result.author,'bricelavillesaintmartin');
  assert.equal(result.zipName,'Clash Royale Illustrations-R3N22D.zip');
  assert.ok(stages.includes('transferring'));
  assert.ok(stages.includes('converting'));

  const verification=await verifyArchive(output,{uid:UID});
  assert.equal(verification.images.length,3);
  assert.equal(verification.glbs.length,0);
  // Extensions come from the bytes, so a PNG served for a `.jpg` URL is stored as `.png`.
  assert.deepEqual(verification.images.map(i=>i.name),[
   'images/01-32829644.png','images/02-Mother Witch.png','images/03-Stamped.png',
  ]);
  assert.equal(verification.images.every(i=>i.format==='png'),true);
  assert.equal(verification.entries,4);
  assert.match(verification.sha256,/^[a-f0-9]{64}$/);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('the manifest inside an image bundle records every file and its source',async()=>{
 const root=await temp();
 try{
  const png=fixturePng();
  // `artstationImageEntries` collects what a runner already staged, so the file has to be there.
  await fsp.mkdir(path.join(root,'images'),{recursive:true});
  await fsp.writeFile(path.join(root,'images','01-a.png'),png);
  const files=[{file:'images/01-a.png',title:'A',width:3,height:2,bytes:png.length,format:'png',sourceUrl:downloadUrl(IMG)}];
  const {zipName,entries}=await artstationImageEntries({work:root,meta:{title:'T',author:'u',artworkUrl:ARTWORK,hash:HASH,rendition:'large'},uid:UID,files});
  assert.deepEqual(entries.map(e=>e.name),['images/01-a.png','info.json']);
  assert.deepEqual(await fsp.readFile(path.join(root,'images','01-a.png')),png);
  const info=JSON.parse(entries[1].data.toString('utf8'));
  assert.equal(info.kind,'images');
  assert.equal(info.uid,UID);
  assert.equal(info.imageCount,1);
  assert.equal(info.rendition,'large');
  assert.equal(info.platform,'artstation');
  assert.equal(info.url,ARTWORK);
  assert.equal(info.source_url,ARTWORK);
  assert.deepEqual(info.images[0],{file:'images/01-a.png',title:'A',width:3,height:2,bytes:png.length,format:'png',url:downloadUrl(IMG)});
  assert.equal(zipName,'T-R3N22D.zip');
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('folder delivery of an image bundle verifies against the manifest in both directions',async()=>{
 const root=await temp();
 try{
  const png=fixturePng();
  const staging=path.join(root,'staging','job.dir');
  const result=await runArtstationImageJob({uid:UID,url:ARTWORK,output:staging,deliver:'folder',workRoot:root,open:fakeOpen({bodies:pngBodies()})});
  assert.equal(result.folder,true);
  assert.equal((await fsp.stat(staging)).isDirectory(),true);
  const verification=await verifyFolder(staging,{uid:UID});
  assert.equal(verification.images.length,3);
  assert.equal(verification.folder,true);

  // A file the manifest never mentions is content nobody vouched for.
  await fsp.writeFile(path.join(staging,'images','99-extra.png'),png);
  await assert.rejects(verifyFolder(staging,{uid:UID}),/未登记/);
  await fsp.rm(path.join(staging,'images','99-extra.png'));

  // A declared file that is missing means a truncated transfer.
  await fsp.rm(path.join(staging,'images','02-Mother Witch.png'));
  await assert.rejects(verifyFolder(staging,{uid:UID}),/缺少已登记的作品图片/);

  // Provenance still has to line up with the job's uid.
  await assert.rejects(verifyFolder(staging,{uid:'a'.repeat(32)}),/不匹配/);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('a bundle whose file is not really an image is rejected, not silently stored',async()=>{
 const root=await temp();
 try{
  const staging=path.join(root,'staging','job.dir');
  await runArtstationImageJob({uid:UID,url:ARTWORK,output:staging,deliver:'folder',workRoot:root,open:fakeOpen({bodies:pngBodies()})});
  const target=path.join(staging,'images','01-32829644.png');
  const html=Buffer.from('<!doctype html><html>challenge</html>','utf8');
  await fsp.writeFile(target,html);
  await assert.rejects(verifyFolder(staging,{uid:UID}),/不是可识别的图片/);

  // The ZIP verifier applies the same rule to the same bytes.
  const work=path.join(root,'work');
  await fsp.mkdir(path.join(work,'images'),{recursive:true});
  await fsp.writeFile(path.join(work,'images','01-a.png'),html);
  const zip=path.join(root,'staging','bad.zip');
  await writeArtstationImageDeliverable({work,meta:{title:'T',artworkUrl:ARTWORK,hash:HASH},uid:UID,files:[{file:'images/01-a.png',bytes:html.length,format:'png',sourceUrl:downloadUrl(IMG)}],output:zip});
  await assert.rejects(verifyArchive(zip,{uid:UID}),/不是可识别的图片/);

  // A bundle whose manifest is empty has no provenance at all, so it must not verify either.
  const bare=path.join(root,'staging','bare.zip');
  await writeArtstationImageDeliverable({work,meta:{title:'T',artworkUrl:ARTWORK,hash:HASH},uid:UID,files:[],output:bare});
  await assert.rejects(verifyArchive(bare,{uid:UID}),/没有登记作品图片/);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('an artwork with no image asset at all fails loudly instead of producing an empty bundle',async()=>{
 const root=await temp();
 try{
  const onlyVideo={title:'Trailer',user:{username:'u'},assets:[{id:1,asset_type:'video',has_image:true,image_url:'https://cdnb.artstation.com/a/large/t.jpg'}]};
  await assert.rejects(
   runArtstationImageJob({uid:UID,url:ARTWORK,output:path.join(root,'x.zip'),deliver:'zip',workRoot:root,open:fakeOpen({project:onlyVideo})}),
   /没有可下载的图片/,
  );
  const unreadable=async()=>({status:403,headers:{},stream:Readable.from([]),url:''});
  await assert.rejects(
   runArtstationImageJob({uid:UID,url:ARTWORK,output:path.join(root,'y.zip'),deliver:'zip',workRoot:root,open:unreadable}),
   /读取 ArtStation 作品信息失败/,
  );
  assert.deepEqual(await fsp.readdir(root),[]);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('an image job honours cancellation and leaves no staging directory behind',async()=>{
 const root=await temp();
 try{
  const controller=new AbortController();
  controller.abort(Error('用户取消'));
  await assert.rejects(
   runArtstationImageJob({uid:UID,url:ARTWORK,output:path.join(root,'x.zip'),deliver:'zip',workRoot:root,open:fakeOpen({})},{signal:controller.signal}),
   /用户取消/,
  );
  assert.deepEqual(await fsp.readdir(root),[]);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('the forked worker picks the image pipeline for scene-less artworks only',()=>{
 assert.equal(artstationRunnerFor({hasMarmoset:false}),runArtstationImageJob);
 assert.equal(artstationRunnerFor({hasMarmoset:true}),runArtstationJob);
 // A queue entry written before the marker existed has no field at all, and must stay a model job.
 assert.equal(artstationRunnerFor({}),runArtstationJob);
 assert.equal(artstationRunnerFor(undefined),runArtstationJob);
});

test('an image job goes through the shared queue and skips FBX and Blender entirely',async()=>{
 const root=await temp();
 const bodies=pngBodies();
 const calls=[];
 const m=await new DownloadManager({
  dataDir:path.join(root,'state'),
  defaultFolder:path.join(root,'downloads'),
  artRunner:async job=>{
   calls.push(job);
   return runArtstationImageJob({uid:job.uid,url:job.url,output:job.output,deliver:job.deliver,workRoot:job.workRoot,open:fakeOpen({bodies})},{progress:()=>{}});
  },
  runner:async()=>{throw Error('Sketchfab 执行器不该被 ArtStation 任务调用');},
  fbxConverter:async()=>{throw Error('图片作品不该尝试转换 FBX');},
  blenderImporter:()=>{throw Error('图片作品不该发送到 Blender');},
  browser:()=>undefined,
  autoStart:false,
 }).init();
 m.start('http://127.0.0.1:1');
 try{
  const created=await m.enqueue({
   kind:'artstation',
   models:[{uid:UID,name:'Clash Royale Illustrations',author:'bricelavillesaintmartin',thumbnail:null,license:'ArtStation 作品 · 需确认授权',artworkUrl:ARTWORK,artId:HASH,hasMarmoset:false}],
   options:{output:'folder',format:'fbx'},authorized:true,
  },{folder:m.settings.folder});
  assert.equal(created.added.length,1);
  // The marker survives persistence, so a restored queue dispatches without re-reading the artwork.
  assert.equal(m.snapshot().jobs[0].hasMarmoset,false);
  const job=await waitState(m,created.added[0],['saved','failed']);
  assert.equal(job.state,'saved',job.message);
  assert.equal(calls.length,1);
  assert.equal(calls[0].hasMarmoset,false);
  assert.equal(calls[0].deliver,'folder');
  assert.equal(job.blender,null);
  assert.equal((await fsp.stat(job.filePath)).isDirectory(),true);
  assert.equal((await fsp.stat(path.join(job.filePath,'images'))).isDirectory(),true);
  assert.equal(job.verification.images.length,3);
  assert.equal(job.verification.glbs.length,0);
  assert.match(job.message,/图片已保存到本机/);
 }finally{await m.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('an image job asked for Blender gets a warning instead of a failed import',async()=>{
 const root=await temp();
 try{
  const m=await new DownloadManager({
   dataDir:path.join(root,'state'),
   defaultFolder:path.join(root,'downloads'),
   artRunner:async job=>runArtstationImageJob({uid:job.uid,url:job.url,output:job.output,deliver:job.deliver,workRoot:job.workRoot,open:fakeOpen({bodies:pngBodies()})},{progress:()=>{}}),
   runner:async()=>{throw Error('不该调用');},
   blenderImporter:()=>{throw Error('图片作品不该发送到 Blender');},
   browser:()=>undefined,
   autoStart:false,
  }).init();
  m.start('http://127.0.0.1:1');
  try{
   const created=await m.enqueue({kind:'artstation',models:[{uid:UID,name:'Art',author:'u',artworkUrl:ARTWORK,artId:HASH,hasMarmoset:false}],options:{output:'zip',format:'glb'},authorized:true,openInBlender:true});
   const job=await waitState(m,created.added[0],['saved','failed']);
   assert.equal(job.state,'saved',job.message);
   assert.match(job.warning,/图片资产/);
   assert.equal(job.blender,null);
   assert.match(job.message,/图片已保存到本机/);
  }finally{await m.close();}
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('fetchProjectJson reads the endpoint the same way the Marmoset resolver does',async()=>{
 const json=await fetchProjectJson(ARTWORK,{open:fakeOpen({})});
 assert.equal(json.title,PROJECT.title);
 assert.equal(await fetchProjectJson('https://www.artstation.com/not-artwork',{open:fakeOpen({})}),null);
 assert.equal(artstationHash(ARTWORK),HASH);
 assert.equal(artstationUid('not a hash'),null);
});

// ---- 并发与容错：与图站图片包对齐 ----
//
// 这条流水线原来是 for 循环串行、一张失败就抛死整包。图站那侧早就改成「并发 + 单张跳过 +
// 体积边下边判」，ArtStation 的图片作品同样是几十张的批量，没道理维持旧语义。

test('作品图片会并发下载，但清单仍按计划顺序',async()=>{
 const root=await temp();
 try{
  const output=path.join(root,'staging','job.zip.part');
  const inner=fakeOpen({bodies:pngBodies()});
  let live=0,peak=0;
  // 每条图片请求故意慢 60ms：串行时峰值只会是 1，并发才看得到 >1。
  const open=async url=>{
   if(/\/projects\/[A-Za-z0-9]+\.json$/.test(String(url)))return inner(url);
   live++;peak=Math.max(peak,live);
   try{await new Promise(r=>setTimeout(r,60));return await inner(url);}
   finally{live--;}
  };
  const result=await runArtstationImageJob({uid:UID,url:ARTWORK,output,deliver:'zip',workRoot:root,open});
  assert.equal(result.imageCount,3);
  assert.ok(peak>=2,`三张慢图应该同时在飞，实际峰值 ${peak}`);
  assert.ok(peak<=6,`并发不能超过上限，实际峰值 ${peak}`);
  const verification=await verifyArchive(output,{uid:UID});
  assert.deepEqual(verification.images.map(i=>i.name),[
   'images/01-32829644.png','images/02-Mother Witch.png','images/03-Stamped.png',
  ],'清单要按 01/02/03 计划顺序，不能按谁先下完');
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('单张取不回来只跳过并记 failedCount，不判死整包',async()=>{
 const root=await temp();
 try{
  const output=path.join(root,'staging','job.dir');
  // 第一张回 404：其余两张照常下完，包必须成功。
  const bodies=Object.fromEntries(FETCHABLE.slice(1).map(u=>[u,fixturePng()]));
  const result=await runArtstationImageJob({uid:UID,url:ARTWORK,output,deliver:'folder',workRoot:root,open:fakeOpen({bodies})});
  assert.equal(result.imageCount,2);
  assert.equal(result.failedCount,1);
  assert.equal(result.truncatedCount,0);
  const info=JSON.parse(await fsp.readFile(path.join(output,'info.json'),'utf8'));
  assert.equal(info.imageCount,2);
  assert.equal(info.failedCount,1,'少了几张要写进清单，别让人以为作者只传了两张');
  const verification=await verifyFolder(output,{uid:UID});
  assert.equal(verification.images.length,2);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('一张都取不回来时必须失败，并带上真实原因',async()=>{
 const root=await temp();
 try{
  await assert.rejects(
   runArtstationImageJob({uid:UID,url:ARTWORK,output:path.join(root,'x.zip'),deliver:'zip',workRoot:root,open:fakeOpen({})}),
   /没有取到任何作品图片/,
  );
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('体积到上限就停并报告剩余张数，而不是下完再作废',async()=>{
 const root=await temp();
 try{
  const output=path.join(root,'staging','job.dir');
  const png=fixturePng();
  const result=await runArtstationImageJob({
   uid:UID,url:ARTWORK,output,deliver:'folder',workRoot:root,
   open:fakeOpen({bodies:pngBodies()}),maxBytes:png.length*2-1,
  });
  // 并发时上限判定会粗一点：同时在飞的几张都会先通过检查，最多多下 2 张。
  assert.ok(result.imageCount>=2&&result.imageCount<=3,'到上限就停，已下到的照常成包');
  assert.equal(result.imageCount+result.truncatedCount,3,'下到的 + 没下的 = 全部，一张都不能凭空消失');
  const info=JSON.parse(await fsp.readFile(path.join(output,'info.json'),'utf8'));
  assert.equal(info.truncatedCount??0,result.truncatedCount);
  const verification=await verifyFolder(output,{uid:UID});
  assert.equal(verification.images.length,result.imageCount);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
