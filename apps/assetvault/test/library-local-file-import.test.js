import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLocalFileImporter} from '../server/local-file-import.mjs';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {createImportRoots} from '../server/import-roots.mjs';
import {saveCollection,setCollectionItems,collectionUids} from '../server/library-collections.mjs';

async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-file-import-')),folder=path.join(dir,'source'),dataDir=path.join(dir,'data');
 await fs.mkdir(folder);await fs.mkdir(dataDir);await fs.writeFile(path.join(folder,'a.png'),'image-data');
 const roots=createImportRoots(dataDir);roots.add(folder);const storage=createLibraryStorage(dataDir);
 t.after(async()=>{await storage.close?.();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 return {dir,folder,dataDir,roots,storage};
}

test('linked/managed实际入库、去重、显式保留两份且原件不变',async t=>{
 const f=await fixture(t);const importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir});
 const input={folder:f.folder,rel:'a.png',mode:'linked'};
 const first=await importer.importFile(input);assert.equal(first.status,'imported');assert.equal(first.asset.storageMode,'linked');assert.equal(first.asset.assetType,'image');
 assert.match(first.asset.thumbnail,/\/api\/local\/thumb/);assert.match(first.asset.url,/\/api\/local\/file/);
 assert.equal((await importer.importFile({...input,duplicate:'keep-both'})).reason,'same-linked-path');
 assert.equal((await importer.importFile({...input,mode:'managed'})).reason,'exact-duplicate');
 const managed=await importer.importFile({...input,mode:'managed',duplicate:'keep-both'});
 assert.equal(managed.status,'imported');assert.notEqual(managed.asset.uid,first.asset.uid);
 assert.equal(await fs.readFile(managed.asset.filePath,'utf8'),'image-data');assert.equal(await fs.readFile(path.join(f.folder,'a.png'),'utf8'),'image-data');
 assert.ok(f.roots.list().includes(path.join(f.dataDir,'imports')));
 const rows=await f.storage.withDb(conn=>conn.all('SELECT uid,payload FROM assets'));assert.equal(rows.length,2);
 await f.storage.withDbWrite(conn=>conn.run("UPDATE assets SET state = 'trashed'"));
 const again=await importer.importFile(input);assert.equal(again.status,'imported','trashed assets must not suppress visible imports');
});

test('复制前参数/越界拒绝，注册根失败与提交失败清理仅本次副本',async t=>{
 const f=await fixture(t);const importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir});
 for(const patch of [{mode:undefined},{rel:'../a.png'},{rel:'/absolute'},{folder:path.dirname(f.folder)},{duplicate:'replace'}])await assert.rejects(importer.importFile({folder:f.folder,rel:'a.png',mode:'managed',...patch}));
 await assert.rejects(fs.stat(path.join(f.dataDir,'imports')),{code:'ENOENT'});
 const brokenRoots={list:f.roots.list,valid:f.roots.valid,add(){throw Error('register failed');},remove(){}};
 await assert.rejects(createLocalFileImporter({storage:f.storage,importRoots:brokenRoots,dataDir:f.dataDir}).importFile({folder:f.folder,rel:'a.png',mode:'managed'}),/register failed/);
 assert.deepEqual(await fs.readdir(path.join(f.dataDir,'imports')),[]);
 const brokenStorage={withDb:f.storage.withDb,withDbWrite(){throw Error('commit failed');}};
 await assert.rejects(createLocalFileImporter({storage:brokenStorage,importRoots:f.roots,dataDir:f.dataDir}).importFile({folder:f.folder,rel:'a.png',mode:'managed'}),/commit failed/);
 assert.deepEqual(await fs.readdir(path.join(f.dataDir,'imports')),[]);assert.ok(!f.roots.list().includes(path.join(f.dataDir,'imports')));
 assert.equal(await fs.readFile(path.join(f.folder,'a.png'),'utf8'),'image-data');
});

