import test from 'node:test';
import assert from 'node:assert/strict';
import {bindScrollPerformance,scrollIdleTask} from '../src/library/scroll-performance.js';

test('automatic feed paging coalesces scroll requests and rechecks current state after idle',()=>{
 const doc=new EventTarget();let scrolling=true,calls=0,route='discover';
 doc.hidden=false;doc.documentElement={classList:{contains:()=>scrolling}};
 const request=scrollIdleTask(()=>{if(route==='discover')calls++;},doc);
 for(let i=0;i<100;i++)request();
 assert.equal(calls,0);
 scrolling=false;doc.dispatchEvent(new Event('assetvault:scroll-idle'));
 assert.equal(calls,1);
 doc.dispatchEvent(new Event('assetvault:scroll-idle'));assert.equal(calls,1);
 scrolling=true;request();route='library';scrolling=false;
 doc.dispatchEvent(new Event('assetvault:scroll-idle'));assert.equal(calls,1);
 route='discover';request();assert.equal(calls,2,'idle requests run immediately');
 scrolling=true;request();doc.hidden=true;scrolling=false;
 doc.dispatchEvent(new Event('assetvault:scroll-idle'));
 doc.hidden=false;doc.dispatchEvent(new Event('assetvault:scroll-idle'));assert.equal(calls,2);
});

test('page and panel scrolls share an idle timer without repeated style changes',()=>{
 const listeners=new Map(),timers=new Map();
 let next=0,adds=0,removes=0;
 const doc={hidden:false,documentElement:{classList:{add(){adds++;},remove(){removes++;}}},
  addEventListener(name,fn,options){listeners.set(name,{fn,options});},
  removeEventListener(name){listeners.delete(name);}};
 const win={setTimeout(fn){timers.set(++next,fn);return next;},clearTimeout(id){timers.delete(id);}};
 const dispose=bindScrollPerformance(doc,win);
 const scroll=listeners.get('scroll');
 assert.deepEqual(scroll.options,{capture:true,passive:true},'nested scrolling stays native and nonblocking');
 for(let i=0;i<100;i++)scroll.fn();
 assert.equal(adds,1,'continuous scrolling changes styles only on entry');
 assert.equal(removes,0);
 assert.equal(timers.size,1,'only the latest idle deadline survives');
 [...timers.values()][0]();
 assert.equal(removes,1,'decoration returns after scrolling stops');
 assert.equal(timers.size,0);
 scroll.fn();
 assert.equal(adds,2);
 doc.hidden=true;listeners.get('visibilitychange').fn();
 assert.equal(removes,2,'hiding the page clears scrolling state');
 assert.equal(timers.size,0);
 dispose();
 assert.equal(listeners.size,0);
 assert.equal(removes,2,'cleanup does not write unchanged styles');
});
