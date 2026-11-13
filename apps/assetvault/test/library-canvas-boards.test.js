import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {createImportRoots} from '../server/import-roots.mjs';
import {createLocalFileImporter} from '../server/local-file-import.mjs';
import {createDropImporter} from '../server/drop-import.mjs';
import {createCanvasBoards} from '../server/canvas-boards.mjs';
import {listCollections,saveCollection,setCollectionItems,collectionUids,deleteCollection} from '../server/library-collections.mjs';

const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const board=(id,name)=>({id,name,panOffset:{x:0,y:0},zoom:1,canvasBackgroundColor:'#18181b',operationHistory:[],operationHistoryIndex:-1});
const project=()=>({format:'artflow-project',version:2,boards:[board('canvas-one','参考图')],assets:[{id:'asset-1',kind:'image',sourceKind:'legacy-inline',locator:{previewRef:pixel,mimeType:'image/png'},metadata:{}}],nodes:[{id:'node-1',boardId:'canvas-one',assetId:'asset-1',nodeType:'image',x:10,y:20,width:200,height:200,zIndex:0,properties:{name:'参考.png'}}]});
async function fixture(t,legacy){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-linked-boards-'));
 const storage=createLibraryStorage(dataDir),importRoots=createImportRoots(dataDir);
 const localImporter=createLocalFileImporter({storage,importRoots,dataDir});
 const dropImporter=createDropImporter({dataDir,importRoots,localImporter});
 if(legacy)await fs.writeFile(path.join(dataDir,'artflow-board.json'),JSON.stringify(legacy));
 const service=createCanvasBoards({storage,dataDir,dropImporter,localImporter});
 t.after(async()=>{await storage.close();await fs.rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {service,storage,dataDir,localImporter};
}
test('旧存档迁移：同ID画板、图片真实入库、原档保留，重启不重复导入',async t=>{
 const original=project(),f=await fixture(t,original);
 const doc=await f.service.read(),uid=doc.nodes[0].assetId;
 assert.match(uid,/^[a-f0-9]{32}$/);
 assert.equal(doc.boards[0].id,'canvas-one');assert.equal(doc.nodes[0].x,10);
 assert.match(doc.assets[0].locator.previewRef,/^\/api\/local\/file/);
 assert.deepEqual(await f.storage.withDb(conn=>[...collectionUids(conn,'canvas-one')]),[uid]);
 const model=await f.storage.withDb(conn=>JSON.parse(conn.all('SELECT payload FROM assets WHERE uid=?',[uid])[0].payload));
 assert.ok((await fs.stat(model.filePath)).size>0);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir,'artflow-board.json'),'utf8')),original);
 await f.service.read();assert.equal(await f.storage.withDb(conn=>conn.all('SELECT count(*) AS n FROM assets',[])[0].n),1);
});
test('旧音视频 blob 失效不阻塞迁移与新建画布，保留旧节点但不伪造库内资产',async t=>{
 const original=project();
 original.assets.push({id:'old-video',kind:'video',sourceKind:'runtime-url',locator:{fileRef:'blob:http://127.0.0.1:4179/expired',mimeType:'video/mp4'}});
 original.nodes.push({id:'old-video-node',boardId:'canvas-one',assetId:'old-video',nodeType:'video',x:0,y:0,width:320,height:240,properties:{name:'旧视频'}});
 const f=await fixture(t,original),base=await f.service.read();
 assert.ok(base.nodes.some(node=>node.id==='old-video-node'));
 assert.equal((await f.storage.withDb(conn=>listCollections(conn)))[0].assetCount,1);
 const next=structuredClone(base);next.boards.push(board('native-created','原画布面板新建'));
 const result=(await f.service.save({document:next,base})).document;
 assert.ok(result.nodes.some(node=>node.id==='old-video-node'));
 assert.ok((await f.storage.withDb(conn=>listCollections(conn))).some(row=>row.id==='native-created'));
 assert.equal(await fs.readFile(path.join(f.dataDir,'artflow-board.json'),'utf8'),JSON.stringify(original));
});

