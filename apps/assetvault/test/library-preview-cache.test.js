import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewCache} from '../src/library/preview-cache.js';

test('慢速磁盘写入队列有字节上限，预览读取不被阻塞',async()=>{
 let release,writes=0;
 const disk={keys:async()=>[],put:async()=>{writes++;await new Promise(resolve=>{release=resolve;});}};
 const cache=createPreviewCache(async()=>new Response('data'),{storage:{open:async()=>disk},maxQueuedBytes:4});
 await cache.get('a');await new Promise(resolve=>setImmediate(resolve));
 await cache.get('b');assert.equal(writes,1);
 release();await cache.flush();assert.equal(writes,1);
});

test('清理内存后在途请求不重新填满缓存',async()=>{
 let release,count=0;
 const cache=createPreviewCache(async()=>{count++;if(count===1)await new Promise(resolve=>{release=resolve;});return new Response('data');},{storage:null});
 const task=cache.get('one');await new Promise(resolve=>setImmediate(resolve));
 cache.clearMemory();release();await task;
 await cache.get('one');assert.equal(count,2);
});

function fixture(options={}){
 const files=new Map();let downloads=0;
 const cache={
  keys:async()=>[...files.keys()].map(url=>({url})),
  match:async key=>files.get(typeof key==='string'?key:key.url)?.clone(),
  put:async(key,response)=>{files.set(key,response.clone());},
  delete:async key=>files.delete(typeof key==='string'?key:key.url),
 };
 const storage={open:async()=>cache};
 const fetchResource=async()=>{downloads++;return new Response('1234');};
 const create=extra=>createPreviewCache(fetchResource,{storage,maxMemoryBytes:4,maxDiskBytes:8,...options,...extra});
 return {files,cache,create,downloads:()=>downloads};
}
const url=n=>`https://example.com/${n}.png`;

test('热缓存淘汰后从磁盘读取；新会话也无需重新下载，字节不改变',async()=>{
 const f=fixture(),c=f.create();
 assert.equal(await (await c.get(url(1))).text(),'1234');await c.flush();
 await c.get(url(2));await c.flush();
 await c.get(url(1));assert.equal(f.downloads(),2);
 assert.equal(await (await f.create().get(url(1))).text(),'1234');
 assert.equal(f.downloads(),2);
});

test('磁盘缓存按字节及条目限额淘汰，超大资源仍能预览',async()=>{
 const f=fixture(),c=f.create();
 for(const n of [1,2,3]){await c.get(url(n));await c.flush();}
 assert.equal(f.files.size,2);assert.ok(!f.files.has(url(1)));
 const small=f.create({maxEntries:1});await small.get(url(4));await small.flush();
 assert.equal(f.files.size,1);
 const tiny=f.create({maxDiskBytes:2,maxMemoryBytes:2});
 assert.equal((await tiny.get(url(5))).size,4);await tiny.flush();
 assert.ok(!f.files.has(url(5)));
});

test('并行请求合并，清空热缓存后不依赖网络',async()=>{
 const f=fixture(),c=f.create();
 const [a,b]=await Promise.all([c.get(url(1)),c.get(url(1))]);
 assert.equal(a,b);assert.equal(f.downloads(),1);await c.flush();
 c.clearMemory();await c.get(url(1));assert.equal(f.downloads(),1);
});

test('缓存禁用/写盘失败不影响预览，网络失败可以重试',async()=>{
 const f=fixture(),c=f.create({storage:{open:async()=>{throw Error('disabled');}}});
 assert.equal((await c.get(url(1))).size,4);
 f.cache.put=async()=>{throw Error('quota');};
 const full=f.create();assert.equal((await full.get(url(2))).size,4);await full.flush();
 let count=0;
 const retry=createPreviewCache(async()=>new Response('ok',{status:++count===1?503:200}),{storage:null});
 await assert.rejects(retry.get(url(1)),/503/);
 assert.equal(await (await retry.get(url(1))).text(),'ok');
});

test('过期磁盘资源重新获取',async()=>{
 const f=fixture(),c=f.create({now:()=>1});
 await c.get(url(1));await c.flush();
 await c.get(url(2));await c.flush();
 const expired=f.create({now:()=>8*24*60*60*1000});
 await expired.get(url(2));await expired.flush();assert.equal(f.downloads(),3);
});
