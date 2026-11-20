import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCollectRules} from '../server/collect-rules.mjs';
import {createCollectRunner} from '../server/collect-runner.mjs';
import {createCollectApi} from '../server/collect-api.mjs';
import {executeHunt,contactSheet,setupAiAssetHunt} from '../src/library/ai-asset-hunt.js';
import {createBoardCollect} from '../src/library/board-collect.js';
import {parseHTML} from 'linkedom';
import {createPersistentStorage} from '../src/library/persistent-storage.js';

const uid='a'.repeat(32);
function dom(){
 const {document,window}=parseHTML('<html><body><div><button id="theme-breakdown-btn">拆词</button></div><input id="asset-query" value="风格化木头，不要写实"></body></html>');
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||'';},set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===value);}});
 window.HTMLElement.prototype.show=function(){this.open=true;};window.HTMLElement.prototype.close=function(){this.open=false;};
 return document;
}

test('待合并保存失败不 ack，并发调用共用一次合并；重试成功后才 ack',async t=>{
 const document=dom();let persisted=false,reads=0,acks=0,fail=true;
 const originalEvent=globalThis.CustomEvent;globalThis.CustomEvent=document.defaultView.CustomEvent;t.after(()=>{globalThis.CustomEvent=originalEvent;});
 const collect=createBoardCollect({document,esc:String,icon:()=>'',toast(){},store:{},state:{models:[]},mergeModels:(_,rows)=>rows,persistNow:()=>{persisted=true;return true;},confirmSave:async()=>{assert.ok(persisted);if(fail)throw Error('磁盘写入失败');},api:{pending:async()=>{reads++;return {models:[{uid}]};},ack:async()=>{acks++;}}});
 const results=await Promise.allSettled([collect.syncPending({strict:true,quiet:true}),collect.syncPending({strict:true,quiet:true})]);
 assert.ok(results.every(r=>r.status==='rejected'));assert.equal(reads,1);assert.equal(acks,0);
 fail=false;assert.equal(await collect.syncPending({strict:true,quiet:true}),1);assert.equal(acks,1);
});

test('已有每日规则编辑保留来源、扩展词、类型过滤与预算',async()=>{
 const document=dom(),rule={id:'r-keep',name:'wood',boardId:'c-1',query:'wood',scope:'local',queries:['plank'],maxCalls:3,platforms:[],frequency:'daily',hour:8,enabled:true,limit:20,filters:{kinds:['textures']}};
 let resolveSaved;const saved=new Promise(resolve=>resolveSaved=resolve);
 const collect=createBoardCollect({document,esc:String,icon:()=>'',toast(){},store:{activeId:'c-1',refresh:async()=>{},flat:()=>[{id:'c-1',name:'wood',depth:0}]},state:{models:[]},mergeModels:(_,rows)=>rows,persistNow:()=>true,api:{rules:async()=>({rules:[rule]}),collectStatus:async()=>({platforms:[]}),saveRule:async value=>resolveSaved(value)}});
 await collect.load();collect.dialog.querySelector('[data-act="edit"]').click();
 assert.equal(collect.dialog.querySelector('.bd-scope').value,'local');assert.equal(collect.dialog.querySelector('.bd-platforms').parentElement.hidden,true);
 collect.dialog.querySelector('[data-act="save"]').click();const result=await saved;
 assert.equal(result.scope,'local');assert.deepEqual(result.queries,['plank']);assert.equal(result.maxCalls,3);assert.deepEqual(result.filters.kinds,['textures']);assert.equal(result.frequency,'daily');assert.equal(result.hour,8);
});

