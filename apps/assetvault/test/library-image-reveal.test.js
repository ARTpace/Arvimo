import test from 'node:test';
import assert from 'node:assert/strict';
import {bindImageReveal} from '../src/library/image-reveal.js';

test('card covers reveal after loading; cached covers and failures never remain hidden',()=>{
 const previous=globalThis.MutationObserver;
 let mutate;globalThis.MutationObserver=class{constructor(fn){mutate=fn;}observe(){}};
 const image=complete=>{
  const values=new Set();
  return {nodeType:1,complete,naturalWidth:complete?200:0,matches:()=>true,querySelectorAll:()=>[],classList:{add:x=>values.add(x),remove:x=>values.delete(x),contains:x=>values.has(x),toggle:(x,on)=>on?values.add(x):values.delete(x)}};
 };
 const pending=image(false),cached=image(true),events={};
 const root={nodeType:1,matches:()=>false,querySelectorAll:selector=>selector==='iframe'?[]:[pending,cached]};
 const doc={documentElement:root,head:{append(){}},createElement:()=>({}),addEventListener:(name,fn)=>{events[name]=fn;}};
 try{
  bindImageReveal(doc);
  assert.equal(pending.classList.contains('av-cover-pending'),true);
  assert.equal(cached.classList.contains('av-cover-pending'),false);
  pending.complete=true;pending.naturalWidth=200;events.load({target:pending});
  assert.equal(pending.classList.contains('av-cover-pending'),false);
  assert.equal(pending.classList.contains('av-cover-reveal'),true);
  pending.complete=false;mutate([{type:'attributes',target:pending}]);
  assert.equal(pending.classList.contains('av-cover-pending'),true);
  events.error({target:pending});
  assert.equal(pending.classList.contains('av-cover-pending'),false);
 }finally{globalThis.MutationObserver=previous;}
});
