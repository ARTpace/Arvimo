import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {dccProfiles,installDcc,dccStatus,sendDcc} from '../server/dcc-import.mjs';
import {resolveDccImport} from '../server/blender-import.mjs';
import {TARGETS as serverTargets} from '../server/export-targets.mjs';
import {TARGETS as clientTargets} from '../src/library/export-targets.js';

async function fixture(t){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-dcc-'));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 return {home,appData:path.join(home,'AppData'),localAppData:path.join(home,'LocalAppData'),dataDir:path.join(home,'data'),programFiles:path.join(home,'Programs'),useRegistry:false};
}

test('DCC menus use real scene import while engine project exports and Blender stay intact',()=>{
 for(const target of ['maya','3dsmax','houdini','c4d']){
  assert.equal(serverTargets.find(t=>t.id===target).kind,'dcc');
  assert.equal(clientTargets.find(t=>t.id===target).kind,'dcc');
 }
 assert.equal(serverTargets.find(t=>t.id==='blender').kind,'bridge');
 assert.equal(serverTargets.find(t=>t.id==='unity').kind,'dir');
});

test('installer detects four DCC profiles, preserves Maya startup and installs idempotently',async t=>{
 const env=await fixture(t);
 const profiles={maya:path.join(env.home,'Documents','maya','2025'),houdini:path.join(env.home,'Documents','houdini21.0'),'3dsmax':path.join(env.localAppData,'Autodesk','3dsMax','2026 - 64bit','ENU'),c4d:path.join(env.appData,'Maxon','Maxon Cinema 4D 2025_ABC')};
 for(const profile of Object.values(profiles))await fs.mkdir(profile,{recursive:true});
 const startup=path.join(profiles.maya,'scripts','userSetup.py');await fs.mkdir(path.dirname(startup));await fs.writeFile(startup,'print("existing startup")\n');
 for(const target of Object.keys(profiles)){
  assert.deepEqual(await dccProfiles(target,env),[await fs.realpath(profiles[target])]);
  const result=await installDcc(env.dataDir,target,env);assert.equal(result.ok,true);
 }
 await installDcc(env.dataDir,'maya',env);
 const script=await fs.readFile(startup,'utf8');
 assert.match(script,/existing startup/);assert.equal((script.match(/receiver: begin/g)||[]).length,1);
 assert.equal(await fs.readFile(startup+'.assetvault-backup','utf8'),'print("existing startup")\n');
 const status=await dccStatus(env.dataDir,'maya',env);assert.equal(status.installed,true);assert.equal(status.connected,false);
});

test('unsupported software and missing profiles fail without creating fake installs',async t=>{
 const env=await fixture(t);
 await assert.rejects(installDcc(env.dataDir,'unknown',env),/不支持/);
 await assert.rejects(installDcc(env.dataDir,'maya',env),/先启动/);
});

test('native imports select persistent FBX before GLB/OBJ and explain GLB-only assets',async t=>{
 const env=await fixture(t),dir=path.join(env.home,'asset');await fs.mkdir(dir);
 await fs.writeFile(path.join(dir,'model.glb'),'glb');
 assert.throws(()=>resolveDccImport(dir),/没有 FBX 或 OBJ/);
 await fs.writeFile(path.join(dir,'model.obj'),'obj');await fs.writeFile(path.join(dir,'model.fbx'),'fbx');
 assert.equal(resolveDccImport(dir).file,await fs.realpath(path.join(dir,'model.fbx')));
});

test('sender waits for matching software acknowledgement instead of reporting file-copy success',async t=>{
 const env=await fixture(t),dir=path.join(env.dataDir,'dcc-import','maya');await fs.mkdir(dir,{recursive:true});
 const file=path.join(env.home,'asset.fbx');await fs.writeFile(file,'fbx');
 await fs.writeFile(path.join(dir,'status-123.json'),JSON.stringify({pid:123,target:'maya',at:Date.now()}));
 let observed=false;
 const timer=setInterval(async()=>{
  for(const name of await fs.readdir(dir))if(name.endsWith('.request.json')){
   const request=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));
   assert.equal(request.session,123);assert.equal(request.file,await fs.realpath(file));observed=true;
   await fs.writeFile(path.join(dir,name.replace('.request.json','.response.json')),JSON.stringify({ok:true,detail:'actual-scene-object'}));
   clearInterval(timer);
  }
 },20);
 t.after(()=>clearInterval(timer));
 const result=await sendDcc({dataDir:env.dataDir,target:'maya',job:{filePath:file,name:'Asset'},timeout:2000});
 assert.equal(observed,true);assert.equal(result.detail,'actual-scene-object');
 assert.equal((await fs.readdir(dir)).some(name=>name.endsWith('.request.json')),false);
});

test('stale receivers are disconnected and multiple sessions are never guessed',async t=>{
 const env=await fixture(t),dir=path.join(env.dataDir,'dcc-import','maya');await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'status-1.json'),JSON.stringify({pid:1,target:'maya',at:0}));
 await assert.rejects(sendDcc({dataDir:env.dataDir,target:'maya',job:{}}),/先在设置/);
 for(const pid of [1,2])await fs.writeFile(path.join(dir,`status-${pid}.json`),JSON.stringify({pid,target:'maya',at:Date.now()}));
 await assert.rejects(sendDcc({dataDir:env.dataDir,target:'maya',job:{}}),/多个软件窗口/);
});

test('missing acknowledgement expires the request without claiming import succeeded',async t=>{
 const env=await fixture(t),dir=path.join(env.dataDir,'dcc-import','maya');await fs.mkdir(dir,{recursive:true});
 const file=path.join(env.home,'asset.obj');await fs.writeFile(file,'obj');
 await fs.writeFile(path.join(dir,'status-123.json'),JSON.stringify({pid:123,target:'maya',at:Date.now()}));
 await assert.rejects(sendDcc({dataDir:env.dataDir,target:'maya',job:{filePath:file},timeout:30}),/超时/);
 assert.equal((await fs.readdir(dir)).some(name=>name.includes('.request')),false);
});
