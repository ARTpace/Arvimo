import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createRangeSelect} from '../src/library/range-select.js';

function fixture(t){
 const {document,window}=parseHTML('<html><body><main><div id="grid"><article class="model-card" data-uid="a"><img id="cover"><label class="card-select"><input data-select="a" type="checkbox"></label><button class="favorite" id="favorite">收藏</button></article><article class="model-card" data-uid="b"><button class="preview-hit" id="preview">预览</button></article></div></main><div id="selection-bar" hidden><b id="selected-count">0</b></div></body></html>');
 const previous=globalThis.MutationObserver;globalThis.MutationObserver=window.MutationObserver;
 t.after(()=>{globalThis.MutationObserver=previous;});
 t.mock.timers.enable({apis:['setTimeout']});
 const state={route:'library',selected:new Set()},grid=document.getElementById('grid');let renders=0,changes=0,opens=0,starts=0;
 document.addEventListener('assetvault:selection-start',()=>starts++);
 const selection=createRangeSelect({grid,state,renderGrid:()=>renders++,onSelectionChange:()=>changes++});selection.setup();
 document.addEventListener('click',()=>opens++);
 const fire=(target,type,extra={})=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{button:0,pointerId:1,clientX:20,clientY:20,...extra});target.dispatchEvent(e);return e;};
 return {document,window,state,selection,fire,card:grid.firstElementChild,second:grid.lastElementChild,tick:ms=>t.mock.timers.tick(ms),stats:()=>({renders,changes,opens,starts})};
}

test('普通短按保留打开行为，不进入多选',t=>{
 const f=fixture(t);f.fire(f.card,'pointerdown');f.tick(200);f.fire(f.card,'pointerup');f.fire(f.card,'click');f.tick(600);
 assert.equal(f.stats().opens,1);assert.equal(f.state.selected.size,0);assert.equal(f.document.body.hasAttribute('data-selection-mode'),false);
});

test('长按选中首卡，松手不打开预览；之后点击多选、取消及Esc退出均不重绘',t=>{
 const f=fixture(t);f.fire(f.card,'pointerdown');f.tick(500);
 assert.deepEqual([...f.state.selected],['a']);assert.equal(f.stats().starts,1);assert.equal(f.card.classList.contains('selected'),true);
 f.fire(f.card,'pointerup');f.fire(f.card,'click');assert.deepEqual([...f.state.selected],['a']);assert.equal(f.stats().opens,0);
 f.fire(f.second,'pointerdown');f.fire(f.second,'pointerup');f.fire(f.document.getElementById('preview'),'click');assert.deepEqual([...f.state.selected],['a','b']);
 f.fire(f.card,'click');f.fire(f.second,'click');assert.equal(f.state.selected.size,0);assert.equal(f.document.getElementById('selection-bar').hidden,false);
 f.fire(f.window,'keydown',{key:'Escape'});assert.equal(f.document.body.hasAttribute('data-selection-mode'),false);assert.equal(f.document.getElementById('selection-bar').hidden,true);
 f.fire(f.card,'click');assert.equal(f.stats().opens,1);assert.equal(f.stats().renders,0);
});

test('移动、滚动、取消指针、切到后台会取消等待',t=>{
 const f=fixture(t);
 for(const cancel of [()=>f.fire(f.card,'pointermove',{clientX:35}),()=>f.fire(f.document,'scroll'),()=>f.fire(f.card,'pointercancel'),()=>f.fire(f.window,'blur')]){
  f.fire(f.card,'pointerdown');f.tick(200);cancel();f.tick(600);assert.equal(f.state.selected.size,0);assert.equal(f.card.hasAttribute('data-long-press'),false);
 }
});

test('独立功能按钮和发现页不触发长按多选；退出后恢复普通点击',t=>{
 const f=fixture(t);f.fire(f.document.getElementById('favorite'),'pointerdown');f.tick(600);assert.equal(f.state.selected.size,0);
 f.state.route='discover';f.fire(f.card,'pointerdown');f.tick(600);assert.equal(f.state.selected.size,0);
 f.state.route='library';f.fire(f.card,'pointerdown');f.tick(500);f.selection.exitSelectionMode();f.state.selected.clear();f.selection.syncSelection();
 f.fire(f.card,'click');assert.equal(f.stats().opens,1);assert.equal(f.document.body.hasAttribute('data-selection-mode'),false);
});