test('找资产入口保留拆词，确认后保存记录并入板，不请求下载',async t=>{
 const document=dom(),calls=[],savedRules=[];
 const originalFetch=globalThis.fetch,originalStorage=globalThis.sessionStorage;
 globalThis.sessionStorage={getItem:()=>null,setItem(){}};
 globalThis.fetch=async(url,options)=>{calls.push(url);assert.equal(JSON.parse(options.body).prompt,'风格化木头，不要写实');return {ok:true,json:async()=>({boardName:'木头',kind:'textures',rule:{query:'stylized wood',platforms:['freestylized'],limit:24}})};};
 t.after(()=>{globalThis.fetch=originalFetch;if(originalStorage===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=originalStorage;});
 const api={collectStatus:async()=>({platforms:[{id:'freestylized',label:'FreeStylized',searchable:true},...Array.from({length:12},(_,i)=>({id:`extra-${i}`,label:`测试平台 ${i}`,searchable:true}))]}),saveBoard:async()=>calls.push('board'),saveRule:async rule=>{if(rule.filters)assert.deepEqual(rule.filters.kinds,['textures']);savedRules.push(rule);calls.push('rule');},runRule:async()=>({run:{status:'completed',found:1,added:1,addedUids:[uid],candidates:[{uid,name:'wood'}]}})};
 const ui=setupAiAssetHunt({doc:document,state:{route:'library'},esc:String,notify(){},hub:{api,store:{list:()=>[],refresh:async()=>{},byId:()=>null},collect:{syncPending:async opts=>{assert.equal(opts.strict,true);calls.push('sync');}},openBoard(){calls.push('open');}}});
 await ui.button.onclick();assert.ok(document.getElementById('theme-breakdown-btn'));assert.equal(ui.panel.open,true);
 for(const input of ui.panel.querySelectorAll('[data-platform]')){input.checked=true;input.setAttribute('checked','');}
 await ui.panel.querySelector('[data-start]').onclick();assert.match(ui.panel.querySelector('[data-status]').textContent,/最多选择 12/);assert.equal(savedRules.length,0);
 for(const input of ui.panel.querySelectorAll('[data-platform]')){input.checked=false;input.removeAttribute('checked');}
 // linkedom does not reflect the checked attribute onto the checked property.
 ui.panel.querySelector('[data-platform]').checked=true;ui.panel.querySelector('[data-platform]').setAttribute('checked','');
 await ui.panel.querySelector('[data-start]').onclick();
 assert.deepEqual(calls,['/api/ai/hunt-plan','board','rule','sync']);assert.match(ui.panel.querySelector('[data-status]').textContent,/已入库 1 · 已入板 1/);
 ui.panel.querySelector('[data-scope]').value='local';ui.panel.querySelector('[data-scope]').onchange();
 assert.equal(ui.panel.querySelector('.hunt-platforms').hidden,true);
 ui.panel.querySelector('[data-daily]').checked=true;ui.panel.querySelector('[data-hour]').value='8';
 ui.panel.querySelector('[data-queries]').value='木头; wood plank';
 await ui.panel.querySelector('[data-start]').onclick();
 assert.equal(savedRules[0].id,savedRules[1].id);assert.equal(savedRules[1].scope,'local');assert.equal(savedRules[1].frequency,'daily');assert.equal(savedRules[1].hour,8);assert.deepEqual(savedRules[1].queries,['木头','wood plank']);assert.deepEqual(savedRules[1].platforms,[]);
 assert.equal(calls.filter(call=>call==='board').length,1);
 await ui.panel.querySelector('[data-schedule]').onclick();assert.equal(savedRules[2].frequency,'manual');assert.equal(ui.panel.querySelector('[data-schedule]'),null);assert.equal(ui.panel.querySelector('[data-daily]').checked,false);
 const clear=document.createElement('button');clear.id='search-clear';clear.onclick=()=>calls.push('clear-query');document.body.append(clear);
 ui.panel.querySelector('[data-open]').onclick();assert.deepEqual(calls.slice(-2),['clear-query','open']);
});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-hunt-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'rules.json'),rules=createCollectRules({file});
 const rule=await rules.save({id:'r-hunt',boardId:'c-1',name:'wood',platforms:['sketchfab'],query:'wood',dedupe:'board',limit:24,filters:{kinds:['textures']}});
 const members=new Map([['c-1',new Set()],['c-2',new Set()]]);let searches=0,queued=[];
 const pending={status:async()=>({count:queued.length}),list:async()=>queued,add:async rows=>{queued.push(...rows);return {added:rows.length};}};
 const runner=createCollectRunner({rules,pending,storage:{withDb:async fn=>fn({})},guard:{acquire:async()=>({ok:true}),noteSuccess(){},noteFailure(){return {}; }},
  search:async()=>{searches++;return {items:[{uid,key:'sketchfab:a',name:'wood',platform:'sketchfab',assetType:'textures',thumbnail:'https://example.com/thumb.jpg'}, {uid:'b'.repeat(32),key:'sketchfab:b',name:'model',platform:'sketchfab',assetType:'models'}]};},
  boardUids:(_,id)=>new Set(members.get(id)),addToBoard:(_,id,uids)=>{for(const key of uids)members.get(id).add(key);return {count:members.get(id).size};}});
 const api=createCollectApi({rules,runner,pending});
 const call=async(body,pathname='/api/collect/run')=>{
  let output,status;const req={method:'POST',headers:{'x-sfx-local':'1'},async *[Symbol.asyncIterator](){yield JSON.stringify(body);}};
  const res={writeHead(code){status=code;},end(text){output=JSON.parse(text);}};
  await api.handle(req,res,new URL(pathname,'http://localhost'));return {status,...output};
 };
 return {dir,file,rules,rule,runner,call,members,searches:()=>searches};
}