test('临时HTTP API完成托管入库且源URL可读，LAN拒绝',async t=>{
 const f=await fixture(t),previous={};for(const k of ['SFX_DATA_DIR','SFX_CACHE_DIR','APPDATA']){previous[k]=process.env[k];process.env[k]=f.dataDir;}
 t.after(()=>{for(const k of Object.keys(previous)){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}});
 const {createLibraryServer}=await import('../server/library.mjs');
 const server=createLibraryServer({cacheDir:f.dataDir,downloads:{dataDir:f.dataDir,jobs:[],snapshot:()=>({jobs:[]})},collect:false,backup:false,lanSharing:{handle:async req=>{if(req.headers['test-lan'])req.lanVisitor=true;return false;}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const base=`http://127.0.0.1:${server.address().port}`,payload={folder:f.folder,rel:'a.png',mode:'managed'};
 const call=(headers={})=>fetch(base+'/api/library/import-file',{method:'POST',headers:{'content-type':'application/json','x-sfx-local':'1',...headers},body:JSON.stringify(payload)});
 assert.equal((await call({'test-lan':'1'})).status,403);assert.equal((await call({origin:'http://evil.invalid'})).status,403);
 const result=await call();assert.equal(result.status,200);const data=await result.json();assert.equal(data.status,'imported');
 const original=await fetch(base+data.asset.url);assert.equal(original.status,200);assert.equal(await original.text(),'image-data');
 const inspect=(headers={})=>fetch(base+'/api/library/file-organize/preflight',{method:'POST',headers:{'content-type':'application/json','x-sfx-local':'1',...headers},body:JSON.stringify({action:'inspect',folder:f.folder})});
 assert.equal((await inspect({'test-lan':'1'})).status,403);
 assert.equal((await inspect({origin:'http://evil.invalid'})).status,403);
 assert.equal((await inspect({'sec-fetch-site':'cross-site'})).status,403);
 const inspected=await inspect();assert.equal(inspected.status,200);assert.equal((await inspected.json()).filesystemWritesEnabled,false);
 const drag=await fetch(base+'/api/drag/files',{method:'POST',headers:{'content-type':'application/json','x-sfx-local':'1'},body:JSON.stringify({items:[{type:'asset',uid:data.asset.uid}]})});
 assert.equal(drag.status,200);const dragged=await drag.json();
 assert.equal(dragged.files.length,1);assert.equal(path.extname(dragged.files[0]),'.png');
 assert.equal(await fs.readFile(dragged.files[0],'utf8'),'image-data','托管资产无需下载任务即可拖出真实原文件');
 assert.equal((await call()).status,200);
});


test('linked重新定位保持UID/标注/合集，异内容和已占目标零写入',async t=>{
 const f=await fixture(t), importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir});
 const first=await importer.importFile({folder:f.folder,rel:'a.png',mode:'linked'}),uid=first.asset.uid;
 const cover='/api/local/thumb?'+new URLSearchParams({root:f.folder,rel:'cover.png',w:'384'});
 await fs.writeFile(path.join(f.folder,'cover.png'),'cover-data');
 await f.storage.withDbWrite(conn=>{
  conn.applyAssetOps([{op:'asset:patch',uid,patch:{thumbnail:cover}}]);
  conn.run('UPDATE assets SET rating=4,note=?,favorite=1 WHERE uid=?',['keep-note',uid]);
  conn.run("INSERT INTO tags (uid,kind,tag) VALUES (?,'user','keep-tag')",[uid]);
  const collection=saveCollection(conn,{name:'Keep collection'});setCollectionItems(conn,collection,[uid],'add');
 });
 const moved=path.join(f.dir,'moved');await fs.mkdir(moved);f.roots.add(moved);
 await fs.rename(path.join(f.folder,'a.png'),path.join(moved,'renamed.png'));
 const read=()=>f.storage.withDb(conn=>({assets:conn.all('SELECT * FROM assets'),tags:conn.all('SELECT * FROM tags ORDER BY uid,kind,tag'),collections:conn.all('SELECT * FROM collection_assets')}));
 const before=await read();
 const result=await importer.relinkFile({uid,folder:moved,rel:'renamed.png'});
 assert.equal(result.asset.thumbnail,cover,'重新定位主文件不覆盖单独选择的封面');
 assert.equal(result.status,'relinked');assert.equal(result.asset.uid,uid);assert.equal(result.asset.localRoot,moved);assert.equal(result.asset.localRel,'renamed.png');
 const after=await read();assert.equal(after.assets.length,1);assert.equal(after.assets[0].rating,4);assert.equal(after.assets[0].note,'keep-note');assert.equal(after.assets[0].favorite,1);
 assert.deepEqual(after.tags,before.tags);assert.deepEqual(after.collections,before.collections);
 await fs.writeFile(path.join(moved,'wrong.png'),'different');
 await assert.rejects(importer.relinkFile({uid,folder:moved,rel:'wrong.png'}),{status:409});assert.deepEqual(await read(),after);
 await fs.writeFile(path.join(moved,'occupied.png'),'image-data');
 await importer.importFile({folder:moved,rel:'occupied.png',mode:'linked',duplicate:'keep-both'});
 const occupied=await read();await assert.rejects(importer.relinkFile({uid,folder:moved,rel:'occupied.png'}),{status:409});assert.deepEqual(await read(),occupied);
 await assert.rejects(importer.relinkFile({uid,folder:moved,rel:'../escape'}));
});

// 2026-11-14：拖入导入改成「边落盘边攒批，最后一次性入库」。
// 旧的逐文件入库每进一个文件都要把整库序列化写回 state_meta（736 条时实测 45ms/文件），
// 1000 个文件就是一分钟起步，而且随库增长线性变慢。批量模式的关键约束：
//   1. 提交前库里查不到（不能半截可见）；2. 批次内重复也要拦（库里还看不到）；
//   3. 放弃批次只删临时副本，绝不碰用户原文件；4. 整批只广播一次。
test('批量入库：先攒后提交、批次内去重、放弃只删副本',async t=>{
 const f=await fixture(t);
 const importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir});
 await fs.writeFile(path.join(f.folder,'b.png'),'image-data-b');
 await fs.writeFile(path.join(f.folder,'c.png'),'image-data-c');
 await fs.writeFile(path.join(f.folder,'a-copy.png'),'image-data');

 const batch='testbatch001';
 assert.equal((await importer.importFile({folder:f.folder,rel:'a.png',mode:'linked',batch})).status,'staged');
 assert.equal((await importer.importFile({folder:f.folder,rel:'b.png',mode:'linked',batch})).status,'staged');
 const dup=await importer.importFile({folder:f.folder,rel:'a-copy.png',mode:'linked',batch});
 assert.equal(dup.status,'skipped');assert.equal(dup.reason,'batch-duplicate');
 assert.equal((await f.storage.withDb(conn=>conn.all('SELECT uid FROM assets'))).length,0,'提交前不应有可见资产');

 const flushed=await importer.flushBatch(batch);
 assert.equal(flushed.applied,2);assert.equal(flushed.assets.length,2);
 assert.equal((await f.storage.withDb(conn=>conn.all("SELECT uid FROM assets WHERE state = 'active'"))).length,2);
 assert.equal((await importer.flushBatch(batch)).applied,0,'同一批复用不会重复入库');

 const empty=await importer.importFile({folder:f.folder,rel:'a.png',mode:'linked',batch:'testbatch002'});
 assert.equal(empty.status,'skipped','提交后再进同一文件应命中去重');
 assert.equal((await importer.abortBatch('testbatch002')).aborted,true);
 assert.equal(await fs.readFile(path.join(f.folder,'a.png'),'utf8'),'image-data','放弃批次不能删用户原文件');
});

