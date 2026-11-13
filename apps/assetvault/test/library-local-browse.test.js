import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listLocalFolder,resolveLocalFile,localMime,parseRange,fileKind} from '../server/local-browse.mjs';

// 本地文件夹索引：只读扫描 + 越界防护。这两条任一失守，用户要么卡在几千个 node_modules
// 文件里，要么能通过 rel 读到索引目录之外的东西。
async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'sfx-local-'));}

async function fixture(base){
 await fs.mkdir(path.join(base,'models'),{recursive:true});
 await fs.mkdir(path.join(base,'tex'),{recursive:true});
 await fs.mkdir(path.join(base,'node_modules','pkg'),{recursive:true});
 await fs.mkdir(path.join(base,'.git'),{recursive:true});
 await fs.writeFile(path.join(base,'models','chair.glb'),'glb');
 await fs.writeFile(path.join(base,'models','terrain.obj'),'obj');
 await fs.writeFile(path.join(base,'tex','wood.png'),'png');
 await fs.writeFile(path.join(base,'tex','sky.exr'),'exr');
 await fs.writeFile(path.join(base,'readme.pdf'),'pdf');
 await fs.writeFile(path.join(base,'song.mp3'),'mp3');
 await fs.writeFile(path.join(base,'node_modules','pkg','index.js'),'js');
 await fs.writeFile(path.join(base,'.git','HEAD'),'ref');
 await fs.writeFile(path.join(base,'.hidden.png'),'png');
 return base;
}

test('扫描只收可预览的文件，跳过依赖与版本库目录',async()=>{
 const base=await fixture(await temp());
 try{
  const result=await listLocalFolder({folder:base});
  const names=result.files.map(f=>f.rel).sort();
  assert.deepEqual(names,['models/chair.glb','models/terrain.obj','readme.pdf','song.mp3','tex/sky.exr','tex/wood.png']);
  assert.ok(!names.some(n=>n.includes('node_modules')||n.includes('.git')),'依赖与版本库目录必须跳过');
  const kinds=Object.fromEntries(result.files.map(f=>[f.name,f.kind]));
  assert.equal(kinds['chair.glb'],'model');
  assert.equal(kinds['terrain.obj'],'model');
  assert.equal(kinds['sky.exr'],'env','exr 归环境贴图，不进图片');
  assert.equal(kinds['wood.png'],'image');
  assert.equal(kinds['song.mp3'],'audio');
  assert.equal(kinds['readme.pdf'],'document');
  assert.equal(result.counts.model,2);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('文件数超限要截断而不是死循环',async()=>{
 const base=await temp();
 try{
  for(let i=0;i<12;i++)await fs.writeFile(path.join(base,`f${i}.png`),'x');
  const result=await listLocalFolder({folder:base,limit:5});
  assert.equal(result.files.length,5);
  assert.equal(result.truncated,true);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('相对路径不能越过索引根目录',async()=>{
 const base=await fixture(await temp());
 try{
  const ok=resolveLocalFile({root:base,rel:'models/chair.glb'});
  assert.equal(ok.rel,'models/chair.glb');
  assert.ok(fsSync.existsSync(ok.file));
  assert.throws(()=>resolveLocalFile({root:base,rel:'../outside.txt'}),/不合法/);
  assert.throws(()=>resolveLocalFile({root:base,rel:'models/../../etc/passwd'}),/不合法/);
  assert.throws(()=>resolveLocalFile({root:base,rel:'models'}),/不是文件/,'目录不能被当文件读');
  assert.throws(()=>resolveLocalFile({root:path.join(base,'nope'),rel:'a.png'}),/不存在|未连接/);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('Range 解析：正常区间、尾段、越界',()=>{
 assert.deepEqual(parseRange('bytes=0-99',1000),{start:0,end:99});
 assert.deepEqual(parseRange('bytes=100-',1000),{start:100,end:999});
 assert.deepEqual(parseRange('bytes=-50',1000),{start:950,end:999});
 assert.deepEqual(parseRange('bytes=0-9999',1000),{start:0,end:999});
 assert.equal(parseRange('',1000),null);
 assert.equal(parseRange('bytes=abc',1000),null);
 assert.deepEqual(parseRange('bytes=1000-',1000),{invalid:true},'起点越界要回 416，不能读越界数据');
});

test('MIME 与类型映射覆盖各档',()=>{
 assert.equal(localMime('a.glb'),'model/gltf-binary');
 assert.equal(localMime('a.stl'),'model/stl');
 assert.equal(localMime('a.exr'),'image/x-exr');
 assert.equal(localMime('a.ttf'),'font/ttf');
 assert.equal(localMime('a.mp4'),'video/mp4');
 assert.equal(localMime('a.mkv'),'video/x-matroska');
 assert.equal(localMime('a.pdf'),'application/pdf');
 assert.equal(localMime('a.unknown'),'application/octet-stream');
 assert.equal(fileKind('x.woff2'),'font');
 assert.equal(fileKind('x.mkv'),'video');
 assert.equal(fileKind('x.psd'),'image');
 assert.equal(fileKind('x.md'),'document');
 assert.equal(fileKind('x.bin'),'other');
});

// 新路由必须登记进能力契约。老进程没有 /api/local/*，只升代码不升能力位的话，
// 启动器会把旧进程判成「已是最新」，本地视图永远只看得到空列表。
test('本地索引登记进能力契约，旧进程才会被换掉',async()=>{
 const {SERVER_CAPABILITIES,SERVER_VERSION}=await import('../server/capabilities.mjs');
 assert.equal(SERVER_CAPABILITIES.localFolderIndex,true,'缺 localFolderIndex 能力位');
 // 不能用 patch 号比较：3.7.0 的 patch 是 0，比 3.6.9 小。
 const [major,minor]=SERVER_VERSION.split('.').map(Number);
 assert.ok(major>3||(major===3&&minor>=7),`版本要往前推，当前 ${SERVER_VERSION}`);
 const server=await fs.readFile(new URL('../server/library.mjs',import.meta.url),'utf8');
 assert.ok(server.includes("'/api/library/scan'"),'缺 /api/library/scan 路由');
 assert.ok(server.includes("'/api/local/file'"),'缺 /api/local/file 路由');
 assert.ok(server.includes('isLocalRootAllowed'),'取文件必须过索引根白名单');
});

// 资产库只扫自己的目录：没有第二个导航页，也没有「选一个文件夹」这一步。
// 用户把素材拷进资产库文件夹就该被认出来，不需要先声明一个来源。
test('资产库扫描自己的目录，不另开导航页也不让用户选文件夹',async()=>{
 const html=await fs.readFile(new URL('../src/library/index.html',import.meta.url),'utf8');
 const app=await fs.readFile(new URL('../src/library/app.js',import.meta.url),'utf8');
 const server=await fs.readFile(new URL('../server/library.mjs',import.meta.url),'utf8');
 assert.ok(!/data-route="local"/.test(html),'导航里不该有「本地」这一页');
 assert.ok(!/data-library-source/.test(html),'不该再有来源切换');
 assert.ok(!html.includes('id="local-pick-folder"'),'不该让用户选文件夹：根由资产库自己决定');
 assert.ok(html.includes('id="local-rescan"'),'要有「扫描本地文件」入口');
 assert.ok(app.includes('scanLibraryFiles'),'缺扫描逻辑');
 assert.ok(app.includes('extraCards'),'本地文件要接在资产库网格里，而不是另起一个网格');
 assert.ok(server.includes("'/api/library/scan'"),'缺扫描接口');
 assert.ok(!server.includes("'/api/local/list'"),'旧的「选文件夹」接口要撤掉');
});
