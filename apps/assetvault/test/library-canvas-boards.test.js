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
import {MAIN_STATE_KEY} from '../server/library-schema.mjs';
import {locationModel} from '../server/file-locations.mjs';

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
 return {service,storage,dataDir,localImporter,dropImporter};
}

test('条件读取空闲不返回全文，库侧改名和同毫秒画布保存均失效版本',async t=>{
 const f=await fixture(t);
 await f.service.readVersioned();
 const first=await f.service.readVersioned();
 assert.ok(first.document);assert.ok(first.etag);
 const idle=await f.service.readVersioned(first.etag);
 assert.equal(idle.unchanged,true);assert.equal(idle.document,undefined);
 await f.storage.withDbWrite(conn=>{const item=listCollections(conn)[0];saveCollection(conn,{...item,name:'库侧新名'});});
 const changed=await f.service.readVersioned(first.etag);
 assert.equal(changed.document.boards[0].name,'库侧新名');assert.notEqual(changed.etag,first.etag);
 const settled=await f.service.readVersioned(changed.etag);
 const base=settled.document||changed.document;
 const edited=structuredClone(base);edited.boards[0].zoom=2;
 await f.service.save({document:edited,base});
 const saved=await f.service.readVersioned(settled.etag);
 assert.equal(saved.document.boards[0].zoom,2);
 const restarted=createCanvasBoards({storage:f.storage,dataDir:f.dataDir,dropImporter:f.dropImporter,localImporter:f.localImporter});
 const current=await restarted.readVersioned();
 assert.equal((await restarted.readVersioned(current.etag)).unchanged,true);
});

test('千节点画布双客户端过期保存合并不同节点修改，条件读最终一致',async t=>{
 const f=await fixture(t),initial=await f.service.read();
 const document=structuredClone(initial);
 document.nodes=Array.from({length:1000},(_,i)=>({id:`text-${i}`,boardId:document.boards[0].id,nodeType:'text',x:i%20*200,y:Math.floor(i/20)*100,width:180,height:80,properties:{text:`节点 ${i}`}}));
 await f.service.save({document,base:initial});
 const second=createCanvasBoards({storage:f.storage,dataDir:f.dataDir,dropImporter:f.dropImporter,localImporter:f.localImporter});
 const base=await f.service.read(),a=structuredClone(base),b=structuredClone(base);
 a.nodes[0].x+=77;b.nodes[999].y+=88;
 await f.service.save({document:a,base});await second.save({document:b,base});
 const result=await f.service.readVersioned();
 assert.equal(result.document.nodes.length,1000);
 assert.equal(result.document.nodes[0].x,a.nodes[0].x);
 assert.equal(result.document.nodes[999].y,b.nodes[999].y);
 const settled=await f.service.readVersioned();
 assert.equal((await second.readVersioned(settled.etag)).unchanged,true);
});

test('运行中恢复无版本表的旧库后自动重建版本，不复用旧验证器',async t=>{
 const f=await fixture(t);
 await f.service.readVersioned();
 const before=await f.service.readVersioned();
 await f.storage.withDbWrite(conn=>{
  for(const row of conn.all("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'canvas_sync_%'",[]))conn.run(`DROP TRIGGER ${row.name}`,[]);
  conn.run('DROP TABLE canvas_sync_version',[]);
 });
 const restored=await f.service.readVersioned(before.etag);
 assert.ok(restored.document);assert.notEqual(restored.etag,before.etag);
 assert.equal((await f.service.readVersioned(restored.etag)).unchanged,true);
});

test('画布导入按画板集中收纳，重复保存不回收已拆分成员，整理后引用跟随 UID',async t=>{
 const f=await fixture(t),base=await f.service.read();
 const doc=project();doc.boards.push(board('other-board','参考图'));
 let saved=(await f.service.save({document:doc,base})).document;
 const uid=saved.nodes[0].assetId;
 const model=await f.storage.withDb(conn=>JSON.parse(conn.all('SELECT payload FROM assets WHERE uid=?',[uid])[0].payload));
 assert.match(model.localRel,/^画布导入\/[a-f0-9]{24}\/参考.png$/);
 const groups=JSON.parse((await f.storage.load()).values[MAIN_STATE_KEY]).options.cardGroups;
 assert.equal(groups.length,1);assert.equal(groups[0].children[0].key,uid);
 // 同画板追加文件落入同一路径；同名画板不共用目录，名称无法逃逸路径。
 const a=await f.dropImporter.save({name:'two.png',stream:[Buffer.from('different image')],canvasBoard:'canvas-one'});
 const b=await f.dropImporter.save({name:'three.png',stream:[Buffer.from('other image')],canvasBoard:'../../other-board'});
 assert.equal(path.posix.dirname(a.name),path.posix.dirname(model.localRel));
 assert.notEqual(path.posix.dirname(a.name),path.posix.dirname(b.name));
 const next=structuredClone(saved);
 next.assets.push({id:a.uid,kind:'image',locator:{originalRef:a.asset.url},metadata:{libraryUid:a.uid,canvasImportBoard:'canvas-one'}});
 next.nodes.push({id:'second',boardId:'canvas-one',assetId:a.uid,nodeType:'image',x:400,y:20,width:200,height:200,properties:{name:'two.png'}});
 saved=(await f.service.save({document:next,base:saved})).document;
 const packed=JSON.parse((await f.storage.load()).values[MAIN_STATE_KEY]).options.cardGroups;
 assert.equal(packed.length,1);assert.deepEqual(packed[0].children.map(ref=>ref.key),[uid,a.uid]);
 await f.storage.mutate(values=>{
  const state=JSON.parse(values[MAIN_STATE_KEY]);state.options.cardGroups[0].children=[];
  return {...values,[MAIN_STATE_KEY]:JSON.stringify(state)};
 });
 await f.service.save({document:saved,base:saved});
 assert.equal(JSON.parse((await f.storage.load()).values[MAIN_STATE_KEY]).options.cardGroups[0].children.length,0);
 // 模拟整理器完成移动后更新的资产定位；画布几何与成员关系不变。
 const moved=locationModel(model,{path:model.localRoot,rel:'整理/参考.png',availability:'online'});
 await fs.mkdir(path.dirname(moved.filePath),{recursive:true});await fs.rename(model.filePath,moved.filePath);
 await f.storage.withDbWrite(conn=>conn.run('UPDATE assets SET payload=? WHERE uid=?',[JSON.stringify(moved),uid]));
 const reopened=await f.service.read(),asset=reopened.assets.find(asset=>asset.id===uid);
 assert.equal(asset.locator.originalRef,moved.url);
 assert.equal(reopened.nodes.find(node=>node.assetId===uid).x,10);
 assert.ok((await fs.stat(moved.filePath)).size>0);
});
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

