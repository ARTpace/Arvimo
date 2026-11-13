import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const motion=readFileSync(new URL('../src/library/disclosure-motion.js',import.meta.url),'utf8').replaceAll('export function','function');
function fixture(reduced=false){
 const animations=[],classes=new Set();let height=0;
 const head={setAttribute(key,value){this[key]=value;}};
 const body={style:{display:'',transition:'',overflow:''},scrollHeight:100,getBoundingClientRect:()=>({height}),animate(frames,options){
  height=(parseFloat(frames[0].height)+parseFloat(frames[1].height))/2;
  const animation={frames,options,cancel(){this.cancelled=true;}};animations.push(animation);return animation;
 }};
 const section={isConnected:true,classList:{contains:key=>classes.has(key),toggle(key,on){on?classes.add(key):classes.delete(key);}},querySelector:selector=>selector.includes('ftree-body')?body:head};
 const context={window:{matchMedia:()=>({matches:reduced})},getComputedStyle:()=>({opacity:classes.has('open')?'1':'0'})};
 vm.runInNewContext(motion,context);
 return {context,section,body,head,animations};
}

test('fold state is immediate; interrupted animation continues from the visible height',()=>{
 const f=fixture(),{context,section,body,head,animations}=f;
 context.setTreeOpen(section,true,true);
 assert.equal(head['aria-expanded'],'true');assert.equal(body.inert,false);
 assert.equal(animations[0].frames[0].height,'0px');assert.equal(animations[0].frames[1].height,'100px');
 context.setTreeOpen(section,false,true);
 assert.equal(animations[0].cancelled,true);assert.equal(animations[1].frames[0].height,'50px');
 assert.equal(body.inert,true);assert.equal(head['aria-expanded'],'false');
 animations[0].onfinish();assert.equal(body.style.display,'block','stale completion must not clear a newer animation');
 animations[1].onfinish();assert.deepEqual(body.style,{display:'',transition:'',overflow:''});
 assert.equal(section.classList.contains('open'),false);
});

test('initialization and reduced motion update fold state without playing an animation',()=>{
 for(const reduced of [false,true]){
  const {context,section,body,animations}=fixture(reduced);
  context.setTreeOpen(section,false);assert.equal(body.inert,true);
  context.setTreeOpen(section,true,reduced);assert.equal(body.inert,false);assert.equal(animations.length,0);
 }
});

test('settings details can reverse a pending close without losing the expanded content',()=>{
 const {context}=fixture();let click,height=130;const animations=[];
 const details={open:true,style:{overflow:''},scrollHeight:130,offsetHeight:130,clientHeight:128,
  matches:()=>true,getBoundingClientRect:()=>({height}),animate(frames){
   height=(parseFloat(frames[0].height)+parseFloat(frames[1].height))/2;
   const animation={frames,cancel(){}};animations.push(animation);return animation;
  }};
 const summary={parentElement:details,getBoundingClientRect:()=>({height:30})};
 context.setupDetailsMotion({addEventListener:(_name,fn)=>click=fn});
 const event={target:{closest:()=>summary},preventDefault(){}};
 click(event);assert.equal(details.open,true);assert.equal(animations[0].frames[1].height,'32px');
 click(event);assert.equal(animations[1].frames[0].height,'81px');assert.equal(animations[1].frames[1].height,'130px');
 animations[0].onfinish();assert.equal(details.style.overflow,'hidden');
 animations[1].onfinish();assert.equal(details.open,true);assert.equal(details.style.overflow,'');
 click(event);animations[2].onfinish();assert.equal(details.open,false);
});

test('floating menus stay within the viewport and scroll bursts trigger one placement per frame',()=>{
 const source=readFileSync(new URL('../src/library/picker.js',import.meta.url),'utf8');
 const place=source.slice(source.indexOf(' function place(){'),source.indexOf(' function paint('));
 let callback,scheduled=0,closed=0;
 const menu={style:{},dataset:{},scrollHeight:500};
 const context={menu,naturalWidth:240,open:true,placeFrame:0,window:{innerWidth:800,innerHeight:600},
  trigger:{getBoundingClientRect:()=>({left:740,top:500,bottom:540,width:100,height:40})},
  close:()=>closed++,requestAnimationFrame:fn=>{callback=fn;scheduled++;return scheduled;},
 };
 vm.runInNewContext(place+';for(let i=0;i<50;i++)schedulePlace();',context);
 assert.equal(scheduled,1);callback();
 assert.equal(menu.style.left,'552px');assert.equal(menu.style.width,'240px');assert.equal(menu.style.maxHeight,'400px');assert.equal(menu.dataset.side,'up');
 context.trigger.getBoundingClientRect=()=>({width:0,height:0});context.place();assert.equal(closed,1);
});

test('rapid route switches discard old scroll restoration and manual scrolling cancels it',()=>{
 const source=readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('let routeScrollFrame='),source.indexOf('function route(name)'));
 const frames=new Map(),positions=[],listeners={};let id=0;
 const context={requestAnimationFrame:fn=>{frames.set(++id,fn);return id;},cancelAnimationFrame:key=>frames.delete(key),
  window:{addEventListener:(name,fn)=>listeners[name]=fn,scrollTo:position=>positions.push(position.top)}};
 vm.runInNewContext(code,context);
 const flush=()=>{const batch=[...frames.values()];frames.clear();for(const fn of batch)fn();};
 context.restoreRouteScroll(500);flush();context.restoreRouteScroll(100);flush();flush();
 assert.deepEqual(positions,[100]);
 context.restoreRouteScroll(800);listeners.wheel();flush();assert.deepEqual(positions,[100]);
});
