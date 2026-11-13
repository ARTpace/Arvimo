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
 assert.equal((await call()).status,200);
});


test('linked重新定位保持UID/标注/合集，异内容和已占目标零写入',async t=>{
 const f=await fixture(t), importer=createLocalFileImporter({storage:f.storage,importRoots:f.roots,dataDir:f.dataDir});
 const first=await importer.importFile({folder:f.folder,rel:'a.png',mode:'linked'}),uid=first.asset.uid;
 await f.storage.withDbWrite(conn=>{
  conn.run('UPDATE assets SET rating=4,note=?,favorite=1 WHERE uid=?',['keep-note',uid]);
  conn.run("INSERT INTO tags (uid,kind,tag) VALUES (?,'user','keep-tag')",[uid]);
  const collection=saveCollection(conn,{name:'Keep collection'});setCollectionItems(conn,collection,[uid],'add');
 });
 const moved=path.join(f.dir,'moved');await fs.mkdir(moved);f.roots.add(moved);
 await fs.rename(path.join(f.folder,'a.png'),path.join(moved,'renamed.png'));
 const read=()=>f.storage.withDb(conn=>({assets:conn.all('SELECT * FROM assets'),tags:conn.all('SELECT * FROM tags ORDER BY uid,kind,tag'),collections:conn.all('SELECT * FROM collection_assets')}));
 const before=await read();
 const result=await importer.relinkFile({uid,folder:moved,rel:'renamed.png'});
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
