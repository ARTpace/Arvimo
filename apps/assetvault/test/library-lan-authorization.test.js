import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createLanSharing} from '../server/lan-sharing.mjs';
import {createMemberDirectory, requestPermission} from '../server/library-members.mjs';

const response = () => ({writeHead(status, headers = {}) {this.status = status; this.headers = headers;}, end(body) {this.body = body;}});
const member = (id, name, role) => ({member_id: id, name, role, disabled: 0});

test('共享口令不认证名字：逐会话审批、即时降权/禁用、撤销与重登/重启失效', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-lan-identity-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const rows = [member('m-aaaaaaaa', 'Owner', 'owner'), member('m-bbbbbbbb', 'Editor', 'editor')];
  const directory = createMemberDirectory({storage:{withDb: async fn => fn({all:()=>rows})}});
  const options = {file:path.join(dir,'lan.json'), interfaces:()=>({eth:[{family:'IPv4',internal:false,address:'192.168.1.10'}]})};
  let lan = createLanSharing(options); lan.attachMembers(directory);
  async function call(url, {local=false, method='GET', body='', cookie='', headers={}}={}) {
    const req = Readable.from([body]);
    req.url=url; req.method=method;
    req.socket={localPort:4178,remoteAddress:local?'127.0.0.1':'192.168.1.20'};
    req.headers={host:local?'127.0.0.1:4178':'192.168.1.10:4178','x-sfx-local':'1',cookie,...headers};
    const res=response(); const handled=await lan.handle(req,res);
    return {req,res,handled};
  }
  const admin = (body) => call('/api/lan/sessions',{local:true,method:'POST',body:JSON.stringify(body)});
  await call('/api/lan/settings',{local:true,method:'POST',body:JSON.stringify({enabled:true,password:'test-password'})});
  const login = async name => (await call('/api/lan/login',{method:'POST',body:new URLSearchParams({username:name,password:'test-password'}).toString()})).res.headers['Set-Cookie'].split(';')[0];
  const cookie=await login('Owner'), duplicate=await login('Owner');
  for (const c of [cookie,duplicate]) {
    const {req}=await call('/api/library/members',{cookie:c,headers:{'x-sfx-member':'m-aaaaaaaa'}});
    assert.equal((await directory.resolve(req)).role,'viewer');
  }
  assert.equal((await call('/api/lan/sessions',{cookie})).res.status,403,'LAN cannot approve itself even with local marker');
  assert.equal((await call('/api/lan/sessions',{local:true,headers:{'x-sfx-local':''}})).res.status,403);
  const sessions=JSON.parse((await call('/api/lan/sessions',{local:true})).res.body).sessions;
  assert.equal(sessions.length,2); assert.notEqual(sessions[0].id,sessions[1].id);
  assert.ok(!JSON.stringify(sessions).includes(cookie.split('=')[1]),'approval list never exposes bearer cookie');
  assert.equal((await admin({id:sessions[0].id,member_id:'m-deadbeef'})).res.status,400);
  assert.equal((await admin({id:sessions[0].id,member_id:rows[1].member_id})).res.status,200);
  const identity = async c => directory.resolve((await call('/api/library/members',{cookie:c})).req);
  assert.equal((await identity(cookie)).role,'editor');
  assert.equal((await identity(duplicate)).role,'viewer','same name/IP does not inherit approval');
  rows[1].role='viewer'; assert.equal((await identity(cookie)).role,'viewer');
  rows[1].role='editor'; rows[1].disabled=1; assert.equal((await identity(cookie)).role,'viewer');
  assert.equal((await admin({id:sessions[1].id,member_id:rows[1].member_id})).res.status,400);
  rows[1].disabled=0;
  await admin({id:sessions[0].id,member_id:''}); assert.equal((await identity(cookie)).role,'viewer');
  assert.equal((await identity(await login('Editor'))).role,'viewer');
  await call('/api/lan/logout',{method:'POST',cookie});
  assert.equal((await call('/api/library/members',{cookie})).res.status,401);
  lan=createLanSharing(options);lan.attachMembers(directory);
  assert.equal((await call('/api/library/members',{cookie:duplicate})).res.status,401);
});

test('集中路由权限：默认写拒绝、显式查询例外与主机专属操作', () => {
  assert.equal(requestPermission('POST','/api/new-write-route'),'write');
  assert.equal(requestPermission('DELETE','/api/library/query'),'write');
  assert.equal(requestPermission('POST','/api/library/query'),'read');
  assert.equal(requestPermission('POST','/api/library/members'),'manage');
  for (const route of ['/api/library/delete','/api/library/stores','/api/library/backups/restore','/api/exports/send','/api/substance/open','/api/library/import/eagle','/api/auth/register']) {
    assert.equal(requestPermission('POST',route),'host',route);
  }
});

