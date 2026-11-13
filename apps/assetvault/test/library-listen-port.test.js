import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {listenPort} from '../server/listen-port.mjs';

async function setup(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-port-'));
 const servers=[];
 const make=()=>{const s=http.createServer((_req,res)=>res.end('other-tool'));servers.push(s);return s;};
 t.after(async()=>{for(const s of servers)if(s.listening)await new Promise(resolve=>s.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
 return {dir,make};
}
const stop=s=>new Promise(resolve=>s.close(resolve));

test('固定端口空闲时直接绑定并记录，不额外启动监听',async t=>{
 const {dir,make}=await setup(t),probe=make();
 const port=await listenPort(probe,{port:0});await stop(probe);
 const server=make();assert.equal(await listenPort(server,{port,fallback:true,dataDir:dir}),port);
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'server-port.json'))).port,port);
});

test('其他工具占用端口时回退，原服务仍然可用，并能复用备用端口',async t=>{
 const {dir,make}=await setup(t),other=make();
 const port=await listenPort(other,{port:0});
 const app=make(),fallback=await listenPort(app,{port,fallback:true,dataDir:dir});
 assert.notEqual(fallback,port);
 assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'other-tool');
 await stop(app);
 assert.equal(await listenPort(make(),{port,fallback:true,dataDir:dir}),fallback);
});

test('首选和记录的备用端口都被占用时再次回退，不动其他服务',async t=>{
 const {dir,make}=await setup(t);
 const port=await listenPort(make(),{port:0}),saved=await listenPort(make(),{port:0});
 await fs.writeFile(path.join(dir,'server-port.json'),JSON.stringify({port:saved}));
 const actual=await listenPort(make(),{port,fallback:true,dataDir:dir});
 assert.ok(actual!==port&&actual!==saved);
});

test('未启用回退时清楚报端口冲突；损坏的端口记录不影响回退',async t=>{
 const {dir,make}=await setup(t),port=await listenPort(make(),{port:0});
 await assert.rejects(listenPort(make(),{port}),{code:'EADDRINUSE'});
 await fs.writeFile(path.join(dir,'server-port.json'),'broken');
 assert.notEqual(await listenPort(make(),{port,fallback:true,dataDir:dir}),port);
});

for(const shared of [false,true])test(`真实后台${shared?'共享':'本机'}模式冲突回退后报告实际端口，健康接口和原工具都正常`,async t=>{
 const {dir,make}=await setup(t),port=await listenPort(make(),{port:0,host:shared?'0.0.0.0':'127.0.0.1'});
 if(shared)await fs.writeFile(path.join(dir,'lan-sharing.json'),JSON.stringify({enabled:true,salt:'a'.repeat(32),hash:'b'.repeat(64),port}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server/library.mjs',import.meta.url))],{
  env:{...process.env,SFX_DATA_DIR:dir,SFX_DOWNLOAD_DIR:dir,SFX_PORT:String(port),SFX_PORT_FALLBACK:'1',SFX_NO_SYSTEM_PROXY:'1'},
  windowsHide:true,stdio:['ignore','pipe','pipe'],
 });
 const exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await exited;}});
 let output='',errors='';child.stderr.on('data',chunk=>{errors+=chunk;});
 const actual=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error(`启动超时：${output} ${errors}`)),20000);
  child.once('exit',()=>{clearTimeout(timer);reject(Error(`后台退出：${errors}`));});
  child.stdout.on('data',chunk=>{
   output+=chunk;
   const match=output.match(/ASSETVAULT_READY_PORT=(\d+)/);
   if(match){clearTimeout(timer);resolve(Number(match[1]));}
  });
 });
 assert.notEqual(actual,port);
 assert.equal((await (await fetch(`http://127.0.0.1:${actual}/api/health`)).json()).name,'assetvault-local-library');
 assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'other-tool');
 const settings=`http://127.0.0.1:${actual}/api/lan/settings`;
 const before=await (await fetch(settings,{headers:{'x-sfx-local':'1'}})).json();
 assert.equal(before.portConflict,shared,JSON.stringify(before));
 if(shared){
  assert.equal(before.sharingPort,port);
  assert.deepEqual(before.addresses,[]);
  const probe=make(),newPort=await listenPort(probe,{port:0});await stop(probe);
  const after=await (await fetch(settings,{method:'POST',headers:{'x-sfx-local':'1','Content-Type':'application/json'},body:JSON.stringify({enabled:true,sharingPort:newPort})})).json();
  assert.equal(after.portConflict,false);assert.equal(after.portChanged,true);assert.equal(after.sharingPort,newPort);assert.equal(after.available,true,JSON.stringify(after));
  if(after.addresses.length)assert.match(await (await fetch(after.addresses[0])).text(),/访问密码/);
 }
});
