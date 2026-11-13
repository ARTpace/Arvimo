// Live image-package cards: the library must be able to show a real card as soon as the folder
// exists, not only after the last picture lands. These tests pin the "live manifest" contract:
// a skeleton info.json with status:'downloading', per-file growth, a clean final manifest that
// still passes verifyFolder, and an 'incomplete' marker whenever the job stops early.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {
  runImageJob,imageManifest,writeImageManifest,markImageBundleIncomplete,
} from '../server/image-bundle.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {scanLibraryPackages} from '../server/local-assets.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {fixturePng} from './download-fixture.mjs';

const UID='c'.repeat(32);
const MODEL=`https://sketchfab.com/models/${UID}`;
const COVER=`https://media.sketchfab.com/models/${UID}/thumbnails/x/front.jpeg`;
const temp=()=>fsp.mkdtemp(path.join(os.tmpdir(),'sfx-livecard-'));
const readInfo=dir=>JSON.parse(fs.readFileSync(path.join(dir,'info.json'),'utf8'));
const projectJson=async()=>({name:'Twin Suns',user:{displayName:'studio'},thumbnails:{images:[{width:1920,url:COVER}]}});
const openPng=()=>({status:200,headers:{'content-type':'image/png','content-length':String(fixturePng().length)},stream:Readable.from([fixturePng()]),url:COVER});
const baseJob=output=>({uid:UID,platform:'sketchfab',name:'插画',author:'studio',url:MODEL,output,deliver:'folder',json:projectJson});

