import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {parseHTML} from 'linkedom';

test('sidebar blank space drags the window without hijacking controls',()=>{
  const {document,window}=parseHTML('<html><body><aside id="sidebar"><div class="side-spacer"></div><button><i></i></button><a href="/">Home</a><div id="side-filters"><span>Category</span></div></aside><main></main></body></html>');
  const calls=[];
  window.__TAURI__={core:{invoke(command,args){calls.push([command,args]);return Promise.resolve();}}};
  runInNewContext(readFileSync(new URL('../sketchfab-exporter-tauri/src-tauri/src/desktop-chrome.js',import.meta.url),'utf8'),{document,window,console,MutationObserver:window.MutationObserver});
  function down(selector,button=0){
    const event=new window.Event('mousedown',{bubbles:true,cancelable:true});
    event.button=button;
    document.querySelector(selector).dispatchEvent(event);
    return event.defaultPrevented;
  }
  assert.equal(down('.side-spacer'),true);
  assert.deepEqual(calls.map(([,args])=>args.action),['drag']);
  for(const selector of ['button i','a','#side-filters span','main']) assert.equal(down(selector),false);
  assert.equal(down('.side-spacer',2),false);
  assert.equal(calls.length,1);
});

test('top docking leaves an input gap in the native drag layer and restores it in normal mode',()=>{
  const {document,window}=parseHTML('<html><body><aside id="sidebar"></aside><div class="search-sticky" data-search-layout="island"><section id="search-panel"></section></div></body></html>');
  window.innerWidth=1400;
  document.getElementById('sidebar').getBoundingClientRect=()=>({right:65});
  let bounds={left:480,right:920};
  document.getElementById('search-panel').getBoundingClientRect=()=>bounds;
  let chromeRoot;
  const create=document.createElement.bind(document);
  document.createElement=(tag)=>{
    const element=create(tag);
    if(tag==='div'){
      const attach=element.attachShadow.bind(element);
      element.attachShadow=options=>(chromeRoot=attach(options));
    }
    return element;
  };
  const observers=[];
  class Observer{constructor(callback){observers.push(callback);}observe(){}}
  runInNewContext(readFileSync(new URL('../sketchfab-exporter-tauri/src-tauri/src/desktop-chrome.js',import.meta.url),'utf8'),{document,window,console,MutationObserver:Observer,ResizeObserver:Observer});
  const drag=chromeRoot.querySelector('.drag');
  const calls=[];
  window.__TAURI__={core:{invoke:(_,args)=>{calls.push(args.action);return Promise.resolve();}}};
  document.querySelector('.search-sticky').getBoundingClientRect=()=>({left:65,right:1400,bottom:120});
  const down=(node)=>{
    const event=new window.Event('mousedown',{bubbles:true,cancelable:true});
    Object.assign(event,{button:0,clientX:300,clientY:20,detail:1});
    node.dispatchEvent(event);
  };
  down(drag);
  assert.deepEqual(calls,['drag'],'native drag fires once');
  down(document.getElementById('arvimo-window-chrome'));
  assert.deepEqual(calls,['drag'],'retargeted native chrome event must not start another drag');
  assert.match(drag.style.clipPath,/415px 0,415px 100%,855px 100%,855px 0/);
  bounds={left:340,right:1060};
  observers.forEach(callback=>callback([]));
  assert.match(drag.style.clipPath,/275px 0,275px 100%,995px 100%,995px 0/);
  const frames=new Map();let frameId=0;
  window.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId;};
  window.cancelAnimationFrame=id=>frames.delete(id);
  const sticky=document.querySelector('.search-sticky');
  sticky.dataset.layoutMotion='true';
  observers.forEach(callback=>callback([]));
  assert.equal(frames.size,1,'native hit testing tracks only while the layout is moving');
  sticky.dataset.searchLayout='normal';
  observers.forEach(callback=>callback([]));
  assert.notEqual(drag.style.clipPath,'','keep the moving panel clickable while returning to normal mode');
  delete sticky.dataset.layoutMotion;
  observers.forEach(callback=>callback([]));
  assert.equal(drag.style.clipPath,'');
  assert.equal(frames.size,0,'no background frame loop after the transition');
  document.body.dataset.route='canvas';
  observers.forEach(callback=>callback([]));
  assert.equal(drag.style.pointerEvents,'none','画布中所有插件与卡片都必须穿透原生拖窗带');
  down(drag);
  assert.deepEqual(calls,['drag']);
  document.body.dataset.route='library';
  observers.forEach(callback=>callback([]));
  assert.equal(drag.style.pointerEvents,'auto','离开画布恢复原生顶部拖窗');
});

test('expanded top blank area drags without intercepting island, type tabs or modal content',()=>{
 const {document,window}=parseHTML('<html><body><div class="search-sticky"><div class="blank"></div><section id="search-panel"><span>hint</span><input></section><nav><button><i></i></button></nav></div><main></main><dialog open><span>content</span></dialog></body></html>');
 document.querySelector('.search-sticky').getBoundingClientRect=()=>({left:65,right:1400,bottom:120});
 const actions=[];
 window.__TAURI__={core:{invoke:(_,args)=>{actions.push(args.action);return Promise.resolve();}}};
 runInNewContext(readFileSync(new URL('../sketchfab-exporter-tauri/src-tauri/src/desktop-chrome.js',import.meta.url),'utf8'),{document,window,console,MutationObserver:window.MutationObserver});
 const down=(selector,props={})=>{
  const e=new window.Event('mousedown',{bubbles:true,cancelable:true});
  Object.assign(e,{button:0,clientX:300,clientY:90,detail:1,...props});
  document.querySelector(selector).dispatchEvent(e);return e.defaultPrevented;
 };
 assert.equal(down('.blank'),true);
 assert.equal(down('.blank',{detail:2}),true);
 for(const selector of ['#search-panel span','input','button i','dialog span'])assert.equal(down(selector),false);
 assert.equal(down('main',{clientY:180}),false);
 assert.equal(down('.blank',{button:2}),false);
 assert.deepEqual(actions,['drag','maximize']);
});
