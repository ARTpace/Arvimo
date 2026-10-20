import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('发布清单与手动安装共用签名包装器，不再生成第二个更新安装包',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-release-'));
 try{
  const scripts=path.join(root,'scripts'),dist=path.join(root,'dist'),tauri=path.join(root,'src-tauri'),bundle=path.join(tauri,'target/release/bundle/nsis');
  for(const dir of [scripts,dist,bundle])await fs.mkdir(dir,{recursive:true});
  await fs.copyFile(new URL('../sketchfab-exporter-tauri/scripts/prepare-release.mjs',import.meta.url),path.join(scripts,'prepare-release.mjs'));
  await fs.writeFile(path.join(tauri,'tauri.conf.json'),JSON.stringify({version:'9.8.7'}));
  const name='AssetVault_9.8.7_x64-setup.exe';
  await fs.writeFile(path.join(dist,name),'wrapper-fixture');await fs.writeFile(path.join(dist,name+'.sig'),'wrapper-signature');
  await fs.writeFile(path.join(bundle,name),'engine-fixture');await fs.writeFile(path.join(bundle,name+'.sig'),'engine-signature');
  await promisify(execFile)(process.execPath,[path.join(scripts,'prepare-release.mjs')]);
  const manifest=JSON.parse(await fs.readFile(path.join(dist,'latest.json'),'utf8'));
  assert.ok(manifest.platforms['windows-x86_64'].url.endsWith('/'+name));
  assert.equal(manifest.platforms['windows-x86_64'].signature,'wrapper-signature');
  assert.deepEqual((await fs.readdir(dist)).sort(),[name,name+'.sig','latest.json'].sort());
  assert.deepEqual(await fs.readdir(bundle),[]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
