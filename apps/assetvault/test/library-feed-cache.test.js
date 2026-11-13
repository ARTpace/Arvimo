import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoveryFeed} from '../src/library/discovery-feed.js';
import {artSearchParams} from '../server/artstation-search.mjs';

test('mode switches reuse results by filters, preserve pagination, and refresh after idle',async t=>{
 let now=1000,calls=0;
 t.mock.method(Date,'now',()=>now);
 t.mock.method(globalThis,'fetch',async()=>Response.json({models:[{uid:String(++calls)}],next:'next',pending:[]}));
 const state={selected:new Set(),options:{scanLimit:100},feeds:{art:{rows:[],request:null,pending:[],visited:new Set(),token:0,pages:0}}};
 const feed=createDiscoveryFeed({state,$:()=>({value:''}),persist(){},renderGrid(){},mergeModels:(a,b)=>[...a,...b],describeArt:()=>'',showsFeed:()=>true});
 const model={q:'',assetType:'marmoset'},image={q:'',assetType:''};
 await feed.requestFeed('art',model);
 await feed.requestFeed('art',model,{more:true});
 assert.equal(calls,2);
 await feed.requestFeed('art',image,{reuse:true});
 assert.equal(calls,3);
 await feed.requestFeed('art',{assetType:'marmoset',q:''},{reuse:true});
 assert.equal(calls,3);
 assert.equal(state.feeds.art.pages,2);
 assert.equal(state.feeds.art.rows.length,2);
 now+=9*60*1000;
 await feed.requestFeed('art',model,{reuse:true});
 assert.equal(calls,3);
 now+=11*60*1000;
 await feed.requestFeed('art',model,{reuse:true});
 assert.equal(calls,4);
 assert.equal(state.feeds.art.pages,1);
 await feed.requestFeed('art',model);
 assert.equal(calls,5,'explicit search refreshes immediately');
});

test('image discovery defaults to latest curated projects across all asset types',()=>{
 const params=artSearchParams({q:'',assetType:'',sort:'relevance',picked:false});
 assert.equal(params.sort,'newest');
 assert.equal(params.picked,true);
 assert.equal(params.assetType,'');
});

test('Chinese searches query original, translation and synonyms independently with the same filters',async t=>{
 const queries=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='/api/ai/translate')return Response.json({query:'木板',english:'wood board',translated:true,expansions:['wooden plank','timber board','wood panel']});
  const request=JSON.parse(options.body);queries.push(request);
  return Response.json({models:request.q==='wooden plank'?[{uid:'plank'}]:[],next:null});
 });
 const state={selected:new Set(),options:{scanLimit:100},feeds:{art:{rows:[],request:null,pending:[],visited:new Set(),token:0,pages:0}}};
 const feed=createDiscoveryFeed({state,$:()=>({value:''}),persist(){},renderGrid(){},mergeModels:(a,b)=>[...a,...b],describeArt:()=>'',showsFeed:()=>true});
 await feed.requestFeed('art',{q:'木板',assetType:'marmoset',category:'12'});
 assert.deepEqual(queries.map(q=>q.q),['木板','wood board','wooden plank','timber board','wood panel']);
 assert.ok(queries.every(q=>q.assetType==='marmoset'&&q.category==='12'));
 assert.equal(state.feeds.art.request.q,'木板');
 assert.deepEqual(state.feeds.art.rows,[{uid:'plank'}]);
});
