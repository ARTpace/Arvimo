import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createTagManagement} from '../server/tag-management.mjs';
import {compileQuery} from '../server/query-sql.mjs';
import {tagFacetView} from '../server/library-tag-facets.mjs';

function fixture(t){
 const db=createLibraryDb({Database,file:':memory:'});t.after(()=>db.close());
 const storage={withDb:async fn=>fn(db),withDbWrite:async fn=>{db.run('BEGIN');try{const result=await fn(db);db.run('COMMIT');return result;}catch(error){db.run('ROLLBACK');throw error;}}};
 const service=createTagManagement({storage});return {db,service};
}
const uid='a'.repeat(32);

test('拆分仅创建继承维度的子分类，保留旧关联；碰撞和过期请求整体回滚',async t=>{
 const {db,service}=fixture(t);
 const source=await service.mutate({action:'create',value:'待细分道具',facets:['subject','usage']});
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid,name:'asset',tags:['待细分道具']}],userTags:{[uid]:['待细分道具']}})});
 const before=db.all('SELECT * FROM asset_tags WHERE uid=?',[uid]);
 await assert.rejects(service.mutate({action:'split',id:source.id,rev:1,values:['子类一','wood']}),/占用/);
 assert.equal((await service.list({q:'子类一'})).total,0);
 await service.mutate({action:'split',id:source.id,rev:1,values:['道具家具','道具灯具']});
 const children=(await service.list({q:'道具'})).terms.filter(item=>item.parentId===source.id);
 assert.equal(children.length,2);for(const child of children)assert.deepEqual(child.facets,['subject','usage']);
 assert.deepEqual(db.all('SELECT * FROM asset_tags WHERE uid=?',[uid]),before);
 await assert.rejects(service.mutate({action:'split',id:source.id,rev:1,values:['子类三','子类四']}),/其它操作/);
});

test('排除记录分页和逐项撤销保留人工标签，过期撤销不能删除新的排除',async t=>{
 const {db,service}=fixture(t);
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid,name:'asset',tags:[]}],userTags:{[uid]:['wood']},aiTags:{[uid]:['wood']}})});
 db.applyTagOps([{op:'tag.remove',uid,source:'ai',value:'wood'}]);
 const page=await service.rejections({limit:1});assert.equal(page.total,1);assert.equal(page.items[0].name,'asset');
 const item=page.items[0];
 await assert.rejects(service.restoreRejection({...item,createdAt:item.createdAt-1}),/已变化/);
 assert.equal((await service.rejections()).total,1);
 await service.restoreRejection(item);
 assert.equal((await service.rejections()).total,0);
 assert.deepEqual(db.readUserDomain().userTags[uid],['wood']);
 assert.equal(db.all("SELECT * FROM asset_tags WHERE uid=? AND source='ai'",[uid]).length,0);
 await assert.rejects(service.restoreRejection(item),/已变化/);
});

test('自定义父子标签创建/改名/别名/查询/停用恢复，关联UID和原路径不变',async t=>{
 const {db,service}=fixture(t);
 const parent=await service.mutate({action:'create',value:'我的场景',facets:['subject']});
 const child=await service.mutate({action:'create',value:'我的森林',parentValue:'我的场景',facets:['subject','usage']});
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid,name:'forest',filePath:'H:/原件/tree.fbx',tags:['我的森林']}],userTags:{[uid]:['人工保留']},favorites:[uid]})});
 const query=compileQuery({filters:{tags:['我的场景']}});assert.equal(query.ok,true);assert.equal(db.queryPage(query).total,1);
 const excluded=compileQuery({filters:{excludeTags:['我的场景']}});assert.equal(db.queryPage(excluded).total,0);
 const raw=db.all('SELECT payload FROM assets WHERE uid=?',[uid])[0].payload;
 const listed=await service.list({q:'我的森林'});assert.equal(listed.terms[0].parentId,parent.id);
 await service.mutate({action:'save',id:child.id,rev:listed.terms[0].rev,value:'自定义林地',parentId:parent.id,facets:['subject'],aliases:['专用林地']});
 assert.equal(db.all('SELECT term_id FROM tag_terms WHERE norm=?',['自定义林地'])[0].term_id,child.id);
 assert.equal(db.queryPage(compileQuery({filters:{tags:['我的森林']}})).total,1);
 assert.equal(db.queryPage(compileQuery({filters:{tags:['专用林地']}})).total,1);
 assert.equal(db.searchAssetRows('自定义林地')[0].uid,uid);
 assert.equal(db.all('SELECT payload FROM assets WHERE uid=?',[uid])[0].payload,raw);
 assert.deepEqual(db.readUserDomain().userTags[uid],['人工保留']);assert.deepEqual(db.readUserDomain().favorites,[uid]);
 await service.mutate({action:'retire',id:child.id,rev:2});
 assert.ok(!tagFacetView(db).facets.flatMap(facet=>facet.values).some(term=>term.value==='自定义林地'));
 const rejected=db.applyTagOps([{op:'tag.add',uid,source:'user',value:'自定义林地'}]);assert.equal(rejected.conflicts[0].code,'term_retired');
 assert.equal(db.queryPage(compileQuery({filters:{tags:['我的场景']}})).total,1,'停用保留历史检索');
 await service.mutate({action:'restore',id:child.id,rev:3});assert.equal((await service.list({q:'自定义林地'})).terms[0].retired,0);
});

