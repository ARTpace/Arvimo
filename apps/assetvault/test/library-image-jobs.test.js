// Picture-jobs-in-the-queue tests.
//
// A picture job has to be an ordinary member of the shared queue, with one deliberate exception: it
// must not collide with the model export of the same asset. Everything else — persistence, dedupe,
// batching, which runner gets called — is shared behaviour, so these tests exist mainly to prove the
// new kind reuses it rather than growing a parallel path.
import test from 'node:test';import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DownloadManager,IMAGE_BATCH,imageOptions} from '../server/downloads.mjs';
import {fixturePng} from './download-fixture.mjs';

const uid=n=>String(n).padStart(32,'a');
const temporary=async()=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'sfx-imgjob-'));
  const download=path.join(dir,'downloads');await fsp.mkdir(download,{recursive:true});
  return {dir,download};
};
/** Writes the shape verifyFolder expects: every declared picture present, every file declared. */
async function writeStaged(output,uid,url){
  await fsp.mkdir(path.join(output,'images'),{recursive:true});
  await fsp.writeFile(path.join(output,'images','01-shot.png'),fixturePng());
  await fsp.writeFile(path.join(output,'info.json'),JSON.stringify({uid,kind:'images',author:'studio',source_url:url,images:[{file:'images/01-shot.png'}]}));
}
/** A manager whose three runners only record what they were asked for. */
async function harness({imageResult={folder:true,bytes:1,fileCount:2,zipName:'fake-images',imageCount:1}}= {}){
  const {dir,download}=await temporary();
  const calls=[];
  const m=await new DownloadManager({
    dataDir:dir,defaultFolder:download,autoStart:false,
    runner:async input=>{calls.push(['model',input]);return {zipName:'model.zip'};},
    artRunner:async input=>{calls.push(['art',input]);return {zipName:'art.zip'};},
    // Stands in for runImageJob's contract: a real staged folder that the *real* verifier accepts,
    // so "the picture job saved" means it went through the same validation a model export does.
    imageRunner:async input=>{calls.push(['image',input]);await writeStaged(input.output,input.uid,input.url);return imageResult;},
    blenderImporter:()=>({ok:true,file:'x'}),
  }).init();
  m.start('http://127.0.0.1:1');
  return {m,calls,dir,download,cleanup:async()=>{await m.close();await fsp.rm(dir,{recursive:true,force:true});}};
}
const wait=async(m,id,states,ms=8000)=>{
  const end=Date.now()+ms;
  while(Date.now()<end){const j=m.snapshot().jobs.find(x=>x.id===id);if(j&&states.includes(j.state))return j;await new Promise(r=>setTimeout(r,25));}
  throw Error('任务未在预期时间内到达状态：'+states.join('/'));
};

test('an images job is queued, persisted with its platform, and handed to the picture runner',async()=>{
  const {m,calls,cleanup}=await harness();
  try{
    const {added}=await m.enqueue({authorized:true,kind:'images',models:[{uid:uid(2),name:'Two',platform:'sketchfab',thumbnail:'https://x/y.jpg'}],options:{}});
    assert.equal(added.length,1);
    const job=m.snapshot().jobs.find(j=>j.id===added[0]);
    assert.equal(job.kind,'images');
    assert.equal(job.platform,'sketchfab');
    assert.equal(job.url,`https://sketchfab.com/models/${uid(2)}`);
    assert.deepEqual(job.options,{output:'folder',imageRendition:'max'});

    const done=await wait(m,added[0],['saved','failed']);
    assert.equal(done.state,'saved');
    // Only the picture runner was asked, and it was given everything the registry needs to resolve
    // the source again after a restart.
    assert.deepEqual(calls.map(c=>c[0]),['image']);
    assert.equal(calls.at(-1)[1].platform,'sketchfab');
    assert.equal(calls.at(-1)[1].uid,uid(2));
  }finally{await cleanup();}
});
test('the same asset may hold both a model job and a picture job without either being "duplicate"',async()=>{
  const {m,calls,cleanup}=await harness();
  try{
    const {added:modelJob}=await m.enqueue({authorized:true,models:[{uid:uid(1),name:'One'}],options:{}});
    assert.equal(modelJob.length,1);
    const {added}=await m.enqueue({authorized:true,kind:'images',models:[{uid:uid(1),name:'One',platform:'sketchfab',thumbnail:'https://x/y.jpg'}],options:{}});
    assert.equal(added.length,1,'same asset, different kind — must not be treated as already queued');
    const again=await m.enqueue({authorized:true,kind:'images',models:[{uid:uid(1),name:'One',platform:'sketchfab'}],options:{}});
    assert.equal(again.added.length,0);
    assert.equal(again.duplicates.length,1);
    await wait(m,added[0],['saved','failed']);
    assert.deepEqual(calls.map(c=>c[0]).sort(),['image','model']);
  }finally{await cleanup();}
});
test('an ArtStation picture job keeps the artwork URL and routes to the same picture runner',async()=>{
  const {m,calls,cleanup}=await harness();
  try{
    const artwork='https://www.artstation.com/artwork/lEVE8J';
    const {added}=await m.enqueue({authorized:true,kind:'images',models:[{uid:uid(3),name:'Three',platform:'artstation',artworkUrl:artwork,artId:'lEVE8J'}],options:{}});
    const job=m.snapshot().jobs.find(j=>j.id===added[0]);
    assert.equal(job.platform,'artstation');
    assert.equal(job.url,artwork);
    assert.equal(job.artId,'lEVE8J');
    await wait(m,added[0],['saved','failed']);
    assert.equal(calls.at(-1)[0],'image');
    assert.equal(calls.at(-1)[1].platform,'artstation');
  }finally{await cleanup();}
});
test('picture batches are capped, and an ArtStation artwork without a valid URL is refused early',async()=>{
  const {m,cleanup}=await harness();
  try{
    const many=Array.from({length:IMAGE_BATCH+1},(_,i)=>({uid:uid(9)+String(i).padStart(0,'0'),name:`M${i}`}));
    await assert.rejects(()=>m.enqueue({authorized:true,kind:'images',models:many,options:{}}),/每批最多添加 50 个/);
    await assert.rejects(()=>m.enqueue({authorized:true,kind:'images',models:[{uid:uid(4),platform:'artstation',artworkUrl:'https://evil.example/a'}],options:{}}),/ArtStation 作品地址无效/);
    await assert.rejects(()=>m.enqueue({authorized:true,kind:'images',models:[{uid:'nope'}],options:{}}),/模型 ID 无效/);
  }finally{await cleanup();}
});
test('picture options stay disjoint from export options, which is what keeps the dedupe honest',()=>{
  assert.deepEqual(imageOptions({}),{output:'folder',imageRendition:'max'});
  // 'zip' is a real choice; 'weird' is not, and must fall back rather than reach the writer.
  assert.deepEqual(imageOptions({output:'zip'}),{output:'zip',imageRendition:'max'});
  assert.deepEqual(imageOptions({output:'weird'}),{output:'folder',imageRendition:'max'});
  assert.notDeepEqual(imageOptions({}),{packMode:'model',maxTextureEdge:0});
});
