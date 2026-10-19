import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {Readable} from 'node:stream';
import {ambientcgUid,normalizeAmbientcgAsset,ambientcgSearch,ambientcgCategories,pickAmbientcgDownload,runAmbientcgJob,ambientcgViewer} from '../server/ambientcg.mjs';
import {materialOptions,modelSnapshot,DownloadManager} from '../server/downloads.mjs';
import {verifyArchive} from '../server/archive.mjs';
import {verifyFolder} from '../server/folder-archive.mjs';
import {createLibraryServer} from '../server/library.mjs';
import {modelPayload} from '../src/library/download-ui.js';
import {zipEntries,fixturePng} from './download-fixture.mjs';

const uid=ambientcgUid('Ground054');
const wait=async fn=>{const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw Error('Test timeout');await new Promise(r=>setTimeout(r,15));}};
async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'sfx-acg-test-'));}

const shadingViewer='https://releases.pbr.one/main/material-shading.html#normal_type=directx&color_url=https://f003.backblazeb2.com/file/ambientCG-Web/media/surface-preview/Ground054/Ground054_SQ_Color.jpg&normal_url=https://f003.backblazeb2.com/file/ambientCG-Web/media/surface-preview/Ground054/Ground054_SQ_NormalDX.jpg';
const searchRow={id:'Ground054',type:'material',title:'Ground 054',url:'https://ambientcg.com/a/Ground054',tags:['sand','ground'],maps:['color','normal','roughness'],previews:[{type:'pbr-one-material-shading',url:shadingViewer}],thumbnails:{'512-JPG-242424':'https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/512-JPG-242424/Ground054.jpg','2048-PNG':'https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/2048-PNG/Ground054.png'}};
const downloadRow={attributes:'2K-PNG',extension:'zip',url:'https://ambientcg.com/get?file=Ground054_2K-PNG.zip',size:42};
const zipBuffer=zipEntries([
 ['Ground054_2K-PNG_Color.png',fixturePng(4,4)],
 ['Ground054_2K-PNG_NormalGL.png',fixturePng(4,4)],
 ['Ground054_2K-PNG_Roughness.png',fixturePng(4,4)],
 ['Ground054_2K-PNG.blend','blend source'],
 ['Ground054.png',fixturePng(2,2)],
]);
/** Fake outbound: the API JSON for /api/v3/assets, the ZIP bytes for the /get download.
 *  Chunks are Buffers — that is the contract openPublic streams honour. */
function fakeOpen({rows=[{...searchRow,downloads:[downloadRow]}],zip=zipBuffer}={}){
 const body=value=>({stream:Readable.from([Buffer.from(value)]),status:200,headers:{}});
 return async url=>{
  if(String(url).includes('/api/v3/assets'))return body(JSON.stringify({totalResults:rows.length,assets:rows}));
  if(String(url).includes('/get?file='))return {stream:Readable.from([zip]),status:200,headers:{'content-length':String(zip.length)}};
  throw Error('unexpected URL: '+url);
 };
}

test('normalizeAmbientcgAsset shapes a card the grid already renders, uid stays 32-hex',()=>{
 const card=normalizeAmbientcgAsset(searchRow);
 assert.equal(card.uid,uid);assert.match(card.uid,/^[a-f0-9]{32}$/);
 assert.equal(card.platform,'ambientcg');assert.equal(card.assetId,'Ground054');
 assert.equal(card.name,'Ground 054');assert.equal(card.author,'ambientCG');
 assert.equal(card.url,'https://ambientcg.com/a/Ground054');
 assert.match(card.thumbnail,/512-JPG-242424/);
 assert.equal(card.viewerUrl,shadingViewer);
 assert.deepEqual(card.maps,['color','normal','roughness']);
 assert.equal(normalizeAmbientcgAsset(null),null);
 assert.equal(normalizeAmbientcgAsset({id:''}),null);
 assert.equal(normalizeAmbientcgAsset({id:'X',previews:[]}).viewerUrl,'');
});

