// 合并面板（使用说明 / 帮助与反馈）的页签切换：只测「切页签 + 只 showModal 一次」，
// 不碰表单提交（那条链路由 feedback 的接口契约覆盖）。
// 先把假 document 装到全局，再动态 import —— 模块里的 wired 标志是按进程记的，
// 静态 import 会抢在 stub 之前执行。
import test from 'node:test';
import assert from 'node:assert/strict';

function tabNode(name){
 const node={dataset:{helpTab:name},attrs:{},classes:new Set(),listeners:{}};
 node.classList={toggle:(cls,on)=>{if(on)node.classes.add(cls);else node.classes.delete(cls);}};
 node.setAttribute=(key,value)=>{node.attrs[key]=value;};
 node.addEventListener=(event,handler)=>{node.listeners[event]=handler;};
 node.click=()=>node.listeners.click?.(node);
 return node;
}

function panelNode(name){
 return {dataset:{helpPanel:name},hidden:false};
}

const tabs=[tabNode('guide'),tabNode('feedback')];
const panels=[panelNode('guide'),panelNode('feedback')];
const dialog={open:false,modalOpens:0,showModal(){this.open=true;this.modalOpens+=1;}};

globalThis.document={
 querySelectorAll(selector){
  if(selector==='[data-help-tab]')return tabs;
  if(selector==='[data-help-panel]')return panels;
  return [];
 },
 getElementById(id){return id==='help-dialog'?dialog:null;},
};

const {openHelp,showHelpTab}=await import('../src/library/help-panel.js');

const visible=()=>panels.filter(panel=>!panel.hidden).map(panel=>panel.dataset.helpPanel);
const selected=()=>tabs.filter(tab=>tab.attrs['aria-selected']==='true').map(tab=>tab.dataset.helpTab);

test('打开面板默认停在「使用说明」',()=>{
 openHelp();
 assert.deepEqual(visible(),['guide']);
 assert.deepEqual(selected(),['guide']);
 assert.equal(dialog.open,true);
 assert.equal(dialog.modalOpens,1);
});

test('反馈入口直接把面板切到第二页，且不重复 showModal',()=>{
 openHelp('feedback');
 assert.deepEqual(visible(),['feedback']);
 assert.deepEqual(selected(),['feedback']);
 assert.equal(tabs[1].classes.has('active'),true);
 assert.equal(tabs[0].classes.has('active'),false);
 assert.equal(dialog.modalOpens,1);
});

test('点页签可以切回使用说明',()=>{
 openHelp('feedback');
 tabs[0].click();
 assert.deepEqual(visible(),['guide']);
 assert.deepEqual(selected(),['guide']);
});

test('未知页签名回落到使用说明，不把面板切成空白',()=>{
 openHelp('nope');
 assert.deepEqual(visible(),['guide']);
 assert.deepEqual(selected(),['guide']);
 assert.equal(showHelpTab('also-nope'),'guide');
});
