import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createLibraryVisibility} from '../src/library/library-visibility.js';
test('全部、仅画板、仅资产直接切换并记住选择；进入画板显示成员',()=>{
 const {document,window}=parseHTML('<html><body><div id="local-toolbar"></div></body></html>');
 const state={options:{libraryCards:'boards'}},changes=[];let active=false;
 const ui=createLibraryVisibility({doc:document,state,activeBoard:()=>active,onChange:mode=>changes.push(mode)});ui.setup();
 assert.equal(document.body.dataset.libraryCards,'boards');assert.equal(document.querySelectorAll('button[data-library-cards]').length,3);
 document.querySelector('button[data-library-cards="assets"]').dispatchEvent(new window.Event('click'));assert.equal(document.body.dataset.libraryCards,'assets');assert.equal(state.options.libraryCards,'assets');assert.deepEqual(changes,['assets']);
 state.options.libraryCards='boards';active=true;ui.apply();assert.equal(document.body.dataset.libraryCards,'boards');assert.equal(document.body.dataset.boardOpen,'true');
 assert.equal(document.querySelector('button[data-library-cards].active').dataset.libraryCards,'boards');
 active=false;ui.apply();assert.equal(document.body.dataset.libraryCards,'boards');
});

test('工具栏回收站图标：点击进入回收站、再点退出，回调触发且在回收站里按全部显示网格',()=>{
 const {document,window}=parseHTML('<html><body><div id="local-toolbar"></div></body></html>');
 const state={options:{libraryCards:'boards'},filter:'all'};let trashClicks=0;
 const ui=createLibraryVisibility({doc:document,state,onTrash:()=>{trashClicks++;state.filter=state.filter==='trash'?'all':'trash';ui.apply();}});ui.setup();
 const btn=document.querySelector('button.trash-mode');
 assert.ok(btn,'工具栏里有回收站图标按钮');
 assert.equal(btn.getAttribute('aria-label'),'回收站');
 assert.equal(document.body.dataset.libraryCards,'boards','非回收站时保持「仅画板」');
 btn.dispatchEvent(new window.Event('click'));
 assert.equal(trashClicks,1);assert.equal(state.filter,'trash');
 assert.equal(document.body.dataset.libraryCards,'all','回收站里强制按「全部」显示，避免「仅画板」藏掉卡片');
 assert.equal(btn.classList.contains('active'),true);assert.equal(btn.getAttribute('aria-pressed'),'true');
 assert.equal(document.querySelector('button[data-library-cards].active'),null,'回收站激活时范围按钮都不点亮');
 btn.dispatchEvent(new window.Event('click'));
 assert.equal(trashClicks,2);assert.equal(state.filter,'all');
 assert.equal(document.body.dataset.libraryCards,'boards','退出回收站恢复原来的「仅画板」');
 assert.equal(btn.classList.contains('active'),false);
});

test('在回收站里点「全部/仅画板/仅资产」会退出回收站，不再卡在空网格',()=>{
 const {document,window}=parseHTML('<html><body><div id="local-toolbar"></div><select id="local-feature"><option value="all">全部资产</option><option value="trash">回收站</option></select></body></html>');
 const state={options:{libraryCards:'boards'},filter:'trash'};
 const ui=createLibraryVisibility({doc:document,state});ui.setup();
 const select=document.querySelector('#local-feature');
 assert.equal(ui.mode(),'boards');
 // 回收站激活时点「全部」：清 filter + 同步下拉 + 切范围，回到正常网格。
 document.querySelector('button[data-library-cards="all"]').dispatchEvent(new window.Event('click'));
 assert.equal(state.filter,'all','退出回收站');
 assert.equal(select.value,'all','下拉同步回全部资产');
 assert.equal(document.body.dataset.libraryCards,'all');
 assert.equal(document.querySelector('button.trash-mode').classList.contains('active'),false);
 // 反过来，在回收站里点「仅画板」也应退出并切到 boards。
 state.filter='trash';ui.apply();
 document.querySelector('button[data-library-cards="boards"]').dispatchEvent(new window.Event('click'));
 assert.equal(state.filter,'all');assert.equal(select.value,'all');assert.equal(state.options.libraryCards,'boards');
});
