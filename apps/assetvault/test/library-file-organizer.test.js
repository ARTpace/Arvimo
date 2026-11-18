import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createFileOrganizer} from '../server/file-organizer.mjs';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {createImportRoots} from '../server/import-roots.mjs';
import {importLibrary,PORTABLE_FORMAT,PORTABLE_VERSION} from '../server/library-portable.mjs';
import {saveCollection,setCollectionItems,collectionUids} from '../server/library-collections.mjs';

const windows={skip:process.platform!=='win32'};
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-real-organize-')),folder=path.join(dir,'source'),dataDir=path.join(dir,'data');
  await fs.mkdir(folder);await fs.mkdir(dataDir);
  const roots=createImportRoots(dataDir);roots.add(folder);
  const storage=createLibraryStorage(dataDir,null,{catalogSingleWriter:true});
  t.after(async()=>{await storage.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  let backupCount=0;
  const options={storage,importRoots:roots,beforeEnable:async()=>{backupCount++;}};
  const service=createFileOrganizer(options);await service.ready;
  async function add(rel,uid='a'.repeat(32),extra={}) {
    await fs.mkdir(path.dirname(path.join(folder,rel)),{recursive:true});await fs.writeFile(path.join(folder,rel),'file '+uid);
    const query=new URLSearchParams({root:folder,rel}).toString();
    const model={uid,name:path.basename(rel),localRoot:folder,localRel:rel,filePath:path.join(folder,rel),sha256:createHash('sha256').update('file '+uid).digest('hex'),
      url:'/api/local/file?'+query,thumbnail:'/api/local/thumb?w=384&'+query,storageMode:'linked',fileExists:true,...extra};
    await importLibrary({storage,payload:{format:PORTABLE_FORMAT,version:PORTABLE_VERSION,assets:[model]},mode:'merge'});
    return model;
  }
  const read=()=>storage.withDb(conn=>conn.readCatalog());
  return {dir,folder,storage,roots,service,options,add,read,backups:()=>backupCount};
}

test('真实目录移动/文件改名/撤销，子项 UID、收藏、标签、合集、重启及旧快照保持',windows,async t=>{
  const f=await fixture(t),uid='a'.repeat(32),uid2='b'.repeat(32);
  const old=await f.add('pack/a.png',uid,{favorite:true,rating:4,note:'原备注',userTags:['人工标签']});
  await f.add('pack/textures/b.png',uid2);await fs.mkdir(path.join(f.folder,'target'));
  await assert.rejects(f.service.move({folder:f.folder,from:'pack',to:'target/pack'}),/允许整理/);
  await f.service.setWritable({folder:f.folder,writable:true});assert.equal(f.backups(),1);
  const before=await f.storage.withDb(conn=>conn.all('SELECT * FROM file_locations'));
  await f.storage.withDbWrite(conn=>{saveCollection(conn,{id:'test',name:'合集'});setCollectionItems(conn,'test',[uid],'add');});
  assert.equal((await f.service.preview({folder:f.folder,from:'pack',to:'target/pack'})).affected,2);
  const moved=await f.service.move({folder:f.folder,from:'pack',to:'target/pack'});
  assert.equal(moved.affected,2);await assert.rejects(fs.stat(path.join(f.folder,'pack')),{code:'ENOENT'});
  assert.equal((await f.read()).models.find(m=>m.uid===uid).localRel,'target/pack/a.png');
  const renamed=await f.service.move({folder:f.folder,from:'target/pack/a.png',to:'target/pack/new.png'});
  let current=(await f.read()).models.find(m=>m.uid===uid);assert.equal(current.name,'new.png');
  await f.storage.withDbWrite(conn=>conn.writeValues({'sfx-library-v2':JSON.stringify({models:[old]})}));
  current=(await f.read()).models.find(m=>m.uid===uid);assert.equal(current.localRel,'target/pack/new.png');assert.equal(current.name,'new.png');
  await f.storage.withDb(conn=>{
    assert.deepEqual(conn.readUserDomain().favorites,[uid]);assert.deepEqual(conn.readUserDomain().userTags[uid],['人工标签']);
    assert.equal(conn.readUserDomain().userMeta[uid].rating,4);assert.deepEqual([...collectionUids(conn,'test')],[uid]);
    assert.equal(conn.all('SELECT * FROM file_locations WHERE asset_uid=?',[uid])[0].location_id,before.find(row=>row.asset_uid===uid).location_id);
    assert.equal(conn.searchAssetRows('new.png')[0].uid,uid);
  });
  await f.service.undo(renamed.operationId);await f.service.undo(moved.operationId);
  assert.equal((await f.read()).models.find(m=>m.uid===uid).localRel,'pack/a.png');
  assert.equal((await createFileOrganizer(f.options).ready).pending.length,0);
  assert.equal((await f.service.history()).find(row=>row.id===moved.operationId).state,'undone');
});

test('覆盖/未入库/依赖型单文件/工程/越界/链接/自循环拦截且原件保留',windows,async t=>{
  const f=await fixture(t);await f.add('a.png');await f.add('model.fbx','b'.repeat(32));
  await fs.mkdir(path.join(f.folder,'target'));await fs.writeFile(path.join(f.folder,'target','a.png'),'occupied');
  await f.service.setWritable({folder:f.folder,writable:true});
  await assert.rejects(f.service.move({folder:f.folder,from:'a.png',to:'target/a.png'}),/目标已存在/);
  await assert.rejects(f.service.move({folder:f.folder,from:'model.fbx',to:'target/model.fbx'}),/完整素材目录/);
  await assert.rejects(f.service.move({folder:f.folder,from:'target',to:'target/child'}),/自身子目录/);
  await assert.rejects(f.service.move({folder:f.folder,from:'../a.png',to:'b.png'}),/名称无效/);
  await assert.rejects(f.service.move({folder:f.folder,from:'target',to:'unmanaged'}),/尚未入库/);
  await fs.symlink(path.join(f.folder,'target'),path.join(f.folder,'junction'),'junction');
  await assert.rejects(f.service.move({folder:f.folder,from:'a.png',to:'junction/new.png'}),/链接|junction/);
  f.roots.add(path.join(f.folder,'target'));
  await assert.rejects(f.service.move({folder:f.folder,from:'a.png',to:'target/new.png'}),/已登记根/);
  await fs.mkdir(path.join(f.folder,'ProjectSettings'));
  await assert.rejects(f.service.move({folder:f.folder,from:'a.png',to:'new.png'}),/Unity|工程/);
  assert.equal(await fs.readFile(path.join(f.folder,'target/a.png'),'utf8'),'occupied');
  assert.equal((await f.service.history()).length,0);
});

test('文件系统成功但事务失败：重启按文件身份恢复 DB，旧位置不复活',windows,async t=>{
  const f=await fixture(t);await f.add('a.png');await f.service.setWritable({folder:f.folder,writable:true});
  const interrupted=createFileOrganizer({...f.options,afterFilesystemMove:async()=>{throw Error('模拟进程中断');}});await interrupted.ready;
  await assert.rejects(interrupted.move({folder:f.folder,from:'a.png',to:'new.png'}),/恢复记录/);
  assert.equal((await f.read()).models[0].localRel,'a.png');assert.equal((await interrupted.pending()).length,1);
  const restarted=createFileOrganizer(f.options);const recovered=await restarted.ready;
  assert.equal(recovered.pending.length,0);assert.equal((await f.read()).models[0].localRel,'new.png');
  assert.equal(await fs.readFile(path.join(f.folder,'new.png'),'utf8'),'file '+'a'.repeat(32));
});

test('恢复遇到外部占位不覆盖；清除冲突后可恢复；撤销拒绝已修改的文件',windows,async t=>{
  const f=await fixture(t);await f.add('a.png');await f.service.setWritable({folder:f.folder,writable:true});
  const interrupted=createFileOrganizer({...f.options,afterFilesystemMove:async()=>{
    await fs.writeFile(path.join(f.folder,'a.png'),'external');throw Error('中断');
  }});await interrupted.ready;
  await assert.rejects(interrupted.move({folder:f.folder,from:'a.png',to:'new.png'}));
  const restarted=createFileOrganizer(f.options);assert.equal((await restarted.ready).pending.length,1);
  assert.equal(await fs.readFile(path.join(f.folder,'a.png'),'utf8'),'external');
  await assert.rejects(restarted.move({folder:f.folder,from:'new.png',to:'another.png'}),/未恢复/);
  await fs.unlink(path.join(f.folder,'a.png'));assert.equal((await restarted.recover()).pending.length,0);
  const completed=(await restarted.history())[0];
  await fs.writeFile(path.join(f.folder,'new.png'),'edited after moving');
  await assert.rejects(restarted.undo(completed.id),/发生变化/);
  assert.equal(await fs.readFile(path.join(f.folder,'new.png'),'utf8'),'edited after moving');
});

test('大小写改名有日志且可撤销；撤销旧路径被占时不覆盖',windows,async t=>{
  const f=await fixture(t);await f.add('a.png');await f.service.setWritable({folder:f.folder,writable:true});
  const moved=await f.service.move({folder:f.folder,from:'a.png',to:'A.png'});
  assert.ok((await fs.readdir(f.folder)).includes('A.png'));
  assert.equal((await f.read()).models[0].localRel,'A.png');
  await f.service.undo(moved.operationId);assert.ok((await fs.readdir(f.folder)).includes('a.png'));
  const moved2=await f.service.move({folder:f.folder,from:'a.png',to:'new.png'});
  await fs.writeFile(path.join(f.folder,'a.png'),'external');
  await assert.rejects(f.service.undo(moved2.operationId),/目标已存在/);
  assert.equal(await fs.readFile(path.join(f.folder,'a.png'),'utf8'),'external');
});

test('首次整理校验旧摘要，之后记录文件身份；同路径换成另一文件时拦截',windows,async t=>{
  const f=await fixture(t);await f.add('a.png');await f.service.setWritable({folder:f.folder,writable:true});
  await fs.writeFile(path.join(f.folder,'a.png'),'replaced before first adoption');
  await assert.rejects(f.service.move({folder:f.folder,from:'a.png',to:'b.png'}),/源内容与入库记录不同/);
  assert.equal((await f.service.history()).length,0);
  await fs.writeFile(path.join(f.folder,'a.png'),'file '+'a'.repeat(32));
  await f.service.move({folder:f.folder,from:'a.png',to:'b.png'});
  const fingerprint=await f.storage.withDb(conn=>JSON.parse(conn.all('SELECT fingerprint FROM file_locations')[0].fingerprint));assert.equal(fingerprint.v,1);
  await fs.rename(path.join(f.folder,'b.png'),path.join(f.folder,'old.png'));
  await fs.writeFile(path.join(f.folder,'b.png'),'file '+'a'.repeat(32));
  await assert.rejects(f.service.move({folder:f.folder,from:'b.png',to:'c.png'}),/身份已变化/);
  assert.ok(await fs.stat(path.join(f.folder,'b.png')));assert.ok(await fs.stat(path.join(f.folder,'old.png')));
});
