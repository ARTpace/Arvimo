import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdvancedQuery} from '../src/library/advanced-query.js';
import {createBoardRule} from '../src/library/board-rule.js';

class Node {
 constructor(){this.value='';this.checked=false;this.listeners={};this.nodes=new Map();}
 addEventListener(type,fn){this.listeners[type]=fn;}
 querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,new Node());return this.nodes.get(key);}
 setAttribute(){}
 showModal(){}
 close(){}
}
function harness(t){
 const previous=globalThis.document;globalThis.document={createElement:()=>new Node(),body:{appendChild(){}}};
 t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
 const calls=[],state={models:[]},warnings=[];let pending;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const body=options.body?JSON.parse(options.body):{};calls.push({url,body});
  if(url.endsWith('/collections'))return {ok:true,json:async()=>({collections:[{id:'s',name:'智能',smart:{q:'saved',sort:'random',sortOrder:'desc',seed:'seed'}},{id:'m',name:'手动'}]})};
  if(pending)return pending;
  return {ok:true,json:async()=>({uids:[body.offset?'second':'first'],items:[{uid:body.offset?'second':'first'}],total:2,engine:'sqlite'})};
 });
 const controls=createAdvancedQuery({$:()=>null,state,renderGrid(){},toast:e=>warnings.push(e),resetPaging(){}}).controls;
 return {controls,state,calls,warnings,setPending:p=>{pending=p;}};
}

test('智能板打开、附加筛选、分页与刷新始终resolve；切全部清scope，旧响应不回流',async t=>{
 const h=harness(t);await h.controls.applyCollection('s');
 let call=h.calls.at(-1);assert.ok(call.url.endsWith('/smart-collections/resolve'));assert.equal(call.body.id,'s');assert.equal(call.body.sortOrder,'desc');assert.equal(call.body.seed,'seed');
 h.controls.q.value='user';h.controls.setExtraFilters({tags:['warm']});await h.controls.apply();
 call=h.calls.at(-1);assert.equal(call.body.q,'user');assert.deepEqual(call.body.filters.tags,['warm']);assert.equal(call.body.id,'s');
 await h.state.onRemoteMore();assert.equal(h.calls.at(-1).body.id,'s');assert.equal(h.calls.at(-1).body.offset,1);
 await h.state.onRemoteRefresh();assert.equal(h.calls.at(-1).body.id,'s');
 let release;h.setPending(new Promise(resolve=>{release=resolve;}));const old=h.controls.apply();
 h.controls.clear();assert.equal(h.controls.getActiveBoard(),null);assert.equal(h.state.queryUids,null);
 release({ok:true,json:async()=>({uids:['stale'],items:[{uid:'stale'}],total:1})});await old;
 assert.equal(h.state.queryUids,null);assert.ok(!h.state.models.some(row=>row.uid==='stale'));
 h.setPending(null);await h.controls.applyCollection('m');assert.ok(h.calls.at(-1).url.endsWith('/assets'));assert.equal(h.calls.at(-1).body.filters.collection,'m');
 await h.controls.clearCollection();assert.equal(h.controls.getActiveBoard(),null);assert.equal(h.calls.at(-1).body.id,undefined);
});

test('当前智能板重复点击退出，无未定义clearCollection；规则保存方向与种子',async t=>{
 const h=harness(t);await h.controls.applyCollection('s');
 const before=h.calls.filter(row=>row.url.endsWith('/collections')).length;
 await h.controls.applyCollection('s',{force:true,refresh:true});assert.equal(h.controls.getActiveBoard().id,'s');assert.equal(h.calls.filter(row=>row.url.endsWith('/collections')).length,before+1);
 await h.controls.applyCollection('s');assert.equal(h.controls.getActiveBoard(),null);
 // 规则弹窗的真实DOM保存/排序契约由library-board-rule-ui专项覆盖；
 // 此处只覆盖高级检索scope与重复点击退出，避免使用不支持共享面板的旧假DOM。
});
