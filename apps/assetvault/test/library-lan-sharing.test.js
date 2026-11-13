import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createLanSharing} from '../server/lan-sharing.mjs';

const LOGIN_BODY='username=tester&password=test-password';

test('共享端口固定，冲突时仅本机可用，显式换端口后显示并保留重新分享提醒',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-share-port-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'sharing.json');
 const options={file,interfaces:()=>({eth:[{family:'IPv4',internal:false,address:'192.168.1.10'}]})};
 let service=createLanSharing(options);
 let state={activePort:4178,errorCode:''};
 function attach(){service.attachListener({state:()=>state,sync:async()=>{const port=service.status().sharingPort;if(port!==4178)state={activePort:port,errorCode:''};}});}
 attach();
 async function request(local,port,input){
  const req=Readable.from([input?JSON.stringify(input):'']);req.url=input?'/api/lan/settings':'/';req.method=input?'POST':'GET';
  req.socket={localPort:port,remoteAddress:local?'127.0.0.1':'192.168.1.20'};
  req.headers={host:`${local?'127.0.0.1':'192.168.1.10'}:${port}`,'x-sfx-local':'1'};
  const res={writeHead(code){this.code=code;},end(body){this.body=body;}};
  res.handled=await service.handle(req,res);return res;
 }
 await request(true,4178,{enabled:true,password:'test-password'});
 service=createLanSharing(options);
 state={activePort:null,errorCode:'EADDRINUSE'};attach();
 assert.equal(service.startupPort(5000),4178);
 assert.equal(service.status(5000).portConflict,true);
 assert.deepEqual(service.status(5000).addresses,[]);
 assert.equal((await request(true,5000)).handled,false);
 assert.equal((await request(false,5000)).code,403);
 await request(true,5000,{enabled:true});
 assert.equal(service.status(5000).portConflict,true,'普通保存不能悄悄切换共享端口');
 await request(true,5000,{enabled:true,sharingPort:6000});
 assert.equal(service.status(5000).portConflict,false);
 assert.equal(service.status(5000).portChanged,true);
 assert.deepEqual(service.status(5000).addresses,['http://192.168.1.10:6000/']);
 assert.equal((await request(false,6000)).code,200);
 service=createLanSharing(options);attach();
 assert.equal(service.startupPort(4178),6000);
 // 待确认提示由换端口那次 POST 的响应负责，落盘的 previousPort 在 startupPort 里被消费掉，
 // 否则每次启动都会把设置页掀开（见 lan-sharing.mjs:69-72）。
 assert.equal(service.status(5000).portChanged,false,'重启消费掉待确认提醒，不再每次启动掀设置页');
 await request(true,5000,{enabled:true,acknowledgePortChange:true});
 assert.equal(service.status(5000).portChanged,false);
 await request(true,5000,{enabled:false});
 assert.equal(service.startupPort(4178),4178);
});

test('旧版共享配置迁移时固定原端口，不更改密码',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-share-migrate-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'sharing.json');
 const saved={enabled:true,salt:'a'.repeat(32),hash:'b'.repeat(64)};
 fs.writeFileSync(file,JSON.stringify(saved));
 const service=createLanSharing({file});
 assert.equal(service.startupPort(5000),5000);
 assert.equal(service.status(5000).portChanged,true,'旧版迁移当次必须提示核对链接');
 const restarted=createLanSharing({file});
 assert.equal(restarted.startupPort(4178),5000);
 assert.equal(restarted.status(5000).portChanged,false,'提示只在迁移当次显示，重启后不再骚扰');
 assert.equal(JSON.parse(fs.readFileSync(file)).hash,saved.hash);
});

test('LAN access requires a name and a password and local administration; sessions expire and are revoked',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assetvault-lan-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'sharing.json');let time=1000;
 const options={file,interfaces:()=>({eth:[{family:'IPv4',internal:false,address:'192.168.1.10'}]}),now:()=>time};
 const service=createLanSharing(options);
 async function request(url,{local=false,method='GET',body='',headers={},ip}={}){
  const req=Readable.from([body]);req.url=url;req.method=method;
  req.socket={localPort:4178,remoteAddress:ip||(local?'127.0.0.1':'192.168.1.20')};
  req.headers={host:local?'127.0.0.1:4178':'192.168.1.10:4178',...headers};
  const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
  res.handled=await service.handle(req,res);return res;
 }
 const save=password=>request('/api/lan/settings',{local:true,method:'POST',headers:{'x-sfx-local':'1'},body:JSON.stringify({enabled:true,password})});
 assert.equal((await request('/')).status,403);
 assert.equal((await request('/api/lan/settings',{local:true})).status,403);
 await assert.rejects(save('short'),/8–128/);
 assert.equal((await save('test-password')).status,200);
 assert.ok(!fs.readFileSync(file,'utf8').includes('test-password'));
 assert.equal(createLanSharing(options).status(4178).enabled,true);
 assert.equal((await request('/api/lan/settings',{headers:{host:'127.0.0.1:4178','x-sfx-local':'1'}})).status,403);
 const page=await request('/');
 assert.match(page.body,/<form/);
 assert.equal(page.headers['Referrer-Policy'],'same-origin','HTTP login forms must preserve their same-origin Origin instead of inheriting no-referrer');
 const navigation={'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
 assert.match((await request('/',{headers:navigation})).body,/<form/,'a link from the local settings page must open the LAN login page');
 assert.equal((await request('/api/library',{headers:navigation})).status,403);
 assert.equal((await request('/',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'cors','sec-fetch-dest':'empty'}})).status,403);
 assert.equal((await request('/api/lan/login',{method:'POST',headers:navigation,body:LOGIN_BODY})).status,403);
 assert.equal((await request('/',{headers:{...navigation,origin:'http://evil.example'}})).status,403);
 assert.equal((await request('/api/library')).status,401);
 assert.equal((await request('/',{headers:{origin:'http://evil.example'}})).status,403);
 assert.equal((await request('/',{ip:'8.8.8.8'})).status,403);
 assert.equal((await request('/',{headers:{host:'evil.example:4178'}})).status,403);
 assert.equal((await request('/api/lan/login',{method:'POST',headers:{origin:'null'},body:LOGIN_BODY})).status,403);
 const postLogin=body=>request('/api/lan/login',{method:'POST',headers:{origin:'http://192.168.1.10:4178'},body});
