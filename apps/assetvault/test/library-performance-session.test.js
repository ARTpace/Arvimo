import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
test('同时进入画布仅初始化一次，失败释放后可重试',async()=>{
 const block=app.slice(app.indexOf('let canvasEntry=null;'),app.indexOf('async function initializeCanvas(){'));
 let starts=0,release;
 const context=vm.createContext({initializeCanvas:()=>{starts++;return new Promise((resolve,reject)=>release={resolve,reject});}});
 vm.runInContext(block+'this.enter=enterCanvas;',context);
 const a=context.enter(),b=context.enter();assert.equal(a,b);assert.equal(starts,1);
 release.reject(Error('首次初始化失败'));await assert.rejects(a,/首次初始化失败/);
 const c=context.enter();assert.equal(starts,2);release.resolve('ready');assert.equal(await c,'ready');
});
test('图片任务监测复用下载UI刷新，不另发下载快照请求且保留强制扫描',async()=>{
 const block=app.slice(app.indexOf('async function runPoll(){'),app.indexOf('schedulePoll();\nconst {counts'));
 let refreshes=0,scans=0,scheduled=0;
 const context=vm.createContext({pollRunning:false,pollTimer:1,pollSteady:false,liveImageKey:'',document:{hidden:false},downloads:{connected:true,jobs:[{id:'image',kind:'images',state:'running',fileExists:true}],refresh:async()=>{refreshes++;}},scanLibraryFiles:async force=>{assert.equal(force,true);scans++;},schedulePoll:()=>{scheduled++;},fetch:()=>{throw Error('不应另发请求');}});
 vm.runInContext(block+'this.run=runPoll;',context);await context.run();
 assert.equal(refreshes,0);assert.equal(scans,1);assert.equal(scheduled,1);
});

test('画布304复用上次文档，不读响应JSON；服务器变更后更新基准',async()=>{
 const source=readFileSync(new URL('../src/library/artflow-embed.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
 const start=source.indexOf("let savedEtag='',savedDocument=null;");
 const end=source.indexOf('/** 画布内容变了就存档。',start);
 let calls=0;const doc={boards:[],nodes:[],assets:[]};
 const context=vm.createContext({LOCAL_HEADERS:{'X-SFX-Local':'1'},fetch:async(url,options)=>{
  calls++;
  if(calls===1){assert.equal(options.headers['If-None-Match'],undefined);return {ok:true,status:200,headers:{get:()=> 'version-one'},json:async()=>doc};}
  assert.equal(options.headers['If-None-Match'],'version-one');return {status:304,json:()=>{throw Error('304不可解析JSON');}};
 }});
 vm.runInContext(source.slice(start,end)+'this.fetchSaved=fetchSaved;',context);
 const first=await context.fetchSaved(),next=await context.fetchSaved();
 assert.equal(first.saved,next.saved);assert.equal(calls,2);
});
