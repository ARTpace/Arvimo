import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SERVER_VERSION,SERVER_CAPABILITIES,REQUIRED_CAPABILITY_KEYS,serverIsCurrent} from '../server/capabilities.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {FEEDS,feedEndpoint} from '../src/library/platforms.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

/** 起一个服务端：所有出站检索都换成假实现，测试永远不碰网络。 */
async function serve(overrides={}){
 const server=createLibraryServer({
  downloads:{close:async()=>{}},
  search:async()=>({models:[]}),
  scan:async()=>({models:[]}),
  artsearch:async()=>({models:[]}),
  polyhaven:async()=>({models:[]}),
  ...overrides,
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 return {base,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

const local={'X-SFX-Local':'1'};

test('AI settings require local access and never return the API key',async()=>{
 const {base,close}=await serve();
 try{
  assert.equal((await fetch(base+'/api/ai/settings')).status,403);
  assert.equal((await fetch(base+'/api/ai/settings',{headers:{...local,Origin:'https://other.example'}})).status,403);
  const response=await fetch(base+'/api/ai/settings',{headers:local});
  assert.equal(response.status,200);
  const config=await response.json();
  assert.equal(typeof config.hasKey,'boolean');
  assert.equal(Object.hasOwn(config,'apiKey'),false);
  assert.equal(SERVER_CAPABILITIES.aiConnection,true);
 }finally{await close();}
});

test('the capability contract is complete and self-consistent',()=>{
 assert.equal(typeof SERVER_VERSION,'string');
 assert.ok(SERVER_VERSION.length>0,'服务端必须有版本号');
 assert.equal(SERVER_CAPABILITIES.version,SERVER_VERSION,'契约里的 version 就是服务端版本，不能各写各的');
 assert.ok(REQUIRED_CAPABILITY_KEYS.length>0);
 assert.equal(REQUIRED_CAPABILITY_KEYS.includes('version'),false,'version 单独比，不该混进能力位');
 for(const key of REQUIRED_CAPABILITY_KEYS)assert.equal(SERVER_CAPABILITIES[key],true,`能力位 ${key} 要为 true`);
});

test('a stale server is recognised as stale, so the launcher restarts it',()=>{
 // 3.5 时代的回答：老能力位一应俱全，但没有 Poly Haven —— 前端却已经是新版。
 // 这一份曾经被判定成「已是最新」，于是进程永不重启，点搜索只能撞上「不存在的页面或接口」。
 const stale={version:'2026-09-blender-install-progress',pickFolder:true,fixedExportDefaults:true,artstationVerifyWindow:true,blenderExistingScene:true,blenderBridgeProgress:true};
 assert.equal(serverIsCurrent(stale),false,'缺少新能力的旧进程必须被重启');
 // 只升了版本、能力位没跟上。
 assert.equal(serverIsCurrent({...SERVER_CAPABILITIES,version:'3.5.0'}),false);
 // 版本对了，但少了任意一位能力。
 for(const key of REQUIRED_CAPABILITY_KEYS)assert.equal(serverIsCurrent({...SERVER_CAPABILITIES,[key]:false}),false,`少了 ${key} 也要重启`);
});

test('only an answer that matches the contract exactly counts as current',()=>{
 assert.equal(serverIsCurrent(SERVER_CAPABILITIES),true);
 assert.equal(serverIsCurrent({...SERVER_CAPABILITIES}),true);
 // 读不到回答时不能乐观当成功——端口被别人占着也是这种情形，重启才是对的。
 for(const junk of [null,undefined,'',0,[],{},'ok',{version:SERVER_VERSION}])assert.equal(serverIsCurrent(junk),false,String(junk));
});

test('the capabilities endpoint answers with the contract itself',async()=>{
 const {base,close}=await serve();
 try{
  const response=await fetch(`${base}/api/downloads/capabilities`,{headers:local});
  assert.equal(response.status,200);
  const cap=await response.json();
  assert.deepEqual(cap,SERVER_CAPABILITIES,'端点必须原样吐契约，不能自己再抄一份');
  assert.equal(serverIsCurrent(cap),true,'启动器看到这份回答就该认为服务是新的');
 }finally{await close();}
});

test('every feed the UI can request has a route behind it',async()=>{
 // 前端 platform registry 里声明的每个结果流，服务端都得接得住。
 // 少了任何一条，用户看到的就是那句「不存在的页面或接口」——而不是某个功能坏了。
 const {base,close}=await serve();
 try{
  for(const mode of FEEDS){
   const response=await fetch(base+feedEndpoint(mode),{method:'POST',headers:local,body:'{}'});
   assert.notEqual(response.status,404,`结果流 ${mode}（${feedEndpoint(mode)}）在服务端没有路由`);
   assert.equal(response.status,200,`结果流 ${mode} 应当正常返回`);
  }
 }finally{await close();}
});

test('the Poly Haven route answers instead of falling through to the 404 page',async()=>{
 let seen;
 const {base,close}=await serve({polyhaven:async input=>(seen=input,{models:[],count:0})});
 try{
  const url=`${base}/api/polyhaven/search`;
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403,'缺本地请求标识要拦住');
  assert.equal((await fetch(url,{method:'GET',headers:local})).status,405,'只接受 POST');
  const response=await fetch(url,{method:'POST',headers:local,body:JSON.stringify({query:'chair'})});
  assert.equal(response.status,200,'检索接口必须存在');
  assert.deepEqual(seen,{query:'chair'});
 }finally{await close();}
});

test('the launcher asks the contract instead of keeping its own copy of the list',()=>{
 const source=fs.readFileSync(path.join(root,'scripts','start-library-background.mjs'),'utf8');
 assert.match(source,/serverIsCurrent/,'启动器要 import 契约里的判定函数');
 assert.equal(/cap\?\.pickFolder/.test(source),false,'能力位清单不能又在启动器里手写一份');
});
