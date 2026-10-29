import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../scripts/start-library-background.mjs',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('async function stopOldIfNeeded()'),source.indexOf('/** 用默认浏览器'));
function launch(jobs,current=false){
 let replaced=0;
 const sandbox={discoverOwner:async()=>({pid:123}),capabilities:async()=>({}),serverIsCurrent:()=>current,fetch:async()=>({ok:true,json:async()=>({jobs})}),AbortSignal,replaceLibraryOwner:()=>{replaced++;return true;},note(){},base:'http://127.0.0.1:7579',fs:{rmSync(){}},pidPath:'test.pid',projectServerPids:()=>[],console:{log(){}},sleep:async()=>{}};
 vm.runInNewContext(handler,sandbox);
 return {run:()=>sandbox.stopOldIfNeeded(),replaced:()=>replaced};
}
test('发现已是新版的安装后台时复用，不接管进程',async()=>{
 const app=launch([],true);assert.equal(await app.run(),true);assert.equal(app.replaced(),0);
});
test('空闲旧后台允许升级，运行或排队任务阻止接管',async()=>{
 const idle=launch([{state:'saved'}]);assert.equal(await idle.run(),false);assert.equal(idle.replaced(),1);
 for(const state of ['running','transferring','validating','saving','queued','retry_wait']){
  const busy=launch([{state}]);await assert.rejects(busy.run(),/旧后台有下载任务/);assert.equal(busy.replaced(),0);
 }
 const unknown=launch(null);await assert.rejects(unknown.run(),/无法确认旧后台任务状态/);assert.equal(unknown.replaced(),0);
});
