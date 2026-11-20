import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML as parse} from 'linkedom';
import {initSearchIsland} from '../src/library/search-island.js';

function parseHTML(html){
 return parse(html.replace('<form id="asset-search-form">','<span id="search-mascot-bubble"></span><form id="asset-search-form">').replace('<button id="search-button"','<button type="button" id="filter-drawer-trigger">分类</button><button type="button" id="search-layout-toggle">布局</button><button id="search-button"'));
}

function fixture(saved='normal'){
 const {document,window}=parseHTML('<html><body><div class="search-sticky"><nav id="content-kind-tabs"><button>图片</button></nav><section id="search-panel"><form id="asset-search-form"><input id="asset-query" placeholder="搜索关键词"><button id="search-button" type="submit"><i>搜索图标</i>搜索 / 解析</button></form><select id="online-sort"><option value="popular" selected>热门</option></select></section></div></body></html>');
 const values=new Map([['av-search-layout',saved]]),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const panel=document.querySelector('#search-panel');
 initSearchIsland(panel,{storage});
 return {document,window,panel,values,toggle:document.querySelector('#search-layout-toggle'),input:document.querySelector('#asset-query')};
}

test('switching presentations preserves the actual form, draft, filters and handlers',()=>{
 const f=fixture(),form=f.panel.querySelector('form'),sort=f.document.querySelector('select');
 f.input.value='wood';let submissions=0;
 form.addEventListener('submit',e=>{e.preventDefault();submissions++;});
 f.toggle.click();
 assert.equal(f.document.querySelector('.search-sticky').dataset.searchLayout,'island');
 assert.equal(f.values.get('av-search-layout'),'island');
 assert.equal(f.toggle.getAttribute('aria-label'),'恢复完整搜索');
 f.toggle.click();
 assert.equal(f.input.value,'wood');
 assert.equal(f.panel.querySelector('form'),form);
 assert.equal(f.document.querySelector('select'),sort);
 assert.equal(sort.value,'popular');
 assert.equal(f.values.get('av-search-layout'),'normal');
 form.dispatchEvent(new f.window.Event('submit',{cancelable:true}));
 assert.equal(submissions,1);
 assert.equal(f.document.querySelectorAll('#asset-query').length,1);
});

test('restores mode, keeps type buttons independent and initializes only once',()=>{
 const f=fixture('island');
 assert.equal(f.toggle.getAttribute('aria-pressed'),'true');
 assert.equal(f.document.querySelector('#content-kind-tabs').parentElement.className,'search-sticky');
 initSearchIsland(f.panel);
 assert.equal(f.document.querySelectorAll('#search-layout-toggle').length,1);
});

test('search lifecycle updates status and reset clears it without changing draft',()=>{
 const f=fixture('island'),status=f.panel.querySelector('[role=status]');
 f.input.value='robot';
 const update=detail=>f.panel.dispatchEvent(new f.window.CustomEvent('search-motion-state',{detail}));
 update({busy:true});assert.equal(status.textContent,'正在搜 · robot');assert.equal(status.hidden,false);
 update({busy:false,ok:true});assert.equal(status.textContent,'搜索完成');
 update({busy:false,ok:false});assert.match(status.textContent,/未完成/);
 update({reset:true,busy:false});assert.equal(status.hidden,true);assert.equal(f.input.value,'robot');
});

test('compact summary does not repeat platform and category focus leaves search collapsed',()=>{
 const f=fixture('island'),line=f.panel.querySelector('.island-rest-line');
 const caption=f.document.createElement('span');caption.className='picker-caption';caption.textContent='小红书';f.panel.append(caption);
 f.input.value='';f.input.dispatchEvent(new f.window.Event('input'));
 assert.equal(line.textContent,'想找什么素材？告诉我吧');
 const bubble=f.panel.querySelector('#search-mascot-bubble');bubble.className='show';
 bubble.innerHTML='<span class="update-bubble-text">已筛选角色</span><button>清除筛选</button>';
 f.input.dispatchEvent(new f.window.Event('input'));
 assert.equal(line.textContent,'已筛选角色');
 const category=f.panel.querySelector('#filter-drawer-trigger');
 category.dispatchEvent(new f.window.Event('focusin',{bubbles:true}));
 assert.equal(f.panel.classList.contains('island-open'),false);
 f.input.dispatchEvent(new f.window.Event('focusin',{bubbles:true}));
 assert.equal(f.panel.classList.contains('island-open'),true);
});

