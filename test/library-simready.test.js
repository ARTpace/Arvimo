import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {simreadySearch,simreadyUid,runSimreadyJob,simreadyPreview,isSimreadyFileUrl} from '../server/simready.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {jobKindOf,platformById} from '../src/library/platforms.js';
import {platformForPath} from '../server/platform-settings.mjs';

const assetId='chair_a01',uid=simreadyUid(assetId);
const payload={'simready_usd/chair.usd':'#usda 1.0\n','simready_usd/Textures/a.png':'texture fixture','.metadata/LICENSE.txt':'CC BY 4.0'};
const rows=Object.entries(payload).map(([file,data])=>({type:'file',path:`${assetId}/${file}`,size:Buffer.byteLength(data)}));
const reply=(data,headers={})=>({status:200,headers,stream:Readable.from([Buffer.from(typeof data==='string'?data:JSON.stringify(data))])});
const open=async url=>{
 const u=new URL(url);
 assert.equal(u.origin,'https://hf-mirror.com');
 if(u.pathname.endsWith('/tree/main'))return reply([{type:'directory',path:u.searchParams.has('cursor')?'chair_a02':assetId}],{link:'<https://huggingface.co/api/datasets/nvidia/simready-assets/tree/main?cursor=next>; rel="next"',... (u.searchParams.has('cursor')?{link:''}:{})});
 if(u.pathname.includes('/tree/main/'))return reply(rows);
 const file=decodeURIComponent(u.pathname.split('/resolve/main/')[1]).slice(assetId.length+1);
 assert.ok(Object.hasOwn(payload,file));return reply(payload[file]);
};
test('SimReady searches names, paginates upstream, and registers the download platform',async()=>{
 const result=await simreadySearch({q:'chair'},{open});
 assert.equal(result.models[0].assetId,assetId);
 assert.equal(result.total,2);
 assert.equal((await simreadySearch({q:'missing'},{open})).models.length,0);
 assert.equal(jobKindOf(result.models),'simready');
 assert.deepEqual(platformById('simready').feeds,['simready']);
 assert.equal(platformForPath('/api/simready/search'),'simready');
});
test('SimReady preserves nested dependencies, detects truncation and rejects unsafe paths',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-simready-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await runSimreadyJob({uid,assetId,output:dir},{open});
 assert.equal(await fs.readFile(path.join(dir,'simready_usd/Textures/a.png'),'utf8'),payload['simready_usd/Textures/a.png']);
 assert.equal((await verifyFolder(dir,{uid})).info.license,'CC BY 4.0');
 await fs.writeFile(path.join(dir,'simready_usd/chair.usd'),'x');
 await assert.rejects(verifyFolder(dir,{uid}),/不完整/);
 await assert.rejects(runSimreadyJob({uid,assetId:'../escape',output:dir},{open}),/ID 无效/);
 await assert.rejects(runSimreadyJob({uid,assetId,output:dir},{open:async()=>reply([{type:'file',path:`${assetId}/../escape.usd`,size:1}])}),/路径无效/);
 await assert.rejects(runSimreadyJob({uid,assetId,output:dir},{open:async url=>url.includes('/tree/')?reply(rows.map(r=>({...r,size:r.size+1}))):open(url)}),/不完整/);
});
test('SimReady HTTP search and queue deliver USD without invoking GLB conversion',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-simready-queue-'));
 const manager=await new DownloadManager({dataDir:path.join(dir,'state'),defaultFolder:path.join(dir,'downloads'),simreadyRunner:(job,options)=>runSimreadyJob(job,{...options,open}),fbxConverter:()=>{throw Error('must not convert');}}).init();
 const server=createLibraryServer({downloads:manager,simready:(input)=>simreadySearch(input,{open}),cacheDir:path.join(dir,'cache'),platformSettingsFile:path.join(dir,'platforms.json')});
 t.after(async()=>{await manager.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;manager.start(base);
 const response=await fetch(base+'/api/simready/search',{method:'POST',headers:{'X-SFX-Local':'1','Content-Type':'application/json'},body:JSON.stringify({q:'chair'})});
 assert.equal(response.status,200);
 const model=(await response.json()).models[0];
 await assert.rejects(manager.enqueue({authorized:true,kind:'simready',models:[model],openInBlender:true}),/暂不支持/);
 await manager.enqueue({authorized:true,kind:'simready',models:[model],options:{format:'fbx'}});
 const end=Date.now()+10000;
 while(!['saved','failed'].includes(manager.jobs[0].state)&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
 assert.equal(manager.jobs[0].state,'saved',manager.jobs[0].message);
 assert.equal(manager.jobs[0].options.format,'usd');
 assert.ok((await fs.stat(path.join(manager.jobs[0].filePath,'simready_usd/chair.usd'))).isFile());
});


test('SimReady preview resolves a root layer and permits only its repository resources',async t=>{
 const manifest=await simreadyPreview(assetId,{open});
 assert.equal(manifest.root,'simready_usd/chair.usd');
 assert.equal(manifest.entries.length,1);
 assert.ok(isSimreadyFileUrl(new URL(manifest.entries[0].url)));
 assert.equal(isSimreadyFileUrl(new URL('https://hf-mirror.com/datasets/other/repo/resolve/main/a.usd')),false);
 assert.equal(isSimreadyFileUrl(new URL('https://evil.test/datasets/nvidia/simready-assets/resolve/main/a.usd')),false);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-simready-proxy-'));
 const server=createLibraryServer({open:async url=>{const r=await open(url);r.headers['content-type']='image/png';return r;},cacheDir:dir,platformSettingsFile:path.join(dir,'platforms.json')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const url=manifest.entries[0].url;
 const image=await fetch(base+'/api/image?url='+encodeURIComponent(url));
 assert.equal(image.status,200,await image.clone().text());
 assert.equal(await image.text(),payload['simready_usd/chair.usd']);
 assert.equal((await fetch(base+'/api/proxy?url='+encodeURIComponent(url))).status,403);
 const proxy=await fetch(base+'/api/proxy?url='+encodeURIComponent(url),{headers:{'x-sfx-local':'1'}});
 assert.equal(proxy.status,200);
 const preview=await fetch(base+'/api/simready/preview?id='+assetId,{headers:{'x-sfx-local':'1'}});
 assert.equal(preview.status,200);assert.equal((await preview.json()).root,manifest.root);
});

test('USD preview preserves relative references and reports missing or truncated layers',async()=>{
 const {build}=await import('esbuild');
 const result=await build({entryPoints:['src/library/usd-preview.js'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'three',setup(b){b.onResolve({filter:/^three(\/|$)/},a=>({path:path.resolve(a.path==='three'?'vendor/three/three.module.js':a.path.replace('three/examples/jsm/','vendor/three/'))}));}}]});
 const {loadUsdPreview}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
 const files={
  'scene/root.usda':'#usda 1.0\ndef Xform "Root" (\n prepend references = @./layers/mesh.usda@</Geometry/Triangle>\n)\n{\n double3 xformOp:translate = (2,0,0)\n uniform token[] xformOpOrder = ["xformOp:translate"]\n}',
  'scene/layers/mesh.usda':'#usda 1.0\ndef Xform "Geometry" {\ndef Mesh "Triangle" {\n double3 xformOp:translate = (3,0,0)\n uniform token[] xformOpOrder = ["xformOp:translate"]\n point3f[] points = [(0,0,0),(1,0,0),(0,1,0)]\n int[] faceVertexCounts = [3]\n int[] faceVertexIndices = [0,1,2]\n}\ndef Mesh "Other" {\n point3f[] points = [(0,0,0),(1,0,0),(0,1,0)]\n int[] faceVertexCounts = [3]\n int[] faceVertexIndices = [0,1,2]\n}\n}',
 };
 const entries=Object.entries(files).map(([name,text])=>({path:name,url:name,bytes:Buffer.byteLength(text)}));
 const get=async name=>new TextEncoder().encode(files[name]).buffer;
 const object=await loadUsdPreview({root:'scene/root.usda',entries},get);
 const meshes=[];object.traverse(n=>{if(n.isMesh)meshes.push(n);});
 assert.equal(meshes.length,1);assert.equal(meshes[0].geometry.attributes.position.count,3);
 object.updateMatrixWorld(true);assert.equal(meshes[0].matrixWorld.elements[12],5);
 await assert.rejects(loadUsdPreview({root:'scene/root.usda',entries:entries.slice(0,1)},get),/缺少引用图层.*mesh.usda/);
 await assert.rejects(loadUsdPreview({root:'scene/root.usda',entries},async()=>new ArrayBuffer(1)),/文件不完整/);
 assert.equal(await loadUsdPreview({root:'scene/root.usda',entries},get,{isCurrent:()=>false}),null);
});
