import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createBoardDrop} from '../src/library/board-drop.js';

test('卡片落点复用拖放会话，显示合并反馈且不误加入画板',()=>{
 const {document,window}=parseHTML('<html><body><article class="local-file-card" data-file="R|a.png"></article><article class="model-card" data-card-group="target"></article></body></html>');
 const handlers=new Map(),calls=[];const target=document.querySelector('[data-card-group]');
 const win={innerWidth:1000,innerHeight:800,addEventListener:(name,fn)=>handlers.set(name,fn)};
 document.elementFromPoint=()=>target;
 const source={key:'source'};
 createBoardDrop({doc:document,win,api:{boardItems:()=>assert.fail('不应投递画板')},cardDrop:{source:()=>source,canDrop:(ref,node)=>ref===source&&node===target,label:()=> '加入集合',drop:(...args)=>calls.push(args)}}).setup();
 const down=new window.Event('pointerdown',{bubbles:true});Object.assign(down,{button:0,clientX:100,clientY:150});document.querySelector('[data-file]').dispatchEvent(down);
 handlers.get('pointermove')({buttons:1,clientX:150,clientY:200,preventDefault(){}});
 assert.equal(target.classList.contains('card-group-drop'),true);assert.equal(document.querySelector('.bd-drop-ghost').textContent,'加入集合');
 handlers.get('pointerup')({clientX:150,clientY:200});assert.deepEqual(calls,[[source,target]]);assert.equal(target.classList.contains('card-group-drop'),false);
});

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

test('图集封面直接拖到画板，按落点加入，无需打开选择器',async()=>{
 const {document,window}=parseHTML('<html><body><article class="model-card" data-package="R|贴花,a"><button class="preview-hit">预览</button></article><article class="bd-card" data-bd-open="board"></article></body></html>');
 const handlers=new Map(),calls=[];const win={innerWidth:1000,innerHeight:800,addEventListener:(name,fn)=>handlers.set(name,fn)};
 document.elementFromPoint=()=>document.querySelector('.bd-card');
 createBoardDrop({doc:document,win,api:{boardItems:async()=>{throw Error('图集不得当成普通uid提交');}},albumKey:card=>card.dataset.package,onAlbumDrop:async(...args)=>calls.push(args),boards:()=>[{id:'board'}]}).setup();
 const event=new window.Event('pointerdown',{bubbles:true});Object.assign(event,{button:0,clientX:100,clientY:150});document.querySelector('.preview-hit').dispatchEvent(event);
 handlers.get('pointermove')({buttons:1,clientX:150,clientY:200,preventDefault(){}});handlers.get('pointerup')({clientX:150,clientY:200});await Promise.resolve();
 assert.deepEqual(calls,[['R|贴花,a','board']]);
});