test('新建、改名、删除画布同步画板；移除资产仅解绑且撤销可重新加入',async t=>{
 const f=await fixture(t,project()),base=await f.service.read(),uid=base.nodes[0].assetId;
 const next=structuredClone(base);next.boards.push(board('canvas-two','新画布'));next.boards[0].name='改名';next.nodes=[];
 const saved=(await f.service.save({document:next,base})).document;
 const rows=await f.storage.withDb(conn=>listCollections(conn));
 assert.deepEqual(rows.map(row=>[row.id,row.name,row.assetCount]),[['canvas-one','改名',0],['canvas-two','新画布',0]]);
 assert.equal(await f.storage.withDb(conn=>conn.all('SELECT count(*) AS n FROM assets WHERE uid=?',[uid])[0].n),1);
 const undo=structuredClone(saved);undo.nodes=base.nodes;
 const restored=(await f.service.save({document:undo,base:saved})).document;
 assert.equal(restored.nodes.length,1);
 const remove=structuredClone(restored);remove.boards=remove.boards.filter(row=>row.id!=='canvas-two');
 await f.service.save({document:remove,base:restored});
 assert.ok(!(await f.storage.withDb(conn=>listCollections(conn))).some(row=>row.id==='canvas-two'));
});
test('资产库改名、增删成员同步画布，过期画布保存不覆盖库侧增删',async t=>{
 const f=await fixture(t,project()),base=await f.service.read(),uid=base.nodes[0].assetId;
 await f.storage.withDbWrite(conn=>{
  const row=listCollections(conn)[0];saveCollection(conn,{...row,name:'库里改名'});
  setCollectionItems(conn,row.id,[uid],'remove');saveCollection(conn,{id:'library-two',name:'库侧画板'});setCollectionItems(conn,'library-two',[uid],'add');
 });
 const edit=structuredClone(base);edit.nodes[0].x=900;
 const doc=(await f.service.save({document:edit,base})).document;
 assert.equal(doc.boards.find(row=>row.id==='canvas-one').name,'库里改名');
 assert.ok(!doc.nodes.some(node=>node.boardId==='canvas-one'));
 assert.equal(doc.nodes.filter(node=>node.boardId==='library-two').length,1);
 await f.storage.withDbWrite(conn=>deleteCollection(conn,'library-two'));
 const after=await f.service.read();assert.ok(!after.boards.some(row=>row.id==='library-two'));
});
test('空画布与远程引用也会入库；旧数组存档可迁移且不额外生成画板',async t=>{
 const f=await fixture(t,[{id:'old',name:'旧版',elements:[]}]);
 assert.ok(Array.isArray(await f.service.read()));
 const input=project();input.assets[0].locator.previewRef='https://example.com/reference.png';
 const doc=(await f.service.save({document:input})).document;
 assert.equal(doc.boards.length,1);assert.equal(doc.boards[0].id,'canvas-one');
 assert.match(doc.nodes[0].assetId,/^[a-f0-9]{32}$/);
});
test('真实HTTP：画布入库、资产库移除与改名、原文件可读、跨源写入拒绝',async t=>{
 const f=await fixture(t);
 const {createLibraryServer}=await import('../server/library.mjs');
 const server=createLibraryServer({cacheDir:f.dataDir,collect:false,backup:false,downloads:{dataDir:f.dataDir,jobs:[],snapshot:()=>({jobs:[]})}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const origin=`http://127.0.0.1:${server.address().port}`,headers={'X-SFX-Local':'1','Content-Type':'application/json'};
 const call=(route,method='GET',input,extra={})=>fetch(origin+route,{method,headers:{...headers,...extra},body:input===undefined?undefined:JSON.stringify(input)});
 const base=await (await call('/api/library/artflow-board')).json();
 const upload=await fetch(origin+'/api/library/drop-import',{method:'POST',headers:{'X-SFX-Local':'1','X-AV-Drop-Name':'reference.png'},body:Buffer.from(pixel.split(',')[1],'base64')});
 assert.equal(upload.status,200);const uploaded=(await upload.json()).asset;assert.ok(uploaded.uid);
 const incoming=project();incoming.assets[0].metadata.libraryUid=uploaded.uid;incoming.assets[0].locator.previewRef=uploaded.url;
 const saved=await call('/api/library/artflow-board','PUT',{document:incoming,base});
 assert.equal(saved.status,200);const doc=(await saved.json()).document;
 const uid=doc.nodes[0].assetId;
 assert.equal((await fetch(origin+doc.assets[0].locator.previewRef)).status,200);
 assert.equal((await call('/api/library/collections/items','POST',{id:'canvas-one',uids:[uid],action:'remove'})).status,200);
 await call('/api/library/collections','POST',{id:'canvas-one',name:'库侧重命名'});
 const after=await (await call('/api/library/artflow-board')).json();
 assert.equal(after.boards[0].name,'库侧重命名');assert.equal(after.nodes.length,0);
 assert.equal((await call('/api/library/artflow-board','PUT',{document:project(),base},{Origin:'http://other.invalid'})).status,403);
});
