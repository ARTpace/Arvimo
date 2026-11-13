import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);

test('build cleanup previews first, protects releases/data and only deep-cleans release dependencies on request',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-clean-'));
 try{
  for(const dir of ['scripts','dist','src-tauri/target/debug','src-tauri/target/installer-ui','src-tauri/target/release/deps','src-tauri/target/release/build','downloads','.assetvault'])await fs.mkdir(path.join(root,dir),{recursive:true});
  const script=path.join(root,'scripts/clean-build-cache.mjs');
  await fs.copyFile(new URL('../sketchfab-exporter-tauri/scripts/clean-build-cache.mjs',import.meta.url),script);
  const installer='AssetVault_1.2.3_x64-setup.exe';
  await fs.writeFile(path.join(root,'src-tauri/tauri.conf.json'),JSON.stringify({version:'1.2.3'}));
  await fs.writeFile(path.join(root,'dist',installer),'MZfixture');
  await fs.writeFile(path.join(root,'dist',installer+'.sig'),'fixture-signature');
  const manifest={version:'1.2.3',platforms:{'windows-x86_64':{url:'https://example.com/'+installer,signature:'fixture-signature'}}};
  await fs.writeFile(path.join(root,'dist/latest.json'),JSON.stringify(manifest));
  for(const name of ['src-tauri/target/debug/cache','src-tauri/target/installer-ui/engine.exe','src-tauri/target/release/deps/cache','src-tauri/target/release/build/cache','downloads/user.glb','.assetvault/settings.json'])await fs.writeFile(path.join(root,name),'keep');
  const run=(...args)=>exec(process.execPath,[script,...args]);
  assert.match((await run()).stdout,/Would remove/);
  await fs.access(path.join(root,'src-tauri/target/debug/cache'));
  await fs.writeFile(path.join(root,'dist',installer+'.sig'),'mismatch');
  await assert.rejects(run('--apply'),/inconsistent/);
  await fs.access(path.join(root,'src-tauri/target/debug/cache'));
  await fs.writeFile(path.join(root,'dist',installer+'.sig'),'fixture-signature');
  await run('--apply');
  await assert.rejects(fs.access(path.join(root,'src-tauri/target/debug')));
  await assert.rejects(fs.access(path.join(root,'src-tauri/target/installer-ui')));
  await fs.access(path.join(root,'src-tauri/target/release/deps/cache'));
  // A directory junction must not allow a generated-folder name to delete user data.
  await fs.symlink(path.join(root,'downloads'),path.join(root,'src-tauri/target/debug'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(run('--apply','--deep'),/plain generated directory/);
  await fs.access(path.join(root,'src-tauri/target/release/deps/cache'));
  await fs.unlink(path.join(root,'src-tauri/target/debug'));
  await run('--apply','--deep');
  await assert.rejects(fs.access(path.join(root,'src-tauri/target/release/deps')));
  for(const name of ['dist/'+installer,'dist/'+installer+'.sig','dist/latest.json','downloads/user.glb','.assetvault/settings.json'])await fs.access(path.join(root,name));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