test('unavailable preference storage does not prevent switching',()=>{
 // A new fixture with inaccessible persistence must still expose a working mode toggle.
 const {document}=parseHTML('<div class="search-sticky"><section id="search-panel"><form id="asset-search-form"><input id="asset-query"><button id="search-button">搜索</button></form></section></div>');
 const storage={getItem(){throw Error('blocked');},setItem(){throw Error('full');}};
 initSearchIsland(document.querySelector('#search-panel'),{storage});
 document.querySelector('#search-layout-toggle').click();
 assert.equal(document.querySelector('.search-sticky').dataset.searchLayout,'island');
});

test('mode motion starts from displayed bounds, cancels previous motion and cleans up',()=>{
 const f=fixture(),animations=[];
 const bounds=[
  {left:20,top:80,width:900,height:140},{left:250,top:0,width:440,height:48},
  {left:150,top:25,width:600,height:80},{left:20,top:80,width:900,height:140},
 ];
 f.panel.getBoundingClientRect=()=>bounds.shift();
 f.panel.animate=(frames,options)=>{
  const animation={frames,options,cancelled:false,cancel(){this.cancelled=true;this.oncancel?.();}};
  animations.push(animation);return animation;
 };
 f.toggle.click();
 assert.match(animations[0].frames[0].transform,/translate\(-230px,80px\)/);
 assert.equal(f.document.querySelector('.search-sticky').dataset.layoutMotion,'true');
 f.toggle.click();
 assert.equal(animations[0].cancelled,true);
 assert.match(animations[1].frames[0].transform,/translate\(130px,-55px\)/);
 animations[1].onfinish();
 assert.equal(f.document.querySelector('.search-sticky').hasAttribute('data-layout-motion'),false);
 assert.equal(f.document.querySelector('.search-sticky').classList.contains('search-layout-morphing'),false);
});

test('reduced motion switches immediately without starting animation',()=>{
 const f=fixture();
 // MatchMedia is read at initialization, as in a browser with the OS preference enabled.
 delete f.panel.dataset.islandReady;
 const {document,window}=parseHTML('<div class="search-sticky"><section id="search-panel"><form id="asset-search-form"><input id="asset-query"><button id="search-button">搜索</button></form></section></div>');
 window.matchMedia=()=>({matches:true});
 const panel=document.querySelector('#search-panel');let calls=0;
 panel.animate=()=>{calls++;};
 initSearchIsland(panel,{storage:{getItem:()=>null,setItem(){}}});
 document.querySelector('#search-layout-toggle').click();
 assert.equal(document.querySelector('.search-sticky').dataset.searchLayout,'island');
 assert.equal(calls,0);
 delete window.matchMedia;
});

test('native transition captures first, commits in its update, and ignores superseded updates',async()=>{
 const f=fixture(),transitions=[];
 f.document.startViewTransition=update=>{
  let finish;
  const transition={update,finished:new Promise(resolve=>{finish=resolve;}),skipTransition(){this.skipped=true;},finish:()=>finish()};
  transitions.push(transition);return transition;
 };
 f.toggle.click();
 assert.equal(f.values.get('av-search-layout'),'normal','preference must not be written before the captured update');
 assert.equal(f.document.querySelector('.search-sticky').dataset.searchLayout,'normal');
 transitions[0].update();
 assert.equal(f.values.get('av-search-layout'),'island');
 f.toggle.click();
 f.toggle.click();
 assert.equal(transitions[1].skipped,true);
 transitions[1].update();
 assert.equal(f.values.get('av-search-layout'),'island','superseded callback must not apply the intermediate normal layout');
 transitions[2].update();transitions[2].finish();
 await Promise.resolve();
 assert.equal(f.document.documentElement.hasAttribute('data-search-layout-transition'),false);
 assert.equal(f.document.querySelectorAll('#asset-query').length,1);
});
