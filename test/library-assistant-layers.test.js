import test from 'node:test';
import assert from 'node:assert/strict';
import {createMascotAssistant} from '../src/library/mascot-assistant.js';

class Node{
 constructor(){this.children=[];this.classList={toggle(){}};}
 setAttribute(name,value){this[name]=value;}
 replaceChildren(){this.children=[];}
 append(child){this.children.push(child);}
}
function fixture(t){
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>new Node()}});
 const cat=new Node(),bubble=new Node(),timers=new Map();let now=0,next=0;
 const assistant=createMascotAssistant({panel:{querySelector:selector=>selector==='#search-mascot'?cat:bubble},random:()=>0,timing:{now:()=>now,setTimer:(fn,delay)=>{timers.set(++next,{fn,at:now+delay});return next;},clearTimer:id=>timers.delete(id)}});
 t.after(()=>{assistant.dispose();if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;});
 return {assistant,cat,bubble,timers,advance(ms){now+=ms;for(let i=0;i<20;i++){const due=[...timers].filter(([,timer])=>timer.at<=now);if(!due.length)break;for(const [id,timer] of due){timers.delete(id);timer.fn();}}}};
}
test('idle variations stay subtle, yield to interactions and skip busy channels',t=>{
 const s=fixture(t);
 s.advance(14000);
 assert.equal(s.cat['data-motion'],'tilt');assert.equal(s.cat['data-effect'],'none');assert.equal(s.bubble.children.length,0);
 s.assistant.notify({type:'motion',value:'still',duration:0});
 assert.equal(s.cat['data-expression'],'idle');assert.equal(s.cat['data-motion'],'still');
 s.advance(14000);assert.equal(s.cat['data-motion'],'still');
 s.assistant.notify({type:'reset-channel',channel:'motion'});
 s.advance(14000);assert.equal(s.cat['data-expression'],'wink');assert.equal(s.cat['data-motion'],'idle');
 s.advance(2801);assert.equal(s.cat['data-expression'],'idle');
 s.assistant.dispose();assert.equal(s.timers.size,0);
});

test('bubble, expression and effect have independent lifetimes; an effect alone never replaces the expression',t=>{
 const s=fixture(t),send=s.assistant.notify;
 send({type:'expression',value:'focused',duration:0});
 send({type:'bubble',message:{id:'notice',text:'下载完成',duration:100}});
 send({type:'effect',value:'sparkles',duration:200});
 assert.equal(s.cat['data-expression'],'focused');assert.equal(s.cat['data-effect'],'sparkles');
 s.advance(101);assert.equal(s.bubble.children.length,0);assert.equal(s.cat['data-expression'],'focused');assert.equal(s.cat['data-effect'],'sparkles');
 s.advance(100);assert.equal(s.cat['data-effect'],'none');assert.equal(s.cat['data-expression'],'focused');
 send({type:'reset-channel',channel:'expression'});assert.equal(s.cat['data-expression'],'idle');
});
test('body motion can change, expire and reset while face, effect and bubble remain untouched',t=>{
 const s=fixture(t),send=s.assistant.notify;
 send({type:'expression',value:'love',duration:0});
 send({type:'effect',value:'hearts',duration:1000});
 send({type:'bubble',message:{text:'保持文字',duration:1000}});
 send({type:'motion',value:'nod',duration:100});
 assert.equal(s.cat['data-motion'],'nod');assert.equal(s.cat['data-expression'],'love');assert.equal(s.cat['data-effect'],'hearts');
 s.advance(101);assert.equal(s.cat['data-motion'],'idle');assert.equal(s.cat['data-expression'],'love');assert.equal(s.cat['data-effect'],'hearts');assert.equal(s.bubble.children[0].textContent,'保持文字');
 send({type:'motion',value:'tilt',duration:0});send({type:'expression',value:'cool',duration:0});
 assert.equal(s.cat['data-motion'],'tilt');
 send({type:'reset-channel',channel:'motion'});assert.equal(s.cat['data-motion'],'idle');assert.equal(s.cat['data-expression'],'cool');
 send({type:'message',message:{id:'timed-motion',bubble:false,motion:'peek',motionDuration:200,duration:100}});
 s.advance(101);assert.equal(s.cat['data-motion'],'peek');s.advance(100);assert.equal(s.cat['data-motion'],'idle');
 s.assistant.dispose();assert.equal(s.timers.size,0);
});

test('business bundles support distinct durations and bubble-free visual feedback',t=>{
 const s=fixture(t);
 s.assistant.notify({type:'message',message:{id:'task',text:'任务提示',expression:'happy',effect:'hearts',duration:100,expressionDuration:300,effectDuration:200}});
 s.advance(101);assert.equal(s.bubble.children.length,0);assert.equal(s.cat['data-expression'],'happy');assert.equal(s.cat['data-effect'],'hearts');
 s.advance(100);assert.equal(s.cat['data-effect'],'none');assert.equal(s.cat['data-expression'],'happy');
 s.advance(100);assert.equal(s.cat['data-expression'],'idle');
 s.assistant.notify({type:'message',message:{id:'silent',bubble:false,expression:'wink',effect:'music',duration:100}});
 assert.equal(s.bubble.children.length,0);assert.equal(s.cat['data-expression'],'wink');assert.equal(s.cat['data-effect'],'music');
});
test('greetings vary while visible; duplicate download snapshots keep their appearance',t=>{
 const s=fixture(t),send=s.assistant.notify;
 send({type:'greeting'});const first=s.cat['data-expression'];
 send({type:'greeting'});assert.notEqual(s.cat['data-expression'],first);
 send({type:'download',phase:'completed',count:1});const completed=[s.cat['data-expression'],s.cat['data-effect']];
 send({type:'download',phase:'completed',count:1});assert.deepEqual([s.cat['data-expression'],s.cat['data-effect']],completed);
 assert.equal(s.bubble.children[0].textContent,'1 项资产已下载完成');
 s.advance(4501);send({type:'download',phase:'completed',count:1});
 assert.notDeepEqual([s.cat['data-expression'],s.cat['data-effect']],completed);
 assert.equal(s.bubble.children[0].textContent,'1 项资产已下载完成');
});

test('priority and resets stay within their channel; closing or hiding bubbles leaves visual state intact',t=>{
 const s=fixture(t),send=s.assistant.notify;
 send({type:'download',phase:'failed',count:1});
 send({type:'expression',value:'happy',duration:1000,priority:10});assert.equal(s.cat['data-expression'],'worried');
 send({type:'effect',value:'flower',duration:1000,priority:50});assert.equal(s.cat['data-effect'],'flower');
 send({type:'bubble-visibility',visible:false});assert.equal(s.bubble.hidden,true);assert.equal(s.cat['data-expression'],'worried');
 s.assistant.dismiss('download:error');assert.equal(s.bubble.children.length,0);assert.equal(s.cat['data-expression'],'worried');
 send({type:'reset-channel',channel:'effect'});assert.equal(s.cat['data-effect'],'none');assert.equal(s.cat['data-expression'],'worried');
 assert.ok(s.assistant.inspect().some(item=>item.channel==='expression'&&item.current));
 send({type:'bubble-visibility',visible:true});assert.equal(s.bubble.hidden,false);
 s.assistant.dispose();assert.equal(s.timers.size,0);assert.equal(s.cat['data-expression'],'idle');
});
