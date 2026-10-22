import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBrowserDelivery,fetchBrowserAsset} from '../src/library/browser-delivery.js';
import {createLibraryServer} from '../server/library.mjs';
import {packFolder} from '../server/folder-archive.mjs';
import {SERVER_CAPABILITIES,serverIsCurrent} from '../server/capabilities.mjs';

test('launcher rejects servers that cannot deliver folders to LAN browsers',()=>{
 const old={...SERVER_CAPABILITIES};delete old.lanFolderDelivery;delete old.lanDeviceManagement;
 assert.equal(serverIsCurrent(old),false);
 assert.equal(serverIsCurrent(SERVER_CAPABILITIES),true);
});

test('LAN delivery defaults to automatic retrieval and preserves explicit opt-out',async()=>{
 let saved;const received=[],storage={getItem:()=>saved,setItem:(key,value)=>{saved=value;}};
 const create=()=>createBrowserDelivery({storage,defaultEnabled:true,download:id=>received.push(id)});
 let delivery=create();assert.equal(delivery.enabled,true);
 delivery.track(['mine']);await delivery.accept([{id:'mine',state:'saved',fileExists:true},{id:'other',state:'saved',fileExists:true}]);
 assert.deepEqual(received,['mine']);
 delivery.setEnabled(false);delivery=create();assert.equal(delivery.enabled,false);
 assert.equal(createBrowserDelivery({download(){}}).enabled,false,'localhost keeps its existing default');
});

test('browser delivery only retrieves opted-in submitted jobs once and survives reload',async()=>{
 let saved;const downloaded=[],storage={getItem:()=>saved,setItem:(key,value)=>{saved=value;}};
 let delivery=createBrowserDelivery({storage,download:id=>downloaded.push(id)});
 delivery.track(['old']);delivery.setEnabled(true);delivery.track(['mine']);
 const jobs=[{id:'other',state:'saved',fileExists:true},{id:'mine',state:'queued'}];
 await delivery.accept(jobs);assert.deepEqual(downloaded,[]);
 delivery=createBrowserDelivery({storage,download:id=>downloaded.push(id)});
 assert.equal(delivery.enabled,true);jobs[1]={id:'mine',state:'saved',fileExists:true};
 await delivery.accept(jobs);await delivery.accept(jobs);assert.deepEqual(downloaded,['mine']);
 delivery.track(['later']);delivery.setEnabled(false);delivery.setEnabled(true);
 await delivery.accept([{id:'later',state:'saved',fileExists:true}]);assert.deepEqual(downloaded,['mine']);
});

test('file retrieval streams ZIP files and packages folders without modifying originals',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-delivery-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const folder=path.join(dir,'asset');await fs.mkdir(folder);await fs.writeFile(path.join(folder,'model.glb'),'fixture');
 const archive=path.join(dir,'existing.zip');await packFolder(folder,archive);
 await assert.rejects(packFolder(folder,path.join(dir,'over.zip'),{maxBytes:1}),/打包限制/);
 const folderId='11111111-1111-1111-1111-111111111111',zipId='22222222-2222-2222-2222-222222222222';
 const downloads={dataDir:dir,file:id=>({job:{filename:id===folderId?'asset':'existing.zip'},path:id===folderId?folder:archive})};
 const server=createLibraryServer({downloads});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`;
 for(const id of [folderId,zipId]){
  const response=await fetch(`${base}/api/downloads/tasks/${id}/file`);
  assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.readUInt32LE(0),0x04034b50);
  if(id===zipId)assert.deepEqual(bytes,await fs.readFile(archive));
  else assert.ok(bytes.includes(Buffer.from('fixture')));
 }
 assert.equal(await fs.readFile(path.join(folder,'model.glb'),'utf8'),'fixture');
});

test('browser rejects server JSON instead of saving file.json',async()=>{
 await assert.rejects(fetchBrowserAsset('id',{fetch:async()=>new Response(JSON.stringify({error:'目录过大'}),{status:400,headers:{'Content-Type':'application/json'}})}),/目录过大/);
 const zip=Buffer.from([0x50,0x4b,0x03,0x04,1]);
 const result=await fetchBrowserAsset('id',{fetch:async()=>new Response(zip,{headers:{'Content-Type':'application/zip','Content-Disposition':"attachment; filename*=UTF-8''model.zip"}})});
 assert.equal(result.filename,'model.zip');assert.equal(result.blob.size,zip.length);
});

test('automatic delivery serializes downloads and retains failed jobs for reload',async()=>{
 let saved,finish,calls=0;const errors=[];
 const storage={getItem:()=>saved,setItem:(key,value)=>{saved=value;}};
 const delivery=createBrowserDelivery({storage,defaultEnabled:true,download:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
 delivery.track(['one','two']);const jobs=['one','two'].map(id=>({id,state:'saved',fileExists:true}));
 const pending=delivery.accept(jobs);await delivery.accept(jobs);assert.equal(calls,1);finish();await pending;
 const failed=createBrowserDelivery({storage,download:async()=>{throw Error('失败');},onError:e=>errors.push(e.message)});
 await failed.accept(jobs);await failed.accept(jobs);assert.deepEqual(errors,['失败']);
 assert.deepEqual(JSON.parse(saved).pending,['two']);
});
