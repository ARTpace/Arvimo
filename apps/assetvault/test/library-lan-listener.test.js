import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {scryptSync} from 'node:crypto';
import {createLanSharing} from '../server/lan-sharing.mjs';
import {createLanListener} from '../server/lan-listener.mjs';
import {listenPort} from '../server/listen-port.mjs';

const host=Object.values(os.networkInterfaces()).flat().find(item=>item.family==='IPv4'&&!item.internal&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))?.address;
const close=async server=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));};
async function freePort(){const server=http.createServer();const port=await listenPort(server,{host,port:0});await close(server);return port;}
async function fixture(t,port){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-dual-port-'));
 const file=path.join(dir,'sharing.json'),salt='a'.repeat(32);
 await fs.writeFile(file,JSON.stringify({enabled:true,port,salt,hash:scryptSync('test-password',salt,32).toString('hex')}));
 const sharing=createLanSharing({file,interfaces:()=>({eth:[{family:'IPv4',internal:false,address:host}]})});
 let count=0;
 const local=http.createServer(async(req,res)=>{
  try{if(await sharing.handle(req,res))return;res.end(JSON.stringify({count:++count}));}
  catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
 });
 const listener=createLanListener(local,sharing);
 await listenPort(local,{port:0,reservedPort:port});
 t.after(async()=>{await listener.close();await close(local);await fs.rm(dir,{recursive:true,force:true});});
 const base=()=>`http://127.0.0.1:${local.address().port}`;
 const save=async input=>(await fetch(base()+'/api/lan/settings',{method:'POST',headers:{'x-sfx-local':'1'},body:JSON.stringify(input)})).json();
 return {sharing,listener,local,base,save,file};
}

test('本机仅监听回环；改变本机端口不会改变分享链接或访客会话，两个入口共用状态', {skip:!host,timeout:20000},async t=>{
 const port=await freePort(),f=await fixture(t,port);
 await f.listener.sync();
 assert.equal(f.local.address().address,'127.0.0.1');
 assert.notEqual(f.local.address().port,port);
 const link=f.sharing.status(f.local.address().port).addresses[0];
 assert.equal(link,`http://${host}:${port}/`);
 const login=await fetch(link+'api/lan/login',{method:'POST',body:'username=tester&password=test-password',redirect:'manual'});
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await (await fetch(f.base()+'/counter')).json()).count,1);
 assert.equal((await (await fetch(link+'counter',{headers:{cookie}})).json()).count,2);
 const old=f.local.address().port;
 await close(f.local);await listenPort(f.local,{port:0,reservedPort:port});
 assert.notEqual(f.local.address().port,old);
 assert.deepEqual(f.sharing.status(f.local.address().port).addresses,[link]);
 assert.equal((await (await fetch(link+'counter',{headers:{cookie}})).json()).count,3);
 assert.equal((await (await fetch(f.base()+'/counter')).json()).count,4);
 await assert.rejects(fetch(`http://${host}:${f.local.address().port}/counter`),'本机入口不能通过局域网地址访问');
});

test('分享冲突只影响分享，释放占用后重试仍用原链接，关闭分享会释放监听', {skip:!host,timeout:20000},async t=>{
 const other=http.createServer((_req,res)=>res.end('other-tool'));
 const port=await listenPort(other,{port:0,host});
 t.after(()=>close(other));
 const f=await fixture(t,port);await f.listener.sync();
 assert.equal(f.sharing.status().portConflict,true);
 assert.deepEqual(f.sharing.status().addresses,[]);
 assert.equal((await (await fetch(f.base()+'/counter')).json()).count,1);
 assert.equal(await (await fetch(`http://${host}:${port}/`)).text(),'other-tool');
 await close(other);await f.save({enabled:true});
 assert.equal(f.sharing.status().available,true);
 assert.equal(f.sharing.status().sharingPort,port);
 assert.equal(f.sharing.status().portChanged,false);
 await f.save({enabled:false});
 assert.equal(f.sharing.status().available,false);
 const reuse=http.createServer();t.after(()=>close(reuse));
 assert.equal(await listenPort(reuse,{port,host}),port);
 assert.equal((await (await fetch(f.base()+'/counter')).json()).count,2);
});

test('手动更换分享端口立即生效并持久化，旧监听释放，本机端口不动', {skip:!host,timeout:20000},async t=>{
 const port=await freePort(),f=await fixture(t,port);await f.listener.sync();
 const localPort=f.local.address().port,next=await freePort();
 const refused=await f.save({enabled:true,sharingPort:localPort});
 assert.match(refused.error,/不能与本机入口端口相同/);
 const state=await f.save({enabled:true,sharingPort:next});
 assert.equal(state.available,true);assert.equal(state.portChanged,true);
 assert.equal(state.previousPort,port);assert.deepEqual(state.addresses,[`http://${host}:${next}/`]);
 assert.equal(f.local.address().port,localPort);
 assert.equal(createLanSharing({file:f.file}).startupPort(4178),next);
 const reuse=http.createServer();t.after(()=>close(reuse));assert.equal(await listenPort(reuse,{port,host}),port);
 await f.save({enabled:true,acknowledgePortChange:true});assert.equal(f.sharing.status().portChanged,false);
 await f.listener.close();
 const finalReuse=http.createServer();t.after(()=>close(finalReuse));assert.equal(await listenPort(finalReuse,{port:next,host}),next);
});
