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
    assert.equal(info.images[0].file,'images/sketchfab_01-Twin Suns.png');
    // The widest published rendition is the one that lands — the other two would be duplicates.
    assert.equal(info.images[0].width,4096);
    assert.equal(info.images[0].url,OTHER);
    assert.equal(info.images[0].format,'png');
    // The extension is chosen from the bytes, never from the URL: both agreed here, but the rule
    // that made them agree is what this asserts.
    await fsp.access(path.join(output,'images','sketchfab_01-Twin Suns.png'));

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
    assert.equal(verified.images[0].name,'images/sketchfab_01-Twin Suns.png');
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

// ---- 一张图出问题不该拖死整包；断点重试不该从头再下一遍 ----
//
// 现实里的图站不会「要么全通、要么全断」：花瓣 294 张的板子断在第 7 张，重试又从第 1 张开始，
// 前 6 张白下。所以这里钉住两件事：个别图取不回来时跳过并记账，重试时按清单续传。

/** Poly Haven 的图片源可以完整注入 open，正好用来造「三张图里坏一张」。 */
function polyhavenOpen(bodies){
  const png=fixturePng();
  return async url=>{
    const text=String(url);
    if(text.endsWith('/renders/Chair'))return {status:200,headers:{},stream:Readable.from([Buffer.from(JSON.stringify({'a.png':0,'b.png':0,'c.png':0}))])};
    if(text.startsWith('https://api.polyhaven.com/assets'))return {status:200,headers:{},stream:Readable.from([Buffer.from('{}')])};
    const name=text.split('/').pop();
    if(bodies[name])return {status:200,headers:{'content-length':String(bodies[name].length)},stream:Readable.from([bodies[name]])};
    return {status:404,headers:{},stream:Readable.from([])};
  };
}
const CDN_BASE='https://cdn.polyhaven.com/asset_img/renders/Chair';

test('个别图片取不回来时跳过继续，清单与提示都记下少了几张',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'out');
    const png=fixturePng();
    const result=await runImageJob(
      {uid:UID,platform:'polyhaven',assetId:'Chair',name:'Chair',output,deliver:'folder',workRoot:root,open:polyhavenOpen({'a.png':png,'c.png':png})},
      {},
    );
    assert.equal(result.imageCount,2,'坏掉的那一张不该让整包失败');
    assert.equal(result.failedCount,1);
    const info=await writeInfo(output,'info.json');
    assert.equal(info.imageCount,2);
    assert.equal(info.failedCount,1,'少了几张要写进清单，卡片才能如实提示');
    // 清单与目录必须两边对得上，否则校验器会以「存在未登记的作品图片」拒绝整包
    const verified=await verifyFolder(output,{uid:UID});
    assert.equal(verified.images.length,2);
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('重试时按清单续传：已有的图不再重下，残留的半张图被清掉',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'out');
    const png=fixturePng();
    await fsp.mkdir(path.join(output,'images'),{recursive:true});
    // 上一次尝试：a、b 已经落盘，清单写着「未完成」；c 没下到，另有一张写了一半的残留
    for(const name of ['01-a.png','02-b.png'])await fsp.writeFile(path.join(output,'images',name),png);
    await fsp.writeFile(path.join(output,'images','09-半张.png'),png);
    await fsp.writeFile(path.join(output,'info.json'),JSON.stringify({
      uid:UID,kind:'images',platform:'polyhaven',title:'Chair',imageCount:2,status:'incomplete',
      images:[
        {file:'images/01-a.png',url:`${CDN_BASE}/a.png`,bytes:png.length,format:'png',width:1,height:1},
        {file:'images/02-b.png',url:`${CDN_BASE}/b.png`,bytes:png.length,format:'png',width:1,height:1},
      ],
    }));
    const asked=[];
    const inner=polyhavenOpen({'a.png':png,'b.png':png,'c.png':png});
    const open=async url=>{asked.push(String(url));return inner(url);};
    const result=await runImageJob(
      {uid:UID,platform:'polyhaven',assetId:'Chair',name:'Chair',output,deliver:'folder',workRoot:root,open},
      {},
    );
    assert.equal(result.imageCount,3);
    assert.equal(result.failedCount,0);
    const imageRequests=asked.filter(u=>u.startsWith(CDN_BASE));
    assert.deepEqual(imageRequests.map(u=>u.split('/').pop()),['c.png'],'a、b 已经在盘上了，只该补 c');
    const info=await writeInfo(output,'info.json');
    assert.deepEqual(info.images.map(i=>i.file),['images/01-a.png','images/02-b.png',info.images[2].file]);
    assert.equal(info.images.length,3);
    assert.equal(info.status,undefined,'续传完成后不再是未完成状态');
    assert.ok(!(await fsp.readdir(path.join(output,'images'))).includes('09-半张.png'),'清单外的残留图片要清掉');
    const verified=await verifyFolder(output,{uid:UID});
    assert.equal(verified.images.length,3);
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});

