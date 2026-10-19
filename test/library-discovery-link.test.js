// Pasting a link must resolve into cards, never into download tasks.
//
// The bug this guards: an ArtStation artwork link used to be resolved and handed straight to
// `enqueueImmediate`, so a single paste silently queued a download. The rule now is one link ->
// one card (or one page of cards) in the link result feed, and the queue is only ever touched
// when the user clicks a card's download button.
//
// discovery-feed.js is where that decision lives, and it talks to the rest of the app only through
// the ctx object, so a plain stub is enough to drive it - no DOM, no network, no real backend.

import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoveryFeed} from '../src/library/discovery-feed.js';

const newFeed=()=>({rows:[],request:null,next:null,pending:[],pages:0,busy:false,token:0,controller:null,status:'',error:false,aborted:false,warnings:[],visited:new Set()});
const UID='a'.repeat(32);

/** Minimal ctx: records what the feed asked the rest of the app to do. */
function harness({resolve=null,scan=null}={}){
 const calls=[];
 const state={route:'discover',platform:'all',source:'search',selected:new Set(),history:[],feeds:{search:newFeed(),art:newFeed(),web:newFeed(),polyhaven:newFeed(),ambientcg:newFeed()}};
 const feed=createDiscoveryFeed({
  $:()=>({value:''}),
  toast:m=>calls.push({type:'toast',message:m}),
  state,
  persist:()=>{},
  renderGrid:()=>{},
  mergeModels:(current,incoming)=>{const map=new Map(current.map(m=>[m.uid,m]));for(const m of incoming||[])map.set(m.uid,{...map.get(m.uid),...m});return [...map.values()];},
  describeArt:()=>'',
  activeModes:()=>['search'],
  showsFeed:mode=>mode==='web',
  searchHistoryUI:()=>({refresh(){},close(){}}),
  resolveArtworkLink:url=>{calls.push({type:'resolve',url});return resolve?resolve(url):Promise.resolve({uid:UID,platform:'artstation',name:'Robot',author:'studio'});},
  routeTo:name=>calls.push({type:'route',name}),
  readRequest:()=>({q:''}),
  clearSearchTimer:()=>{},
  feedError:({error})=>error||'failed',
 });
 // fetch 只服务网页解析那条路；这里记录它被问了什么，然后回一份空结果。
 globalThis.fetch=async(url,init)=>{
  calls.push({type:'scan',url,body:JSON.parse(init.body)});
  return {ok:true,json:async()=>scan||{models:[],next:null,pending:[],warnings:[]}};
 };
 return {calls,state,feed};
}

const ARTSTATION_URL='https://www.artstation.com/artwork/lEVE8J';
const SKETCHFAB_URL='https://sketchfab.com/3d-models/robot-abc';

test('a pasted ArtStation artwork link resolves into one card, not a download task',async()=>{
 const {calls,state,feed}=harness();
 await feed.submitLink(ARTSTATION_URL);
 assert.deepEqual(calls.filter(c=>c.type==='resolve').map(c=>c.url),[ARTSTATION_URL],'作品页应走识别通道');
 assert.equal(state.source,'link','解析结果接管结果区');
 assert.equal(state.feeds.web.rows.length,1,'识别出的作品要变成一张卡片');
 assert.equal(state.feeds.web.rows[0].uid,UID);
 assert.equal(calls.some(c=>c.type==='scan'),false,'单个作品页不必再扫一遍网页');
 // 关键断言：识别本身绝不能触发任何下载动作。ctx 里根本没有 enqueue 入口，
 // 一旦有人把入队塞回来，这里就会因为缺能力而在实现里被迫新增 ctx —— 断言同时盯住文案。
 assert.match(state.feeds.web.status,/未自动下载/);
});

test('a pasted Sketchfab page still resolves through the page scanner',async()=>{
 const {calls,state,feed}=harness();
 await feed.submitLink(SKETCHFAB_URL);
 assert.deepEqual(calls.filter(c=>c.type==='scan').map(c=>c.body.url),[SKETCHFAB_URL]);
 assert.equal(calls.some(c=>c.type==='resolve'),false,'Sketchfab 页面不走作品识别');
 assert.equal(state.source,'link');
});

test('a failed resolve reports the error in the status line instead of pretending',async()=>{
 const {state,feed}=harness({resolve:()=>Promise.reject(Error('这个作品里没有可嵌入的 Marmoset 场景'))});
 await feed.submitLink(ARTSTATION_URL);
 assert.equal(state.feeds.web.error,true);
 assert.match(state.feeds.web.status,/没有可嵌入的 Marmoset 场景/);
 assert.equal(state.feeds.web.rows.length,0,'识别失败不该留下假卡片');
});

test('a pasted link is remembered so 最近检索 can replay it',async()=>{
 const {state,feed}=harness();
 await feed.submitLink(ARTSTATION_URL);
 assert.deepEqual(state.history.map(h=>({kind:h.kind,url:h.url})),[{kind:'web',url:ARTSTATION_URL}]);
});

test('the link result flow leaves no pagination cursor, so no「解析下一页」button',async()=>{
 const {state,feed}=harness();
 await feed.submitLink(ARTSTATION_URL);
 assert.equal(state.feeds.web.next,null);
 assert.deepEqual(state.feeds.web.pending,[]);
});