import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../src/library/splash.js',import.meta.url),'utf8');
function boot(invoke,{interfaceStage=false}={}){
 const nodes=new Map();
 const get=id=>{
  if(!nodes.has(id))nodes.set(id,{style:{},textContent:'',classList:{add(){},remove(){}},addEventListener(){}});
  return nodes.get(id);
 };
 let now=0,removed=false;
 const listeners=new Map();
 const screen={style:{},attachShadow:()=>({getElementById:get}),remove(){removed=true;}};
 const timers=[],frames=[],navigations=[];
 vm.runInNewContext(source,{
  document:{getElementById:id=>id==='startup-screen'?(interfaceStage?screen:null):get(id),documentElement:{dataset:{}}},window:{__TAURI__:{core:{invoke}},addEventListener:(name,fn)=>listeners.set(name,fn)},URL,
  DOMParser:class{parseFromString(){return {querySelector:selector=>selector==='style'?{textContent:'body{}'}:{outerHTML:'<main></main>'}};}},
  location:{pathname:'/waiting.html',replace:url=>navigations.push(url)},
  Date:{now:()=>now},setTimeout:fn=>timers.push(fn),requestAnimationFrame:fn=>frames.push(fn),
  fetch:()=>{if(interfaceStage)return Promise.resolve({ok:true,text:async()=>'<main></main>'});throw Error('桌面加载页不应跨源请求后端');},
 });
 return {get,timers,frames,navigations,listeners,get removed(){return removed;},frame(time){now=time;frames.shift()?.();}};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('桌面启动全程使用本地加载页，服务未就绪不跳转，就绪后直接进入首页',async()=>{
 let ready=false;
 const commands=[];
 const b=boot(async command=>{commands.push(command);return command==='backend_ready_url'&&ready?'http://127.0.0.1:54321/':null;});
 await flush();b.frame(6000);
 assert.deepEqual(b.navigations,[]);
 assert.ok(b.timers.length);
 ready=true;
 for(const timer of b.timers.splice(0))timer();
 await flush();b.frame(6500);b.frame(7000);
 for(const timer of b.timers.splice(0))timer();
 assert.deepEqual(b.navigations,[]);
 assert.ok(commands.includes('open_ready_library'));
 assert.notEqual(b.get('pct').textContent,'100%'); // 100% 留给首页真正初始化完成。
});

test('首页在布局准备好之前保留启动遮罩，收到就绪信号才完成动画',async()=>{
 const b=boot(async()=>null,{interfaceStage:true});
 await flush();b.frame(5000);
 assert.equal(b.removed,false);
 assert.notEqual(b.get('pct').textContent,'100%');
 b.listeners.get('assetvault:ui-ready')();
 b.frame(5100);b.frame(5600);
 for(const timer of b.timers.splice(0))timer();
 assert.equal(b.removed,true);
 assert.equal(b.get('pct').textContent,'100%');
});

test('服务启动失败留在同一加载卡片显示错误，迟到动画不覆盖错误',async()=>{
 const b=boot(async command=>command==='backend_startup_error'?'本地服务启动失败：测试':null);
 b.frame(500);
 await flush();
 for(const timer of b.timers.splice(0))timer();
 assert.equal(b.get('msg').textContent,'启动未完成');
 assert.match(b.get('tip').textContent,/本地服务启动失败/);
 assert.deepEqual(b.navigations,[]);
});

test('本地加载页复用吉祥物布局和脚本，不再显示蓝色圆点动画',()=>{
 const html=readFileSync(new URL('../sketchfab-exporter-tauri/src/waiting.html',import.meta.url),'utf8');
 assert.match(html,/id="hero"/);assert.match(html,/src="splash.js"/);
 assert.doesNotMatch(html,/class="dots"/);
 const rust=readFileSync(new URL('../sketchfab-exporter-tauri/src-tauri/src/main.rs',import.meta.url),'utf8');
 assert.match(rust,/fn open_ready_library/);
 assert.doesNotMatch(source,/location\.replace\(home\)/);
});
