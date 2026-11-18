import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCardGroupUI} from '../src/library/card-group-ui.js';
import {groupMenuItems,assetMenuItems} from '../src/library/card-context-menu.js';

test('FBX集合封面接入模型缩略图生成，不把模型当普通图片读取',()=>{
 const {document}=parseHTML('<html><body><div id="grid"></div></body></html>');
 const state={route:'library',filter:'all',options:{cardGroups:[{id:'fbx',type:'album',name:'模型',children:[{kind:'file',key:'J:/assets|a.FBX',root:'J:/assets',rel:'a.FBX',level:'item',fileKind:'model'}]}]},search:'',selected:new Set()};
 const ui=createCardGroupUI({state,doc:document,localFiles:{entries:()=>[],packages:()=>[]},cardView:{imageUrl:()=>''},findModel:()=>null,esc:String,icon:()=>'',persist(){},render(){},toast(){}});
 document.getElementById('grid').innerHTML=ui.extras()[0].html;
 const image=document.querySelector('img.model-thumb');assert.ok(image);
 assert.equal(new URL(image.getAttribute('src'),'http://local').searchParams.get('rel'),'a.FBX');
});

test('普通模型拖到材质卡生成集合，单击进入后成员可见，返回与解散恢复原卡',async()=>{
 const {document,window}=parseHTML('<html><body><div id="grid"><article data-uid="a"></article><article data-uid="b"></article></div></body></html>');
 const models=[{uid:'a',name:'模型',assetType:'models'},{uid:'b',name:'材质',assetType:'textures'}];
 const state={route:'library',filter:'all',options:{},search:'',selected:new Set(),models};
 let saves=0;
 const ui=createCardGroupUI({state,doc:document,localFiles:{entries:()=>[],packages:()=>[],resetAlbumFolder(){}},cardView:{imageUrl:()=>''},findModel:id=>models.find(m=>m.uid===id),esc:s=>String(s||''),icon:()=>'',persist:()=>saves++,render(){},toast(){}});
 const cards=document.querySelectorAll('article');
 await ui.drop(ui.source(cards[0]),cards[1]);
 assert.equal(saves,1);assert.equal(ui.acceptsModel(models[0]),false);assert.equal(ui.extras().length,1);
 document.getElementById('grid').innerHTML=ui.extras()[0].html;
 document.querySelector('[data-card-group]').dispatchEvent(new window.Event('click',{bubbles:true}));
 assert.equal(ui.active(),true);assert.deepEqual(ui.models().map(m=>m.uid),['b','a']);
 assert.equal(document.querySelector('.drag-group-nav').hidden,false);
 document.querySelector('[data-group-back]').click();assert.equal(ui.active(),false);
 document.querySelector('[data-card-group]').click();document.querySelector('[data-group-dissolve]').click();
 assert.equal(ui.active(),false);assert.equal(ui.acceptsModel(models[0]),true);assert.equal(ui.extras().length,0);
});

test('拆分单个成员后原资产回全部资产，解散清掉整组',async()=>{
 const {document,window}=parseHTML('<html><body><div id="grid"><article data-uid="a"></article><article data-uid="b"></article></div></body></html>');
 const models=[{uid:'a',name:'模型',assetType:'models'},{uid:'b',name:'材质',assetType:'textures'}];
 const state={route:'library',filter:'all',options:{},search:'',selected:new Set(),models};
 const ui=createCardGroupUI({state,doc:document,localFiles:{entries:()=>[],packages:()=>[],resetAlbumFolder(){}},cardView:{imageUrl:()=>''},findModel:id=>models.find(m=>m.uid===id),esc:s=>String(s||''),icon:()=>'',persist(){},render(){},toast(){}});
 const cards=document.querySelectorAll('article');
 await ui.drop(ui.source(cards[0]),cards[1]);
 const grid=document.getElementById('grid');
 grid.innerHTML=ui.extras()[0].html;
 document.querySelector('[data-card-group]').click();
 assert.equal(ui.active(),true);
 const refA=ui.refOf(cards[0]);
 assert.equal(ui.split(refA),true);
 assert.deepEqual(ui.models().map(m=>m.uid),['b']);
 assert.equal(ui.split(refA),false,'重复拆分不应生效');
 document.querySelector('[data-group-back]').click();
 assert.equal(ui.acceptsModel(models[0]),true,'拆出的成员回到全部资产');
 document.querySelector('[data-card-group]').click();
 assert.equal(ui.dissolve(),true);
 assert.equal(ui.active(),false);assert.equal(ui.extras().length,0);
 assert.equal(ui.acceptsModel(models[1]),true);
});

test('右键菜单：合集卡给出解散，成员卡给出从合集移出',()=>{
 let dissolved=0,split=0;
 const group=groupMenuItems({card:{click(){}},row:{name:'测试合集',children:[{},{}]},onDissolve:()=>dissolved++});
 const dissolve=group.items.find(item=>item.label==='解散整个合集');
 assert.ok(dissolve,'合集卡右键应有解散入口');
 assert.equal(group.subtitle,'2 项资产');
 dissolve.run();assert.equal(dissolved,1);
 const asset=assetMenuItems({uid:'a',model:{name:'A'},realm:'library',onGroupSplit:()=>split++});
 const out=asset.items.find(item=>item.label==='从合集移出');
 assert.ok(out,'合集内成员卡右键应有拆分入口');
 out.run();assert.equal(split,1);
 assert.equal(assetMenuItems({uid:'a',model:{name:'A'},realm:'library'}).items.some(item=>item.label==='从合集移出'),false,'不在合集时不显示拆分');
});

test('模型合集不出现在文档视频音频筛选，嵌套混合集按实际成员匹配',()=>{
 const {document}=parseHTML('<html><body><div id="grid"></div></body></html>');
 const asset=(key,assetType)=>({kind:'asset',key,summary:{uid:key,assetType}});
 const rows=[
  {id:'model',type:'album',name:'模型合集',children:[asset('m','models')]},
  {id:'mixed',type:'album',name:'混合集',children:[asset('d','documents'),asset('v','videos'),asset('a','audio')]},
  {id:'folder',type:'folder',name:'合集文件夹',children:[{kind:'group',key:'mixed'}]},
 ];
 const state={route:'library',filter:'all',search:'',options:{cardGroups:rows},selected:new Set()};
 const ui=createCardGroupUI({state,doc:document,localFiles:{entries:()=>[],packages:()=>[]},cardView:{imageUrl:()=>''},findModel:()=>null,esc:String,icon:()=>'',persist(){},render(){},toast(){}});
 for(const kind of ['documents','videos','audio']){
  state.contentKind=kind;
  const html=ui.extras().map(card=>card.html).join('');
  assert.ok(!html.includes('data-card-group="model"'),kind);
  assert.ok(html.includes('data-card-group="folder"'),kind);
 }
 state.contentKind='models';
 assert.deepEqual(ui.extras().map(card=>card.name),['模型合集']);
 state.contentKind='';assert.equal(ui.extras().length,2,'无筛选恢复所有顶层合集');
});