test('真实总分发器：viewer 全写入口无磁盘/DB/任务副作用，editor 限权，主机保持可用', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-lan-matrix-'));
  const previous={};
  for (const key of ['SFX_DATA_DIR','SFX_CACHE_DIR','APPDATA']) {previous[key]=process.env[key];process.env[key]=dir;}
  t.after(async()=>{for(const key of Object.keys(previous)) {if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}await fs.rm(dir,{recursive:true,force:true});});
  const {createLibraryServer}=await import('../server/library.mjs');
  const {createLibraryDb}=await import('../server/library-db.mjs');
  const {default:Database}=await import('better-sqlite3');
  const db=createLibraryDb({Database,file:path.join(dir,'library.db')});
  db.run('INSERT INTO members (member_id,name,role,disabled,created_at) VALUES (?,?,?,?,?)',['m-bbbbbbbb','Editor','editor',0,1]);db.close();
  let effects=0;
  const downloads={dataDir:dir,defaultFolder:dir,jobs:[],settings:{folder:dir},snapshot:()=>({jobs:[]}),save(){effects++;},create(){effects++;},batch(){effects++;}};
  const server=createLibraryServer({downloads,cacheDir:dir,collect:false,backup:false,
    lanSharing:{handle:async req=>{if(req.headers['test-identity']!=='host'){req.lanVisitor=true;req.lanUser='Editor';req.lanMemberId=req.headers['test-identity']==='editor'?'m-bbbbbbbb':'';}return false;}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(route, role='viewer', body='{}', method='POST') {
    return fetch(base+route,{method,headers:{'x-sfx-local':'1','x-sfx-member':'m-bbbbbbbb','test-identity':role,'content-type':'application/json'},...(method==='GET'?{}:{body})});
  }
  const entries=['/api/library-state','/api/library/mutations','/api/library/tags/mutate','/api/library/assets/mutate','/api/library/assets/remove','/api/library/collections','/api/library/collections/items','/api/library/smart-collections','/api/library/session','/api/library/backups','/api/library/backups/restore','/api/library/import','/api/library/import/eagle','/api/library/import/eagle/probe','/api/library/stores','/api/library/stores/restart','/api/library/semantic/build','/api/library/members','/api/library/picture-board','/api/library/register','/api/library/delete','/api/local/meta-patch','/api/library/scan','/api/collect/rules','/api/collect/run','/api/collect/pending/ack','/api/downloads/tasks','/api/downloads/actions','/api/exports/send','/api/exports/configure','/api/exports/install','/api/substance/open','/api/substance/input','/api/drag/files','/api/xhs/album','/api/feedback','/api/ai/tags','/api/browser/login','/api/setup','/api/library/import-roots','/api/library/sync','/api/platforms','/api/auth/register','/api/downloads/tasks/00000000-0000-0000-0000-000000000000/action'];
  async function snapshot(folder) {
    const files={};
    for(const entry of await fs.readdir(folder,{withFileTypes:true})) {
      const file=path.join(folder,entry.name);
      if(entry.isDirectory()) Object.assign(files,await snapshot(file));
      else files[file]=(await fs.readFile(file)).toString('base64');
    }
    return files;
  }
  // SQLite 打开连接会刷新文件头的 change counter 等元数据，整文件字节比对会假失败。
  // 改为比对业务表计数 + 磁盘文件清单：越权 INSERT/UPDATE/新建文件依然会被抓到。
  const dbFile=path.join(dir,'library.db');
  const probe=createLibraryDb({Database,file:dbFile});
  const beforeCounts=probe.counts();probe.close();
  const before=await snapshot(dir);
  for(const route of entries) assert.equal((await call(route)).status,403,route);
  assert.equal((await call('/api/collect/rules','viewer','{}','DELETE')).status,403);
  assert.equal((await call('/api/library/mutations','viewer','not JSON')).status,403,'deny before body parsing');
  assert.equal(effects,0,'403 不能触发下载任务写入');
  assert.deepEqual(downloads.jobs,[],'403 不能排新任务');
  const after=await snapshot(dir);
  assert.deepEqual(Object.keys(after).sort(),Object.keys(before).sort(),'403 不能新增或删除磁盘文件');
  const verify=createLibraryDb({Database,file:dbFile});
  assert.deepEqual(verify.counts(),beforeCounts,'403 不能改动任何业务表');
  verify.close();
  for(const route of ['/api/library/delete','/api/library/backups/restore','/api/exports/send','/api/library/stores','/api/library/members']) assert.equal((await call(route,'editor')).status,403,route);
  const write=await call('/api/library/session','editor',JSON.stringify({options:{test:true}}));
  assert.equal(write.status,200,await write.text());
  assert.equal((await call('/api/library/session','host',JSON.stringify({options:{test:false}}))).status,200);
  for(const route of ['/api/library/query','/api/library/assets/detail','/api/library/collections/previews']) {
    assert.equal((await call(route,'viewer','{}')).status,200,route+' remains readable');
  }
  assert.equal((await call('/api/health','viewer','', 'GET')).status,200);
  assert.equal((await (await call('/api/library/members','viewer','', 'GET')).json()).me.local,false);
  assert.equal((await (await call('/api/library/members','host','', 'GET')).json()).me.local,true);
});
