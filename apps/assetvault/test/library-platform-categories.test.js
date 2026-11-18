import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {PLATFORM_CATEGORIES,normalizePlatformCategories,mappedPlatformCategories} from '../server/platform-categories.mjs';
import {TERMS,VOCAB_REV} from '../server/library-vocab.seed.mjs';
import {normalizeModel} from '../server/catalog.mjs';
import {normalizeArtstationProject,artstationFilterOptions,resetArtstationFilterCache} from '../server/artstation-search.mjs';
import {fetchProjectAssets} from '../server/artstation-project.mjs';
import {Readable} from 'node:stream';
import {createLibraryDb} from '../server/library-db.mjs';
import {createTagBackfill} from '../server/tag-backfill.mjs';
const uid='a'.repeat(32),other='b'.repeat(32),channel='taxonomy-explicit-metadata-v1';

test('两平台全部分类都有标准词或原词别名，既有稳定词条不重复创建',()=>{
 assert.equal(PLATFORM_CATEGORIES.filter(row=>row.platform==='artstation').length,59);
 assert.equal(PLATFORM_CATEGORIES.filter(row=>row.platform==='sketchfab').length,18);
 for(const row of PLATFORM_CATEGORIES)assert.ok(TERMS.some(term=>term.value===row.value||term.aliases?.some(alias=>alias.toLowerCase()===row.name.toLowerCase())),row.name);
 assert.equal(TERMS.filter(term=>term.value==='建筑').length,1);
 assert.ok(TERMS.find(term=>term.value==='角色建模').facets.includes('usage'));
 assert.ok(TERMS.find(term=>term.value==='硬表面').facets.includes('tech'));
});

test('归一化保留原始 ID、slug、名字和平台；未知 ID 不猜分类',async()=>{
 const source=[{uid:'cat-1',slug:'characters-creatures',name:'Characters & Creatures'},{name:'Future Category'}];
 const model=normalizeModel({uid,categories:source});
 assert.deepEqual(model.platformCategories[0],{platform:'sketchfab',id:'cat-1',slug:'characters-creatures',name:'Characters & Creatures'});
 assert.deepEqual(mappedPlatformCategories(model).map(row=>row.value),['角色与生物']);
 assert.ok(model.categories.includes('Future Category'));
 assert.deepEqual(mappedPlatformCategories({platform:'artstation',categories:['999999']}),[]);
 assert.deepEqual(normalizePlatformCategories('artstation',null),[]);
 resetArtstationFilterCache();
 await artstationFilterOptions({open:async()=>({status:200,stream:Readable.from(Buffer.from(JSON.stringify([{name:'category_ids',select_options:[{id:21,name:'Props'}]}])))})});
 try{
  const art=normalizeArtstationProject({hash_id:'abcd',categories:[{id:66,name:'Character Modeling'}],category_ids:[21,999999]});
  assert.ok(art.categories.includes('Character Modeling'));assert.ok(art.categories.includes('Props'));
  assert.equal(art.platformCategories.find(row=>row.id==='999999').name,'');
  const detail=await fetchProjectAssets('https://www.artstation.com/artwork/abcd',{open:async()=>({status:200,stream:Readable.from(Buffer.from(JSON.stringify({categories:[{id:66,name:'Character Modeling'}],assets:[]})))})});
  assert.equal(detail.platformCategories[0].name,'Character Modeling');
 }finally{resetArtstationFilterCache();}
});

test('旧分类补标可续跑，平台隔离，未知保留，人工排除和手动标签不覆盖',async t=>{
 const db=createLibraryDb({Database,file:':memory:'});t.after(()=>db.close());
 const storage={withDb:async fn=>fn(db),withDbWrite:async fn=>{db.run('BEGIN');try{const result=await fn(db);db.run('COMMIT');return result;}catch(e){db.run('ROLLBACK');throw e;}}};
 const service=createTagBackfill({storage});
 db.writeValues({'sfx-library-v2':JSON.stringify({models:[{uid,platform:'artstation',categories:['Character Modeling','Science Fiction','Future Category'],localRel:'keep/file.png'},{uid:other,platform:'unrelated',categories:['Character Modeling']}],userTags:{[uid]:['人工保留']}})});
 // v3 覆盖不能阻止词表 v4 的平台分类补标。
 db.run('INSERT INTO asset_label_progress VALUES (?,?,?,?)',[uid,channel,VOCAB_REV-1,1]);
 const finish=async()=>{await service.start({channel});for(let i=0;i<200;i++){const report=await service.status({channel});if(report.job.state==='completed')return;if(report.job.state==='failed')throw Error(report.job.error);await new Promise(resolve=>setTimeout(resolve,5));}throw Error('补标超时');};
 const values=id=>db.all("SELECT t.value FROM asset_tags a JOIN tag_terms t ON t.term_id=a.term_id WHERE a.uid=? AND a.source='ai'",[id]).map(row=>row.value);
 await finish();assert.ok(values(uid).includes('角色建模'));assert.ok(db.all('SELECT 1 FROM asset_tags a JOIN tag_terms t ON t.term_id=a.term_id WHERE a.uid=? AND t.value=?',[uid,'科幻']).length);assert.deepEqual(values(other),[]);
 const original=db.all('SELECT payload FROM assets WHERE uid=?',[uid])[0].payload;
 assert.deepEqual(JSON.parse(original).categories,['Character Modeling','Science Fiction','Future Category']);assert.equal(JSON.parse(original).localRel,'keep/file.png');
 db.applyTagOps([{op:'tag.remove',uid,source:'ai',value:'角色建模'}]);await finish();assert.ok(!values(uid).includes('角色建模'));
 assert.deepEqual(db.readUserDomain().userTags[uid],['人工保留']);assert.equal((await service.status({channel})).covered,2);
});
