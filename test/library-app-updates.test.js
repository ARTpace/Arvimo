import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppUpdates} from '../src/library/app-updates.js';

function setup(t,{available=true,ready=false,auto=false,failDownload=false}={}){
 const property=(name,descriptor)=>{const original=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,descriptor);t.after(()=>{if(original)Object.defineProperty(globalThis,name,original);else delete globalThis[name];});};
 class Node{
  constructor(){this.nodes=new Map();this.hidden=false;this.open=false;this.classes=new Set();this.classList={toggle:(key,on)=>on?this.classes.add(key):this.classes.delete(key)};}
  querySelector(s){if(!this.nodes.has(s))this.nodes.set(s,new Node());return this.nodes.get(s);}
  append(){} showModal(){this.open=true;} close(){this.open=false;} setAttribute(k,v){this[k]=v;} removeAttribute(k){delete this[k];}
 }
 const doc=new Node(),created=[],calls=[],timers=[];let active=false;
 property('document',{value:{createElement(){const el=new Node();created.push(el);return el;},body:new Node(),querySelector:s=>doc.querySelector(s)},configurable:true});
 property('window',{value:{__TAURI__:{app:{getVersion:async()=>'0.1.12'},core:{invoke:async cmd=>{
  calls.push(cmd);
  if(cmd==='check_app_update')return {available,ready,version:'0.1.13',notes:'fixture notes'};
  if(cmd==='download_app_update'&&failDownload)throw Error('network');
 }},event:{listen:async()=>{}}}},configurable:true});
 property('localStorage',{value:{getItem:()=>String(auto),setItem(){}},configurable:true});
 t.mock.method(globalThis,'setTimeout',fn=>{timers.push(fn);});t.mock.method(globalThis,'setInterval',()=>{});
 const states=[];
 const ui=createAppUpdates({hasActiveTasks:()=>active,onState:state=>states.push(state)}),dialog=created[1];
 return {ui,dialog,doc,calls,timers,states,active:()=>{active=true;}};
}
test('小猫检查更新不弹窗，通过气泡状态执行更新',async t=>{
 const s=setup(t);await Promise.resolve();
 assert.equal(s.doc.querySelector('#app-version').textContent,'v0.1.12');
 await s.ui.check();
 await Promise.resolve();await Promise.resolve();
 assert.equal(s.dialog.open,false);assert.ok(s.states.some(state=>state.available));
 assert.equal(s.dialog.querySelector('[data-notes]').textContent,'fixture notes');
 await s.ui.update();
 assert.deepEqual(s.calls,['check_app_update','download_app_update','install_app_update']);
});
test('自动发现与后台下载不擅自安装，关闭弹窗后提醒保留，活动任务阻止安装',async t=>{
 const s=setup(t,{auto:true});s.ui.start();s.timers[0]();
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(s.dialog.open,false);assert.deepEqual(s.calls,['check_app_update','download_app_update']);
 s.dialog.querySelector('[data-dismiss]').onclick();
 assert.equal(s.dialog.open,false);assert.ok(s.states.some(state=>state.phase==='ready'));
 s.active();await s.dialog.querySelector('[data-install]').onclick();
 assert.equal(s.calls.includes('install_app_update'),false);
 assert.match(s.dialog.querySelector('[data-status]').textContent,/任务/);
});
test('下载失败保留重试入口',async t=>{
 const s=setup(t,{failDownload:true});s.ui.open();await Promise.resolve();await Promise.resolve();await Promise.resolve();
 await s.dialog.querySelector('[data-install]').onclick();
 assert.match(s.dialog.querySelector('[data-status]').textContent,/下载失败/);
 assert.equal(s.dialog.querySelector('[data-install]').disabled,false);
 assert.equal(s.calls.includes('install_app_update'),false);
});
test('已是最新版时不显示更新徽标或安装按钮',async t=>{
 const s=setup(t,{available:false});s.ui.open();for(let i=0;i<6;i++)await Promise.resolve();
 assert.equal(s.states.at(-1).available,false);
 assert.equal(s.dialog.querySelector('[data-install]').hidden,true);
 assert.match(s.dialog.querySelector('[data-status]').textContent,/最新版本/);
});
