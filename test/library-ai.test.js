import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createAIService} from '../server/ai.mjs';
import {createLibraryServer} from '../server/library.mjs';

async function fixture(t,options={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-ai-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return createAIService({file:path.join(dir,'ai.json'),...options});
}

test('configuration persists, masks and preserves keys, with explicit clearing',async t=>{
 const ai=await fixture(t);
 assert.equal((await ai.settings()).enabled,false);
 const input={enabled:true,baseUrl:'http://127.0.0.1:31415/v1/',model:'auto',apiKey:'test-secret'};
 const saved=await ai.configure(input);
 assert.equal(saved.baseUrl,'http://127.0.0.1:31415/v1');
 assert.equal(saved.hasKey,true);
 assert.deepEqual(await ai.key(),{apiKey:'test-secret'});
 assert.ok(!JSON.stringify(saved).includes('test-secret'));
 assert.equal((await ai.configure({apiKey:'',model:'other'})).hasKey,true);
 assert.equal((await ai.settings()).model,'other');
 assert.equal((await ai.configure({clearKey:true})).hasKey,false);
 assert.deepEqual(await ai.key(),{apiKey:''});
});

test('saved key requires an explicit local POST and must not be cached or exposed in settings',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-key-'));
 const ai=createAIService({file:path.join(dir,'ai-settings.json')});
 await ai.configure({apiKey:'fixture-reveal-key'});
 const previous=process.env.SFX_DATA_DIR;let server;
 try{process.env.SFX_DATA_DIR=dir;server=createLibraryServer();}
 finally{if(previous===undefined)delete process.env.SFX_DATA_DIR;else process.env.SFX_DATA_DIR=previous;}
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}/api/ai/`;
 const headers={'X-SFX-Local':'1','Content-Type':'application/json'};
 assert.equal((await fetch(base+'key',{method:'POST',body:'{}'})).status,403);
 assert.equal((await fetch(base+'key',{method:'POST',headers:{...headers,Origin:'https://example.com'},body:'{}'})).status,403);
 const settings=await(await fetch(base+'settings',{headers})).json();
 assert.equal(settings.hasKey,true);assert.equal(settings.apiKey,undefined);
 const response=await fetch(base+'key',{method:'POST',headers,body:'{}'});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(await response.json(),{apiKey:'fixture-reveal-key'});
});

test('rejects unsafe configuration and does not call disabled services',async t=>{
 let calls=0;const ai=await fixture(t,{fetchImpl:()=>{calls++;}});
 await assert.rejects(ai.complete([{role:'user',content:'hello'}]),/启用/);
 for(const baseUrl of ['file:///tmp/x','http://example.com/v1','https://key@example.com/v1','https://example.com/v1?key=x'])await assert.rejects(ai.configure({baseUrl}));
 await assert.rejects(ai.configure({apiKey:'bad\nkey'}),/密钥/);
 assert.equal(calls,0);
});

test('real HTTP model discovery and completion use the configured endpoint and key',async t=>{
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  requests.push({url:req.url,key:req.headers.authorization,body:text?JSON.parse(text):null});
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(req.url.endsWith('/models')?{data:[{id:'tiny-model'}]}:{model:'tiny-model',choices:[{message:{content:'好的'}}]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const ai=await fixture(t);
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 await ai.configure({enabled:true,baseUrl,model:'tiny-model',apiKey:'fixture-key'});
 assert.deepEqual(await ai.models({}),{models:['tiny-model']});
 assert.deepEqual(await ai.test(),{ok:true,model:'tiny-model'});
 assert.deepEqual(await ai.complete([{role:'user',content:'翻译木椅'}]),{text:'好的',model:'tiny-model'});
 assert.equal(requests[0].url,'/v1/models');
 assert.equal(requests[1].url,'/v1/chat/completions');
 assert.equal(requests[1].key,'Bearer fixture-key');
 assert.equal(requests[1].body.stream,false);
 assert.equal(requests[1].body.max_tokens,32);
});

test('upstream errors never expose provider responses or credentials',async t=>{
 const ai=await fixture(t,{fetchImpl:async()=>new Response('fixture-secret',{status:401})});
 await ai.configure({enabled:true,apiKey:'fixture-secret'});
 await assert.rejects(ai.test(),error=>error.message.includes('401')&&!error.message.includes('fixture-secret'));
});

test('empty, oversized and invalid model responses fail explicitly',async t=>{
 for(const data of [{choices:[]},{error:'upstream error'},'not-json','x'.repeat(1024*1024+1)]){
  const ai=await fixture(t,{fetchImpl:async()=>new Response(typeof data==='string'?data:JSON.stringify(data))});
  await ai.configure({enabled:true});
  await assert.rejects(ai.test());
 }
 const ai=await fixture(t,{fetchImpl:async()=>new Response('{}')});
 await assert.rejects(ai.models({}),/模型列表/);
});
