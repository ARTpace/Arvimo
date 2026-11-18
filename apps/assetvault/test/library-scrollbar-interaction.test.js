import test from 'node:test';
import assert from 'node:assert/strict';
import {bindScrollbarInteraction} from '../src/library/scrollbar-interaction.js';

test('thumb follows outside gutter until release; proximity changes no geometry',()=>{
 const events=new Map(),frames=new Map(),classes=new Set();let id=0;
 const listen={addEventListener(name,fn){events.set(name,fn);},removeEventListener(name){events.delete(name);}};
 const root={...listen,nodeType:1,parentElement:null,clientWidth:990,clientHeight:600,
  scrollWidth:990,scrollHeight:1800,scrollTop:0,scrollLeft:0,
  classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}};
 const doc={...listen,scrollingElement:root,documentElement:root};
 const win={...listen,innerWidth:1000,innerHeight:600,getComputedStyle:()=>({overflowY:'auto'}),
  requestAnimationFrame(fn){frames.set(++id,fn);return id;},cancelAnimationFrame(i){frames.delete(i);}};
 const dispose=bindScrollbarInteraction(doc,win);
 const event=(x,y,buttons=0)=>({target:root,clientX:x,clientY:y,buttons,button:0,preventDefault(){},stopPropagation(){}});
 const tick=()=>{for(const fn of frames.values())fn();frames.clear();};
 events.get('mousemove')(event(980,70));tick();
 assert.ok(classes.has('av-scrollbar-near'));
 events.get('mousedown')(event(995,70,1));
 assert.ok(classes.has('av-scrollbar-dragging'));
 events.get('mousemove')(event(400,170,1));
 assert.equal(root.scrollTop,300,'horizontal escape must not cancel vertical drag');
 assert.ok(classes.has('av-scrollbar-dragging'));
 events.get('mouseup')();
 assert.equal(classes.size,0,'release away from edge hides thumb');
 events.get('mousemove')(event(980,170));tick();
 events.get('mousedown')(event(980,170,1));
 assert.equal(classes.has('av-scrollbar-dragging'),false,'content near gutter retains ordinary clicks');
 dispose();assert.equal(events.size,0);assert.equal(classes.size,0);
});
