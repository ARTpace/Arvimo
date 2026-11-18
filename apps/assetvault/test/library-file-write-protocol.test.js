import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {createLibraryDb} from '../server/library-db.mjs';
import {createLibraryStorage} from '../server/library-storage.mjs';
import {assertFileWriteProtocol,requireFileWriteProtocol} from '../server/file-write-protocol.mjs';

test('旧库兼容；开启保护后拒绝缺失/未知协议；已有整理库无需新标记也受保护',t=>{
 const db=createLibraryDb({Database,file:':memory:'});t.after(()=>db.close());
 assert.doesNotThrow(()=>assertFileWriteProtocol(db,null));
 db.run("INSERT INTO file_roots (root_id,path,writable) VALUES ('root','H:/test',1)");
 assert.throws(()=>assertFileWriteProtocol(db,null),error=>error.status===426&&error.requiredProtocol==='1');
 assert.doesNotThrow(()=>assertFileWriteProtocol(db,'1'));
 requireFileWriteProtocol(db);db.run('UPDATE file_roots SET writable=0');
 assert.throws(()=>assertFileWriteProtocol(db,'0'),/刷新或升级/);
 assert.throws(()=>assertFileWriteProtocol(db,'2'),/刷新或升级/);
 assert.throws(()=>assertFileWriteProtocol(null,null),error=>error.status===503);
});

test('写队列内核验：开启保护后排队旧保存与旧增量零副作用，重开仍受保护，新版可写',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-protocol-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const storage=createLibraryStorage(dir);t.after(()=>storage.close());
 await storage.save({'sfx-library-ui':'{"initial":true}'},{clientProtocol:null});
 const enable=storage.withDbWrite(conn=>requireFileWriteProtocol(conn));
 const stale=storage.save({'sfx-library-ui':'{"stale":true}'},{clientProtocol:null});
 await enable;await assert.rejects(stale,error=>error.code==='client_upgrade_required');
 let transformed=false;
 await assert.rejects(storage.mutate(values=>{transformed=true;return {...values,'sfx-library-ui':'{}'};},{clientProtocol:null}),/刷新或升级/);
 assert.equal(transformed,false);
 assert.equal((await storage.load()).values['sfx-library-ui'],'{"initial":true}');
 const reopened=createLibraryStorage(dir);t.after(()=>reopened.close());
 await assert.rejects(reopened.save({'sfx-library-ui':'{}'},{clientProtocol:null}),/刷新或升级/);
 await reopened.save({'sfx-library-ui':'{"new":true}'},{clientProtocol:'1'});
 assert.equal((await reopened.load()).values['sfx-library-ui'],'{"new":true}');
});

test('没有 DB 的文件模式可降级；已有 DB 无法读取时快照拒绝且不改写',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'av-protocol-fallback-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const storage=createLibraryStorage(dir,null,{disableDb:true});t.after(()=>storage.close());
 await storage.save({'sfx-library-ui':'{"fileOnly":true}'},{clientProtocol:null});
 await fs.writeFile(path.join(dir,'library.db'),'unavailable-db');
 await assert.rejects(storage.save({'sfx-library-ui':'{"stale":true}'},{clientProtocol:'1'}),error=>error.code==='write_protocol_unavailable');
 assert.equal((await storage.load()).values['sfx-library-ui'],'{"fileOnly":true}');
});
