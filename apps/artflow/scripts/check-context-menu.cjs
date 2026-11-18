// Focused regression: disabled history, command projection and selection context.
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {createKernel} = require('../plugin-runtime/kernel.ts');
const {ContextMenu} = require('../components/ContextMenu.tsx');
const kernel = createKernel();
kernel.contributions.register('commands', {id:'view.test-grid',pluginId:'test.menu',value:{title:'Test grid',group:'View',run(){}}});
kernel.contributions.register('ui_menus', {id:'test.selection',pluginId:'test.menu',value:{group:'clipboard',label:()=> 'Selected object',visible:ctx=>ctx.selectedElements.length===1,run(){}}});
kernel.contributions.register('ui_menus', {id:'test.broken',pluginId:'test.menu',value:{group:'clipboard',label:()=> 'Broken item',visible(){throw Error('isolated');},run(){}}});
const props={kernel,x:999,y:999,language:'zho',elementId:null,elements:[],selectedElementIds:[],actions:{},onClose(){},items:[{label:()=> 'Undo',group:'history',visible:()=>true,enabled:()=>false,shortcut:'Ctrl+Z',run(){}}]};
const empty=renderToStaticMarkup(React.createElement(ContextMenu,props));
assert.match(empty,/role="menu"/);
assert.match(empty,/disabled=""[^>]*>.*?Undo/);
assert.match(empty,/Ctrl\+Z/);
assert.match(empty,/显示模式/,'existing View commands are reachable through the mode menu');
assert.ok(!empty.includes('Selected object'));
assert.ok(!empty.includes('Broken item'));
const selected=renderToStaticMarkup(React.createElement(ContextMenu,{...props,elements:[{id:'one',type:'image'}],elementId:'one',selectedElementIds:['one']}));
assert.match(selected,/Selected object/);
const locked=renderToStaticMarkup(React.createElement(ContextMenu,{...props,elements:[{id:'one',type:'image',isLocked:true}],elementId:'one',selectedElementIds:['one'],items:[{label:()=> 'Delete',group:'destructive',visible:()=>true,run(){}}]}));
assert.match(locked,/disabled=""[^>]*>.*?Delete/);
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const contributed=[];
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../plugins/builtin.commands-core/plugin.js'),'utf8'),{Artflow:{
 services:{},bi:(zh)=>zh,definePlugin(plugin){plugin.activate({contributions:{register(slot,item){if(slot==='ui_menus')contributed.push(item);return ()=>{};}},use(){return {};}});}
}});
let duplicates=0,deletes=0;
const selectionContext={element:null,selectedElements:[{id:'one'}],isMultiSelection:false,actions:{copySelection(){duplicates++;},deleteSelection(){deletes++;}}};
contributed.find(item=>item.id==='builtin.canvas-menus.copy').value.run(selectionContext);
contributed.find(item=>item.id==='builtin.canvas-menus.delete').value.run(selectionContext);
assert.equal(duplicates,1,'blank-space menu acts on a single selected object too');
assert.equal(deletes,1);

const {transformReferenceImage}=require('../utils/referenceImageTools.ts');
const calls=[];
const context={translate:(...args)=>calls.push(['translate',...args]),scale:(...args)=>calls.push(['scale',...args]),drawImage:()=>calls.push(['draw']),filter:'none'};
globalThis.Image=class {naturalWidth=320;naturalHeight=180;set src(value){this.onload();}};
globalThis.document={createElement:()=>({getContext:()=>context,toDataURL:()=> 'data:image/png;base64,new'})};
(async()=>{
 const image={id:'one',type:'image',href:'old',assetId:'old-asset',assetRef:{src:'old'},thumbnailHref:'old-thumb',width:160,height:90};
 const patch=await transformReferenceImage(image,'flip-h');
 assert.deepEqual(calls.slice(0,2),[['translate',320,0],['scale',-1,1]]);
 assert.equal(patch.assetId,undefined,'changed pixels cannot retain the old managed asset identity');
 assert.equal(patch.thumbnailHref,undefined,'old LOD proxies must be invalidated');
 assert.equal(patch.originalHref,patch.href);
 assert.equal(image.href,'old','source remains untouched for undo');
 calls.length=0;
 await transformReferenceImage(image,'flip-v');
 assert.deepEqual(calls.slice(0,2),[['translate',0,180],['scale',1,-1]]);
 await transformReferenceImage(image,'grayscale');
 assert.equal(context.filter,'grayscale(1)');
 console.log('Context menu and image transform checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
