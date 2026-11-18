import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createLibraryGridCache} from '../src/library/library-grid-cache.js';
import {createBoardActions} from '../src/library/board-actions.js';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('新建画板不进入，不改当前选择',async()=>{
 let opened=0,selected=0;const actions=createBoardActions({store:{create:async()=> 'new',setActive:()=>selected++},ask:async()=> '新板',openBoard:()=>opened++});
 assert.equal(await actions.createManual(),'new');assert.equal(opened,0);assert.equal(selected,0);
});
test('进出画板恢复同一张卡片和图片节点，不重设图片地址',()=>{
 const {document}=parseHTML('<div id="grid"><article><img src="a"></article></div>');const grid=document.querySelector('#grid'),card=grid.firstElementChild,img=card.firstElementChild,cache=createLibraryGridCache(grid);
 cache.switchTo('board',{gridMode:'ll'});assert.equal(grid.children.length,0);assert.equal(img.getAttribute('src'),'a');
 grid.innerHTML='<article>board</article>';const restored=cache.switchTo('library',{});assert.equal(grid.firstElementChild,card);assert.equal(card.firstElementChild,img);assert.equal(restored.gridMode,'ll');assert.equal(card.dataset.cardCached,undefined);
});

test('合集与文件夹逐层返回复用各自卡片，缓存淘汰只释放离场页面',()=>{
 const {document}=parseHTML('<div id="grid"><article><img src="root"></article></div>');
 const grid=document.querySelector('#grid'),root=grid.firstElementChild,cache=createLibraryGridCache(grid);
 cache.switchTo('folder:a',{gridMode:'gl'});grid.innerHTML='<article><img src="folder"></article>';
 const folder=grid.firstElementChild;
 cache.switchTo('group:b',{gridMode:'gl'});grid.innerHTML='<article><img src="group"></article>';
 cache.switchTo('folder:a',{});assert.equal(grid.firstElementChild,folder);assert.equal(folder.firstElementChild.getAttribute('src'),'folder');
 cache.switchTo('library',{});assert.equal(grid.firstElementChild,root);assert.equal(root.firstElementChild.getAttribute('src'),'root');
 for(let i=0;i<5;i++){cache.switchTo(`group:${i}`,{});grid.innerHTML=`<article><img src="${i}"></article>`;}
 assert.equal(root.firstElementChild.getAttribute('src'),null);
 assert.equal(grid.querySelector('img').getAttribute('src'),'4');
});
test('仅两项的画板仍生成三个固定大预览槽位',()=>{
 const source=readFileSync(new URL('../src/library/board-deck.js',import.meta.url),'utf8');const context={previews:{board:{items:[{thumbnail:'a'},{thumbnail:'b'}]}},thumbUrl:item=>item.thumbnail,esc:String,icon:()=>''};vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('  function previewHtml('),source.indexOf('  function cardHtml(')),context);const html=context.previewHtml({id:'board'}).strip;
 assert.equal((html.match(/class="bd-card-thumb/g)||[]).length,3);
});

test('重命名使用非模态小表单，保存一次完成',async()=>{
 const {document}=parseHTML('<html><body></body></html>');const calls=[];
 const actions=createBoardActions({document,store:{byId:()=>({id:'board',name:'旧名'}),rename:async(...args)=>calls.push(args)}});
 const pending=actions.rename('board');const form=document.querySelector('.bd-inline-editor');assert.ok(form);assert.equal(document.querySelector('dialog'),null);
 form.querySelector('input').value='新名';form.onsubmit({preventDefault(){}});await pending;assert.deepEqual(calls,[['board',{name:'新名'}]]);assert.equal(document.querySelector('.bd-inline-editor'),null);
});