test('the skeleton manifest makes the folder a real library card before the first picture lands',async()=>{
 const root=await temp();
 try{
  const output=path.join(root,'插画-images');
  let skeleton=null,skeletonPkg=null,midway=null,midwayFiles=null;
  const open=async()=>{
   if(!skeleton){
    skeleton=readInfo(output);
    skeletonPkg=(await scanLibraryPackages({roots:[root]})).packages.find(pkg=>pkg.rel===path.basename(output));
   }
   return openPng();
  };
  const progress=p=>{
   if(!midway&&p.stage==='transferring'&&String(p.message).startsWith('已写入本机')){
    midway=readInfo(output);
    midwayFiles=fs.readdirSync(path.join(output,'images'));
   }
  };
  await runImageJob({...baseJob(output),workRoot:root,open},{progress});

  // Before any byte of the first picture is fetched, the folder already has an identity.
  assert.equal(skeleton.status,'downloading');
  assert.equal(skeleton.uid,UID);
  assert.equal(skeleton.title,'Twin Suns');
  assert.equal(skeleton.platform,'sketchfab');
  assert.equal(skeleton.imageCount,0);
  assert.deepEqual(skeleton.images,[]);
  assert.equal(skeletonPkg.uid,UID,'扫描器立刻认出这是正式包，不是无名目录');
  assert.equal(skeletonPkg.title,'Twin Suns');
  assert.equal(skeletonPkg.category,'images');
  assert.equal(skeletonPkg.hasMeta,true,'有清单就不该再挂「登记」按钮');
  assert.equal(skeletonPkg.status,'downloading');

  // The first finished picture is declared at once, so the card has both a cover and a count.
  assert.equal(midway.status,'downloading');
  assert.equal(midway.imageCount,1);
  assert.equal(midway.images.length,1);
  assert.equal(midwayFiles.length,1);
  assert.equal(midway.images[0].file,`images/${midwayFiles[0]}`);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('the final manifest drops status and still passes the folder verifier',async()=>{
 const root=await temp();
 try{
  const output=path.join(root,'插画-images');
  await runImageJob({...baseJob(output),workRoot:root,open:async()=>openPng()},{});
  const info=readInfo(output);
  assert.equal(info.status,undefined,'成品清单不再声称正在下载');
  assert.equal(info.imageCount,1);
  assert.equal((await verifyFolder(output,{uid:UID})).images.length,1);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('an aborted image job marks the half-written folder incomplete',async()=>{
 const root=await temp();
 try{
  const output=path.join(root,'插画-images');
  const controller=new AbortController();
  const open=async()=>{controller.abort(Error('用户取消'));return openPng();};
  await assert.rejects(
   runImageJob({...baseJob(output),workRoot:root,open},{signal:controller.signal}),
   /用户取消/,
  );
  assert.equal(readInfo(output).status,'incomplete');
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('markImageBundleIncomplete leaves a finished manifest untouched',async()=>{
 const root=await temp();
 try{
  await writeImageManifest(root,imageManifest({job:{uid:UID,name:'插画',url:MODEL,tags:[]},plan:{title:'插画',platform:'sketchfab'},files:[],skipped:0}));
  const before=readInfo(root);
  await markImageBundleIncomplete(root);
  assert.deepEqual(readInfo(root),before);
  await writeImageManifest(root,{...before,status:'downloading'});
  await markImageBundleIncomplete(root);
  assert.equal(readInfo(root).status,'incomplete');
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

async function waitState(manager,id,states){
 for(let i=0;i<300;i++){
  const job=manager.snapshot().jobs.find(item=>item.id===id);
  if(job&&states.includes(job.state))return job;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 throw Error('任务未到达终态');
}

test('a failed queue job marks its live folder incomplete from the parent process',async()=>{
 const root=await temp();
 const manager=await new DownloadManager({
  dataDir:path.join(root,'state'),defaultFolder:path.join(root,'downloads'),
  imageRunner:async job=>{
   await fsp.mkdir(job.output,{recursive:true});
   await writeImageManifest(job.output,imageManifest({
    job:{uid:job.uid,name:job.name,url:job.url,tags:[]},plan:{title:job.name,platform:'sketchfab'},
    files:[],skipped:0,status:'downloading',
   }));
   throw Error('模拟下载中断');
  },
  runner:async()=>{throw Error('图片任务不该调用模型执行器');},
  autoStart:false,
 }).init();
 manager.start('http://127.0.0.1:1');
 try{
  const created=await manager.enqueue({
   kind:'images',models:[{uid:UID,name:'插画',author:'studio'}],
   options:{output:'folder'},authorized:true,
  });
  assert.equal(created.added.length,1);
  const job=await waitState(manager,created.added[0],['failed','cancelled']);
  assert.equal(job.state,'failed',job.message);
  assert.equal(readInfo(job.filePath).status,'incomplete');
 }finally{await manager.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('重启后的提示要说实话：图片文件夹包能续传，其它任务只能从头下',async()=>{
 // 一句不准的文案代价很实在：告诉用户「从头下载」，他可能就把半天的进度删了重来。
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-restart-'));
 try{
  const dataDir=path.join(root,'state'),folder=path.join(root,'downloads');
  const images=path.join(folder,'图片','插画-images');
  await fsp.mkdir(path.join(images,'images'),{recursive:true});
  await fsp.writeFile(path.join(images,'images','01-shot.png'),fixturePng());
  await writeImageManifest(images,imageManifest({
   job:{uid:UID,name:'插画',url:MODEL,tags:[]},plan:{title:'插画',platform:'sketchfab'},
   files:[{file:'images/01-shot.png',title:null,width:1,height:1,bytes:fixturePng().length,format:'png',sourceUrl:COVER}],
   skipped:0,status:'downloading',
  }));
  await fsp.mkdir(dataDir,{recursive:true});
  const base=(id,uid,kind,extra)=>({id,uid,kind,name:'插画',state:'running',stage:'transferring',options:{output:'folder'},downloadDir:path.join(folder,'图片'),downloadRoot:folder,attempts:1,createdAt:Date.now(),logs:[],...extra});
  const modelUid='b'.repeat(32);
  const jobs=[
   base('img-1',UID,'images',{filePath:images}),
   base('model-1',modelUid,'sketchfab',{options:{output:'zip',format:'glb'},filePath:path.join(folder,'模型','x.zip')}),
  ];
  await fsp.writeFile(path.join(dataDir,'tasks.json'),JSON.stringify({version:1,settings:{folder,concurrency:1,retryLimit:1,paused:true},jobs}));
  const manager=await new DownloadManager({dataDir,defaultFolder:folder,autoStart:false}).init();
  try{
   const snapshot=manager.snapshot().jobs;
   const picture=snapshot.find(job=>job.id==='img-1');
   const model=snapshot.find(job=>job.id==='model-1');
   assert.equal(picture.state,'interrupted');
   assert.match(picture.message,/接着补下/);
   assert.equal(readInfo(images).status,'incomplete','被强杀时清单还写着「下载中」，重启要改回来');
   assert.equal(model.state,'interrupted');
   assert.match(model.message,/从头下载/);
  }finally{await manager.close();}
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
