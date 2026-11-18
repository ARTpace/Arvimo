import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createTagBackfill} from '../server/tag-backfill.mjs';

async function wait(service,state){for(let i=0;i<200;i++){const status=await service.status();if(status.job?.state===state)return status;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('补标任务未进入 '+state);}
function fixture(t,count=205){
 const db=createLibraryDb({Database,file:':memory:'});t.after(()=>db.close());
 const models=Array.from({length:count},(_,i)=>({uid:(i+1).toString(16).padStart(32,'0'),name:'asset '+i,tags:['wood'],userTags:['人工分类']}));
 db.writeValues({'sfx-library-v2':JSON.stringify({models})});
 const storage={withDb:async fn=>fn(db),withDbWrite:async fn=>{db.run('BEGIN');try{const result=await fn(db);db.run('COMMIT');return result;}catch(error){db.run('ROLLBACK');throw error;}}};
 return {db,models,storage};
}

test('分页补标可暂停续跑、重启幂等、新资产不遗漏、人工标注保留',async t=>{
 const {db,models,storage}=fixture(t);const service=createTagBackfill({storage});
 // 模拟旧版本留下原始标签，但新词表关联尚未建立。
 db.run('DELETE FROM asset_tags');
 await service.start();await service.pause();const paused=await service.status();assert.equal(paused.job.state,'paused');
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await service.status()).covered,paused.covered);
 const restarted=createTagBackfill({storage});await restarted.start();const done=await wait(restarted,'completed');assert.equal(done.covered,205);
 assert.equal(db.readUserDomain().userTags[models[0].uid][0],'人工分类');
 const n=db.all('SELECT count(*) n FROM asset_tags')[0].n;
 await restarted.start();await wait(restarted,'completed');assert.equal(db.all('SELECT count(*) n FROM asset_tags')[0].n,n);
 db.applyAssetOps([{op:'asset:add',uid:'f'.repeat(32),model:{uid:'f'.repeat(32),name:'new',tags:['unity3d']}}]);
 await restarted.start();assert.equal((await wait(restarted,'completed')).covered,206);
});

test('人工删除自动标签建立排除，补标和旧快照不能加回，显式添加解除排除',async t=>{
 const {db,models,storage}=fixture(t,1),uid=models[0].uid;
 db.applyTagOps([{op:'tag.add',uid,source:'ai',value:'Unity'}],{actor:'host'});
 db.applyTagOps([{op:'tag.remove',uid,source:'ai',value:'Unity'}],{actor:'host'});
 assert.equal(db.all('SELECT count(*) n FROM tag_rejections')[0].n,1);
 db.run("INSERT INTO tags VALUES (?,'platform','unity3d')",[uid]);
 const service=createTagBackfill({storage});await service.start();await wait(service,'completed');
 assert.equal(db.all("SELECT * FROM tags WHERE uid=? AND kind='ai'",[uid]).length,0);
 db.writeValues({'sfx-library-v2':JSON.stringify({models,aiTags:{[uid]:['Unity']}})},{syncUser:true});
 assert.equal(db.all("SELECT * FROM tags WHERE uid=? AND kind='ai'",[uid]).length,0);
 db.applyTagOps([{op:'tag.add',uid,source:'ai',value:'Unity'}],{actor:'host'});
 assert.equal(db.all('SELECT * FROM tag_rejections').length,0);
 assert.equal(db.all("SELECT * FROM tags WHERE uid=? AND kind='ai'",[uid]).length,1);
});

test('失败不推进本批覆盖版本，重试补齐',async t=>{
 const {db,storage}=fixture(t,2);db.run('DELETE FROM asset_tags');
 let injected=true;
 const broken={...storage,withDbWrite:fn=>storage.withDbWrite(conn=>{
  const proxy=new Proxy(conn,{get(target,property){if(property==='applyTagOps'&&injected)return ()=>{throw Error('模拟标注失败');};return target[property];}});
  return fn(proxy);
 })};
 const service=createTagBackfill({storage:broken});await service.start();const failed=await wait(service,'failed');assert.equal(failed.covered,0);assert.match(failed.job.error,/模拟/);
 injected=false;await service.start();assert.equal((await wait(service,'completed')).covered,2);
});
