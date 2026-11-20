import test from 'node:test';
import assert from 'node:assert/strict';
import {createSearchTranslator} from '../server/ai-search.mjs';
import {createSearchTranslation,bindLocalSearch} from '../src/library/search-translation.js';
import {filterLocalAssets} from '../src/library/local-filters.js';
import {createDiscoveryFeed} from '../src/library/discovery-feed.js';

test('Chinese queries translate once across simultaneous feeds and reuse bounded cache',async()=>{
 let calls=0;
 const translator=createSearchTranslator({settings:async()=>({enabled:true}),complete:async messages=>{calls++;assert.equal(messages[1].content,'木椅');return {text:'wooden chair'};}});
 const results=await Promise.all([translator.translate('木椅'),translator.translate('木椅')]);
 assert.equal(results[0].english,'wooden chair');assert.equal(results[1].english,'wooden chair');
 await translator.translate('木椅');assert.equal(calls,1);
 translator.clear();await translator.translate('木椅');assert.equal(calls,2);
 await translator.translate('chair');await translator.translate('https://example.com/木椅');assert.equal(calls,2);
});

test('disabled, failing and malformed AI responses preserve the original search',async()=>{
 for(const text of ['', '木椅', 'some\nexplanation', '{"q":"chair"}']){
  const translator=createSearchTranslator({settings:async()=>({enabled:true}),complete:async()=>({text})});
  const result=await translator.translate('木椅');assert.equal(result.translated,false);assert.equal(result.query,'木椅');
 }
 const disabled=createSearchTranslator({settings:async()=>({enabled:false}),complete:()=>{throw Error('must not call');}});
 assert.match((await disabled.translate('木椅')).reason,/未启用/);
 await assert.rejects(disabled.translate('x'.repeat(201)));
});

test('translateSearch answers English and expansions from a single completion',async()=>{
 let calls=0;
 const translator=createSearchTranslator({settings:async()=>({enabled:true}),complete:async()=>{calls++;return {text:'ENGLISH: wooden chair\nALSO: stool, bench seat, NONE'};}});
 const result=await translator.translateSearch('木椅');
 assert.equal(result.english,'wooden chair');assert.equal(result.translated,true);
 assert.deepEqual(result.expansions,['stool','bench seat']);
 assert.equal(calls,1,'翻译与扩词只允许一次 LLM 调用');
 await translator.translateSearch('木椅');assert.equal(calls,1,'命中缓存不再调用');
});

test('translateSearch falls back to plain text when the model ignores the format',async()=>{
 const translator=createSearchTranslator({settings:async()=>({enabled:true}),complete:async()=>({text:'wooden chair\nsome explanation'})});
 const result=await translator.translateSearch('木椅');
 assert.equal(result.english,'wooden chair');assert.deepEqual(result.expansions,[]);
 const broken=createSearchTranslator({settings:async()=>({enabled:true}),complete:async()=>({text:'{"q":"chair"}'})});
 assert.equal((await broken.translateSearch('木椅')).translated,false);
});

test('client merges simultaneous requests and falls back when server is unavailable',async()=>{
 let calls=0;
 const translate=createSearchTranslation({fetchImpl:async()=>{calls++;return Response.json({translated:true,english:'wooden chair'});}});
 await Promise.all([translate('木椅'),translate('木椅')]);assert.equal(calls,1);
 await translate('chair');assert.equal(calls,1);
 const failed=createSearchTranslation({fetchImpl:async()=>{throw Error();}});
 assert.equal((await failed('木椅')).translated,false);
});

test('authentication failures show an actionable fallback without caching failure',async()=>{
 let calls=0;
 const translator=createSearchTranslator({settings:async()=>({enabled:true}),complete:async()=>{calls++;if(calls===1)throw Error('AI 接口返回 HTTP 401');return {text:'wooden chair'};}});
 assert.match((await translator.translate('木椅')).reason,/检查密钥/);
 assert.equal((await translator.translate('木椅')).english,'wooden chair');
});

