import test from 'node:test';
import assert from 'node:assert/strict';
import {openSiteLogin,bindSiteLogin} from '../src/library/site-login.js';

const originalFetch=globalThis.fetch;
const jsonResponse=(data,ok=true)=>({ok,json:async()=>data});
/** 轮询是 async 的（fetch → json 至少两次 await），tick 之后要把微任务跑干净再断言。 */
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};

test('开窗只发一次 POST，窗口还开着就不重跑，关掉之后才回调',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const calls=[],closed=[];
 let polls=0;
 globalThis.fetch=async(url,options={})=>{
  const method=options.method||'GET';
  calls.push({url,method,body:options.body});
  if(method==='POST')return jsonResponse({ok:true});
  polls+=1;
  return jsonResponse({open:polls<3});
 };
 try{
  await openSiteLogin('xiaohongshu',{onClosed:()=>closed.push('closed'),toast:()=>{}});
  assert.equal(calls[0].method,'POST','先开窗');
  assert.equal(calls[0].url,'/api/browser/login');
  assert.deepEqual(JSON.parse(calls[0].body),{platform:'xiaohongshu'},'要带上平台 id，服务端靠它查登录入口');
  await t.mock.timers.tick(2500);await flush();
  assert.deepEqual(closed,[],'窗口还开着就不能重跑解析');
  await t.mock.timers.tick(2500);await flush();
  assert.deepEqual(closed,[],'第二次轮询仍开着，继续等');
  await t.mock.timers.tick(2500);await flush();
  assert.deepEqual(closed,['closed'],'窗口关掉＝用户登完了，这时才回调');
 }finally{globalThis.fetch=originalFetch;t.mock.timers.reset();}
});

test('窗口打不开要把服务端的原因抛出去，而不是静默失败',async()=>{
 globalThis.fetch=async()=>jsonResponse({error:'这个站点没有登记登录入口'},false);
 try{
  await assert.rejects(()=>openSiteLogin('unknown',{toast:()=>{}}),/没有登记登录入口/);
 }finally{globalThis.fetch=originalFetch;}
});

test('bindSiteLogin：等待期间禁用按钮，窗口关掉后恢复可点并重跑',async t=>{
 t.mock.timers.enable({apis:['setInterval']});
 let polls=0,reloads=0;
 globalThis.fetch=async(url,options={})=>{
  if((options.method||'GET')==='POST')return jsonResponse({ok:true});
  polls+=1;
  return jsonResponse({open:polls<2});
 };
 const button={disabled:false,onclick:null};
 bindSiteLogin(button,'xiaohongshu',{toast:()=>{},onClosed:()=>{reloads+=1;}});
 try{
  const pending=button.onclick();
  assert.equal(button.disabled,true,'开窗期间要禁用，避免连点开出第二个窗口');
  await pending;
  assert.equal(button.disabled,true,'窗口开着就一直禁用');
  await t.mock.timers.tick(2500);await flush();
  assert.equal(button.disabled,true,'第一次轮询还开着，继续等，别提前重跑');
  assert.equal(reloads,0);
  await t.mock.timers.tick(2500);await flush();
  assert.equal(button.disabled,false,'窗口关掉要恢复可点');
  assert.equal(reloads,1,'登录完必须重跑那一次解析，否则用户还是看不到内容');
 }finally{globalThis.fetch=originalFetch;t.mock.timers.reset();}
});

test('开窗失败时按钮立刻恢复，并把原因说出来',async()=>{
 globalThis.fetch=async()=>jsonResponse({error:'打开登录窗口失败'},false);
 const messages=[];
 const button={disabled:false,onclick:null};
 bindSiteLogin(button,'zcool',{toast:message=>messages.push(message)});
 try{
  await button.onclick();
  assert.equal(button.disabled,false,'失败不能把按钮永久卡死');
  assert.deepEqual(messages,['打开登录窗口失败']);
 }finally{globalThis.fetch=originalFetch;}
});
