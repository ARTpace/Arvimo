import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {categoryOrder,orderedCategories,moveCategory,setupCategoryOrder} from '../src/library/category-order.js';
import {MODE_PRESETS} from '../src/library/mode-presets.js';
import {loadLibrary,saveLibrary} from '../src/library/library-state.js';
import {createContentKindTabs} from '../src/library/content-kind-tabs.js';
test('排序去重补全、非法值忽略，母类排序不改分类内容，待分类最后',()=>{
 const options={categoryOrder:['media','bad','media','three-d']};
 assert.deepEqual(categoryOrder(options),['media','three-d','image-assets','ui-assets','document-assets']);
 const rows=[...MODE_PRESETS.map(row=>({id:row.groupId,kids:row.localKinds})),{id:'unknown'}];
 const sorted=orderedCategories(rows,options);
 assert.equal(sorted[0],rows[4]);assert.equal(sorted.at(-1).id,'unknown');
 assert.equal(moveCategory(options,'three-d','media'),true);
 assert.equal(moveCategory(options,'three-d','three-d'),false);
 assert.equal(moveCategory(options,'unknown','media'),false);
 assert.equal(moveCategory(options,'three-d','media',true),true);
});
test('共享顺序通过现有保存机制恢复',()=>{
 const storage={value:null,getItem(){return this.value;},setItem(key,value){this.value=value;}};
 const state=loadLibrary(storage);moveCategory(state.options,'media','image-assets');
 saveLibrary(storage,state);
 assert.deepEqual(categoryOrder(loadLibrary(storage).options),categoryOrder(state.options));
});
test('顶部和侧栏使用同一拖动处理，外部文件与取消拖动不改序',()=>{
 const {document,window}=parseHTML('<div><button class="ck-tab" data-category-order="image-assets"></button><button data-category-order="media"></button></div>');
 const state={options:{}},before=categoryOrder(state.options);let commits=0,picks=0;
 setupCategoryOrder({root:document,state,onChange:()=>commits++});
 const [top,side]=document.querySelectorAll('button');side.getBoundingClientRect=()=>({top:20,height:40});
 top.getBoundingClientRect=()=>({left:10,width:50});
 // linkedom does not implement ancestor capture; observe the shared root handler order.
 document.addEventListener('click',()=>picks++);
 const transfer={setData(){}};
 const fire=(node,type,coords={})=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{dataTransfer:transfer,...coords});node.dispatchEvent(event);return event;};
 fire(side,'drop',{clientY:21});assert.deepEqual(categoryOrder(state.options),before);
 fire(top,'dragstart');fire(side,'dragover',{clientY:55});
 assert.equal(side.classList.contains('category-drop-after'),true);
 fire(side,'drop',{clientY:55});
 assert.equal(commits,1);assert.equal(categoryOrder(state.options).at(-1),'image-assets');
 fire(top,'click');assert.equal(picks,0);
 fire(top,'dragend');assert.equal(top.classList.contains('category-dragging'),false);
 fire(side,'dragstart');fire(top,'drop',{clientX:55});fire(side,'dragend');
 assert.equal(commits,2);assert.ok(categoryOrder(state.options).indexOf('media')>categoryOrder(state.options).indexOf('image-assets'));
 const saved=categoryOrder(state.options);fire(top,'dragstart');fire(top,'dragend');
 assert.deepEqual(categoryOrder(state.options),saved);
});
test('顶部 render 同步新顺序且保留按钮节点和激活状态',()=>{
 const {document}=parseHTML('<div id="tabs"></div>'),host=document.querySelector('#tabs');
 const state={options:{},mode:'models'};
 const tabs=createContentKindTabs({host,state});tabs.render();
 const image=host.querySelector('[data-mode="images"]');
 moveCategory(state.options,'media','image-assets');tabs.render();
 assert.equal(host.firstElementChild.dataset.mode,'videos');
 assert.equal(host.querySelector('[data-mode="images"]'),image);
 assert.equal(host.querySelector('[data-mode="models"]').getAttribute('aria-pressed'),'true');
 assert.equal(image.getAttribute('draggable'),'true');
});

test('拖动时两边同步让位，原节点保留；取消不保存，落下才提交',()=>{
 const ids=MODE_PRESETS.map(row=>row.groupId);
 const {document,window}=parseHTML(`<div id="top">${ids.map(id=>`<button class="ck-tab" data-category-order="${id}"></button>`).join('')}</div><div id="side">${ids.map(id=>`<div class="ftree-group"><button data-category-order="${id}"></button><div>子分类</div></div>`).join('')}</div>`);
 const top=[...document.querySelectorAll('.ck-tab')],side=[...document.querySelectorAll('.ftree-group')];
 top.forEach((node,i)=>{node.getBoundingClientRect=()=>({left:i*60,top:0,width:50,height:40});});
 side.forEach((node,i)=>{node.getBoundingClientRect=()=>({left:0,top:i*120,width:200,height:110});});
 const state={options:{}},original=categoryOrder(state.options);let saves=0;
 setupCategoryOrder({root:document,state,onChange:()=>saves++});
 const fire=(node,type,coords={})=>{
  const event=new window.Event(type,{bubbles:true,cancelable:true});
  Object.assign(event,{dataTransfer:{setData(){}},...coords});node.dispatchEvent(event);
 };
 fire(top[0],'dragstart');fire(top[2],'dragover',{clientX:165});
 assert.equal(top[0].style.translate,'120px 0px');
 assert.equal(top[1].style.translate,'-60px 0px');
 assert.equal(side[0].style.translate,'0px 240px');
 assert.equal(top[0].parentNode.firstElementChild,top[0],'预览不搬动原生拖动源 DOM');
 assert.equal(saves,0);assert.deepEqual(categoryOrder(state.options),original);
 fire(top[0],'dragend');
 assert.equal(top[0].style.translate,'');assert.equal(side[0].style.translate,'');
 assert.equal(saves,0);assert.deepEqual(categoryOrder(state.options),original);
 fire(top[0],'dragstart');fire(top[2],'dragover',{clientX:165});
 // Repeat identical coordinates while other rows animate: no oscillation.
 fire(top[1],'dragover',{clientX:165});assert.equal(top[0].style.translate,'120px 0px');
 fire(top[2],'drop',{clientX:165});
 assert.equal(saves,1);assert.equal(categoryOrder(state.options)[2],ids[0]);
 assert.equal(top[0].style.translate,'');
 fire(top[0],'dragstart');fire(side[4].querySelector('button'),'dragover',{clientY:580});
 fire(top[0],'keydown',{key:'Escape'});
 assert.equal(saves,1);assert.equal(side[0].style.translate,'');
});
