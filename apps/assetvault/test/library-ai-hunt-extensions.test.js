import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCollectRules} from '../server/collect-rules.mjs';
import {createCollectRunner} from '../server/collect-runner.mjs';
import {createCollectScheduler} from '../server/collect-scheduler.mjs';
import {searchCollectedLibrary} from '../server/collect-local.mjs';
import {createAiHunt} from '../server/ai-hunt.mjs';
import {COLLECT_PLATFORMS,createCollectSearch} from '../server/collect-search.mjs';
import {createCollectGuard} from '../server/collect-guard.mjs';
import {executeHunt,singlePreview} from '../src/library/ai-asset-hunt.js';

const uid=n=>String(n).padStart(32,'0');
const asset=(n,patch={})=>({uid:uid(n),key:`test:${n}`,name:`wood ${n}`,assetType:'textures',platform:'sketchfab',thumbnail:'/api/local/thumb?a=1',...patch});
async function fixture(t,options={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-hunt-ext-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const now=()=>new Date(2026,0,1,10,0).getTime();
 const rules=createCollectRules({file:path.join(dir,'rules.json'),now});
 const rule=await rules.save({id:'r-ext',name:'wood',boardId:'c-1',query:'wood',platforms:['sketchfab','freestylized'],dedupe:'board',limit:4,...options.rule});
 const members=new Set(),queued=[],calls=[];
 const runner=createCollectRunner({rules,now,pending:{add:async items=>{queued.push(...items);return {added:items.length};}},storage:{withDb:async fn=>fn({})},guard:{acquire:async()=>({ok:true}),noteSuccess(){},noteFailure:()=>({})},boardUids:()=>new Set(members),addToBoard:(_,id,uids)=>{uids.forEach(uid=>members.add(uid));return {count:members.size};},search:async(platform,input)=>{calls.push([platform,input.query]);return {items:[asset(calls.length),asset(1)]};},...options.runner});
 return {dir,rules,rule,runner,queued,members,calls,now};
}

test('多关键词先覆盖各平台，遵守总调用与总候选上限，持久化后仍幂等去重',async t=>{
 const x=await fixture(t,{rule:{queries:['plank','timber'],maxCalls:3,limit:2}});
 const run=await x.runner.run(x.rule.id);
 assert.deepEqual(x.calls,[['sketchfab','wood'],['freestylized','wood'],['sketchfab','plank']]);
 assert.equal(run.added,2);assert.equal(x.queued.length,2);assert.equal(x.members.size,2);assert.match(run.warnings.join(),/3 次/);
 const saved=(await x.rules.snapshot()).runs[0];assert.equal(saved.candidates.length,2);assert.equal(saved.addedUids.length,2);
});

test('12 平台、60 项、12 次预算达到上限，重复运行不重复入板',async t=>{
 const platforms=COLLECT_PLATFORMS.filter(p=>p.searchable).slice(0,12).map(p=>p.id),calls=[];
 const x=await fixture(t,{rule:{platforms,limit:60,maxCalls:12,queries:['plank','timber']},runner:{search:async(platform,input)=>{
  calls.push({platform,...input});return {items:Array.from({length:input.limit},(_,i)=>asset(platforms.indexOf(platform)*100+i+1,{platform}))};
 }}});
 const result=await x.runner.run(x.rule.id);
 assert.equal(calls.length,12);assert.deepEqual(calls.map(c=>c.platform),platforms);assert.ok(calls.every(c=>c.query==='wood'&&c.limit===7));
 assert.equal(result.added,60);assert.equal(result.addedUids.length,60);assert.equal(result.candidates.length,60);assert.equal(x.queued.length,60);assert.equal(x.members.size,60);
 const again=await x.runner.run(x.rule.id);assert.equal(again.added,24);assert.equal(x.queued.length,84);assert.equal(x.members.size,84);
 assert.equal(new Set(x.queued.map(row=>row.uid)).size,84);
 const exhausted=await x.runner.run(x.rule.id);assert.equal(exhausted.added,0);assert.equal(x.members.size,84);
 const restored=createCollectRules({file:path.join(x.dir,'rules.json')});assert.equal((await restored.snapshot()).runs[2].addedUids.length,60);
});

test('超限输入明确拒绝，重复平台不重复调用，部分失败不突破剩余预算',async t=>{
 const platforms=COLLECT_PLATFORMS.filter(p=>p.searchable).slice(0,13).map(p=>p.id);
 const x=await fixture(t);
 await assert.rejects(x.rules.save({...x.rule,platforms}),/最多选择 12/);
 const rule=await x.rules.save({...x.rule,platforms:[platforms[0],platforms[0],platforms[1]],limit:999,maxCalls:999});
 assert.equal(rule.limit,60);assert.equal(rule.maxCalls,12);assert.deepEqual(rule.platforms,platforms.slice(0,2));
 const calls=[];let n=0;
 const y=await fixture(t,{rule:{platforms:platforms.slice(0,12),limit:60,maxCalls:3},runner:{search:async platform=>{
  calls.push(platform);if(++n===2)throw Error('测试平台失败');return {items:Array.from({length:30},(_,i)=>asset(n*100+i,{platform}))};
 }}});
 const result=await y.runner.run(y.rule.id);assert.equal(calls.length,3);assert.equal(result.failed,1);assert.equal(result.status,'partial');assert.equal(result.added,60);assert.equal(y.members.size,60);
});

test('真实 12 平台边界抽检：隔离规则与成员，不下载、不调用 AI',{skip:process.env.ARVIMO_HUNT_LIVE!=='1',timeout:240000},async t=>{
 const platforms=COLLECT_PLATFORMS.filter(p=>p.searchable).slice(0,12).map(p=>p.id),calls=[],search=createCollectSearch().search;
 const x=await fixture(t,{rule:{platforms,limit:60,maxCalls:12,filters:{}},runner:{guard:createCollectGuard(),search:async(platform,input)=>{
  const at=Date.now();calls.push(platform);
  try{const result=await search(platform,{...input,signal:AbortSignal.timeout(15000)});t.diagnostic(`${platform}: ${result.items.length} items, ${Date.now()-at}ms`);return result;}
  catch(error){t.diagnostic(`${platform}: ${error.name}, ${Date.now()-at}ms`);throw error;}
 }}});
 const result=await x.runner.run(x.rule.id);
 assert.equal(calls.length,12);assert.equal(new Set(calls).size,12);assert.ok(result.added<=60);assert.equal(x.queued.length,result.added);assert.equal(x.members.size,result.added);assert.equal(result.addedUids.length,result.added);
 t.diagnostic(JSON.stringify({found:result.found,added:result.added,failed:result.failed,status:result.status,platforms:result.platforms}));
});

test('纯资产库模式不联网、不重写已有记录，混合来源按 UID 合并',async t=>{
 const local=[asset(1,{_libraryExisting:true,tags:['用户标签']})];
 const x=await fixture(t,{rule:{scope:'local',platforms:[]},runner:{localSearch:async()=>local}});
 const first=await x.runner.run(x.rule.id);assert.equal(first.added,1);assert.equal(x.calls.length,0);assert.equal(x.queued.length,0);assert.ok(x.members.has(uid(1)));
 await x.rules.save({...x.rule,scope:'both',platforms:['sketchfab'],limit:4});
 const second=await x.runner.run(x.rule.id);assert.equal(second.added,0);assert.equal(x.calls.length,1);assert.equal(x.queued.length,0);
});

test('长描述无结果才逐步缩词，保留类型并受同一调用预算限制',async t=>{
 const calls=[];
 const x=await fixture(t,{rule:{query:'stylized stone brick wall texture',platforms:['freestylized','ambientcg'],maxCalls:6,filters:{kinds:['textures']}},runner:{search:async(platform,input)=>{
  calls.push({platform,...input});return {items:input.query==='brick'?[asset(1)]:[]};
 }}});
 const result=await x.runner.run(x.rule.id);
 assert.deepEqual(calls.map(c=>c.query),['stylized stone brick wall texture','stylized stone brick wall texture','stone brick','stone brick','brick','brick']);
 assert.ok(calls.every(c=>c.assetType==='textures'));assert.equal(result.added,1);assert.match(result.warnings.join(),/仍需复核风格/);
 const y=await fixture(t,{rule:{query:'stylized stone brick wall texture',platforms:['freestylized'],maxCalls:1},runner:{search:async()=>({items:[]})}});
 const limited=await y.runner.run(y.rule.id);assert.equal(limited.added,0);assert.ok(!limited.warnings.some(w=>w.includes('尝试核心')));
 const success=[];
 const z=await fixture(t,{rule:{query:'stylized stone brick wall texture',platforms:['freestylized'],maxCalls:12},runner:{search:async(_,input)=>{success.push(input.query);return {items:[asset(1)]};}}});
 await z.runner.run(z.rule.id);assert.equal(success.length,1);
});

test('已有库查询复用类型与回收站过滤，不把散落文件当作新的导入',async()=>{
 const models=[asset(1),asset(2,{assetType:'models'}),asset(3),asset(4,{name:'stone'})];
 const storage={ensureIndex:async()=>false,readRawState:async()=>({'sfx-library-v2':JSON.stringify({version:2,models:models.filter(m=>m.uid!==uid(3)),trashed:[models[2]]})})};
 const items=await searchCollectedLibrary(storage,{queries:['wood'],filters:{kinds:['textures']},limit:10});
 assert.deepEqual(items.map(item=>item.uid),[uid(1)]);assert.ok(items.every(item=>item._libraryExisting));
 const indexed={ensureIndex:async()=>true,withDb:async fn=>fn({all:sql=>sql.includes('FROM assets')?models.slice(0,3).map((model,i)=>({uid:model.uid,name:model.name,state:i===2?'trashed':'active',payload:JSON.stringify(model)})):[]})};
 assert.deepEqual((await searchCollectedLibrary(indexed,{queries:['wood'],filters:{kinds:['textures']},limit:10})).map(x=>x.uid),[uid(1)]);
});

test('定时与手动执行复用同一个规则锁，失败记录会推进每日时间',async t=>{
 let release,started;const ready=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
 const x=await fixture(t,{rule:{frequency:'daily'},runner:{search:async()=>{started();await gate;return {items:[asset(1)]};}}});
 const first=x.runner.run(x.rule.id);await ready;
 await assert.rejects(x.runner.run(x.rule.id),error=>error.code==='COLLECT_BUSY');release();await first;
 let recorded=0;
 const scheduler=createCollectScheduler({rules:{list:async()=>[{...x.rule,nextRunAt:1}],recordRun:async(id,result)=>{recorded++;assert.equal(result.failed,1);}},runner:{run:async()=>{throw Error('检索失败');}},now:x.now});
 await scheduler.tick();assert.equal(recorded,1);
 assert.ok((await x.rules.get(x.rule.id)).nextRunAt>x.now());
});

test('每日收集只由用户选项开启，复用原规则保存与停止',async()=>{
 const saved=[],task={boardId:'c-1',boardSaved:true,ruleId:'r-1',requestId:'req-daily',plan:{boardName:'wood',rule:{query:'wood',scope:'local',platforms:[],frequency:'daily',hour:8}}};
 await executeHunt(task,{api:{saveRule:async rule=>saved.push(rule),runRule:async()=>({run:{status:'completed'}})},sync:async()=>{}});
 assert.equal(saved[0].frequency,'daily');assert.equal(saved[0].hour,8);assert.equal(saved[0].scope,'local');
});

test('单图精查使用完整封面与 1×1 协议，释放位图且不下载原文件',async()=>{
 const urls=[],draws=[];let closed=0;
 const sheet=await singlePreview(asset(1),{document:{createElement:()=>({getContext:()=>({fillRect(){},fillText(){},drawImage:(...args)=>draws.push(args)}),toDataURL:()=> 'data:image/jpeg;base64,YWJj'})},fetchImpl:async url=>{urls.push(url);return {ok:true,blob:async()=>({})};},bitmap:async()=>({width:800,height:400,close:()=>closed++})});
 assert.equal(closed,1);assert.match(urls[0],/^\/api\/local\/thumb/);assert.equal(draws[0][3]/draws[0][4],2);
 const hunt=createAiHunt({settings:async()=>({enabled:true}),complete:async()=>({text:'{"scores":[{"index":1,"score":81}]}'})});
 assert.equal((await hunt.rank({sheet,goal:'wood',count:1,cols:1,rows:1})).scores[0].score,81);
 await assert.rejects(hunt.rank({sheet:'data:image/jpeg;base64,Y',goal:'wood',count:1,cols:1,rows:1}),/base64/);
 await assert.rejects(hunt.rank({sheet,goal:'a'.repeat(301),count:1,cols:1,rows:1}),/1–300/);
 const unsupported=createAiHunt({settings:async()=>({enabled:true}),complete:async()=>{throw Error('当前模型不支持图片输入');}});
 assert.equal((await unsupported.rank({sheet,goal:'wood',count:1,cols:1,rows:1})).status,'unsupported');
});
