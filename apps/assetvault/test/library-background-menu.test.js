import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {libraryBackgroundTarget,libraryBackgroundItems} from '../src/library/library-background-menu.js';
import {createContextMenu} from '../src/library/card-context-menu.js';
import {createLibraryVisibility} from '../src/library/library-visibility.js';

const markup='<html><body><aside id="sidebar"></aside><main><div class="content"><div id="local-toolbar"><button id="tool">工具</button></div><section id="board-deck"><article class="bd-card" id="board"></article></section><div id="grid"><article class="model-card" id="card"><span id="cover"></span></article><input id="input"><button id="control">操作</button><div contenteditable id="editor"></div></div><div id="empty"><h3 id="empty-title">暂无资产</h3></div></div></main><dialog id="dialog"></dialog></body></html>';

test('仅资产库空白可打开，不接管卡片、输入、工具栏和弹窗',()=>{
 const {document}=parseHTML(markup),get=id=>document.getElementById(id);
 for(const id of ['grid','board-deck','empty-title'])assert.ok(libraryBackgroundTarget(get(id),'library'),id);
 for(const id of ['sidebar','board','card','cover','input','control','editor','tool','dialog'])assert.equal(libraryBackgroundTarget(get(id),'library'),null,id);
 for(const route of ['discover','downloads','favorites'])assert.equal(libraryBackgroundTarget(get('grid'),route),null);
});

test('所有主要操作平铺直达，标记当前模式；访客不提供创建和导入',()=>{
 const calls=[];
 const args={gallery:true,cards:'boards',onCreate:()=>calls.push('create'),onSmart:()=>calls.push('smart'),onImport:()=>calls.push('import'),onDisplay:key=>calls.push(key),onCards:key=>calls.push(key)};
 const {items}=libraryBackgroundItems(args);
 for(const label of ['新建画板','新建智能画板','导入资产','网格','瀑布流','全部卡片','仅画板','仅资产'])assert.equal(typeof items.find(item=>item.label===label)?.run,'function',label);
 assert.equal(items.find(item=>item.label==='瀑布流').icon,'check');assert.equal(items.find(item=>item.label==='仅画板').icon,'check');
 items.find(item=>item.label==='新建画板').run();items.find(item=>item.label==='网格').run();items.find(item=>item.label==='仅资产').run();
 assert.deepEqual(calls,['create','grid','assets']);
 const visitor=libraryBackgroundItems({...args,canCreate:false}).items;
 assert.ok(!visitor.some(item=>/新建|导入/.test(item.label||'')));
});

test('右键真实空白打开菜单，点击操作关闭菜单并复用工具栏状态',t=>{
 const {document,window}=parseHTML(markup);
 const originalDoc=globalThis.document,originalWin=globalThis.window;
 globalThis.document=document;globalThis.window=window;
 t.after(()=>{globalThis.document=originalDoc;globalThis.window=originalWin;});
 const state={options:{libraryCards:'all'}},changes=[];
 const visibility=createLibraryVisibility({doc:document,state,onChange:mode=>changes.push(mode)});visibility.setup();
 let created=0;
 const menu=createContextMenu({icon:()=>'',targetOf:target=>libraryBackgroundTarget(target,'library'),buildItems:()=>libraryBackgroundItems({cards:visibility.mode(),onCreate:()=>created++,onCards:visibility.setMode})});
 const event=new window.Event('contextmenu',{bubbles:true,cancelable:true});
 document.getElementById('grid').dispatchEvent(event);
 assert.equal(event.defaultPrevented,true);assert.equal(menu.menu.hidden,false);
 const buttons=()=>[...menu.menu.querySelectorAll('button')];
 buttons().find(button=>button.textContent==='仅画板').click();
 assert.equal(menu.menu.hidden,true);assert.equal(state.options.libraryCards,'boards');assert.equal(document.body.dataset.libraryCards,'boards');assert.deepEqual(changes,['boards']);
 document.getElementById('grid').dispatchEvent(new window.Event('contextmenu',{bubbles:true,cancelable:true}));
 buttons().find(button=>button.textContent==='新建画板').click();assert.equal(created,1);assert.equal(menu.menu.hidden,true);
});
