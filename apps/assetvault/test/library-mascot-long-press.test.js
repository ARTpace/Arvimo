import test from 'node:test';
import assert from 'node:assert/strict';
import {bindMascotLongPress} from '../src/library/mascot-long-press.js';

function fixture(enabled=true){
 const node=new EventTarget(),host=new EventTarget(),doc=new EventTarget(),timers=new Map();let opened=0,next=0;
 node.setAttribute=()=>{};node.removeAttribute=()=>{};
 const dispose=bindMascotLongPress(node,{enabled,host,doc,onOpen:()=>opened++,setTimer:(fn,delay)=>{assert.equal(delay,5000);timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});
 const fire=(target,type,props={})=>{const event=new Event(type,{cancelable:true});Object.assign(event,{button:0,isPrimary:true,pointerId:1,clientX:10,clientY:10,...props});target.dispatchEvent(event);return event;};
 return {node,host,doc,dispose,fire,get opened(){return opened;},get pending(){return timers.size;},advance(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}
test('desktop admin long press waits five seconds and consumes its normal click once',()=>{
 const s=fixture();s.fire(s.node,'pointerdown');assert.equal(s.opened,0);assert.equal(s.pending,1);
 s.advance();assert.equal(s.opened,1);s.fire(s.host,'pointerup');
 assert.equal(s.fire(s.node,'click',{detail:1}).defaultPrevented,true);
 assert.equal(s.fire(s.node,'click',{detail:1}).defaultPrevented,false);s.dispose();
});
test('release, leaving, dragging, cancellation, background and disposal cancel the gesture',()=>{
 const actions=[s=>s.fire(s.host,'pointerup'),s=>s.fire(s.node,'pointerleave'),s=>s.fire(s.node,'pointermove',{clientX:25}),s=>s.fire(s.node,'pointercancel'),s=>s.fire(s.host,'blur'),s=>s.fire(s.doc,'visibilitychange'),s=>s.dispose()];
 for(const action of actions){const s=fixture();s.fire(s.node,'pointerdown');action(s);s.advance();assert.equal(s.opened,0);s.dispose();}
});
test('ordinary click, right click and disabled web entry do not open; keyboard remains usable',()=>{
 const s=fixture();s.fire(s.node,'pointerdown');s.fire(s.host,'pointerup');assert.equal(s.fire(s.node,'click',{detail:1}).defaultPrevented,false);
 s.fire(s.node,'pointerdown',{button:2});s.advance();assert.equal(s.opened,0);
 s.fire(s.node,'pointerdown');s.advance();assert.equal(s.fire(s.node,'click',{detail:0}).defaultPrevented,false);s.dispose();
 const web=fixture(false);web.fire(web.node,'pointerdown');web.advance();assert.equal(web.opened,0);assert.equal(web.fire(web.node,'contextmenu').defaultPrevented,false);web.dispose();
});