// 拖入导入改成「先落盘、后 flush」之后，进程中途被杀会留下没人认领的 imports/drop-*。
// 清理必须狠不下心就删：只删「无资产记录 + 超龄」两个条件同时成立的目录。
test('启动期清理：只删无资产记录且超龄的 drop-* 目录',async t=>{
 const f=await fixture(t);
 const importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir});
 const imports=path.join(f.dataDir,'imports');
 const older=async name=>{const dir=path.join(imports,name);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'a.png'),'x');await fs.utimes(dir,new Date(0),new Date(0));return dir;};
 const orphan=await older('drop-aaaaaaaaaaaaaaaa');
 const referenced=await older('drop-bbbbbbbbbbbbbbbb');
 const fresh=path.join(imports,'drop-cccccccccccccccc');
 await fs.mkdir(fresh,{recursive:true});

 const {importLibrary,PORTABLE_FORMAT,PORTABLE_VERSION}=await import('../server/library-portable.mjs');
 await importLibrary({storage:f.storage,mode:'merge',payload:{format:PORTABLE_FORMAT,version:PORTABLE_VERSION,assets:[{
  uid:'a'.repeat(32),name:'a.png',filePath:path.join(referenced,'a.png'),localRoot:imports,
  localRel:'drop-bbbbbbbbbbbbbbbb/a.png',storageMode:'linked',sha256:'q',bytes:1,addedAt:Date.now(),
  platform:'local',source:'local-import',assetType:'image',ext:'png'}]}});

 const out=await importer.sweepOrphanDirs({olderThanMs:60*1000});
 assert.equal(out.removed,1);
 await assert.rejects(fs.stat(orphan),{code:'ENOENT'},'无记录的旧目录要清掉');
 assert.ok((await fs.stat(referenced)).isDirectory(),'有资产记录指向的目录不能删');
 assert.ok((await fs.stat(fresh)).isDirectory(),'刚落地还没 flush 的一批不能删');
});

