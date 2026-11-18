import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {addCustomCategory,assignCustomCategory,customCategories,categoriesForAsset,customCategoryOf,matchesCustomCategory,customCategoryFacets} from '../src/library/custom-categories.js';
import {loadLibrary,saveLibrary} from '../src/library/library-state.js';
import {tagPanel} from '../src/library/asset-tags.js';
import {assetMenuItems,packageMenuItems,fileMenuItems} from '../src/library/card-context-menu.js';
import {esc} from '../src/library/html-esc.js';
import {createLibraryStorage} from '../server/library-storage.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const uid='a'.repeat(32),model={uid,platform:'local',assetType:'model',name:'tree.glb'};
test('大类和类型都能建子类，空子类保留，同父级重名拒绝，不同父级可同名',()=>{
 const options={};addCustomCategory(options,'three-d','角色','characters');addCustomCategory(options,'textures','木材','wood');addCustomCategory(options,'image-assets','角色','references');
 assert.equal(customCategories(options).length,3);
 assert.throws(()=>addCustomCategory(options,'three-d',' 角色 '),/同名/);
 assert.throws(()=>addCustomCategory(options,'invalid','bad'),/父分类/);
 assert.throws(()=>addCustomCategory(options,'three-d','  '),/名称/);
 assert.deepEqual(customCategoryFacets(options,'textures',[]).map(row=>[row.label,row.count]),[['木材',0]]);
});
test('归类、移除、筛选和计数一致，平台分类与标签不冒充自定义分类',()=>{
 const options={};addCustomCategory(options,'three-d','角色','characters');addCustomCategory(options,'textures','木材','wood');
 assert.deepEqual(categoriesForAsset(options,model).map(row=>row.id),['characters']);
 assignCustomCategory(options,model,'characters');
 assert.equal(matchesCustomCategory(options,model,'custom:characters'),true);
 assert.equal(matchesCustomCategory(options,{...model,uid:'b'.repeat(32),tags:['角色'],categories:['角色']},'custom:characters'),false);
 assert.equal(customCategoryFacets(options,'three-d',[model,model])[0].count,1);
 assert.throws(()=>assignCustomCategory(options,model,'wood'),/不匹配/);
 assignCustomCategory(options,model,'');assert.equal(customCategoryOf(options,model),'');
 assert.equal(model.customCategories,undefined);
});
test('未登记的磁盘文件和资产包也能归类，不改变源文件或元数据',()=>{
 const options={};addCustomCategory(options,'textures','木材','wood');addCustomCategory(options,'image-assets','参考图','reference');
 const pkg={root:'J:/资产库',rel:'Wood',category:'material'};
 const file={root:'J:/资产库',rel:'ref.png',kind:'image'};
 assignCustomCategory(options,pkg,'wood');assignCustomCategory(options,file,'reference');
 assert.equal(matchesCustomCategory(options,pkg,'custom:wood'),true);
 assert.equal(customCategoryFacets(options,'textures',[pkg])[0].count,1);
 assert.equal(customCategoryOf(options,{...file,root:'j:\\资产库'}),'reference');
});
test('资产面板直接选择，三种右键菜单均直接归类，安全转义子类名称',async()=>{
 const options={};addCustomCategory(options,'three-d','<角色>','characters');assignCustomCategory(options,model,'characters');
 const {document}=parseHTML(tagPanel({options,models:[model]},model,esc));
 const select=document.querySelector('[data-custom-category-for]');assert.ok(select);
 assert.equal(select.querySelector('[value="characters"]').hasAttribute('selected'),true);
 assert.match(select.textContent,/<角色>/);assert.equal(select.querySelector('角色'),null);
 let calls=0;const onCustomCategory=()=>calls++;
 for(const spec of [assetMenuItems({model,uid,inLibrary:true,realm:'library',onCustomCategory}),packageMenuItems({pkg:{},onCustomCategory}),fileMenuItems({file:{},onCustomCategory})]){
  const item=spec.items.find(item=>item.label==='归入自定义子类…');assert.ok(item);await item.run();
 }
 assert.equal(calls,3);
});
test('分类定义与归属通过现有保存机制写盘，重开后空分类和关联不丢失',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arvimo-categories-'));
 let storage=createLibraryStorage(dir);t.after(async()=>{await storage.close();await fs.rm(dir,{recursive:true,force:true});});
 const memory={values:{},getItem(key){return this.values[key]??null;},setItem(key,value){this.values[key]=value;}};
 const state=loadLibrary(memory);
 addCustomCategory(state.options,'three-d','角色','characters');addCustomCategory(state.options,'textures','空分类','empty');assignCustomCategory(state.options,model,'characters');
 saveLibrary(memory,state);await storage.save(memory.values);await storage.close();storage=createLibraryStorage(dir);
 const {values}=await storage.load();const restored=loadLibrary({getItem:key=>values[key]??null,setItem(){}});
 assert.equal(customCategories(restored.options).length,2);
 assert.equal(customCategoryOf(restored.options,model),'characters');
 assert.equal(customCategoryFacets(restored.options,'textures',[])[0].count,0);
});
