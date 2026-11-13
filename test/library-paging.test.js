import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createLibraryPaging} from '../src/library/library-paging.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('资产库触底追加本地卡片；服务端分页防并发，取完停止',async t=>{
 const old={document:globalThis.document,IntersectionObserver:globalThis.IntersectionObserver};
 const {document}=parseHTML('<html><body><div id="grid"></div></body></html>');globalThis.document=document;
 let fire,observed=false;
 globalThis.IntersectionObserver=class{constructor(fn){fire=()=>fn([{isIntersecting:true}]);}observe(){observed=true;}disconnect(){observed=false;}};
 t.after(()=>Object.assign(globalThis,old));
 const state={route:'library'},rows=Array.from({length:130},(_,uid)=>({uid}));let paging,shown,calls=0,release;
 paging=createLibraryPaging({$:s=>document.querySelector(s),state,onMore:()=>{shown=paging.slice(rows);},onRemoteMore:async()=>{calls++;await new Promise(r=>release=r);state.remotePaging={loaded:120,total:120,hasMore:false};paging.slice(rows.slice(0,120));}});
 assert.equal(paging.slice(rows).length,60);assert.equal(observed,true);
 fire();await tick();assert.equal(shown.length,120);
 fire();await tick();assert.equal(shown.length,130);assert.equal(observed,false);
 state.remotePaging={loaded:60,total:120,hasMore:true};paging.slice(rows.slice(0,60));fire();fire();assert.equal(calls,1);release();await tick();assert.equal(observed,false);
 state.route='discover';paging.slice(rows);fire();await tick();assert.equal(calls,1);
});
