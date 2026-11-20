import test from 'node:test';
import assert from 'node:assert/strict';
import {pictureWindow,forgetPictureIndex} from '../server/picture-index.mjs';
import {collectPictureAssets,PICTURE_SITES} from '../server/picture-sites.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const items=(start,count)=>Array.from({length:count},(_,i)=>({url:`https://img.test/${start+i}.jpg`}));

test('小红书首屏按24张采集，不先凑72张；后续仍填充索引',async()=>{
 const calls=[];let release;
 const url='https://www.xiaohongshu.com/explore?first-page-proof';
 const result=await pictureWindow('xiaohongshu',url,24,{collect:async(_,args,{maxItems})=>{
  calls.push(maxItems);
  if(calls.length>1)await new Promise(resolve=>release=resolve);
  return {items:items(0,calls.length===1?24:84),truncated:calls.length===1};
 }});
 assert.equal(calls[0],24);assert.equal(result.items.length,24);
 release();
 const more=await pictureWindow('xiaohongshu',url,84,{collect:()=>{throw Error('应复用正在填充的索引');}});
 assert.equal(more.items.length,84);forgetPictureIndex('xiaohongshu',url);
});
test('progressive crawl publishes the first page without restarting page one',async()=>{
 const results=[];
 for(const progressive of [false,true]) {
  let requests=0,collects=0;const url=`https://perf.test/${progressive}`;
  const collect=async(_,args,{maxItems,onProgress})=>{
   collects++;const all=[];
   for(let page=0;page<6&&all.length<maxItems;page++) {
    requests++;await sleep(20);const batch=items(page*24,24);all.push(...batch);onProgress?.({items:batch,title:'Pictures'});
   }
   return {items:all,truncated:all.length<144,title:'Pictures'};
  };
  const start=performance.now();const first=await pictureWindow('perf',url,24,{collect,progressive});const firstMs=performance.now()-start;
  assert.equal(first.items.length,24);
  const all=await pictureWindow('perf',url,144,{collect,progressive});
  assert.equal(all.items.length,144);assert.equal(new Set(all.items.map(it=>it.url)).size,144);
  assert.equal(collects,progressive?1:2);assert.equal(requests,progressive?6:9);
  results.push({progressive,requests,collects,firstMs:Math.round(firstMs),allMs:Math.round(performance.now()-start)});
  forgetPictureIndex('perf',url);
 }
 console.log('PAGINATION_PERFORMANCE '+JSON.stringify(results));
});
test('production collector emits only new page items with platform metadata',async()=>{
 const progress=[];let page=0;
 const result=await collectPictureAssets('wallhaven',{url:'nature'},{maxItems:100,onProgress:batch=>progress.push(batch),readJson:async()=>({data:items(++page,1).map(item=>({path:item.url})),meta:{next_page:page<2}})});
 assert.deepEqual(progress.map(batch=>batch.items.length),[1,1]);assert.equal(result.items.length,2);assert.equal(progress[0].platform,'wallhaven');assert.equal(progress[0].source,'nature');assert.equal(progress[0].title,'nature');assert.equal(progress[0].rendition,'original');
});
test('progressive failure retains visible items; clearing an index aborts its crawl',async()=>{
 const url='https://perf.test/failure';const error=new Error('later request failed');
 const result=await pictureWindow('perf',url,60,{progressive:true,collect:async(_,args,{onProgress})=>{onProgress({items:items(0,24)});throw error;}});
 assert.equal(result.items.length,24);assert.equal(result.complete,false);assert.equal(result.truncated,true);assert.equal(result.warning,error.message);forgetPictureIndex('perf',url);
 const controller=new AbortController();let crawlSignal;
 const pending=pictureWindow('perf','https://perf.test/cancel',24,{progressive:true,signal:controller.signal,collect:(_,args,{signal})=>{crawlSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(crawlSignal.aborted,true);
});

test('retrying a failed crawl keeps visible items and clears its old warning on recovery',async()=>{
 const url='https://perf.test/recover';let attempts=0;
 const collect=async(_,args,{onProgress})=>{
  attempts++;onProgress({items:items(0,24)});
  if(attempts===1)throw Error('temporary upstream failure');
  return {items:items(0,48)};
 };
 const partial=await pictureWindow('perf',url,48,{collect,progressive:true});
 assert.equal(partial.items.length,24);assert.match(partial.warning,/temporary/);
 const recovered=await pictureWindow('perf',url,48,{collect,progressive:true});
 assert.equal(recovered.items.length,48);assert.equal(recovered.warning,'');assert.equal(recovered.complete,true);assert.equal(attempts,2);
 forgetPictureIndex('perf',url);
});
test('one cancelled waiter cannot cancel a shared request needed by another viewer',async()=>{
 const url='https://perf.test/shared';const controller=new AbortController();let crawlSignal,release;
 const collect=async(_,args,{signal,onProgress})=>{crawlSignal=signal;await new Promise(resolve=>release=resolve);onProgress({items:items(0,24)});return {items:items(0,24),truncated:false};};
 const cancelled=pictureWindow('perf',url,24,{collect,progressive:true,signal:controller.signal});
 const survivor=pictureWindow('perf',url,24,{collect,progressive:true});controller.abort();await assert.rejects(cancelled,{name:'AbortError'});assert.equal(crawlSignal.aborted,false);release();assert.equal((await survivor).items.length,24);forgetPictureIndex('perf',url);
});
test('LRU eviction keeps other entries cached and aborts evicted background work',async()=>{
 const signals=[];const urls=[];
 for(let i=0;i<13;i++) {
  const url=`https://perf.test/lru/${i}`;urls.push(url);
  await pictureWindow('perf',url,1,{progressive:true,collect:(_,args,{signal,onProgress})=>{signals.push(signal);onProgress({items:items(i,1)});return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 }
 assert.equal(signals[0].aborted,true);assert.equal(signals.at(-1).aborted,false);
 const latest=await pictureWindow('perf',urls.at(-1),1,{collect:()=>{throw Error('cache must survive unrelated insertion');}});assert.equal(latest.items.length,1);
 for(const url of urls)forgetPictureIndex('perf',url);
});
