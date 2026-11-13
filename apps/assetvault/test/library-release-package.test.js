import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('Windows 桌面壳将文件拖放交给 HTML5，允许内嵌画布接收本地文件',async()=>{
 const config=JSON.parse(await fs.readFile(new URL('../sketchfab-exporter-tauri/src-tauri/tauri.conf.json',import.meta.url),'utf8'));
 // WebView2's native drop handler replaces HTML5 DnD when enabled.
 assert.equal(config.app.windows[0].dragDropEnabled,false);
});

test('Windows 标题经过 JSON 解码后保留中文品牌，不出现乱码',async()=>{
 const config=JSON.parse(await fs.readFile(new URL('../sketchfab-exporter-tauri/src-tauri/tauri.conf.json',import.meta.url),'utf8'));
 assert.equal(config.app.windows[0].title,'Arvimo \u00b7 \u827a\u56e2');
});

test('发布清单与手动安装共用签名包装器，不再生成第二个更新安装包',async()=>{
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'assetvault-release-'));
 const root=path.join(workspace,'apps/assetvault/desktop');
 try{
  const scripts=path.join(root,'scripts'),dist=path.join(workspace,'dist'),tauri=path.join(root,'src-tauri'),bundle=path.join(tauri,'target/release/bundle/nsis');
  for(const dir of [scripts,dist,bundle])await fs.mkdir(dir,{recursive:true});
  await fs.copyFile(new URL('../sketchfab-exporter-tauri/scripts/prepare-release.mjs',import.meta.url),path.join(scripts,'prepare-release.mjs'));
  await fs.writeFile(path.join(tauri,'tauri.conf.json'),JSON.stringify({version:'9.8.7'}));
  const name='Arvimo_9.8.7_x64-setup.exe';
  await fs.writeFile(path.join(dist,name),'wrapper-fixture');await fs.writeFile(path.join(dist,name+'.sig'),'wrapper-signature');
  await fs.writeFile(path.join(bundle,name),'engine-fixture');await fs.writeFile(path.join(bundle,name+'.sig'),'engine-signature');
  await promisify(execFile)(process.execPath,[path.join(scripts,'prepare-release.mjs')]);
  const manifest=JSON.parse(await fs.readFile(path.join(dist,'latest.json'),'utf8'));
  assert.ok(manifest.platforms['windows-x86_64'].url.endsWith('/'+name));
  assert.equal(manifest.platforms['windows-x86_64'].signature,'wrapper-signature');
  assert.deepEqual((await fs.readdir(dist)).sort(),[name,name+'.sig','latest.json'].sort());
  assert.deepEqual(await fs.readdir(bundle),[]);
 }finally{await fs.rm(workspace,{recursive:true,force:true});}
});
