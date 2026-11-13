import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createBoardDrop} from '../src/library/board-drop.js';

test('普通封面拖到画板无需Shift；点击不弹拖拽条，Alt让位外部拖放',async()=>{
 const {document,window}=parseHTML('<html><body><article class="model-card" data-uid="asset"><button class="preview-hit">预览</button></article><article class="bd-card" data-bd-open="board"><div class="bd-card-foot"><strong>参考</strong></div></article></body></html>');
 const handlers=new Map(),calls=[];
 const win={innerWidth:1000,innerHeight:800,addEventListener:(name,fn)=>handlers.set(name,fn)};
 document.elementFromPoint=()=>document.querySelector('.bd-card');
 createBoardDrop({doc:document,win,api:{boardItems:async(...args)=>calls.push(args)},boards:()=>[{id:'board',name:'参考'}]}).setup();
 const down=(extra={})=>{const e=new window.Event('pointerdown',{bubbles:true});Object.assign(e,{button:0,clientX:100,clientY:150,...extra});document.querySelector('.preview-hit').dispatchEvent(e);};
 down();assert.equal(document.querySelector('.bd-drop-dock'),null);
 handlers.get('pointermove')({buttons:1,clientX:150,clientY:200,preventDefault(){}});
 assert.equal(document.querySelector('.bd-drop-dock').hidden,false);
 handlers.get('pointerup')({clientX:150,clientY:200});await Promise.resolve();
 assert.deepEqual(calls,[['board',['asset'],'add']]);
 down({altKey:true});handlers.get('pointerup')({clientX:150,clientY:200});
 assert.equal(calls.length,1);
});