const anonymous=await postLogin('password=test-password');
assert.equal(anonymous.status,401,'a missing name is rejected');
assert.match(anonymous.body,/你的名字/);
assert.equal((await postLogin('username='+encodeURIComponent('<script>x</script>')+'&password=test-password')).status,401,'names carrying markup are rejected');
const login=()=>postLogin(LOGIN_BODY);
 const logged=await login();assert.equal(logged.status,303);
 assert.match(logged.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);
 const cookie=logged.headers['Set-Cookie'].split(';')[0];
 assert.equal((await request('/api/library',{headers:{cookie}})).handled,false);
 assert.equal((await request('/api/ai/key',{headers:{cookie}})).status,403);
 for(const route of ['/api/ai/settings','/api/downloads/settings','/api/downloads/pick-folder','/api/downloads/browse-folders','/api/downloads/reveal','/api/setup','/api/browser/install','/api/downloads/blender-bridge/install']){
  assert.equal((await request(route,{method:'POST',headers:{cookie,'x-sfx-local':'1'},body:'{}'})).status,403,route+' must reject LAN administration');
  assert.equal((await request(route,{local:true,headers:{'x-sfx-local':'1'}})).handled,false,route+' remains available to host');
 }
 const devices=()=>request('/api/lan/clients',{local:true,headers:{'x-sfx-local':'1'}});
 const block=blocked=>request('/api/lan/clients',{local:true,method:'POST',headers:{'x-sfx-local':'1'},body:JSON.stringify({ip:'192.168.1.20',blocked})});
 assert.equal((await request('/api/lan/clients',{headers:{cookie,'x-sfx-local':'1'}})).status,403);
 assert.equal((await request('/api/lan/clients',{local:true})).status,403);
 let stats=JSON.parse((await devices()).body);
 assert.equal(stats.total,1);assert.equal(stats.online,1);
 assert.equal(stats.clients[0].ip,'192.168.1.20');assert.equal(stats.clients[0].firstSeen,1000);
assert.deepEqual(stats.clients[0].usernames,['tester'],'the name typed at login is recorded for the host');
assert.deepEqual(stats.clients[0].onlineUsers,['tester'],'the host sees which name is currently online');
 assert.equal((await request('/api/library',{headers:{cookie},ip:'192.168.1.21'})).status,401,'sessions are bound to their socket IP');
 const renewed=(await login()).headers['Set-Cookie'].split(';')[0];
 assert.equal((await block(true)).status,200);
 assert.equal((await request('/',{headers:{cookie:renewed}})).status,403);
 assert.equal((await login()).status,403,'blocked clients cannot log in again');
 const restored=createLanSharing(options);
 const blockedReq=Readable.from([]);blockedReq.url='/api/library';blockedReq.method='GET';blockedReq.socket={localPort:4178,remoteAddress:'::ffff:192.168.1.20'};blockedReq.headers={host:'192.168.1.10:4178'};
 const blockedRes={writeHead(status){this.status=status;},end(){}};
 await restored.handle(blockedReq,blockedRes);assert.equal(blockedRes.status,403,'blocking survives restart and IPv4-mapped addresses');
 assert.equal((await request('/',{ip:'192.168.1.22'})).status,200,'other devices are unaffected');
 await block(false);
 assert.equal((await request('/api/library',{headers:{cookie:renewed}})).status,401,'unblocking must not restore revoked sessions');
 assert.equal((await login()).status,303);
assert.equal((await postLogin('username='+encodeURIComponent('阿离')+'&password=test-password')).status,303);
stats=JSON.parse((await devices()).body);
assert.deepEqual(stats.clients.find(client=>client.ip==='192.168.1.20').usernames,['tester','阿离'],'a second name from the same IP is appended');
assert.deepEqual(stats.clients.find(client=>client.ip==='192.168.1.22').usernames,[],'devices that never logged in show no name');
 stats=JSON.parse((await devices()).body);assert.equal(stats.total,3);assert.equal(stats.online,1);
 time+=5*60*1000;
 assert.equal(JSON.parse((await devices()).body).online,0,'idle sessions are not reported as active');
 time+=12*60*60*1000+1;
 assert.equal((await request('/api/library',{headers:{cookie}})).status,401);
 const fresh=(await login()).headers['Set-Cookie'].split(';')[0];
 await save('new-password');
 assert.equal((await request('/api/library',{headers:{cookie:fresh}})).status,401);
 for(let i=0;i<5;i++)assert.equal((await login()).status,401);
 assert.equal((await login()).status,429);
 const disabled=await request('/api/lan/settings',{local:true,method:'POST',headers:{'x-sfx-local':'1'},body:'{"enabled":false}'});
 assert.equal(disabled.status,200);assert.equal((await request('/')).status,403);
});