// ---- 限流：整包不该因为「连续几张被拦」就判死，先歇一会儿再继续 ----
//
// 花瓣 1923 张的板子实测在 100 张左右开始整批回 HTTP 567（IP 累计配额）。判死重来的代价是
// 重新扫一遍上千张清单 + 续传对齐，而冷却 30 秒后往往就能接着跑 —— 所以这一层必须存在。
test('连续限流时先整包冷却再继续，而不是判死整包',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'staged');
    let requests=0;
    const open=async url=>{
      requests++;
      // 前 4 次模拟「抓得太急被拦」，之后恢复：只有冷却后继续才可能拿到图。
      if(requests<=4)return {status:567,headers:{},stream:Readable.from([]),url};
      return {status:200,headers:{'content-type':'image/png','content-length':String(fixturePng().length)},stream:Readable.from([fixturePng()]),url};
    };
    const cooled=[];
    const throttle={
      wait:async()=>{},
      reward:()=>{},
      penalise:()=>15000,
      coolDown:(url,ms,status)=>{cooled.push({ms,status});return ms;},
      ruleForUrl:()=>({id:'huaban',coolBaseMs:15000,coolMaxMs:180000}),
    };
    const messages=[];
    const result=await runImageJob(
      {uid:UID,platform:'sketchfab',name:'Rate limited',url:MODEL,output,deliver:'folder',workRoot:root,open,json:sketchfabJson,throttle},
      {progress:p=>messages.push(p.message)},
    );
    assert.equal(result.imageCount,1,'冷却之后仍要把图取回来');
    assert.ok(cooled.length>=1,'整包级冷却必须真的发生');
    assert.equal(cooled[0].status,567);
    assert.ok(messages.some(m=>/限流/.test(m)),'进度里要说清楚是在等限流，而不是卡住');
    const verified=await verifyFolder(output,{uid:UID});
    assert.equal(verified.images.length,1);
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});

// ---- 体积上限：边下边判，别等两小时跑完才说「超了」 ----
//
// 1923 张 4K 原图合计 8GB。原来的做法是全部收完再 `if(bytes>limit)throw`，等于白跑；
// 现在是到上限就停、包照样成功，把「还剩几张没下」如实写进清单与提示。
test('体积到上限时停下并如实报告还剩几张，而不是下完再判死',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'out');
    const png=fixturePng();
    const result=await runImageJob(
      {uid:UID,platform:'polyhaven',assetId:'Chair',name:'Chair',output,deliver:'folder',workRoot:root,
       open:polyhavenOpen({'a.png':png,'b.png':png,'c.png':png}),
       totalBytes:png.length*2-1},
      {},
    );
    // 3 路并发时上限判定会「粗」一点：同时在飞的三张都会先通过检查，所以最多多下 2 张。
    // 这点超发完全可接受 —— 要防的是「跑两小时才发现超限」，不是差这两张。
    assert.ok(result.imageCount>=2&&result.imageCount<=3,'到上限就停，已下到的照常成包');
    assert.equal(result.imageCount+result.truncatedCount,3,'下到的 + 没下的 = 全部，一张都不能凭空消失');
    const info=await writeInfo(output,'info.json');
    assert.equal(info.truncatedCount??0,result.truncatedCount);
    const verified=await verifyFolder(output,{uid:UID});
    assert.equal(verified.images.length,result.imageCount);
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});

// ---- 并发：节流管「什么时候发起」，下载与写盘在这个间隔里并行 ----
//
// 串行时每张 = 等间隔 + 网络 + 写盘，首尾相连；并发后后两段落进等待里。
// 这里钉住三件事：真的并发了（峰值 > 1）、没有超过上限、清单顺序仍按计划序号排。

