import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPlatformSettings} from '../server/platform-settings.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {platformModules,platformForFeed,enabledPlatform} from '../src/library/platforms.js';

test('平台默认全开，支持全部关闭、恢复和重启持久化',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-platforms-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'settings.json'),store=createPlatformSettings(file);
 assert.ok(Object.values(store.get()).every(Boolean));
 const off=Object.fromEntries(platformModules().map(p=>[p.id,false]));await store.save(off);
 assert.deepEqual(createPlatformSettings(file).get(),off);
 await store.save({sketchfab:true});assert.equal(createPlatformSettings(file).enabled('sketchfab'),true);
 assert.equal(store.enabled('artstation'),false);assert.throws(()=>store.save({unknown:false}));
 assert.equal(platformForFeed('web'),'sketchfab');assert.equal(enabledPlatform(off,platformForFeed('art')),false);
});

test('关闭平台时后端拒绝搜索、自动分类、解析、代理与新下载，访客不能修改',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-platform-api-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let calls=0,visitor=false;
 const server=createLibraryServer({platformSettingsFile:path.join(dir,'settings.json'),cacheDir:path.join(dir,'cache'),lanSharing:{async handle(req){req.lanVisitor=visitor;return false;}},search:async()=>{calls++;return {models:[]};},polyhavenCats:async()=>{calls++;return {categories:[]};},downloads:{dataDir:dir,enqueueWithFolder:async()=>{calls++;return {};}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(url,input)=>fetch(base+url,{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify(input)});
 assert.equal((await post('/api/platforms',Object.fromEntries(platformModules().map(p=>[p.id,false])))).status,200);
 for(const url of ['/api/search','/api/scan','/api/artstation/resolve'])assert.equal((await post(url,{url:'https://sketchfab.com/models/test'})).status,403);
 assert.equal((await fetch(base+'/api/polyhaven/categories')).status,403);
 assert.equal((await fetch(base+'/api/image?url='+encodeURIComponent('https://media.sketchfab.com/test.jpg'))).status,403);
 assert.equal((await post('/api/downloads/tasks',{kind:'sketchfab',models:[]})).status,403);assert.equal(calls,0);
 visitor=true;assert.equal((await post('/api/platforms',{sketchfab:true})).status,403);
 assert.equal((await fetch(base+'/api/platforms')).status,200);
 visitor=false;await post('/api/platforms',{sketchfab:true});assert.equal((await post('/api/search',{})).status,200);assert.equal(calls,1);
});

test('前端关闭的平台不发请求，全部关闭与粘贴链接有提示',async()=>{
 const {createDiscoveryFeed}=await import('../src/library/discovery-feed.js');
 const {combine}=await import('../src/library/discovery-view.js');
 const notices=[],state={feeds:{},selected:new Set()},query={value:''};
 const feed=createDiscoveryFeed({$:()=>query,toast:text=>notices.push(text),state,activeModes:()=>[],feedEnabled:()=>false,renderGrid(){},clearSearchTimer(){},markQueryActive(){},searchHistoryUI:()=>null});
 await feed.requestFeed('search',{q:'test'});
 await feed.startSearch();feed.submitLink('https://www.artstation.com/artwork/test');
 assert.equal(notices.length,2);assert.match(notices[0],/所有平台已关闭/);assert.match(notices[1],/该平台已关闭/);
 const empty=combine({sources:[],feeds:{}});assert.equal(empty.error,false);assert.deepEqual(empty.rows,[]);
});
