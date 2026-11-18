import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryDb} from '../server/library-db.mjs';
import {localLocator, locationModel} from '../server/file-locations.mjs';
import {createFileOrganizePreflight} from '../server/file-organize-preflight.mjs';
import {MIGRATIONS} from '../server/library-schema.mjs';

const uid = 'a'.repeat(32);
const model = root => ({uid, name:'a.png', localRoot:root,localRel:'a.png',storageMode:'linked',
  filePath:path.join(root,'a.png'),sha256:'hash',url:`/api/local/file?root=${encodeURIComponent(root)}&rel=a.png`,
  thumbnail:`/api/local/thumb?w=384&root=${encodeURIComponent(root)}&rel=a.png`});

test('稳定定位不把平台预览图或自定义封面改成模型主文件', () => {
  const root=path.resolve('cover-library');
  const query=rel=>new URLSearchParams({root,rel}).toString();
  const main='models/rock/model.glb';
  const old={...model(root),localRel:main,url:`/api/local/file?${query(main)}`,
    previewUrl:`/api/local/file?${query('models/rock/preview.jpg')}`,
    thumbnail:`/api/local/thumb?w=384&${query('models/rock/preview.jpg')}`};
  const location={path:root,rel:'models/renamed/model.glb',availability:'online'};
  const current=locationModel(old,location);
  assert.equal(current.thumbnail,old.thumbnail);
  assert.equal(current.previewUrl,old.previewUrl);
  assert.equal(new URL(current.url,'http://local').searchParams.get('rel'),location.rel);
  assert.equal(locationModel({...old,thumbnail:'https://cdn.example.com/cover.jpg'},location).thumbnail,'https://cdn.example.com/cover.jpg');
  const foreign=`/api/local/thumb?${new URLSearchParams({root:path.resolve('other-library'),rel:main})}`;
  assert.equal(locationModel({...old,thumbnail:foreign},location).thumbnail,foreign);
});

test('主文件自身的缩略图跟随位置更新，但保留缩略图参数', () => {
  const root=path.resolve('cover-library'),old=model(root);
  const current=locationModel(old,{path:root,rel:'renamed/a.png',availability:'online'});
  const thumbnail=new URL(current.thumbnail,'http://local');
  assert.equal(thumbnail.searchParams.get('rel'),'renamed/a.png');
  assert.equal(thumbnail.searchParams.get('w'),'384');
});

test('稳定位置保留 UID 和用户数据；旧快照与普通 patch 不能覆盖重定位', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-locations-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'test.db'), root=path.join(dir,'source');
  let db=createLibraryDb({Database,file});
  try {
    const old=model(root);
    db.writeValues({'sfx-library-v2':JSON.stringify({models:[old],favorites:[uid],userTags:{[uid]:['自定义']},userMeta:{[uid]:{rating:4,note:'保留'}}})});
    const first=db.all('SELECT * FROM file_locations')[0];
    assert.equal(first.asset_uid,uid);assert.equal(first.rel,'a.png');
    assert.equal(db.all('SELECT writable FROM file_roots')[0].writable,0);
    db.run('BEGIN');
    db.rebindFileLocation({...old,localRel:'new/a.png'});
    db.applyAssetOps([{op:'asset:patch',uid,patch:{localRel:'new/a.png'}}]);
    db.run('COMMIT');
    db.writeValues({'sfx-library-v2':JSON.stringify({models:[old]})});
    db.applyAssetOps([{op:'asset:patch',uid,patch:{localRel:'stale.png',filePath:'stale'}}],{syncBlob:true});
    const current=db.readCatalog().models[0];
    assert.equal(current.uid,uid);assert.equal(current.localRel,'new/a.png');
    assert.equal(current.filePath,path.join(root,'new','a.png'));
    assert.equal(new URL(current.thumbnail,'http://local').searchParams.get('w'),'384');
    assert.equal(new URL(current.url,'http://local').searchParams.get('rel'),'new/a.png');
    assert.equal(db.all('SELECT * FROM file_locations')[0].location_id,first.location_id);
    assert.deepEqual(db.readUserDomain().userMeta[uid],{rating:4,note:'保留'});
    assert.deepEqual(db.readUserDomain().userTags[uid],['自定义']);
    assert.deepEqual(db.readUserDomain().favorites,[uid]);
    const raw=JSON.parse(db.readValues()['sfx-library-v2']);
    assert.equal(raw.models[0].localRel,'new/a.png');
    db.close();db=createLibraryDb({Database,file});
    assert.equal(db.readCatalog().models[0].locationId,first.location_id);
    db.removeAssets([uid]);assert.equal(db.all('SELECT * FROM file_locations').length,0);
  } finally {db.close();}
});