test('删除最后画板后读取、过期保存与重开均不重建默认画板，资产保留',async t=>{
 const f=await fixture(t,project()),base=await f.service.read(),uid=base.nodes[0].assetId;
 await f.storage.withDbWrite(conn=>deleteCollection(conn,'canvas-one'));
 const after=await f.service.read();
 assert.deepEqual(after.boards,[]);assert.deepEqual(after.nodes,[]);
 const stale=structuredClone(base);stale.nodes[0].x=900;
 assert.deepEqual((await f.service.save({document:stale,base})).document.boards,[]);
 const reopened=createCanvasBoards({storage:f.storage,dataDir:f.dataDir});
 assert.deepEqual((await reopened.read()).boards,[]);
 assert.deepEqual(await f.storage.withDb(conn=>listCollections(conn)),[]);
 assert.equal(await f.storage.withDb(conn=>conn.all('SELECT count(*) AS n FROM assets WHERE uid=?',[uid])[0].n),1);
 const next=structuredClone(after);next.boards=[board('new-board','手动新建')];
 assert.equal((await f.service.save({document:next,base:after})).document.boards[0].id,'new-board');
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
 const validation=await call('/api/library/artflow-board');await validation.json();
 const unchanged=await call('/api/library/artflow-board','GET',undefined,{'If-None-Match':validation.headers.get('etag')});
 assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');
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

test('图集在画布展开为命名图组，保存布局不打散画板成员，重开不重复生成',async t=>{
 const f=await fixture(t,project());await f.service.read();
 const root=path.join(f.dataDir,'album-source');await fs.mkdir(root);
 for(const name of ['a.png','b.png','c.png'])await fs.writeFile(path.join(root,name),Buffer.from(pixel.split(',')[1],'base64'));
 const uid='a'.repeat(32),model={uid,name:'符文图集',platform:'local',assetType:'images',source:'album-reference',albumRoot:f.dataDir,albumRel:'album-source',albumPackage:{root:f.dataDir,rel:'album-source',title:'符文图集',category:'images'}};
 await f.storage.withDbWrite(conn=>{conn.applyAssetOps([{op:'asset:add',uid,model}]);setCollectionItems(conn,'canvas-one',[uid],'set');});
 const doc=await f.service.read(),group=doc.nodes.find(node=>node.nodeType==='group');
 assert.equal(group.properties.name,'符文图集');assert.equal(group.properties.albumUid,uid);
 const children=doc.nodes.filter(node=>node.parentId===group.id);assert.equal(children.length,3);assert.equal(new Set(children.map(node=>`${node.x},${node.y}`)).size,3);
 assert.equal((await f.storage.withDb(conn=>listCollections(conn)))[0].assetCount,1);
 const moved=structuredClone(doc);moved.assets.forEach(asset=>{asset.metadata={};});moved.nodes.find(node=>node.id===children[0].id).x+=77;
 const saved=(await f.service.save({document:moved,base:doc})).document;
 assert.equal(saved.nodes.find(node=>node.id===children[0].id).x,children[0].x+77);
 assert.equal(saved.nodes.filter(node=>node.nodeType==='group').length,1);
 assert.deepEqual([...await f.storage.withDb(conn=>collectionUids(conn,'canvas-one'))],[uid]);
 const reopened=await f.service.read();assert.equal(reopened.nodes.length,4);
 const removed=structuredClone(reopened);removed.nodes=[];
 await f.service.save({document:removed,base:reopened});assert.equal((await f.service.read()).nodes.length,0);
 assert.equal(await f.storage.withDb(conn=>conn.all('SELECT count(*) AS n FROM assets')[0].n),2,'图组图片不各自入库，原先资产保留');
});
