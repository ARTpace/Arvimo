import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {resolveBlenderImport,findHdriFile,resolveDccImport} from '../server/blender-import.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {createBlenderButton} from '../src/library/blender-send.js';

test('ambientCG OBJ packages preserve MTL and textures at a persistent import location',async()=>{
 const base=await temp();
 try{
  const dir=await kenneyDelivery(base,{zipEntries:[
   {name:'apple/apple.obj',data:'mtllib apple.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'},
   {name:'apple/apple.mtl',data:'newmtl apple\nmap_Kd color.jpg'},
   {name:'apple/color.jpg',data:'texture'},
  ]});
  const asset=resolveBlenderImport(dir);
  assert.match(asset.file,/apple\.obj$/);assert.equal(asset.tmpDir,null);assert.ok(fsSync.existsSync(asset.file));
  assert.equal(fsSync.readFileSync(path.join(path.dirname(asset.file),'color.jpg'),'utf8'),'texture');
  assert.equal(resolveBlenderImport(dir).file,asset.file);
  const terrain=path.join(base,'Terrain001.obj');await fs.writeFile(terrain,'v 0 0 0');
  assert.equal(resolveBlenderImport(terrain).file,terrain);
  const button=createBlenderButton({icon:()=>''});
  assert.match(button({job:{id:'terrain',kind:'ambientcg',assetType:'models',sourceType:'terrain'}}),/blender-send/);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

// 新平台（Kenney / FreeStylized / Poly Pizza / Poly Haven HDRI）下载后的 Blender 导入：
// 资源包平台的交付目录里只有一个原始 pack.zip，真正的模型在压缩包里；
// Poly Haven HDRI 是 .hdr 环境贴图，走桥接的 environment 操作设世界环境。
// 这里只测纯 JS 这一侧——Python 那段只能靠真机验证。

async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'sfx-pack-import-'));}

/** 最小 ZIP 写入器：stored 条目，够把假 pack.zip 打出来。 */
async function writeZip(target,entries){
 const locals=[],central=[];
 let offset=0;
 for(const entry of entries){
  const name=Buffer.from(entry.name,'utf8'),data=Buffer.from(entry.data,'utf8');
  const crc=(await import('../server/archive.mjs')).crc32(data);
  const local=Buffer.alloc(30+name.length);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);
  local.writeUInt16LE(0,8);local.writeUInt32LE(crc,14);
  local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);
  local.writeUInt16LE(name.length,26);name.copy(local,30);
  locals.push(local,data);
  const cd=Buffer.alloc(46+name.length);
  cd.writeUInt32LE(0x02014b50,0);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(0,10);
  cd.writeUInt32LE(crc,16);cd.writeUInt32LE(data.length,20);cd.writeUInt32LE(data.length,24);
  cd.writeUInt16LE(name.length,28);cd.writeUInt32LE(offset,42);name.copy(cd,46);
  central.push(cd);
  offset+=local.length+data.length;
 }
 const cd=Buffer.concat(central),body=Buffer.concat(locals);
 const eocd=Buffer.alloc(22);
 eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(entries.length,8);eocd.writeUInt16LE(entries.length,10);
 eocd.writeUInt32LE(cd.length,12);eocd.writeUInt32LE(body.length,16);
 await fs.writeFile(target,Buffer.concat([body,cd,eocd]));
 return target;
}

/** Kenney 风格的交付目录：info.json + pack.zip，模型嵌在 zip 深处。 */
async function kenneyDelivery(base,{zipEntries}={}){
 const dir=path.join(base,'car-kit-pack');
 await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'info.json'),JSON.stringify({uid:'kenney-car-kit',kind:'pack',platform:'kenney'}));
 await writeZip(path.join(dir,'pack.zip'),zipEntries??[
  {name:'car-kit/License.txt',data:'CC0'},
  {name:'car-kit/Models/GLB format/sedan.glb',data:'fake-glb-bytes'},
  {name:'car-kit/Models/FBX/sedan.fbx',data:'fake-fbx-bytes'},
 ]);
 return dir;
}

