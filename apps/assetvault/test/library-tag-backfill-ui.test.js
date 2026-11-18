import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createTagBackfillUi} from '../src/library/tag-backfill-ui.js';

test('运行时自动刷新越过首批100、完成后停止；关闭停止请求，重开读取最新状态',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const previousDocument=globalThis.document,previousFetch=globalThis.fetch;
 const {document,Event}=parseHTML('<html><body></body></html>');globalThis.document=document;
 const create=document.createElement.bind(document);
 document.createElement=name=>{const element=create(name);if(name==='dialog'){
  element.showModal=()=>{element.open=true;};
  element.close=()=>{element.open=false;element.dispatchEvent(new Event('close'));};
 }return element;};
 const channel='taxonomy-existing-tags-v1';let calls=0;
 globalThis.fetch=async()=>{const step=++calls,covered=step===1?100:step===2?200:736,state=step<3?'running':'completed';return {ok:true,json:async()=>({version:4,total:736,covered,rejections:0,job:{state},channels:[{id:channel,covered,job:{state}}]})};};
 t.after(()=>{globalThis.document=previousDocument;globalThis.fetch=previousFetch;});
 const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 const ui=createTagBackfillUi({esc:value=>String(value)});await ui.open();
 const dialog=document.querySelector('dialog');assert.match(dialog.textContent,/100 \/ 736/);
 t.mock.timers.tick(1000);await settle();assert.match(dialog.textContent,/200 \/ 736/);
 t.mock.timers.tick(1000);await settle();assert.match(dialog.textContent,/已完成/);assert.match(dialog.textContent,/736 \/ 736/);
 t.mock.timers.tick(3000);await settle();assert.equal(calls,3);
 calls=0;await ui.open();assert.equal(calls,1);dialog.close();
 t.mock.timers.tick(3000);await settle();assert.equal(calls,1);
 await ui.open();assert.equal(calls,2);assert.match(dialog.textContent,/200 \/ 736/);dialog.close();
});
