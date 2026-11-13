import test from 'node:test';
import assert from 'node:assert/strict';
import {createAssistantMessages} from '../src/library/assistant-messages.js';
import {createMascotAssistant} from '../src/library/mascot-assistant.js';

function setup(canManageUpdates=false){
 let time=0,next=0,current;const timers=new Map(),renders=[];
 const manager=createAssistantMessages({canManageUpdates,render:message=>{current=message;renders.push(message);},now:()=>time,setTimer:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:time+delay});return id;},clearTimer:id=>timers.delete(id)});
 return {manager,renders,get current(){return current;},advance(ms){time+=ms;for(const [id,timer] of [...timers])if(timer.at<=time){timers.delete(id);timer.fn();}}};
}

test('important messages survive hints; expired pending hints never reappear',()=>{
 const s=setup();
 s.manager.publish({id:'search',text:'搜索中',priority:20,duration:0});
 s.manager.publish({text:'普通问候',duration:100});
 assert.equal(s.current.id,'search');
 s.advance(101);s.manager.clear('search');assert.equal(s.current,null);
});

test('same task merges progress and duplicates do not rerender or extend expiry',()=>{
 const s=setup();
 s.manager.publish({id:'task',text:'下载 1/3',duration:100});
 s.advance(50);s.manager.publish({id:'task',text:'下载 1/3',duration:100});
 assert.equal(s.renders.length,1);
 s.advance(51);assert.equal(s.current,null);
 s.manager.publish({id:'task',text:'下载 2/3'});s.manager.publish({id:'task',text:'下载完成'});
 assert.equal(s.current.text,'下载完成');
});

test('update audience is blocked outside admin desktop; dismissed reminders stay dismissed until explicit reopen',()=>{
 const message={id:'update:2',text:'新版本',priority:50,duration:0,audience:'desktop-admin',rememberDismissal:true};
 const visitor=setup();assert.equal(visitor.manager.publish(message),false);assert.equal(visitor.current,undefined);
 const admin=setup(true);admin.manager.publish(message);admin.manager.dismiss();
 assert.equal(admin.current,null);
 admin.manager.publish({...message,text:'已下载'});assert.equal(admin.current,null);
 admin.manager.publish({...message,force:true});assert.equal(admin.current.id,'update:2');
});

test('search dismissal does not suppress later completion; disposal cancels timers',()=>{
 const s=setup();s.manager.publish({id:'search',text:'搜索中',duration:0});s.manager.dismiss();
 s.manager.publish({id:'search',text:'完成'});assert.equal(s.current.text,'完成');
 s.manager.dispose();const count=s.renders.length;s.advance(9999);assert.equal(s.renders.length,count);
});

test('assistant keeps web greetings ordinary and renders admin update actions without letting hints replace them',t=>{
 class Node{
  constructor(){this.children=[];this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
  replaceChildren(){this.children=[];}append(node){this.children.push(node);}setAttribute(name,value){this[name]=value;}
 }
 const original=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>new Node()}});
 t.after(()=>{if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;});
 const fixture=canManageUpdates=>{
  const bubble=new Node(),mascot=new Node();let checks=0,installs=0,downloads=0,clears=0;
  const assistant=createMascotAssistant({panel:{querySelector:selector=>selector==='#search-mascot'?mascot:bubble},canManageUpdates,random:()=>0,onCheckUpdates:()=>checks++,onInstallUpdate:()=>installs++,onViewDownloads:()=>downloads++,onClearFilters:()=>clears++});
  return {assistant,bubble,mascot,get checks(){return checks;},get installs(){return installs;},get downloads(){return downloads;},get clears(){return clears;}};
 };
 const detail={phase:'available',available:true,version:'2',message:'发现新版本 2',actionLabel:'更新并重启'};
 const web=fixture(false);web.assistant.notify({type:'greeting'});web.assistant.notify({type:'update',detail});
 assert.equal(web.checks,0);assert.match(web.bubble.children[0].textContent,/随时准备搜索/);assert.equal(web.bubble.children.length,1);web.assistant.dispose();
 const admin=fixture(true);admin.assistant.notify({type:'greeting'});assert.equal(admin.checks,1);
 admin.assistant.notify({type:'update',detail});admin.assistant.notify({type:'hint',text:'不要覆盖更新'});
 assert.equal(admin.bubble.children[0].textContent,'发现新版本 2');
 admin.bubble.children[1].onclick();assert.equal(admin.installs,1);
 admin.assistant.dispose();
 const activity=fixture(false);
 activity.assistant.notify({type:'category',label:'材质'});
 assert.equal(activity.mascot['data-expression'],'focused');
 assert.match(activity.bubble.children[0].textContent,/继续输入名称/);
 activity.assistant.notify({type:'category',label:'模型'});
 assert.equal(activity.bubble.children[0].textContent,'已筛选模型');
 activity.assistant.notify({type:'empty'});activity.bubble.children[1].onclick();assert.equal(activity.clears,1);
 assert.equal(activity.mascot['data-expression'],'curious');assert.equal(activity.mascot['data-effect'],'question');
 activity.assistant.notify({type:'download',phase:'failed',count:2});
 activity.assistant.notify({type:'hint',text:'不能覆盖失败'});
 assert.equal(activity.bubble.children[0].textContent,'2 项下载失败');
 assert.equal(activity.mascot['data-expression'],'worried');
 activity.bubble.children[1].onclick();assert.equal(activity.downloads,1);
 activity.assistant.dispose();
 assert.equal(activity.mascot['data-expression'],'idle');assert.equal(activity.mascot['data-effect'],'none');
 const download=fixture(false);
 download.assistant.notify({type:'download',phase:'started',count:1});
 assert.equal(download.mascot['data-expression'],'focused');assert.equal(download.mascot['data-effect'],'download');
 download.assistant.notify({type:'download',phase:'completed',count:1});
 assert.equal(download.mascot['data-expression'],'happy');assert.equal(download.mascot['data-effect'],'sparkles');
 download.assistant.dispose();
});

test('expression-only changes rerender while identical expressions stay deduplicated; expiry restores idle',()=>{
 const s=setup();
 s.manager.publish({id:'status',text:'状态',expression:'focused',duration:100});
 s.manager.publish({id:'status',text:'状态',expression:'happy',effect:'sparkles',duration:100});
 assert.equal(s.current.expression,'happy');assert.equal(s.renders.length,2);
 s.manager.publish({id:'status',text:'状态',expression:'happy',effect:'sparkles',duration:100});
 assert.equal(s.renders.length,2);s.advance(101);assert.equal(s.current,null);
});

test('debug snapshots are read-only copies without executable actions and expire with messages',()=>{
 const s=setup();s.manager.publish({id:'download',text:'下载完成',expression:'happy',priority:30,duration:100,actions:[{label:'查看',run:()=>{throw Error('must not run');}}]});
 s.manager.publish({id:'hint',text:'等待中的提示',duration:100});
 const snapshot=s.manager.inspect();assert.equal(snapshot[0].current,true);assert.equal(snapshot[1].current,false);assert.equal(snapshot[0].remaining,100);assert.equal(snapshot[0].actions,undefined);
 snapshot[0].text='改动副本';assert.equal(s.current.text,'下载完成');
 s.advance(101);assert.deepEqual(s.manager.inspect(),[]);
});
