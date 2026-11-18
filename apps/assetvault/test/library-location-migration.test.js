import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createLocationMigration} from '../server/location-migration.mjs';
import {saveCollection,setCollectionItems,collectionUids} from '../server/library-collections.mjs';

const uid='a'.repeat(32),sha=value=>createHash('sha256').update(value).digest('hex');

test('全库关联审计报告未知关联、重复 UID 和损坏记录，不修改库',async t=>{
 const {db,service,counts}=await fixture(t);
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid,name:'known'}]})});
 saveCollection(db,{id:'audit-test',name:'审计'});setCollectionItems(db,'audit-test',['orphan-collection'],'add');
 const snapshot=JSON.stringify({models:[{uid},{uid}],favorites:['orphan-favorite'],userTags:{'orphan-manual':['tag']},aiTags:{'orphan-auto':['auto']},userMeta:{'orphan-note':{note:'keep'}}});
 db.run('UPDATE state_meta SET value=? WHERE key=?',[snapshot,'sfx-library-v2']);
 db.run('UPDATE assets SET payload=? WHERE uid=?',[JSON.stringify({uid:'mismatch'}),uid]);
 const before={state:db.all('SELECT * FROM state_meta'),assets:db.all('SELECT * FROM assets'),collections:db.all('SELECT * FROM collection_assets')};
 const report=await service.audit();assert.equal(report.readOnly,true);assert.equal(report.total,5);
 assert.deepEqual(new Set(report.items.map(item=>item.kind)),new Set(['favorite','manual-tag','automatic-tag','annotation','collection']));
 assert.deepEqual(report.duplicateSnapshotUids,[{uid,copies:2}]);assert.deepEqual(report.malformed,[{uid}]);
 assert.deepEqual({state:db.all('SELECT * FROM state_meta'),assets:db.all('SELECT * FROM assets'),collections:db.all('SELECT * FROM collection_assets')},before);
 assert.deepEqual(counts(),{backups:0,changes:0});
});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'av-migrate-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const db=createLibraryDb({Database,file:':memory:'});t.after(()=>db.close());let backups=0,changes=0;
 const storage={withDb:async fn=>fn(db),withDbWrite:async fn=>{db.run('BEGIN');try{const result=await fn(db);db.run('COMMIT');return result;}catch(error){db.run('ROLLBACK');throw error;}}};
 const service=createLocationMigration({storage,importRoots:{list:()=>[root]},beforeMigrate:async()=>{backups++;},onChanged:()=>{changes++;}});
 return {root,db,service,counts:()=>({backups,changes})};
}
test('旧 filePath 资产经摘要校验认领位置，保留 UID、标签、收藏和原文件，旧快照不能回滚',async t=>{
 const {root,db,service,counts}=await fixture(t),file=path.join(root,'old.png');await fs.writeFile(file,'original');
 const old={uid,name:'旧标题',filePath:file,sha256:sha('original'),tags:['wood']};
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[old],favorites:[uid],userTags:{[uid]:['我的标签']},userMeta:{[uid]:{rating:4,note:'保留'}}})});
 saveCollection(db,{id:'migration-test',name:'迁移保留合集'});setCollectionItems(db,'migration-test',[uid],'add');
 assert.equal((await service.inspect({folder:root})).ready,1);
 const result=await service.migrate({folder:root,uids:[uid]});assert.equal(result.results[0].ok,true);
 const location=db.all('SELECT * FROM file_locations')[0];assert.equal(location.asset_uid,uid);assert.equal(location.rel,'old.png');
 assert.equal(db.readCatalog().models[0].locationId,location.location_id);
 assert.deepEqual(db.readUserDomain().favorites,[uid]);assert.deepEqual(db.readUserDomain().userTags[uid],['我的标签']);
 assert.deepEqual([...collectionUids(db,'migration-test')],[uid]);
 assert.equal(db.readUserDomain().userMeta[uid].note,'保留');assert.equal(await fs.readFile(file,'utf8'),'original');
 assert.deepEqual(counts(),{backups:1,changes:1});assert.equal((await service.inspect({folder:root})).total,0);
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[old]})});assert.equal(db.readCatalog().models[0].locationId,location.location_id);
 assert.equal((await service.migrate({folder:root,uids:[uid]})).results[0].ok,false);
});
test('同路径不同身份、缺摘要、旧定位异常、摘要不符均不认领；失败不阻碍其它项目',async t=>{
 const {root,db,service}=await fixture(t);await fs.writeFile(path.join(root,'same.png'),'same');await fs.writeFile(path.join(root,'wrong.png'),'changed');await fs.writeFile(path.join(root,'ok.png'),'ok');
 const models=[
  {uid,name:'dup1',filePath:path.join(root,'same.png'),sha256:sha('same')},
  {uid:'b'.repeat(32),name:'dup2',filePath:path.join(root,'same.png'),sha256:sha('same')},
  {uid:'c'.repeat(32),name:'nohash',filePath:path.join(root,'missing.png')},
  {uid:'d'.repeat(32),name:'wrong',filePath:path.join(root,'wrong.png'),sha256:sha('before')},
  {uid:'e'.repeat(32),name:'badlocator',localRoot:root,localRel:'../bad.png',filePath:path.join(root,'bad.png'),sha256:sha('bad')},
  {uid:'f'.repeat(32),name:'ok',filePath:path.join(root,'ok.png'),sha256:sha('ok')}
 ];db.writeValues({'sfx-library-v2':JSON.stringify({models})});
 const report=await service.inspect({folder:root});assert.equal(report.total,6);assert.equal(report.ready,2);
 assert.deepEqual(report.items.slice(0,3).map(item=>item.code),['path-conflict','path-conflict','missing-sha256']);
 const result=await service.migrate({folder:root,uids:models.map(item=>item.uid)});
 assert.deepEqual(result.results.map(item=>item.ok),[false,false,false,false,false,true]);assert.equal(db.all('SELECT * FROM file_locations').length,1);
 await assert.rejects(service.inspect({folder:path.dirname(root)}),/登记/);
});
test('链接、待恢复日志和取消阻断认领',async t=>{
 const {root,db,service}=await fixture(t),file=path.join(root,'a.png');await fs.writeFile(file,'a');
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid,filePath:file,sha256:sha('a')}]})});
 db.run("INSERT INTO file_operations (operation_id,state,plan,created_at,updated_at) VALUES ('pending','prepared','{}',1,1)");
 assert.equal((await service.migrate({folder:root,uids:[uid]})).results[0].ok,false);
 db.run('DELETE FROM file_operations');const controller=new AbortController();controller.abort();
 assert.equal((await service.migrate({folder:root,uids:[uid],signal:controller.signal})).cancelled,true);
 assert.equal(db.all('SELECT * FROM file_locations').length,0);
 const target=path.join(root,'target'),linked=path.join(root,'linked');await fs.mkdir(target);await fs.writeFile(path.join(target,'b.png'),'b');
 await fs.symlink(target,linked,process.platform==='win32'?'junction':'dir');
 const linkUid='b'.repeat(32);db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid:linkUid,filePath:path.join(linked,'b.png'),sha256:sha('b')}]})});
 const result=await service.migrate({folder:root,uids:[linkUid]});assert.equal(result.results[0].ok,false);assert.match(result.results[0].error,/链接/);
 assert.equal(db.all('SELECT * FROM file_locations').length,0);
});
