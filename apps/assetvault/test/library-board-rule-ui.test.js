import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createBoardRule} from '../src/library/board-rule.js';
import {assertSmartConditions} from '../server/library-collections.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness({initial={},board}={}){
 const {document,window}=parseHTML('<html><body></body></html>');
 globalThis.document=document;globalThis.window=window;globalThis.Event=window.Event;
 const saves=[],notices=[];let pending;
 const ui=createBoardRule({esc,icon:()=>'',toast:x=>notices.push(x),document,
 controls:{currentRule:()=>initial,getModels:()=>[],describeRule:()=>[]},store:{byId:()=>board,saveSmart:async payload=>{assertSmartConditions(payload);saves.push(payload);if(pending)await pending;return 'saved';}}});
 ui.dialog.show=()=>{ui.dialog.open=true;};ui.dialog.close=()=>{ui.dialog.open=false;};
 const find=s=>ui.dialog.querySelector(s);
 const click=s=>{const n=find(s);assert.ok(n,s);n.dispatchEvent(new window.Event('click',{bubbles:true}));};
 return {ui,find,click,saves,notices,setPending:p=>pending=p,window};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));
test('复用原抽屉与颜色面板，空白新建选择颜色即可保存',async()=>{
 const h=harness();h.ui.openNew();h.find('.bd-rule-name').value='红色板';
 assert.ok(h.find('.fd-drawer .fd-rail'));assert.ok(h.find('.fv-slider-input'));
 assert.equal(h.find('.bd-rule-save').disabled,true);
 h.click('.fd-swatch[data-value]');assert.equal(h.find('.bd-rule-save').disabled,false);
 h.click('[data-act=save]');await settled();assert.equal(h.saves.length,1);assert.ok(h.saves[0].filters.colors.length);
});
test('原规则回读与取消隔离；跨次打开不残留条件，未知字段保留',async()=>{
 const original={q:'stone',filters:{tags:['old'],future:{keep:true},rating:[1,4],formats:['png']},sort:'name',sortOrder:'desc',seed:'fixed'};
 const toolbar={q:'toolbar',filters:{tags:['toolbar']}};
 const h=harness({initial:toolbar,board:{name:'原板',rule:original}});h.ui.open('id');
 h.find('.bd-rule-name').value='新名';h.click('[data-act=save]');await settled();assert.deepEqual(h.saves[0],{...original,name:'新名',id:'id'});
 h.ui.open('id');h.click('.fd-swatch[data-value]');h.click('[data-act=cancel]');assert.deepEqual(original.filters.tags,['old']);assert.deepEqual(toolbar,{q:'toolbar',filters:{tags:['toolbar']}});
 h.ui.openNew();h.find('.bd-rule-name').value='新板';h.click('[data-act=save]');await settled();assert.equal(h.saves[1].filters.colors,undefined);assert.deepEqual(h.saves[1].filters.tags,['toolbar']);
});
test('共享更多/排序面板只编辑草稿，不暴露全库写操作',async()=>{
 const h=harness();h.ui.openNew();h.find('.bd-rule-name').value='检索板';
 h.click('.fd-rail-btn[data-id=more]');assert.equal(h.find('.fd-collection-new'),null);assert.equal(h.find('.fd-local-health'),null);
 const q=h.find('.fd-q');q.value='tag:stone';q.dispatchEvent(new h.window.Event('input',{bubbles:true}));
 h.click('.fd-rail-btn[data-id=sort]');h.click('.fv-sort-dir');h.click('[data-act=save]');await settled();assert.equal(h.saves[0].q,'tag:stone');assert.equal(h.saves[0].sortOrder,'desc');
});
test('保存中禁止重复提交、取消及切板',async()=>{
 const h=harness({initial:{q:'stone'}});h.ui.openNew();h.find('.bd-rule-name').value='板';let release;h.setPending(new Promise(r=>release=r));
 h.click('[data-act=save]');h.click('[data-act=save]');h.click('[data-act=cancel]');h.ui.open('other');assert.equal(h.saves.length,1);assert.equal(h.ui.dialog.open,true);
 release();await settled();assert.equal(h.ui.dialog.open,false);
});
