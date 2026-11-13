import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('主机已登记根只读检查闭环及LAN/未登记/跨源拒绝',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-preflight-api-'));
 const old={};for(const key of ['SFX_DATA_DIR','SFX_CACHE_DIR','APPDATA']){old[key]=process.env[key];process.env[key]=dir;}
 t.after(async()=>{for(const key of Object.keys(old)){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}await fs.rm(dir,{recursive:true,force:true});});
 const folder=path.join(dir,'assets');await fs.mkdir(path.join(folder,'sub'),{recursive:true});
 await fs.writeFile(path.join(folder,'a.txt'),'same');await fs.writeFile(path.join(folder,'b.txt'),'same');await fs.writeFile(path.join(folder,'sub','a.txt'),'other');
 const {createLibraryServer}=await import('../server/library.mjs');
 const server=createLibraryServer({cacheDir:dir,collect:false,backup:false,downloads:{dataDir:dir,jobs:[],snapshot:()=>({jobs:[]})},lanSharing:{handle:async req=>{if(req.headers['test-lan'])req.lanVisitor=true;return false;}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const base=`http://127.0.0.1:${server.address().port}`;
 const call=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','x-sfx-local':'1',...headers},body:JSON.stringify(body)});
 const route='/api/library/import-preflight';
 assert.equal((await call(route,{folder})).status,403);
 assert.equal((await call('/api/library/import-roots',{folder})).status,200);
 const response=await call(route,{folder});assert.equal(response.status,200);const data=await response.json();
 assert.equal(data.scope,'directory-batch');assert.equal(data.truncated,false);assert.equal(data.stats.total,3);assert.deepEqual(data.scanned,{folders:1,skipped:0});
 assert.equal(data.stats['exact-duplicate'],1);assert.equal(data.stats['same-name-different-content'],1);
 assert.equal((await call(route,{folder},{'test-lan':'1'})).status,403);
 assert.equal((await call(route,{folder},{origin:'http://evil.invalid'})).status,403);
 assert.equal((await call(route,{folder},{'x-sfx-local':''})).status,403);
 assert.equal(await fs.readFile(path.join(folder,'a.txt'),'utf8'),'same');
 await fs.rename(folder,folder+'-offline');assert.equal((await call(route,{folder})).status,409);
});