test('层级循环/名称别名碰撞/过期版本/内置编辑均拒绝，事务零残留',async t=>{
 const {db,service}=fixture(t);
 const a=await service.mutate({action:'create',value:'自定义甲',facets:['subject']});
 const b=await service.mutate({action:'create',value:'自定义乙',parentId:a.id,facets:['subject']});
 await assert.rejects(service.mutate({action:'save',id:a.id,rev:1,value:'自定义甲',parentId:b.id,facets:['subject']}),/成环/);
 await assert.rejects(service.mutate({action:'save',id:a.id,rev:1,value:'自定义甲',aliases:['wood'],facets:[]}),/占用/);
 await assert.rejects(service.mutate({action:'save',id:a.id,rev:99,value:'新版甲',facets:[]}),/其它操作/);
 await assert.rejects(service.mutate({action:'create',value:'临时错误',facets:['not-a-facet']}),/维度/);
 assert.equal(db.all("SELECT * FROM tag_terms WHERE value='临时错误'").length,0);
 const builtin=db.all("SELECT term_id FROM tag_terms WHERE value='木材'")[0].term_id;
 await assert.rejects(service.mutate({action:'retire',id:builtin}),/内置/);
 await assert.rejects(service.mutate({action:'merge',id:a.id,targetId:b.id}),/成环/);
 assert.equal(db.all('SELECT edit_rev FROM tag_terms WHERE term_id=?',[a.id])[0].edit_rev,1);
});

test('合并保留来源/排除/子项，旧名成为别名，计数按资产去重且可查询',async t=>{
 const {db,service}=fixture(t);
 const source=await service.mutate({action:'create',value:'自建木质',facets:['material']});
 const child=await service.mutate({action:'create',value:'自建木质子项',parentId:source.id,facets:['material']});
 const target=db.all("SELECT term_id FROM tag_terms WHERE value='木材'")[0].term_id;
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid,name:'tree',tags:['自建木质','wood']}],userTags:{[uid]:['自建木质']}})});
 db.run('INSERT INTO tag_rejections VALUES (?,?,?,?)',[uid,source.id,'ai',1]);
 await service.mutate({action:'merge',id:source.id,rev:1,targetValue:'木材'});
 assert.equal(db.all('SELECT status FROM tag_terms WHERE term_id=?',[source.id])[0].status,'merged');
 assert.equal(db.all('SELECT parent_id FROM tag_terms WHERE term_id=?',[child.id])[0].parent_id,target);
 assert.equal(db.all('SELECT term_id FROM tag_rejections')[0].term_id,target);
 assert.equal(db.all('SELECT count(*) n FROM asset_tags WHERE term_id=?',[source.id])[0].n,0);
 assert.equal(db.all('SELECT count(*) n FROM asset_tags WHERE term_id=?',[target])[0].n,2);
 assert.equal(db.all('SELECT asset_count FROM tag_counts WHERE term_id=?',[target])[0].asset_count,1);
 assert.equal(db.queryPage(compileQuery({filters:{tags:['自建木质']}})).total,1);
 assert.equal(db.queryPage(compileQuery({filters:{tags:['木材']}})).total,1);
});

test('合并尊重目标的人工排除；保留旧别名，维护操作不清除排除',async t=>{
 const {db,service}=fixture(t);
 const source=await service.mutate({action:'create',value:'自建材质源',facets:['material']});
 const target=await service.mutate({action:'create',value:'自建材质目标',facets:['material']});
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid,name:'asset',tags:['自建材质源']}],aiTags:{[uid]:['自建材质源']}})});
 db.run('INSERT INTO tag_rejections VALUES (?,?,?,?)',[uid,target.id,'ai',1]);
 await service.mutate({action:'merge',id:source.id,targetId:target.id});
 assert.equal(db.all("SELECT * FROM asset_tags WHERE uid=? AND source='ai'",[uid]).length,0);
 assert.equal(db.all("SELECT * FROM tags WHERE uid=? AND kind='ai'",[uid]).length,0);
 assert.equal(db.all('SELECT * FROM tag_rejections WHERE uid=?',[uid]).length,1);
 await service.mutate({action:'save',id:target.id,rev:2,value:'自建新材质目标',facets:['material'],aliases:[]});
 assert.equal(db.all("SELECT term_id FROM tag_aliases WHERE alias_norm='自建材质源'")[0].term_id,target.id);
 assert.equal(db.all('SELECT * FROM tag_rejections WHERE uid=?',[uid]).length,1);
 assert.equal(db.queryPage(compileQuery({filters:{tags:['自建新材质目标']}})).total,1);
});
