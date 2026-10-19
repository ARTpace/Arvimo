// Picture-bundle tests: one asset -> a verifiable folder/ZIP of pictures plus their manifest.
//
// The point of these is shared-property of the queue: whatever the source platform, an `images` job
// has to produce a bundle the *existing* verifiers accept (kind 'images', every declared file present,
// every present file declared, uid intact) — otherwise image jobs would quietly bypass the checks
// every other export goes through.
import test from 'node:test';import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {runImageJob,bundleStem} from '../server/image-bundle.mjs';
import {verifyArchive} from '../server/archive.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {fixturePng} from './download-fixture.mjs';

const UID='b'.repeat(32);
const MODEL=`https://sketchfab.com/models/${UID}`;
const COVER=`https://media.sketchfab.com/models/${UID}/thumbnails/x/front.jpeg`;
const OTHER=`https://media.sketchfab.com/models/${UID}/thumbnails/x/side.jpeg`;

/** One canned body per URL: a real PNG, so the sniffed extension has to come back as `png`. */
function fakeOpen(bodies){
  const png=fixturePng();
  return async url=>{
    if(bodies[url])return {status:200,headers:{'content-type':'image/png','content-length':String(bodies[url].length)},stream:Readable.from([bodies[url]]),url};
    return {status:404,headers:{},stream:Readable.from([]),url};
  };
}
/** Three renditions of one cover: the widest (4096) is the only one that should reach the disk. */
const sketchfabJson=async()=>({name:'Twin Suns',user:{displayName:'studio'},thumbnails:{images:[
  {width:720,url:`${COVER}-720`},{width:1920,url:COVER},{width:4096,url:OTHER},
]}});
const temp=()=>fsp.mkdtemp(path.join(os.tmpdir(),'sfx-imgbundle-'));
const writeInfo=(root,name)=>fsp.readFile(path.join(root,name),'utf8').then(JSON.parse);

test('a picture bundle carries the largest rendition, named by its bytes and verified',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'staged');
    const stages=[];
    const result=await runImageJob(
      {uid:UID,platform:'sketchfab',name:'Fallback name',url:MODEL,output,deliver:'folder',workRoot:root,open:fakeOpen({[OTHER]:fixturePng()}),json:sketchfabJson},
      {progress:p=>stages.push(p.stage)},
    );
    assert.equal(result.folder,true);
    assert.equal(result.imageCount,1);
    assert.equal(result.title,'Twin Suns');
    assert.equal(result.zipName,'Twin Suns-images');
    assert.ok(stages.includes('transferring'));

    const info=await writeInfo(output,'info.json');
    assert.equal(info.kind,'images');
    assert.equal(info.platform,'sketchfab');
    assert.equal(info.uid,UID);
    assert.equal(info.imageCount,1);
    assert.equal(info.images[0].file,'images/01-Twin Suns.png');
    // The widest published rendition is the one that lands — the other two would be duplicates.
    assert.equal(info.images[0].width,4096);
    assert.equal(info.images[0].url,OTHER);
    assert.equal(info.images[0].format,'png');
    // The extension is chosen from the bytes, never from the URL: both agreed here, but the rule
    // that made them agree is what this asserts.
    await fsp.access(path.join(output,'images','01-Twin Suns.png'));

    const verified=await verifyFolder(output,{uid:UID});
    assert.equal(verified.images.length,1);
    assert.equal(verified.author,'studio');
    assert.equal(verified.source,MODEL);
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});
test('the same bundle verifies as a ZIP, and its manifest still matches the archive exactly',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'staging','images.zip.part');
    const result=await runImageJob(
      {uid:UID,platform:'sketchfab',url:MODEL,output,deliver:'zip',workRoot:root,open:fakeOpen({[OTHER]:fixturePng()}),json:sketchfabJson},
      {},
    );
    assert.equal(result.folder,false);
    const verified=await verifyArchive(output,{uid:UID});
    assert.equal(verified.images.length,1);
    assert.equal(verified.images[0].name,'images/01-Twin Suns.png');
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});
test('a failure on one picture leaves nothing behind and says which URL broke',async()=>{
  const root=await temp();
  try{
    await assert.rejects(
      runImageJob({uid:UID,platform:'sketchfab',url:MODEL,output:path.join(root,'out'),deliver:'folder',workRoot:root,open:fakeOpen({}),json:sketchfabJson},{}),
      /HTTP 404/,
    );
    assert.deepEqual((await fsp.readdir(root)).filter(n=>n!=='out'),[]);
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});
test('an unknown source is refused before anything is written',async()=>{
  const root=await temp();
  try{
    await assert.rejects(
      runImageJob({uid:UID,platform:'myspace',url:MODEL,output:path.join(root,'out'),workRoot:root,open:fakeOpen({}),json:sketchfabJson},{}),
      /不支持下载图片/,
    );
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});
test('the export name always says it holds pictures, and falls back when the asset has no title',()=>{
  assert.equal(bundleStem('ignored',{title:'Twin Suns'}),'Twin Suns-images');
  assert.equal(bundleStem('My Model',{title:null}),'My Model-images');
  assert.equal(bundleStem(undefined,{title:'  '}),'images-images');
});
