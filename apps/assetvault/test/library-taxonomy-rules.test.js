import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createTagManagement} from '../server/tag-management.mjs';
import {createTaxonomyRules,RULE_CHANNEL} from '../server/taxonomy-rules.mjs';
import {createTagBackfill} from '../server/tag-backfill.mjs';
const a='a'.repeat(32),b='b'.repeat(32),metadata='taxonomy-explicit-metadata-v1';
function fixture(t){const db=createLibraryDb({Database,file:':memory:'});t.after(()=>db.close());const storage={withDb:async fn=>fn(db),withDbWrite:async fn=>{db.run('BEGIN');try{const result=await fn(db);db.run('COMMIT');return result;}catch(error){db.run('ROLLBACK');throw error;}}};return {db,storage,terms:createTagManagement({storage}),rules:createTaxonomyRules({storage}),backfill:createTagBackfill({storage})};}
async function finish(service,channel){for(let i=0;i<200;i++){const status=await service.status({channel});if(status.job?.state==='completed')return status;if(status.job?.state==='failed')throw Error(status.job.error);await new Promise(resolve=>setTimeout(resolve,5));}throw Error('任务超时');}
test('元数据通道只采信明确字段、维度正确，不从格式/文件名/平台推断授权，更新后可重跑',async t=>{
 const {db,backfill}=fixture(t);
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid:a,name:'CC0_unity.fbx',platform:'Sketchfab',software:['Blender'],license:'CC0'},{uid:b,name:'CC0_unity.fbx',platform:'local',license:'Blender'}],userTags:{[a]:['人工保留']}})});
 await backfill.start({channel:metadata});await finish(backfill,metadata);
 const values=uid=>db.all("SELECT t.value FROM asset_tags a JOIN tag_terms t ON t.term_id=a.term_id WHERE a.uid=? AND a.source='ai'",[uid]).map(row=>row.value).sort();
 assert.deepEqual(values(a),['Blender','CC0','Sketchfab']);assert.deepEqual(values(b),[]);
 db.applyTagOps([{op:'tag.remove',uid:a,source:'ai',value:'CC0'}]);
 db.applyAssetOps([{op:'asset:patch',uid:a,patch:{software:['Maya']}}]);
 await backfill.start({channel:metadata});await finish(backfill,metadata);
 assert.ok(values(a).includes('Maya'));assert.ok(!values(a).includes('CC0'));assert.deepEqual(db.readUserDomain().userTags[a],['人工保留']);
 assert.equal((await backfill.status()).channels.length,4);
});
test('规则唯一命中补子分类、歧义保留、人工排除不加回，旧来源保留且规则删除版本化',async t=>{
 const {db,terms,rules,backfill}=fixture(t);
 const parent=await terms.mutate({action:'create',value:'项目道具',facets:['subject']});
 const chair=await terms.mutate({action:'create',value:'项目椅子',parentId:parent.id,facets:['subject']});
 await terms.mutate({action:'create',value:'项目桌子',parentId:parent.id,facets:['subject']});
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid:a,tags:['项目道具','椅子提示']},{uid:b,tags:['项目道具','椅子提示','桌子提示']}],userTags:{[a]:['项目道具']}})});
 await rules.write({action:'create',source:'项目道具',target:'项目椅子',match:'椅子提示'});
 await rules.write({action:'create',source:'项目道具',target:'项目桌子',match:'桌子提示'});
 await assert.rejects(rules.write({action:'create',source:'项目椅子',target:'项目桌子',match:'错误'}),/直接子分类/);
 await backfill.start({channel:RULE_CHANNEL});await finish(backfill,RULE_CHANNEL);
 assert.equal(db.all("SELECT 1 FROM asset_tags WHERE uid=? AND term_id=? AND source='ai'",[a,chair.id]).length,1);
 assert.equal(db.all("SELECT 1 FROM asset_tags WHERE uid=? AND term_id=?",[b,chair.id]).length,0);
 assert.equal(db.all("SELECT 1 FROM asset_tags WHERE uid=? AND term_id=? AND source='user'",[a,parent.id]).length,1);
 db.applyTagOps([{op:'tag.remove',uid:a,source:'ai',value:'项目椅子'}]);await backfill.start({channel:RULE_CHANNEL});await finish(backfill,RULE_CHANNEL);
 assert.equal(db.all("SELECT 1 FROM asset_tags WHERE uid=? AND term_id=?",[a,chair.id]).length,0);
 const listed=await rules.list();await assert.rejects(rules.write({action:'remove',id:listed.rules[0].rule_id,rev:99}),/已变化/);
 await rules.write({action:'remove',id:listed.rules[0].rule_id,rev:1});assert.ok((await rules.list()).version>listed.version);
 assert.equal((await backfill.status({channel:RULE_CHANNEL})).covered,0);
});
