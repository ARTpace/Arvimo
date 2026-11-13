import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesWindowsOwner,lockOwnerAlive,processIdentity,canReplaceOwner} from '../server/process-lock.mjs';

test('桌面接管必须同时确认服务命令、路径和创建时间',()=>{
 const owner={pid:123,startedAt:10000,executable:'C:/AssetVault/node.exe'};
 const actual={...owner,isLibrary:true};
 assert.equal(canReplaceOwner(owner,actual),true);
 assert.equal(canReplaceOwner(owner,{...actual,isLibrary:false}),false);
 assert.equal(canReplaceOwner(owner,{...actual,startedAt:20000}),false);
 assert.equal(canReplaceOwner(owner,{...actual,executable:null}),false);
 assert.equal(canReplaceOwner({pid:123},actual),false);
});

test('lock identity rejects exited processes and reused PIDs without killing anything',()=>{
 const owner={pid:123,startedAt:10000,executable:'C:\\AssetVault\\node.exe'};
 assert.equal(matchesWindowsOwner(owner,null),false);
 assert.equal(matchesWindowsOwner(owner,{startedAt:20000,executable:owner.executable}),false);
 assert.equal(matchesWindowsOwner(owner,{startedAt:10000,executable:'C:\\Other\\node.exe'}),false);
 assert.equal(matchesWindowsOwner(owner,{startedAt:10005,executable:owner.executable.toUpperCase()}),true);
 assert.equal(matchesWindowsOwner(owner,{startedAt:10005,executable:null}),true);
 assert.equal(matchesWindowsOwner({pid:123},{isLibrary:false}),false);
 assert.equal(matchesWindowsOwner({pid:123},{isLibrary:true}),true);
 assert.equal(lockOwnerAlive(processIdentity()),true);
 assert.throws(()=>lockOwnerAlive({pid:-1}),/锁无效/);
});


test('按锁身份发现安装版实际端口，拒绝 PID 被复用的进程',async()=>{
 const {libraryOwnerPorts}=await import('../server/process-lock.mjs');
 const owner={pid:123,startedAt:10000,executable:'C:/AssetVault/node.exe'};
 const inspect=actual=>()=>JSON.stringify(actual);
 assert.deepEqual(libraryOwnerPorts(owner,inspect({...owner,isLibrary:true,ports:[7579,7579]})),[7579]);
 assert.deepEqual(libraryOwnerPorts(owner,inspect({...owner,isLibrary:true,startedAt:20000,ports:[7579]})),[]);
 assert.deepEqual(libraryOwnerPorts(owner,inspect({...owner,isLibrary:false,ports:[7579]})),[]);
});
