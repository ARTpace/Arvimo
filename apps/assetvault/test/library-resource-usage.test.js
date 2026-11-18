import test from 'node:test';
import assert from 'node:assert/strict';
import {selectAppProcesses,createResourceUsage} from '../server/resource-usage.mjs';
import {createResourceUsagePanel,resourceUsageHtml} from '../src/library/resource-usage.js';
import {parseHTML} from 'linkedom';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLibraryServer} from '../server/library.mjs';

const rows=[
 {pid:1,ppid:0,name:'explorer.exe'},
 {pid:2,ppid:1,name:'arvimo.exe'},
 {pid:3,ppid:2,name:'node.exe',memory:100,cpu:1,started:'a'},
 {pid:4,ppid:2,name:'msedgewebview2.exe',command:'--type=renderer',memory:200,cpu:2,started:'a'},
 {pid:5,ppid:4,name:'msedgewebview2.exe',command:'--type=gpu-process',memory:150,cpu:3,started:'a'},
 {pid:6,ppid:1,name:'chrome.exe',memory:9999,cpu:999},
 {pid:7,ppid:3,name:'blender.exe',memory:120,cpu:1,started:'a'},
];
const system={totalmem:()=>10000,freemem:()=>5000,availableParallelism:()=>8};

test('进程归属只包含宿主及后代，开发终端和其它浏览器排除',()=>{
 assert.deepEqual(selectAppProcesses(rows,3).map(row=>row.pid),[2,3,4,5,7]);
 const dev=rows.map(row=>row.pid===2?{...row,name:'powershell.exe'}:row);
 assert.deepEqual(selectAppProcesses(dev,3).map(row=>row.pid),[3,7]);
});

test('CPU增量、PID复用、暂停后基线、合并请求与隐私字段',async()=>{
 let time=10000,source=structuredClone(rows),calls=0;
 const monitor=createResourceUsage({readProcesses:async()=>{calls++;return source;},pid:3,now:()=>time,system});
 const [first,shared]=await Promise.all([monitor.sample(),monitor.sample()]);
 assert.equal(first,shared);assert.equal(calls,1);
 assert.equal(first.memory.app,570);assert.equal(first.scope,'desktop');
 assert.equal(first.cpu.pending,5);
 assert.equal(JSON.stringify(first).includes('--type'),false);
 time+=3000;
 source=source.map(row=>({...row,cpu:(row.cpu||0)+3}));
 const second=await monitor.sample();
 assert.equal(second.groups.find(group=>group.label==='界面').cpu,100);
 assert.equal(second.cpu.percent,400);
 time+=3000;source=source.map(row=>row.pid===4?{...row,started:'new',cpu:0}:row);
 assert.equal((await monitor.sample()).groups.find(group=>group.label==='界面').cpuPending,1);
 time+=40000;assert.equal((await monitor.sample()).cpu.pending,5);
});

test('私有驻留和提交独立汇总，共享工作集不参与系统内存拆分',async()=>{
 const source=rows.map(row=>({...row,privateWorkingSet:(row.memory||0)/2,privateCommit:(row.memory||0)*2}));
 const data=await createResourceUsage({readProcesses:async()=>source,pid:3,system}).sample();
 assert.equal(data.memory.workingSet,570);
 assert.equal(data.memory.privateWorkingSet,285);
 assert.equal(data.memory.privateCommit,1140);
 assert.equal(data.memory.used,5000);
 const renderer=data.groups.find(group=>group.label==='界面');
 assert.equal(renderer.privateWorkingSet,100);assert.equal(renderer.privateCommit,400);
 const html=resourceUsageHtml(data);
 assert.match(html,/工具私有驻留内存/);assert.match(html,/系统已用/);
 assert.doesNotMatch(html,/ru-bar-app|其它已用|undefined|NaN/);
});

test('读取失败和不支持的平台显示不可用，不把工作集冒充私有驻留',async()=>{
 const source=rows.map(row=>({...row,privateWorkingSet:0,privateCommit:0}));
 delete source.find(row=>row.pid===4).privateWorkingSet;
 const data=await createResourceUsage({readProcesses:async()=>source,pid:3,system}).sample();
 assert.equal(data.memory.privateWorkingSet,null);assert.equal(data.memory.privateCommit,0);
 assert.equal(data.groups.find(group=>group.label==='界面').privateWorkingSet,null);
 assert.match(resourceUsageHtml(data),/工具私有驻留内存<\/span><strong>不可用/);
 const fallback=await createResourceUsage({readProcesses:null,pid:3,system}).sample();
 assert.equal(fallback.memory.privateWorkingSet,null);assert.equal(fallback.memory.privateCommit,null);
 assert.ok(fallback.memory.workingSet>0);
});

test('面板仅在打开时取样，关闭与隐藏停止，重开后忽略过期响应',async t=>{
 const {document,window}=parseHTML('<html><body><button id="entry">资源占用</button></body></html>');
 const oldDocument=globalThis.document;globalThis.document=document;t.after(()=>{globalThis.document=oldDocument;});
 t.mock.timers.enable({apis:['setTimeout']});t.after(()=>t.mock.timers.reset());
 let release,calls=0;
 const entry=document.querySelector('button');
 const {dialog}=createResourceUsagePanel({entry,fetchImpl:async()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
 dialog.showModal=()=>{dialog.open=true;};dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new window.Event('close'));};
 assert.equal(calls,0);entry.click();assert.equal(calls,1);
 dialog.close();release({ok:true,json:async()=>({})});
 await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(10000);
 assert.equal(calls,1);entry.click();assert.equal(calls,2);
 const monitor=createResourceUsage({readProcesses:async()=>rows,pid:3,system});
 const data=await monitor.sample();release({ok:true,json:async()=>data});
 await new Promise(resolve=>setImmediate(resolve));assert.ok(document.querySelector('.ru-table'));
 Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new window.Event('visibilitychange'));
 t.mock.timers.tick(10000);assert.equal(calls,2);
 assert.doesNotMatch(resourceUsageHtml(data),/undefined|NaN/);
 dialog.close();
});

test('资源接口拒绝无本地标识和跨域请求',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-resource-')),previous=process.env.SFX_DATA_DIR;let server;
 try{process.env.SFX_DATA_DIR=dir;server=createLibraryServer();}finally{if(previous===undefined)delete process.env.SFX_DATA_DIR;else process.env.SFX_DATA_DIR=previous;}
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}/api/resource-usage`;
 assert.equal((await fetch(url)).status,403);
 assert.equal((await fetch(url,{headers:{'X-SFX-Local':'1',Origin:'https://example.com'}})).status,403);
});