test('多张图会并发下载，但不超过上限、清单仍按计划顺序',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'out');
    const png=fixturePng();
    let live=0,peak=0;
    const inner=polyhavenOpen({'a.png':png,'b.png':png,'c.png':png});
    // 每张图故意慢 60ms：串行时峰值只会是 1，并发才看得到 >1。
    const open=async url=>{
      live++;peak=Math.max(peak,live);
      try{await new Promise(r=>setTimeout(r,60));return await inner(url);}
      finally{live--;}
    };
    const result=await runImageJob(
      {uid:UID,platform:'polyhaven',assetId:'Chair',name:'Chair',output,deliver:'folder',workRoot:root,open},
      {},
    );
    assert.equal(result.imageCount,3);
    assert.ok(peak>=2,`三张慢图应该同时在飞，实际峰值 ${peak}`);
    assert.ok(peak<=3,`并发不能超过上限，实际峰值 ${peak}`);
    const info=await writeInfo(output,'info.json');
    const names=info.images.map(i=>i.file);
    assert.deepEqual(names,[...names].sort(),'清单要按 01/02/03 计划顺序，不能按谁先下完');
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});

// ---- 免二次拷贝：文件夹模式直接下到输出目录 ----
//
// 原来「先写 tmp、再逐张拷进输出」，上千张大图等于多搬一遍全部图片。现在下载即就位，
// 但输出目录里不能留下 `.part` 之类的东西（校验器会把未登记文件当错误）。

test('文件夹模式直接落盘，不留 tmp 中转目录、也不留 .part 残留',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'out');
    const png=fixturePng();
    const result=await runImageJob(
      {uid:UID,platform:'polyhaven',assetId:'Chair',name:'Chair',output,deliver:'folder',workRoot:root,open:polyhavenOpen({'a.png':png,'b.png':png,'c.png':png})},
      {},
    );
    assert.equal(result.imageCount,3);
    const leftovers=(await fsp.readdir(root)).filter(n=>n.startsWith('sva-images-'));
    assert.deepEqual(leftovers,[],'不该再建 tmp 中转目录');
    const top=await fsp.readdir(output);
    assert.deepEqual(top.filter(n=>/^\.part-/.test(n)),[],'输出目录里不能留下载临时文件');
    const verified=await verifyFolder(output,{uid:UID});
    assert.equal(verified.images.length,3);
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});

// ---- 续传：磁盘上的文件被截断时必须重下，而不是当成品接回来 ----
//
// 不逐张 fsync 之后，断电最坏能留下「文件在、内容半截」的成品。续传原来的判定只是
// 「文件存在吗」，那会把半张图接回清单 —— 所以现在按清单里的 bytes 校验大小。

test('续传时按清单字节数校验，截断的文件会重下',async()=>{
  const root=await temp();
  try{
    const output=path.join(root,'out');
    const png=fixturePng();
    const first=await runImageJob(
      {uid:UID,platform:'polyhaven',assetId:'Chair',name:'Chair',output,deliver:'folder',workRoot:root,open:polyhavenOpen({'a.png':png,'b.png':png,'c.png':png})},
      {},
    );
    assert.equal(first.imageCount,3);
    const info=await writeInfo(output,'info.json');
    const victim=path.join(output,...info.images[0].file.split('/'));
    await fsp.writeFile(victim,png.subarray(0,10));            // 模拟「写到一半断电」
    const asked=[];
    const inner=polyhavenOpen({'a.png':png,'b.png':png,'c.png':png});
    const result=await runImageJob(
      {uid:UID,platform:'polyhaven',assetId:'Chair',name:'Chair',output,deliver:'folder',workRoot:root,
       open:async url=>{asked.push(url);return inner(url);}},
      {},
    );
    assert.equal(result.imageCount,3,'截断的那张要重下，另外两张走续传');
    assert.equal((await fsp.stat(victim)).size,png.length,'重下后文件必须恢复完整大小');
    // 只该为坏掉的那一张发请求：好文件不重下，这才是续传的意义。
    const imageRequests=asked.filter(u=>/cdn\.polyhaven\.com/.test(String(u)));
    assert.equal(imageRequests.length,1,`只应重下 1 张，实际请求了 ${imageRequests.length} 张`);
  }finally{await fsp.rm(root,{recursive:true,force:true});}
});