// 剪切（move，2026-11-14）：复制 + SHA256 校验 + 入库成功之后才删原件。
// 三个不能踩的坑：① 命中重复跳过时绝不能删原件（库里指向的是旧副本，删了就真丢了）；
// ② 入库失败不能删；③ 批量里不允许混进 move（删一半没法回滚）。
test('剪切导入：入库成功才删原件，命中重复不碰原件',async t=>{
 const f=await fixture(t);
 const importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir});
 await fs.writeFile(path.join(f.folder,'b.png'),'cut-me');

 const cut=await importer.importFile({folder:f.folder,rel:'b.png',mode:'move'});
 assert.equal(cut.status,'imported');
 assert.equal(cut.sourceRemoved,true,'入库成功应删掉原件');
 await assert.rejects(fs.stat(path.join(f.folder,'b.png')),{code:'ENOENT'});
 assert.equal(await fs.readFile(cut.asset.filePath,'utf8'),'cut-me','库内副本还在');
 assert.equal(cut.asset.storageMode,'managed','剪切按托管副本存');
 assert.equal(cut.asset.importMode,'move');

 // 同样的内容在库里已有一份：这次是 skipped，原件必须原地不动。
 await fs.writeFile(path.join(f.folder,'b-copy.png'),'cut-me');
 const skipped=await importer.importFile({folder:f.folder,rel:'b-copy.png',mode:'move'});
 assert.equal(skipped.status,'skipped');
 assert.equal(await fs.readFile(path.join(f.folder,'b-copy.png'),'utf8'),'cut-me','跳过时必须保留原件');

 await assert.rejects(importer.importFile({folder:f.folder,rel:'b-copy.png',mode:'move',batch:'movebatch001'}),/剪切/);
});

test('天空盒PNG导入、浏览和历史记录修复共享环境识别，手动图片分类优先',async t=>{
 const f=await fixture(t);
 const folder=path.join(f.folder,'HDR');await fs.mkdir(folder);
 const png=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(4096,16);png.writeUInt32BE(2048,20);
 await fs.writeFile(path.join(folder,'Anubis1.png'),png);
 const {listLocalFolder}=await import('../server/local-browse.mjs');
 const listed=await listLocalFolder({folder:f.folder});
 assert.equal(listed.files.find(file=>file.name==='Anubis1.png').kind,'env');
 const importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir});
 const imported=await importer.importFile({folder:f.folder,rel:'HDR/Anubis1.png',mode:'linked'});
 assert.equal(imported.asset.assetType,'env');assert.equal(imported.asset.ext,'png');
 const uid=imported.asset.uid;
 await f.storage.mutateAssets([{op:'asset:patch',uid,patch:{assetType:'image',formatCheck:null}}]);
 const {repairAssetTypes}=await import('../server/asset-type-repair.mjs');
 const first=await repairAssetTypes({storage:f.storage});assert.equal(first.repaired,1);
 const rows=await f.storage.withDb(conn=>conn.all('SELECT kind,payload FROM assets WHERE uid = ?',[uid]));
 assert.equal(rows[0].kind,'hdris');assert.equal(JSON.parse(rows[0].payload).ext,'png');
 assert.equal((await repairAssetTypes({storage:f.storage})).repaired,0);
 await f.storage.mutateAssets([{op:'asset:patch',uid,patch:{assetType:'image',typeOverride:'images'}}]);
 assert.equal((await repairAssetTypes({storage:f.storage})).repaired,0);
});

test('托管副本落进资产根的分类目录，根自动登记，同名加序号',async t=>{
 const f=await fixture(t);
 const assetRoot=path.join(f.dir,'资产库');
 const importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir,archiveRoot:assetRoot});
 const first=await importer.importFile({folder:f.folder,rel:'a.png',mode:'managed'});
 assert.equal(first.status,'imported');
 // 与平台下载同一套「分组/子类型」：不再是 imports/<uid>/ 那种认不出来的目录。
 assert.equal(path.dirname(first.asset.filePath),path.join(assetRoot,'图片','其他图片'));
 assert.equal(first.asset.localRoot,assetRoot);
 assert.equal(first.asset.localRel,'图片/其他图片/a.png');
 assert.ok(f.roots.list().includes(assetRoot),'资产根要登记成导入根，否则缩略图 403');
 // 同名再进一次：绝不覆盖，落到 (2)。
 const second=await importer.importFile({folder:f.folder,rel:'a.png',mode:'managed',duplicate:'keep-both'});
 assert.equal(second.status,'imported');
 assert.equal(second.asset.localRel,'图片/其他图片/a (2).png');
 assert.equal(await fs.readFile(first.asset.filePath,'utf8'),'image-data');
});