test('ambientcgSearch pages via limit/offset and reports an empty library honestly',async()=>{
 const seen=[];
 const page=rows=>async url=>{seen.push(String(url));return {stream:Readable.from([Buffer.from(JSON.stringify({totalResults:30,assets:rows}))]),status:200,headers:{}};};
 const first=await ambientcgSearch({q:'sand'},{open:page([searchRow])});
 assert.equal(first.models.length,1);assert.equal(first.total,30);
 assert.match(seen[0],/type=material/);assert.match(seen[0],/q=sand/);assert.match(seen[0],/limit=24/);assert.match(seen[0],/offset=0/);
 const next=JSON.parse(first.next);
 assert.deepEqual(next,{q:'sand',category:'',page:2});
 await ambientcgSearch({cursor:next},{open:page([searchRow])});
 assert.match(seen[1],/offset=24/);
 const empty=await ambientcgSearch({q:'nothing'},{open:async()=>({stream:Readable.from([Buffer.from(JSON.stringify({totalResults:0,assets:[]}))]),status:200,headers:{}})});
 assert.equal(empty.models.length,0);assert.equal(empty.next,null);assert.match(empty.warnings[0],/没有匹配/);
});

test('pickAmbientcgDownload honours exact tier, falls back within format then across',()=>{
 const dl=res=>({attributes:res,extension:'zip',url:`https://ambientcg.com/get?file=X_${res}.zip`,size:1});
 const all=['1K-JPG','2K-JPG','4K-JPG','8K-JPG','1K-PNG','2K-PNG'].map(dl);
 assert.equal(pickAmbientcgDownload(all,{resolution:'2K',textureFormat:'JPG'}).attributes,'2K-JPG');
 assert.equal(pickAmbientcgDownload(all,{resolution:'2K',textureFormat:'PNG'}).attributes,'2K-PNG');
 // 2K is missing in JPG: nearest tier not exceeding wins, format stays.
 const jpgOnly=['1K-JPG','4K-JPG'].map(dl);
 assert.equal(pickAmbientcgDownload(jpgOnly,{resolution:'2K',textureFormat:'JPG'}).attributes,'1K-JPG');
 assert.equal(pickAmbientcgDownload(jpgOnly,{resolution:'8K',textureFormat:'JPG'}).attributes,'4K-JPG');
 // Nothing at or below the request: take the smallest that exists.
 assert.equal(pickAmbientcgDownload(['4K-PNG'].map(dl),{resolution:'1K',textureFormat:'PNG'}).attributes,'4K-PNG');
 // Format missing entirely: fall across to whatever format exists.
 assert.equal(pickAmbientcgDownload(['2K-JPG'].map(dl),{resolution:'2K',textureFormat:'PNG'}).attributes,'2K-JPG');
 assert.equal(pickAmbientcgDownload([],{}),null);
 assert.equal(pickAmbientcgDownload([{attributes:'weird',url:'https://x'}],{}),null);
});

test('materialOptions validates and defaults; modelSnapshot requires the asset id',()=>{
 assert.deepEqual(materialOptions({}),{output:'folder',resolution:'2K',textureFormat:'JPG'});
 assert.deepEqual(materialOptions({output:'zip',resolution:'8K',textureFormat:'PNG'}),{output:'zip',resolution:'8K',textureFormat:'PNG'});
 assert.equal(materialOptions({resolution:'16K'}).resolution,'2K');
 const snapshot=modelSnapshot({uid,assetId:'Ground054',platform:'ambientcg',name:'Ground 054'},'ambientcg');
 assert.equal(snapshot.kind,'ambientcg');assert.equal(snapshot.assetId,'Ground054');
 assert.equal(snapshot.url,'https://ambientcg.com/a/Ground054');
 assert.throws(()=>modelSnapshot({uid,platform:'ambientcg'},'ambientcg'),/资产 ID 缺失/);
});