test('其他 DCC 直接复用 ZIP 解包，挑 FBX 且长期保留相对贴图路径',async()=>{
 const base=await temp();
 try{
  const delivery=await kenneyDelivery(base,{zipEntries:[
   {name:'asset/model.glb',data:'glb'},
   {name:'asset/model.fbx',data:'fbx'},
   {name:'asset/textures/color.png',data:'texture'}
  ]});
  const result=resolveDccImport(delivery);
  assert.match(result.file,/pack\.unpacked[\\/]asset[\\/]model\.fbx$/);
  assert.equal(await fs.readFile(path.join(path.dirname(result.file),'textures','color.png'),'utf8'),'texture');
  assert.equal(resolveDccImport(delivery).file,result.file);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('资源包交付：文件夹里只有 pack.zip 也能解出模型',async()=>{
 const base=await temp();
 try{
  const dir=await kenneyDelivery(base);
  const asset=resolveBlenderImport(dir);
  assert.ok(asset.tmpDir,'ZIP 交付必须标记临时目录，让调用方在导入后清理');
  assert.match(asset.file,/sedan\.glb$/,'优先挑 glb，不落 fbx');
  assert.ok(fsSync.existsSync(asset.file),'解出的模型必须真实存在');
  fsSync.rmSync(asset.tmpDir,{recursive:true,force:true});
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('ZIP 显式目录条目不会被写成文件，支持重复目录与嵌套贴图',async()=>{
 const base=await temp();
 let asset;
 try{
  const dir=await kenneyDelivery(base,{zipEntries:[
   {name:'floor_tiles_34_2k/',data:''},
   {name:'floor_tiles_34_2k/',data:''},
   {name:'floor_tiles_34_2k/textures/',data:''},
   {name:'floor_tiles_34_2k/textures/base.png',data:'texture'},
   {name:'floor_tiles_34_2k/model.gltf',data:'model'},
  ]});
  asset=resolveBlenderImport(dir);
  assert.ok(fsSync.statSync(path.join(asset.tmpDir,'floor_tiles_34_2k')).isDirectory());
  assert.equal(await fs.readFile(asset.file,'utf8'),'model');
  assert.equal(await fs.readFile(path.join(asset.tmpDir,'floor_tiles_34_2k/textures/base.png'),'utf8'),'texture');
 }finally{
  if(asset?.tmpDir)await fs.rm(asset.tmpDir,{recursive:true,force:true});
  await fs.rm(base,{recursive:true,force:true});
 }
});

test('直接把 ZIP 当交付物也一样能解',async()=>{
 const base=await temp();
 try{
  const dir=await kenneyDelivery(base);
  const asset=resolveBlenderImport(path.join(dir,'pack.zip'));
  assert.match(asset.file,/sedan\.glb$/);
  fsSync.rmSync(asset.tmpDir,{recursive:true,force:true});
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('资源包里没有模型时明确报错（FreeStylized 贴图包/天空盒的情况）',async()=>{
 const base=await temp();
 try{
  const dir=await kenneyDelivery(base,{zipEntries:[
   {name:'pack/textures/brick_diffuse.jpg',data:'fake-jpg'},
   {name:'pack/preview.png',data:'fake-png'},
  ]});
  assert.throws(()=>resolveBlenderImport(dir),/资源包里没有可导入 Blender 的 GLB、glTF、FBX 或 OBJ 模型/);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('散置模型优先：Poly Pizza 的 model.glb 目录不该碰 zip 逻辑',async()=>{
 const base=await temp();
 try{
  const dir=path.join(base,'polypizza');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'model.glb'),'fake-glb');
  const asset=resolveBlenderImport(dir);
  assert.equal(asset.file,path.join(dir,'model.glb'));
  assert.equal(asset.tmpDir,null,'散置模型不该产生临时目录');
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('HDRI 交付：info.json 清单优先，退回按扩展名扫',async()=>{
 const base=await temp();
 try{
  const dir=path.join(base,'kloofendal-hdri');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'environment.hdr'),'fake-hdr');
  await fs.writeFile(path.join(dir,'info.json'),JSON.stringify({kind:'hdri',files:[{file:'environment.hdr',bytes:8}]}));
  assert.equal(findHdriFile(dir).file,path.join(dir,'environment.hdr'));
  // 没有清单也能靠扩展名找到
  const dir2=path.join(base,'no-manifest');
  await fs.mkdir(dir2,{recursive:true});
  await fs.writeFile(path.join(dir2,'environment.exr'),'fake-exr');
  assert.equal(findHdriFile(dir2).file,path.join(dir2,'environment.exr'));
  // 什么都没有就报错
  const dir3=path.join(base,'empty');
  await fs.mkdir(dir3,{recursive:true});
  assert.throws(()=>findHdriFile(dir3),/没有[^。]*世界环境/);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('天空盒通过旧目录联接导入时，解包和贴图引用都使用真实路径',async()=>{
 const base=await temp();
 const current=path.join(base,'current'),legacy=path.join(base,'legacy');
 try{
  await fs.mkdir(current);
  await fs.symlink(current,legacy,process.platform==='win32'?'junction':'dir');
  await writeZip(path.join(current,'pack.zip'),[{name:'sky_129_2k.png',data:'panorama'}]);
  const real=await fs.realpath(current);
  const result=findHdriFile(legacy);
  assert.equal(result.file,path.join(real,'pack.unpacked','sky_129_2k.png'));
  assert.equal(result.tmpDir,null);
  assert.equal(await fs.readFile(result.file,'utf8'),'panorama');
  assert.equal(findHdriFile(legacy).file,result.file);
 }finally{
  await fs.unlink(legacy).catch(()=>{});
  await fs.rm(base,{recursive:true,force:true});
 }
});

test('ambientCG 天空盒：整包 ZIP 里优先挑 .exr，解到持久目录不清理',async()=>{
 const base=await temp();
 try{
  const dir=path.join(base,'EveningSkyHDRI048B-350dcfee');
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'info.json'),JSON.stringify({
   kind:'pack',platform:'ambientcg',assetId:'EveningSkyHDRI048B',sourceType:'hdri',
   files:[{file:'EveningSkyHDRI048B.zip'}],
  }));
  await writeZip(path.join(dir,'EveningSkyHDRI048B.zip'),[
   {name:'EveningSkyHDRI048B_2K_HDR.exr',data:'fake-exr'},
   {name:'EveningSkyHDRI048B_2K_TONEMAPPED.jpg',data:'fake-jpg'},
   {name:'EveningSkyHDRI048B_2K.blend',data:'fake-blend'},
  ]);
  const first=findHdriFile(dir);
  // 反证：以前这里返回 os.tmpdir 下的临时目录，调用方 finally 一删，Blender 的
  // Image datablock 就指向不存在的文件，世界环境整片变成缺失贴图的洋红（用户看到的爆粉）。
  assert.equal(first.tmpDir,null,'环境图必须落在持久位置，不能交给临时目录');
  assert.match(first.file,/_2K_HDR\.exr$/,'要挑真 HDR，不能拿 TONEMAPPED 的 LDR 全景图凑数');
  assert.equal(first.file,path.join(dir,'EveningSkyHDRI048B.unpacked','EveningSkyHDRI048B_2K_HDR.exr'),'解包目录固定在压缩包旁边');
  assert.ok(fsSync.existsSync(first.file),'交给 Blender 的文件必须真实存在');
  // 第二次导入直接命中已解包的文件，不重复落盘
  const second=findHdriFile(dir);
  assert.equal(second.file,first.file);
  assert.equal(second.tmpDir,null);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('sendToBlender 三路分流：材质 / HDRI / 模型（含资源包）',async()=>{
 const base=await temp();
 try{
  const calls=[];
  const m=await new DownloadManager({
   dataDir:path.join(base,'state'),defaultFolder:path.join(base,'downloads'),
   browser:()=>'/fixture/browser',blender:()=>'/fixture/blender',
   blenderImporter:file=>(calls.push({which:'model',file}),{ok:true,file}),
   materialImporter:file=>(calls.push({which:'material',file}),{ok:true,name:'Wood 096'}),
   hdriImporter:file=>(calls.push({which:'hdri',file}),{ok:true,kind:'hdri',world:'World'}),
  }).init();
  try{
   await m.sendToBlender({kind:'polyhaven',assetType:'hdris',filePath:'C:/x/hdri',logs:[]});
   await m.sendToBlender({kind:'kenney',filePath:'C:/x/pack-dir',logs:[]});
   await m.sendToBlender({kind:'freestylized',filePath:'C:/x/fs-dir',logs:[]});
   await m.sendToBlender({kind:'polypizza',filePath:'C:/x/glb',logs:[]});
   assert.deepEqual(calls.map(c=>c.which),['hdri','model','model','model']);
  }finally{await m.close();}
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('Blender 按钮文案与可见性：按 kind/assetType 分流',()=>{
 const button=createBlenderButton({icon:name=>`<i class="${name}"></i>`});
  const hdri=button({job:{id:'h1',kind:'polyhaven',assetType:'hdris'}});
  assert.match(hdri,/把已下载的 HDRI\/天空盒设为已打开 Blender 的世界环境/);
 assert.ok(hdri.includes('>环境<'),'HDRI 卡按钮该写「环境」');
 const pack=button({job:{id:'p1',kind:'kenney'}});
 assert.match(pack,/把已下载的模型发送到已打开的 Blender/);
 const fsTex=button({job:{id:'f1',kind:'freestylized',assetType:'textures'}});
 assert.ok(fsTex.includes('>材质<'),'FreeStylized 贴图要写「材质」');
 assert.match(fsTex,/把已下载的材质导入已打开的 Blender/);
 const fsSky=button({job:{id:'f2',kind:'freestylized',assetType:'skybox'}});
 assert.ok(fsSky.includes('>环境<'),'FreeStylized 天空盒要写「环境」');
 assert.match(fsSky,/HDRI\/天空盒设为已打开 Blender 的世界环境/);
 // 没有可导入内容的类型不显示按钮
 assert.equal(button({job:{id:'x1',kind:'images'}}),'','纯图片不显示按钮');
 assert.equal(button({job:{id:'x2',kind:'artstation',hasMarmoset:false}}),'','ArtStation 无 Marmoset 场景不显示按钮');
 assert.equal(button({job:{id:'x3',kind:'freestylized',assetType:'alphas'}}),'','FreeStylized Alpha 单图不显示按钮');
});

test('桥接脚本必须支持 environment 操作并接世界节点图',()=>{
 const src=fsSync.readFileSync(new URL('../server/blender-bridge.py',import.meta.url),'utf8');
 const body=src.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*#.*$/gm,'');
 assert.match(body,/op == "environment"/,'桥接必须处理 environment 操作');
 assert.match(body,/ShaderNodeTexEnvironment/,'世界环境要建 Environment Texture 节点');
 assert.match(body,/ShaderNodeBackground/,'Environment Texture 后面要接 Background');
 assert.match(body,/\.hdr/,'环境贴图只认 .hdr/.exr，其余格式要拒绝');
});
