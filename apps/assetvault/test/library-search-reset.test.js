import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resetDiscoveryFeeds} from '../src/library/discovery-feed.js';

test('清空搜索使所有平台的结果、分页和在途请求同时失效',()=>{
 const controllers=[new AbortController(),new AbortController()];
 const feeds=Object.fromEntries(['search','art','web'].map((mode,i)=>[mode,{
  controller:controllers[i]||null,token:7,busy:true,rows:[{uid:mode}],
  request:{q:'tree'},next:'old-page',pending:['old-id'],pages:2,
  status:'old',error:true,aborted:true,warnings:['old'],translation:'tree',origin:'old',visited:new Set(['old'])
 }]));
 const state={feeds,source:'link',selected:new Set(['old']),models:[{uid:'saved'}],history:[{q:'tree'}]};
 resetDiscoveryFeeds(state);
 assert.ok(controllers.every(c=>c.signal.aborted));
 for(const f of Object.values(feeds)){
  assert.equal(f.token,8); // 旧响应的 token 不再匹配，不能覆盖清空后的状态。
  assert.equal(f.controller,null);assert.equal(f.busy,false);
  assert.deepEqual(f.rows,[]);assert.equal(f.request,null);assert.equal(f.next,null);
  assert.deepEqual(f.pending,[]);assert.equal(f.pages,0);assert.equal(f.visited.size,0);
  assert.equal(f.translation,'');assert.equal(f.status,'');assert.deepEqual(f.warnings,[]);
 }
 assert.equal(state.source,'search');assert.equal(state.selected.size,0);
 assert.deepEqual(state.models,[{uid:'saved'}]);assert.deepEqual(state.history,[{q:'tree'}]);
});

test('重新启动只恢复发现页偏好，不恢复旧搜索现场',()=>{
 const app=readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
 assert.doesNotMatch(app,/Object\.entries\(savedDiscovery\.feeds\)/);
 assert.doesNotMatch(app,/set\('#asset-query',filters\.query\)/);
 assert.match(app,/set\('#asset-query',''\)/);
 const persist=app.slice(app.indexOf('const persistNow='),app.indexOf('const persist='));
 assert.doesNotMatch(persist,/feeds:|source:/);
});