test('单次请求幂等、运行记录就地更新，重启后结果与候选仍可恢复',async t=>{
 const x=await fixture(t);const body={id:x.rule.id,requestId:'request-1234'};
 const first=await x.call(body);assert.equal(first.status,200);assert.deepEqual(first.run.addedUids,[uid]);assert.equal(first.run.candidates.length,1);
 const second=await x.call(body);assert.equal(x.searches(),1);assert.deepEqual(second.run.addedUids,[uid]);
 const disk=createCollectRules({file:x.file});const runs=(await disk.snapshot()).runs;
 assert.equal(runs.length,1);assert.equal(runs[0].status,'completed');assert.equal(runs[0].candidates[0].uid,uid);
 await x.rules.save({...x.rule,query:'stone'});assert.equal((await x.call(body)).status,409);assert.equal(x.searches(),1);
});

test('按目标画板去重，已见资产可添加另一画板且不混入模型',async t=>{
 const x=await fixture(t);const first=await x.runner.run(x.rule.id);assert.equal(first.added,1);
 const same=await x.runner.run(x.rule.id);assert.equal(same.added,0);
 const other=await x.rules.save({...x.rule,id:'r-other',boardId:'c-2'});
 assert.equal((await x.runner.run(other.id)).added,1);assert.ok(x.members.get('c-2').has(uid));
});

test('恢复创建时复用同一身份；保存确认失败不把前端任务标成完成',async()=>{
 const calls=[],task={requestId:'request-1234',boardId:'c-hunt-1234',ruleId:'r-hunt-1234',phase:'creating',plan:{boardName:'wood',rule:{query:'wood',platforms:['sketchfab'],limit:24}}};
 let fail=true;
 const api={saveBoard:async b=>{calls.push(b.id);if(fail){fail=false;throw Error('lost response');}},saveRule:async()=>{},runRule:async()=>({run:{status:'completed',addedUids:[uid]}})};
 await assert.rejects(executeHunt(task,{api,sync:async()=>{}}),/lost response/);
 await assert.rejects(executeHunt(task,{api,sync:async()=>{throw Error('保存失败');}}),/保存失败/);
 assert.deepEqual(calls,['c-hunt-1234','c-hunt-1234']);assert.equal(task.phase,'syncing');
 await executeHunt(task,{api,sync:async()=>{}});assert.equal(task.phase,'done');
});

test('严格保存确认会报告异步失败，后续无关设置保存不能掩盖资产保存失败',async()=>{
 let fail=true;
 const blob=JSON.stringify({version:2,models:[],favorites:[],tasks:[],options:{}});
 const storage=await createPersistentStorage({getItem:()=>null,setItem(){}},async(url,opts={})=>{
  if(!opts.method)return {ok:true,json:async()=>({values:{'sfx-library-v2':blob}})};
  return {ok:!fail,status:fail?500:200,json:async()=>({error:'写入失败'})};
 });
 storage.setItem('sfx-library-v2',JSON.stringify({...JSON.parse(blob),models:[{uid,name:'wood'}]}));
 await assert.rejects(storage.flush({strict:true}),/写入失败/);
 fail=false;storage.setItem('sfx-library-ui','{}');await assert.rejects(storage.flush({strict:true}),/写入失败/);
 storage.setItem('sfx-library-v2',storage.getItem('sfx-library-v2'));await storage.flush({strict:true});
});

test('拼图保持失败项编号，用完整比例绘图并释放位图',async()=>{
 const draws=[],labels=[];let closed=0;
 const ctx={fillRect(){},fillText:(text)=>labels.push(text),drawImage:(_,x,y,w,h)=>draws.push({w,h})};
 const canvas={getContext:()=>ctx,toDataURL:()=> 'data:image/jpeg;base64,YWJj'};
 const result=await contactSheet([{thumbnail:'/ok'},{thumbnail:''},{thumbnail:'/ok2'}],{document:{createElement:()=>canvas},fetchImpl:async()=>({ok:true,blob:async()=>({})}),bitmap:async()=>({width:800,height:400,close(){closed++;}})});
 assert.equal(canvas.width,2048);assert.deepEqual([...result.valid].sort(),[1,3]);assert.equal(draws[0].w/draws[0].h,2);assert.equal(closed,2);
 for(const number of ['1','2','3'])assert.ok(labels.includes(number));assert.ok(!labels.includes('4'));
});
