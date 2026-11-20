// 可重复的隔离验收：node scripts/benchmark-library-canvas.mjs
// 不读取真实用户库；输出暖读视图与 60 秒空闲 HTTP 同步的原始数据。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {createCanvasBoards} from '../server/canvas-boards.mjs';
import {createLibraryServer} from '../server/library.mjs';

const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'av-perf-benchmark-'));
let server;
try {
 const storage=createLibraryStorage(dataDir);
 const models=Array.from({length:10000},(_,i)=>({uid:i.toString(16).padStart(32,'0'),name:`Asset ${i}`,thumbnail:`https://img.invalid/${i}.jpg`}));
 await storage.save({'sfx-library-v2':JSON.stringify({version:2,models,trashed:[],favorites:[],options:{}})});
 const samples=[];
 for(let i=0;i<3;i++){
  for(const paged of (i%2?[true,false]:[false,true])){
   const start=performance.now(),view=await storage.load({catalogPaged:paged});
   samples.push({paged,ms:+(performance.now()-start).toFixed(2),bytes:Buffer.byteLength(JSON.stringify(view))});
   if(paged)assert.equal(view.catalogTotal,10000);
  }
 }
 assert.equal((await storage.catalogPage(9990,24)).items.length,10);
 const service=createCanvasBoards({storage,dataDir});
 const base=await service.read();
 const document={format:'artflow-project',version:2,boards:base.boards,assets:[],nodes:Array.from({length:1000},(_,i)=>({id:`text-${i}`,boardId:base.boards[0].id,nodeType:'text',x:i%25*240,y:Math.floor(i/25)*120,width:200,height:80,properties:{text:`验收节点 ${i}`}}))};
 await service.save({document,base});
 server=createLibraryServer({cacheDir:dataDir,downloads:{dataDir,jobs:[],snapshot:()=>({jobs:[]})},collect:false,backup:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/api/library/artflow-board`;
 const headers={'X-SFX-Local':'1'};
 // 首次读取可能 reconcile，第二次获取稳定版本。
 await (await fetch(url,{headers})).arrayBuffer();
 const initial=await fetch(url,{headers}),text=await initial.text(),etag=initial.headers.get('etag');
 assert.equal(JSON.parse(text).nodes.length,1000);assert.ok(etag);
 const idle=[],started=performance.now();
 console.log(JSON.stringify({phase:'seeded',rows:10000,nodes:1000,samples,canvasBytes:Buffer.byteLength(text)}));
 for(let i=1;i<=20;i++){
  await delay(Math.max(0,started+i*3000-performance.now()));
  const start=performance.now(),response=await fetch(url,{headers:{...headers,'If-None-Match':etag}}),body=await response.text();
  assert.equal(response.status,304);assert.equal(body,'');
  idle.push({status:response.status,ms:+(performance.now()-start).toFixed(2),bodyBytes:Buffer.byteLength(body)});
 }
 console.log(JSON.stringify({phase:'idle-complete',seconds:+((performance.now()-started)/1000).toFixed(2),idle,bodyBytes:idle.reduce((n,row)=>n+row.bodyBytes,0),fullReadBodyBytes:Buffer.byteLength(text)*20}));
} finally {
 if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await fs.rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
