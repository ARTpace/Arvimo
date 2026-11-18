import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createTextLabelMatcher,TEXT_LABEL_CHANNEL as channel} from '../server/text-label-analysis.mjs';
import {createLibraryDb} from '../server/library-db.mjs';
import {createTagBackfill} from '../server/tag-backfill.mjs';
import {createTagManagement} from '../server/tag-management.mjs';

test('文本词组索引匹配中英文/别名/目录，英文边界、长词优先、短词和敏感维度保护',()=>{
 const terms=['汽车','座椅','角色','角色设计','CC0','Blender','Sketchfab','云'].map((value,i)=>({term_id:i+1,value}));
 const match=createTextLabelMatcher({terms,aliases:[{term_id:1,alias_norm:'car'},{term_id:2,alias_norm:'wood chair'}],facets:new Map([[5,new Set(['license'])],[6,new Set(['software'])],[7,new Set(['platform'])]])});
 const values=model=>match(model).map(row=>row.value);
 assert.deepEqual(values({name:'cartoon.png'}),[]);
 assert.deepEqual(values({name:'Wood_Chair_v2.png',localRel:'角色设计/car-01.png',description:'CC0 Blender Sketchfab 云'}),['座椅','角色设计','汽车']);
 assert.deepEqual(values({filePath:'C:/汽车/unknown.png'}),[],'绝对根目录不当作内容');
 assert.deepEqual(values({name:'unknown.png',description:'<a href="https://example.com/car">details</a>'}),[]);
 assert.deepEqual(values({keywords:['CAR'],subject:'座椅'}),['汽车','座椅']);
 assert.equal(match({name:'wood-chair.png'})[0].evidence.field,'name');
});

test('文件信息后台补标支持自定义标签、排除、元数据变更重跑和新增词条，不改文件/人工归属',async t=>{
 const db=createLibraryDb({Database,file:':memory:'});t.after(()=>db.close());
 const storage={withDb:async fn=>fn(db),withDbWrite:async fn=>{db.run('BEGIN');try{const result=await fn(db);db.run('COMMIT');return result;}catch(e){db.run('ROLLBACK');throw e;}}};
 const management=createTagManagement({storage});await management.mutate({action:'create',value:'项目座椅',facets:['subject']});
 const uid='a'.repeat(32),model={uid,name:'unknown.png',localRel:'项目座椅/wooden-chair.png',description:'CC0 Blender Sketchfab',platform:'local'};
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[model],userTags:{[uid]:['人工保留']}})});
 const service=createTagBackfill({storage});
 const finish=async()=>{await service.start({channel});for(let i=0;i<200;i++){const report=await service.status({channel});if(report.job.state==='completed')return report;if(report.job.state==='failed')throw Error(report.job.error);await new Promise(resolve=>setTimeout(resolve,5));}throw Error('补标超时');};
 const values=()=>db.all("SELECT t.value FROM asset_tags a JOIN tag_terms t ON t.term_id=a.term_id WHERE a.uid=? AND a.source='ai'",[uid]).map(row=>row.value);
 assert.equal((await finish()).covered,1);assert.ok(values().includes('项目座椅'));assert.ok(values().includes('木材'));
 assert.ok(!values().some(value=>['CC0','Blender','Sketchfab'].includes(value)));
 db.applyTagOps([{op:'tag.remove',uid,source:'ai',value:'项目座椅'}]);await finish();assert.ok(!values().includes('项目座椅'));
 db.applyAssetOps([{op:'asset:patch',uid,patch:{description:'汽车 新增项目'}}]);await finish();assert.ok(values().includes('汽车'));
 await management.mutate({action:'create',value:'新增项目',facets:['subject']});await finish();assert.ok(values().includes('新增项目'));
 assert.deepEqual(db.readUserDomain().userTags[uid],['人工保留']);assert.equal(db.readCatalog().models[0].localRel,model.localRel);
 const restarted=createTagBackfill({storage});assert.equal((await restarted.status({channel})).covered,1);
});
