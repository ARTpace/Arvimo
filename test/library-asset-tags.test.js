import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeTags,tagsFor,addAITags,tagPanel} from '../src/library/asset-tags.js';
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
test('平台和 AI 标签分组展示并安全转义，重复标签不重复显示',()=>{
 const html=tagPanel({aiTags:{[uid]:['TREE','<script>']}},{uid,tags:['tree','rock']},esc);
 assert.match(html,/平台标签/);assert.match(html,/保存在本机/);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/>TREE</);
 assert.match(html,/data-action="ai-tags"/);
});
test('所有平台卡片都有统一标签入口，包括只有官方页面的资产',()=>{
 const state={favorites:new Set(),models:[],selected:new Set(),tasks:[]};
 const cards=createCardView({state,icon:()=>'',esc,fmt:String,queuePulse:new Map(),
  imageDownload:{},blenderSendButton:()=>'',platformLabel:String,
  artstationUI:()=>({has3dScene:()=>false}),downloadsUI:()=>({jobs:[]})});
 for(const platform of ['sketchfab','artstation','polyhaven','ambientcg','polypizza','kenney','freestylized']){
  const html=cards.card({uid,platform,name:'Asset',license:'CC0',assetType:'packs'});
  assert.match(html,/data-action="asset-tags"/,platform);
 }
});