test('路径拒绝穿越/设备分隔；冲突不抢占原资产身份，预检只读且保护重名与依赖',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'av-organize-plan-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const rel of ['../a','a/../b','a:b','/abs','a//b','a.','a\\..\\b','CON.png','a\u0001b'])assert.equal(localLocator({localRoot:root,localRel:rel}),null);
  await fs.writeFile(path.join(root,'a.png'),'image');await fs.mkdir(path.join(root,'target'));
  await fs.writeFile(path.join(root,'existing.png'),'keep');await fs.writeFile(path.join(root,'a.fbx'),'model');
  const db=createLibraryDb({Database,file:':memory:'});t.after(()=>db.close());
  db.writeValues({'sfx-library-v2':JSON.stringify({models:[model(root)]})});
  const service=createFileOrganizePreflight({storage:{withDb:async fn=>fn(db)},importRoots:{list:()=>[root]}});
  const plan=await service.plan({folder:root,from:'a.png',to:'target/a.png'});
  assert.equal(plan.filesystemWritesEnabled,false);assert.equal(plan.affected[0].uid,uid);
  assert.equal(plan.affected[0].to,'target/a.png');
  assert.equal(await fs.readFile(path.join(root,'a.png'),'utf8'),'image');
  await assert.rejects(service.plan({folder:root,from:'a.png',to:'existing.png'}),/已经存在/);
  await assert.rejects(service.plan({folder:root,from:'a.fbx',to:'target/a.fbx'}),/完整素材包/);
  await assert.rejects(service.plan({folder:root,from:'../a.png',to:'target/a.png'}),/相对路径/);
  await assert.rejects(service.inspect(path.dirname(root)),/已登记/);
  await fs.symlink(path.join(root,'target'),path.join(root,'alias'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(service.plan({folder:root,from:'a.png',to:'alias/a.png'}),/链接|junction/);
  db.applyAssetOps([{op:'asset:add',uid:'b'.repeat(32),model:{...model(root),uid:'b'.repeat(32)}}]);
  const report=await service.inspect(root);
  assert.equal(report.issues[0].code,'location-conflict');
  assert.equal(db.all('SELECT * FROM file_locations').length,1);
  await assert.rejects(service.plan({folder:root,from:'a.png',to:'target/a.png'}),/定位冲突/);
});

test('已有 V6 数据库升级后幂等认领位置，原 UID 和旧标注不重键',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-v6-upgrade-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'library.db'), original=model(dir);
  const legacy=new Database(file);
  for(const migration of MIGRATIONS.filter(item=>item.version<=6)){
    legacy.exec(migration.sql);
    legacy.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(migration.version,migration.name,migration.checksum,new Date().toISOString());
  }
  legacy.prepare(`INSERT INTO assets (uid,position,state,payload,name,rating,note,favorite)
    VALUES (?,0,'active',?,'a.png',5,'旧备注',1)`).run(uid,JSON.stringify(original));
  legacy.close();
  let db=createLibraryDb({Database,file});
  const first=db.all('SELECT * FROM file_locations')[0];
  assert.equal(first.asset_uid,uid);assert.equal(db.readUserDomain().userMeta[uid].note,'旧备注');
  assert.equal(db.readCatalog().models[0].locationId,first.location_id);
  db.close();db=createLibraryDb({Database,file});
  try{assert.equal(db.all('SELECT * FROM file_locations')[0].location_id,first.location_id);}
  finally{db.close();}
});
