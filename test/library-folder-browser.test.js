import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {browseFolders} from '../server/folder-dialog.mjs';
import {createLibraryServer} from '../server/library.mjs';

test('in-app folder browser lists only folders, navigates parents and handles invalid paths',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'av-folders-'));
 try{
  await fs.mkdir(path.join(root,'材质'));await fs.mkdir(path.join(root,'Models'));
  await fs.writeFile(path.join(root,'secret.txt'),'not returned');
  const result=await browseFolders({folder:root});
  assert.equal(result.folder,await fs.realpath(root));assert.equal(result.selectable,true);
  assert.deepEqual(new Set(result.directories.map(item=>item.name)),new Set(['材质','Models']));
  const child=await browseFolders({folder:path.join(root,'材质')});
  assert.equal(child.parent,result.folder);assert.deepEqual(child.directories,[]);
  const fallback=await browseFolders({folder:path.join(root,'missing'),initial:true});
  assert.equal(fallback.folder,result.folder);
  await assert.rejects(browseFolders({folder:path.join(root,'missing')}));
  await assert.rejects(browseFolders({folder:path.join(root,'secret.txt')}));
  for(const folder of ['relative','\\\\server\\share','//server/share','C:\\bad\0',12])await assert.rejects(browseFolders({folder}));
  const disks=await browseFolders();assert.equal(disks.selectable,false);assert.ok(disks.directories.length);
  const disk=await browseFolders({folder:path.parse(root).root});assert.equal(disk.selectable,false);assert.equal(disk.parent,'');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('folder navigation endpoint requires local marker and rejects cross-origin requests',async()=>{
 const server=createLibraryServer({downloads:{}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/api/downloads/browse-folders`;
 try{
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{'X-SFX-Local':'1',Origin:'https://evil.test'},body:'{}'})).status,403);
  const response=await fetch(url,{method:'POST',headers:{'X-SFX-Local':'1'},body:'{}'});
  assert.equal(response.status,200);assert.ok((await response.json()).directories.length);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
