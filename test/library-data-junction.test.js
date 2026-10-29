import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DownloadManager} from '../server/downloads.mjs';
test('旧数据路径为目录联接时，真实目录加锁且阻止第二个服务写入',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sfx-data-junction-'));
 const real=path.join(dir,'current'),legacy=path.join(dir,'legacy');
 await fs.mkdir(real);await fs.symlink(real,legacy,process.platform==='win32'?'junction':'dir');
 let manager;
 t.after(async()=>{await manager?.close();await fs.unlink(legacy);await fs.rm(dir,{recursive:true,force:true});});
 manager=await new DownloadManager({dataDir:legacy,defaultFolder:path.join(dir,'downloads'),autoStart:false}).init();
 assert.equal(manager.dataDir,await fs.realpath(real));
 const owner=JSON.parse(await fs.readFile(path.join(real,'manager.lock'),'utf8'));assert.equal(owner.pid,process.pid);
 await assert.rejects(new DownloadManager({dataDir:real,defaultFolder:path.join(dir,'downloads'),autoStart:false}).init(),/另一个服务使用/);
});
