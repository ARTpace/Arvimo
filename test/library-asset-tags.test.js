import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeTags,tagsFor,addAITags,tagPanel,userTagsFor,addUserTag,removeUserTag,listUserTags,renameUserTag,deleteUserTag} from '../src/library/asset-tags.js';
import {loadLibrary,saveLibrary} from '../src/library/library-state.js';
import {filterLocalAssets} from '../src/library/local-filters.js';
import {createCardView} from '../src/library/card-view.js';
import {esc} from '../src/library/html-esc.js';

const uid='a'.repeat(32);
const memory=()=>{const data={};return {getItem:key=>data[key]??null,setItem:(key,value)=>{data[key]=value;}};};
test('保留全部平台标签；补充标签按内容去重，不再缩成一个或截断原标签',()=>{
 const model={uid,tags:Array.from({length:16},(_,i)=>`source-${i}`)};
 const original=[...model.tags],state={aiTags:{}};
 assert.equal(addAITags(state,model,['Robot',' robot ','机器人','source-1',null]),2);
 assert.deepEqual(model.tags,original);
 assert.deepEqual(state.aiTags[uid],['Robot','机器人']);
 assert.equal(tagsFor(state,model).length,18);
 assert.equal(addAITags(state,model,['ROBOT','机器人','metal']),1);
 assert.deepEqual(mergeTags([' tree ','TREE','rock']),['tree','rock']);
});
test('只在发现页整理也能持久保存，关闭重开或平台重新返回元数据不会覆盖 AI 标签',()=>{
 const storage=memory(),state=loadLibrary(storage),model={uid,tags:['platform']};
 addAITags(state,model,['机器人','robot']);saveLibrary(storage,state);
 const restored=loadLibrary(storage);
 assert.deepEqual(restored.models,[]); // 不需要偷偷收藏资产才能保存标签。
 assert.deepEqual(tagsFor(restored,{uid,tags:['new-platform']}),['new-platform','机器人','robot']);
 const rows=[{uid,name:'Asset',tags:tagsFor(restored,model)}];
 assert.equal(filterLocalAssets(rows,{search:'机器人'}).length,1);
});
test('原始和 AI 标签紧凑合并并安全转义，重复标签不重复显示',()=>{
 const html=tagPanel({aiTags:{[uid]:['TREE','<script>']}},{uid,tags:['tree','rock']},esc);
 assert.doesNotMatch(html,/平台标签|AI 标签 ·|<small>/);assert.match(html,/✦ AI标签/);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/>TREE</);
 assert.match(html,/data-action="ai-tags"/);
});
test('所有平台卡片都有统一标签入口，包括只有官方页面的资产',()=>{
 const state={favorites:new Set(),models:[],selected:new Set(),tasks:[]};
 // card-view 现在要的是 sendControl（两步式导出控件），旧名 blenderSendButton 传进来它拿不到。
 const cards=createCardView({state,icon:()=>'',esc,fmt:String,queuePulse:new Map(),
  imageDownload:{},sendControl:()=>'',platformLabel:String,
  artstationUI:()=>({has3dScene:()=>false}),downloadsUI:()=>({jobs:[]})});
 for(const platform of ['sketchfab','artstation','polyhaven','ambientcg','polypizza','kenney','freestylized']){
  const html=cards.card({uid,platform,name:'Asset',license:'CC0',assetType:'packs'});
  assert.match(html,/data-action="asset-tags"/,platform);
 }
});
test('我的标签：增删、跨资产重命名/删除，与平台/AI 层合并检索',()=>{
 const state={aiTags:{},models:[]};
 assert.equal(addUserTag(state,{uid},'robot'),1);
 assert.equal(addUserTag(state,{uid},' robot '),0);
 assert.equal(addUserTag(state,{uid},'metal'),1);
 assert.deepEqual(userTagsFor(state,{uid}),['robot','metal']);
 assert.equal(removeUserTag(state,{uid},'ROBOT'),1);
 assert.deepEqual(userTagsFor(state,{uid}),['metal']);
 state.models=[{uid},{uid:'b'.repeat(32)}];
 addUserTag(state,{uid},'robot');
 assert.deepEqual(listUserTags(state).map(t=>t.name).sort(),['metal','robot']);
 assert.equal(renameUserTag(state,'robot','机甲'),1);
 assert.deepEqual(userTagsFor(state,{uid}),['metal','机甲']);
 assert.equal(deleteUserTag(state,'metal'),1);
 assert.deepEqual(userTagsFor(state,{uid}),['机甲']);
 assert.equal(tagsFor(state,{uid,tags:['src']}).length,2);
});
test('标签面板三层并排：平台可检索、AI 带 ✦、我的带 ×，评分备注同面板',()=>{
 const html=tagPanel({aiTags:{[uid]:['ai-tag']},userTags:{[uid]:['mine']},userMeta:{[uid]:{rating:3,note:'ok'}}},{uid,tags:['platform']},esc);
 assert.match(html,/data-tag="platform"/);
 assert.match(html,/✦ ai-tag/);
 assert.match(html,/data-remove-tag="mine"/);
 assert.match(html,/data-rate="3"/);
 assert.match(html,/>ok</);
 assert.doesNotMatch(html,/data-remove-tag="platform"/);
});
