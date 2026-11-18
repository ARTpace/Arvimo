// 可重复的 50k/200k 合成规模基准；只创建临时 SQLite 数据，不读取或移动用户原件。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {compileQuery} from '../server/query-sql.mjs';
import {createFileOrganizePreflight} from '../server/file-organize-preflight.mjs';
import {createLocationMigration} from '../server/location-migration.mjs';

const counts=process.argv.filter(arg=>/^\d+$/.test(arg)).map(Number);
if(!counts.length)counts.push(50000,200000);
if(counts.some(count=>count<100||count>200000))throw Error('规模须为 100–200000');
const results=[];
for(const count of counts){
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-scale-')),root=path.join(temp,'assets');let conn;
 try{
  conn=createLibraryDb({Database,file:path.join(temp,'library.db')});
  const native=conn.native(),wood=conn.all("SELECT term_id FROM tag_terms WHERE norm='木材'")[0].term_id;
  const insert=native.prepare("INSERT INTO assets (uid,position,state,payload,name) VALUES (?,?,'active',?,?)"),loc=native.prepare("INSERT INTO file_locations (location_id,asset_uid,root_id,rel,fingerprint,availability,mode) VALUES (?,?,'root',?,'fixture','online','linked')"),tag=native.prepare("INSERT INTO asset_tags (uid,term_id,source,created_at) VALUES (?,?,'platform',1)");
  conn.run('INSERT INTO file_roots (root_id,path,writable) VALUES (?,?,0)',['root',root]);
  const started=performance.now();
  native.transaction(()=>{for(let i=1;i<=count;i++){
   const uid=i.toString(16).padStart(32,'0'),rel=`pack-${Math.floor(i/1000)}/${i}.png`,name=`asset-${i}`;
   insert.run(uid,i,JSON.stringify({uid,name,localRoot:root,localRel:rel}),name);loc.run('loc-'+i,uid,rel);tag.run(uid,wood);
  }})();
  const seededMs=performance.now()-started;
  const measure=async fn=>{const begin=performance.now();const value=await fn();return {ms:Number((performance.now()-begin).toFixed(2)),value};};
  const lookup=await measure(()=>conn.all('SELECT location_id FROM file_locations WHERE root_id=? AND rel=?',['root',`pack-${Math.floor(count/1000)}/${count}.png`]).length);
  const query=await measure(()=>conn.queryPage(compileQuery({filters:{tags:['木材']},limit:100})).total);
  if(query.value!==count||lookup.value!==1)throw Error('合成索引查询结果不完整');
  const storage={withDb:async fn=>fn(conn)},importRoots={list:()=>[root]};
  const preflight=await measure(async()=>(await createFileOrganizePreflight({storage,importRoots}).inspect(root)).registeredAssets);
  const audit=await measure(async()=>(await createLocationMigration({storage,importRoots}).audit()).total);
  results.push({count,fixtureInsertMs:Number(seededMs.toFixed(2)),locationLookupMs:lookup.ms,tagPageMs:query.ms,rootPreflightMs:preflight.ms,identityAuditMs:audit.ms,rssMB:Number((process.memoryUsage().rss/1024**2).toFixed(1))});
 }finally{conn?.close();await fs.rm(temp,{recursive:true,force:true});}
}
const report={at:new Date().toISOString(),node:process.version,platform:process.platform,cpu:os.cpus()[0]?.model,scope:'合成 SQLite 定位/标签分页/根预检/关联审计；不代表导入、图像解码、真实移动、掉电或界面验收',results};
const outputIndex=process.argv.indexOf('--output');if(outputIndex>=0){const output=process.argv[outputIndex+1];if(!output)throw Error('缺少输出路径');await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