test('local bilingual search preserves Chinese matches and combines English tokens across fields',()=>{
 const models=[{uid:'cn',name:'木椅'},{uid:'en',name:'Chair 01',tags:['wooden']},{uid:'no',name:'Metal table'}];
 assert.deepEqual(filterLocalAssets(models,{search:'木椅',english:'wooden chair'},[]).map(m=>m.uid),['cn','en']);
 assert.equal(filterLocalAssets(models,{search:'木椅'},[]).length,1);
});

function discovery(){
 const state={feeds:{search:{token:0,rows:[],pending:[],visited:new Set(),pages:0,warnings:[]}},selected:new Set(),options:{scanLimit:24},pageSize:24,history:[]};
 const ctx={state,$:()=>({value:'木椅'}),toast:()=>{},persist:()=>{},renderGrid:()=>{},mergeModels:(_,rows)=>rows,describeArt:()=>'',activeModes:()=>['search'],showsFeed:()=>true,searchHistoryUI:()=>null,readRequest:()=>({q:'木椅'}),clearSearchTimer:()=>{},markQueryActive:()=>{}};
 return {state,feed:createDiscoveryFeed(ctx)};
}

test('discovery searches Chinese and English independently while preserving request and history',async t=>{
 const sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const body=JSON.parse(options.body);sent.push({url,body});
  return Response.json(url==='/api/ai/translate'?{query:'木椅',translated:true,english:'wooden chair'}:{models:[]});
 });
 const {state,feed}=discovery();
 await feed.requestFeed('search',{q:'木椅',category:'furniture'},{record:true});
 assert.deepEqual(sent.slice(1).map(item=>item.body.q),['木椅','wooden chair']);assert.ok(sent.slice(1).every(item=>item.body.category==='furniture'));
 assert.equal(state.feeds.search.request.q,'木椅');assert.equal(state.history[0].params.q,'木椅');
});

test('a superseded translation cannot launch a stale platform search',async t=>{
 let release;const queries=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  const body=JSON.parse(options.body);
  if(url==='/api/ai/translate'){
   if(body.query==='旧')await new Promise(resolve=>{release=resolve;});
   return Response.json({query:body.query,translated:true,english:body.query==='旧'?'old':'new'});
  }
  queries.push(body.q);return Response.json({models:[]});
 });
 const {feed}=discovery();const old=feed.requestFeed('search',{q:'旧'});
 await feed.requestFeed('search',{q:'新'});release();await old;
 assert.deepEqual(queries,['新','new']);
});

test('clearing local search prevents a late parse from changing results',async()=>{
 const nodes={'#model-search':{value:'木椅'},'#local-translation':{}};
 const state={selected:new Set(),search:''};let release;
 const local=bindLocalSearch({$:id=>nodes[id],state,renderGrid:()=>{},delay:0,parse:()=>new Promise(resolve=>{release=resolve;})});
 local.search();
 await new Promise(resolve=>setTimeout(resolve,5));local.reset();state.search='';
 release({search:'wooden chair',english:['wooden chair'],kind:'',parsed:true});await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(state.searchEnglish,'');assert.equal(nodes['#local-translation'].hidden,true);
});

test('shared search input filters locally only in library mode and ignores late results after switching away',async()=>{
 const nodes={'#asset-query':{value:'木椅'},'#local-translation':{},'#local-kind':{value:''}};
 const state={selected:new Set(),search:''};let library=false,release,calls=0;
 const local=bindLocalSearch({$:id=>nodes[id],state,renderGrid:()=>{},inputSelector:'#asset-query',enabled:()=>library,delay:0,parse:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
 nodes['#asset-query'].oninput({target:nodes['#asset-query']});
 assert.equal(state.search,'');assert.equal(calls,0);
 library=true;
 nodes['#asset-query'].oninput({target:nodes['#asset-query']});
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(state.search,'');assert.equal(calls,0);
 local.search();assert.equal(state.search,'木椅');
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,1);
 library=false;release({search:'chair',english:['wooden chair'],kind:'models'});
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(state.search,'木椅');assert.equal(state.searchEnglish,'');assert.equal(nodes['#local-kind'].value,'');
 local.reset();
});