test('material ZIP verifies: manifest and contents must agree in both directions',async()=>{
 const d=await temp();try{
  const p=path.join(d,'m.zip');
  const manifest={uid,kind:'material',platform:'ambientcg',assetId:'Ground054',textures:[
   {file:'textures/Color.png',map:'Color',bytes:fixturePng(4,4).length,url:downloadRow.url},
   {file:'textures/NormalGL.png',map:'NormalGL',bytes:fixturePng(4,4).length,url:downloadRow.url},
  ]};
  await fs.writeFile(p,zipEntries([['textures/Color.png',fixturePng(4,4)],['textures/NormalGL.png',fixturePng(4,4)],['info.json',JSON.stringify(manifest)]]));
  const ok=await verifyArchive(p,{uid});
  assert.equal(ok.textures.length,2);assert.equal(ok.glbs.length,0);assert.equal(ok.images,null);
  await assert.rejects(verifyArchive(p,{uid:'a'.repeat(32)}),/不匹配/);
  // A declared texture missing from the archive is a truncated transfer.
  await fs.writeFile(p,zipEntries([['textures/Color.png',fixturePng(4,4)],['info.json',JSON.stringify(manifest)]]));
  await assert.rejects(verifyArchive(p,{uid}),/缺少已登记的材质贴图/);
  // An unlisted textures/ entry is content nobody vouched for.
  await fs.writeFile(p,zipEntries([['textures/Color.png',fixturePng(4,4)],['textures/NormalGL.png',fixturePng(4,4)],['textures/Evil.png',fixturePng(4,4)],['info.json',JSON.stringify(manifest)]]));
  await assert.rejects(verifyArchive(p,{uid}),/未登记的材质贴图/);
  // A manifest-less bundle has no provenance at all.
  await fs.writeFile(p,zipEntries([['textures/Color.png',fixturePng(4,4)],['info.json',JSON.stringify({uid,kind:'material'})]]));
  await assert.rejects(verifyArchive(p,{uid}),/没有登记材质贴图/);
  // Non-image bytes under textures/ are rejected by the container sniff.
  await fs.writeFile(p,zipEntries([['textures/Color.png','not an image'],['info.json',JSON.stringify(manifest)]]));
  await assert.rejects(verifyArchive(p,{uid}),/可识别的图片|缺少已登记|未登记/);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test('material folder verifies by the same two-direction rule',async()=>{
 const d=await temp();try{
  const dir=path.join(d,'m.dir');
  const manifest={uid,kind:'material',platform:'ambientcg',textures:[{file:'textures/Color.png',map:'Color',bytes:fixturePng(4,4).length}]};
  for(const [name,data] of [['textures/Color.png',fixturePng(4,4)],['info.json',JSON.stringify(manifest)]]){
   await fs.mkdir(path.dirname(path.join(dir,...name.split('/'))),{recursive:true});
   await fs.writeFile(path.join(dir,...name.split('/')),data);
  }
  const ok=await verifyFolder(dir,{uid});
  assert.equal(ok.textures.length,1);
  await fs.rm(path.join(dir,'textures','Color.png'));
  await assert.rejects(verifyFolder(dir,{uid}),/缺少已登记的材质贴图/);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test('runAmbientcgJob (ZIP delivery) keeps only PBR maps, renames them and passes the verifier',async()=>{
 const d=await temp();try{
  const out=path.join(d,'stage.zip');
  const meta=await runAmbientcgJob({uid,assetId:'Ground054',options:{resolution:'2K',textureFormat:'PNG'},deliver:'zip',output:out,workRoot:d,open:fakeOpen()});
  assert.equal(meta.zipName,'Ground054-material');
  const result=await verifyArchive(out,{uid});
  assert.deepEqual(result.textures.map(t=>t.name).sort(),['textures/Color.png','textures/NormalGL.png','textures/Roughness.png']);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test('runAmbientcgJob (folder delivery) records the manifest and the skipped DCC sources',async()=>{
 const d=await temp();try{
  const out=path.join(d,'stage.dir');
  const meta=await runAmbientcgJob({uid,assetId:'Ground054',options:{resolution:'2K',textureFormat:'PNG'},deliver:'folder',output:out,workRoot:d,open:fakeOpen()});
  assert.equal(meta.zipName,'Ground054-material');
  const result=await verifyFolder(out,{uid});
  assert.equal(result.textures.length,3);
  const info=JSON.parse(await fs.readFile(path.join(out,'info.json'),'utf8'));
  assert.equal(info.uid,uid);assert.equal(info.kind,'material');assert.equal(info.platform,'ambientcg');
  assert.equal(info.assetId,'Ground054');assert.equal(info.license,'CC0 1.0 通用公共领域贡献');
  assert.equal(info.textures.length,3);
  assert.ok(info.textures.every(t=>/^textures\//.test(t.file)&&t.url===downloadRow.url));
  assert.deepEqual(info.skippedFiles.map(f=>f.file).sort(),['Ground054.png','Ground054_2K-PNG.blend']);
  assert.deepEqual(info.maps,['color','normal','roughness']);
 }finally{await fs.rm(d,{recursive:true,force:true});}
});

test('ambientcgViewer resolves the embeddable preview lazily, by asset id',async()=>{
 const ok=await ambientcgViewer('Ground054',{open:fakeOpen()});
 assert.equal(ok,shadingViewer);
 await assert.rejects(ambientcgViewer('Missing999',{open:fakeOpen({rows:[{...searchRow,downloads:[downloadRow]}]})}),/找不到材质/);
 await assert.rejects(ambientcgViewer('',{open:fakeOpen()}),/资产 ID 缺失/);
 const none=await ambientcgViewer('Ground054',{open:fakeOpen({rows:[{...searchRow,previews:[],downloads:[downloadRow]}]})});
 assert.equal(none,'');
});

test('ambientcgSearch narrows by category and keeps it in the paging cursor',async()=>{
 const seen=[];
 const page=rows=>async url=>{seen.push(String(url));return {stream:Readable.from([Buffer.from(JSON.stringify({totalResults:9,assets:rows}))]),status:200,headers:{}};};
 const first=await ambientcgSearch({q:'brick',category:'Bricks'},{open:page([searchRow])});
 assert.match(seen[0],/category=Bricks/);
 const next=JSON.parse(first.next);
 assert.equal(next.category,'Bricks');
 await ambientcgSearch({cursor:next},{open:page([searchRow])});
 assert.match(seen[1],/category=Bricks/);assert.match(seen[1],/offset=24/);
});

test('ambientcgCategories keeps material facets only, normalised for the picker',async()=>{
 const apiRows=[
  {id:'Tiles',title:'Tiles',type:'material',numberOfAssets:164},
  {id:'DaySkyHDRI',title:'Day Sky HDRI',type:'hdri',numberOfAssets:142},
  {id:'Ground',title:'Ground',type:'material',numberOfAssets:128},
  {title:'No id here',type:'material',numberOfAssets:1},
 ];
 const cats=await ambientcgCategories({open:async()=>({stream:Readable.from([Buffer.from(JSON.stringify(apiRows))]),status:200,headers:{}})});
 assert.deepEqual(cats.map(c=>c.value),['Tiles','Ground']);
 assert.deepEqual(cats.map(c=>c.count),[164,128]);
 assert.equal(cats[0].label,'Tiles');
});

test('GET /api/ambientcg/preview serves the lazy resolution behind the local marker',async()=>{
 let server;try{
  const resolved=[];
  server=createLibraryServer({ambientcgPreview:async id=>{resolved.push(id);return 'https://releases.pbr.one/main/material-shading.html#ok';}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const missingMarker=await fetch(`${base}/api/ambientcg/preview?id=Ground054`);
  assert.equal(missingMarker.status,403);
  const ok=await fetch(`${base}/api/ambientcg/preview?id=Ground054`,{headers:{'X-SFX-Local':'1'}});
  assert.equal(ok.status,200);
  assert.deepEqual(await ok.json(),{viewerUrl:'https://releases.pbr.one/main/material-shading.html#ok'});
  assert.deepEqual(resolved,['Ground054']);
 }finally{server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());}
});

test('the client payload whitelist carries assetId/hasMarmoset through to the queue snapshot',()=>{
 const card={uid,assetId:'Ground054',platform:'ambientcg',name:'Ground 054',author:'ambientCG',license:'CC0 1.0 通用公共领域贡献',thumbnail:'https://acg-media.struffelproductions.com/x.jpg',downloadable:true,url:'https://ambientcg.com/a/Ground054',viewerUrl:'https://releases.pbr.one/main/material-shading.html#ok',maps:['color'],tags:['sand']};
 const wire=modelPayload(card);
 // 队列键字段必须活着上线；展示字段（url/viewerUrl/maps/tags）不进 POST。
 assert.equal(wire.assetId,'Ground054');
 assert.equal(wire.platform,'ambientcg');
 assert.equal('url' in wire,false);assert.equal('viewerUrl' in wire,false);
 // 抽出的载荷直接过服务端快照——这正是点击下载时走的那条路径，不再报“资产 ID 缺失”。
 assert.equal(modelSnapshot(wire,'ambientcg').assetId,'Ground054');
 // ArtStation 的 2D 标记同理：丢了它，纯图片作品会被派去 Marmoset 转换器。
 const art=modelPayload({uid:'a'.repeat(32),platform:'artstation',name:'2D',artworkUrl:'https://www.artstation.com/artwork/AAAA11',artId:'AAAA11',hasMarmoset:false});
 assert.equal(modelSnapshot(art,'artstation').hasMarmoset,false);
});

test('GET /api/ambientcg/categories serves the material facets behind the local marker',async()=>{
 let server;try{
  const cats=[{value:'Tiles',label:'Tiles',count:164}];
  server=createLibraryServer({ambientcgCats:async()=>cats});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/ambientcg/categories`)).status,403);
  const ok=await fetch(`${base}/api/ambientcg/categories`,{headers:{'X-SFX-Local':'1'}});
  assert.equal(ok.status,200);
  assert.deepEqual(await ok.json(),{categories:cats});
 }finally{server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());}
});

test('分类表不足 3 条时只当次返回、不落盘（夹具或上游降级都不该毒住侧边栏一整天）',async()=>{
 // 2026-10-16 实测：ambientCG 侧边栏只剩一个「Tiles · 164」。根因是分类表抓一次缓存一天，
 // 而测试夹具（只有一个分类的那份）被写进了真缓存，于是 24 小时内每次请求都拿它。
 // 这里用「回源次数」判定缓存行为，不碰文件系统：不完整的表不该被缓存，正常的表照旧该被缓存。
 let calls=0,server;
 const small=[{value:'Tiles',label:'Tiles',count:164}];
 const many=[{value:'Tiles',label:'Tiles',count:164},{value:'Wood',label:'Wood',count:102},{value:'Metal',label:'Metal',count:88}];
 const serve=async rows=>{
  server=createLibraryServer({ambientcgCats:async()=>{calls++;return rows;}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const hit=async()=>(await fetch(`${base}/api/ambientcg/categories`,{headers:{'X-SFX-Local':'1'}})).json();
  const first=await hit(),second=await hit();
  server.closeAllConnections();await new Promise(r=>server.close(r));server=null;
  return {first,second,calls};
 };
 try{
  const bad=await serve(small);
  assert.deepEqual(bad.first,{categories:small});
  assert.deepEqual(bad.second,{categories:small});
  assert.equal(bad.calls,2,'只有一条的分类表不该落盘，否则一份坏数据会撑满整个缓存周期');
  calls=0;
  const good=await serve(many);
  assert.deepEqual(good.first,{categories:many});
  assert.deepEqual(good.second,{categories:many});
  assert.equal(good.calls,1,'完整分类表必须照旧缓存，否则每次开侧边栏都要回源');
 }finally{server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());}
});

test('the queue drives a material job end to end: enqueue, runner, verification, commit',async()=>{
 const d=await temp();let m;try{
  m=await new DownloadManager({
   dataDir:path.join(d,'state'),defaultFolder:path.join(d,'downloads'),
   browser:()=>'/fixture/browser',
   materialRunner:(args,{signal,progress}={})=>runAmbientcgJob({...args,open:fakeOpen()},{signal,progress}),
  }).init();
  m.start('http://127.0.0.1:1');
  const r=await m.enqueue({authorized:true,kind:'ambientcg',options:{output:'zip',resolution:'2K',textureFormat:'PNG'},models:[{uid,assetId:'Ground054',platform:'ambientcg',name:'Ground 054',author:'ambientCG',license:'CC0 1.0 通用公共领域贡献'}]});
  assert.equal(r.added.length,1);
  await wait(()=>['saved','failed','cancelled'].includes(m.jobs[0].state));
  const job=m.jobs[0];
  assert.equal(job.state,'saved');
  assert.equal(job.kind,'ambientcg');assert.equal(job.options.resolution,'2K');
  assert.match(job.filename,/Ground054-material.*\.zip$/);
  assert.equal(job.verification.textures.length,3);
  assert.equal(job.message,'已保存到本机，文件完整性校验通过');
  // Duplicates still dedupe by options, so a re-click does not double-queue.
  assert.equal((await m.enqueue({authorized:true,kind:'ambientcg',options:{output:'zip',resolution:'2K',textureFormat:'PNG'},models:[{uid,assetId:'Ground054',platform:'ambientcg',name:'Ground 054'}]})).duplicates.length,1);
 }finally{await m?.close();await fs.rm(d,{recursive:true,force:true});}
});
