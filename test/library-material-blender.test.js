import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import {findMaterialBundle,launchBlenderImport} from '../server/blender-import.mjs';
import {DownloadManager} from '../server/downloads.mjs';
import {createBlenderButton} from '../src/library/blender-send.js';

// 材质导入要解决的是「贴图不是网格」：服务端把交付目录/ZIP 解析成 map→路径，
// 桥接再按 PBR 惯例接进 Principled BSDF。这里只测纯 JS 这一侧——Python 那段只能靠真机验证。

async function temp(){return fs.mkdtemp(path.join(os.tmpdir(),'sfx-material-bundle-'));}

/** 造一个和 ambientCG runner 同shape 的交付目录：textures/<Map>.<ext> + info.json。 */
async function folderDelivery(base,{title='Wood 096',maps={Color:'Color.jpg',NormalGL:'NormalGL.png',Roughness:'Roughness.jpg',AmbientOcclusionRoughnessMetalness:'ARM.jpg'},listed=true}={}){
 const dir=path.join(base,title.replace(/\s+/g,''));
 await fs.mkdir(path.join(dir,'textures'),{recursive:true});
 const textures=[];
 for(const [map,name] of Object.entries(maps)){
  await fs.writeFile(path.join(dir,'textures',name),'fake-image-bytes');
  textures.push(listed?{file:`textures/${name}`,map}:undefined);
 }
 await fs.writeFile(path.join(dir,'info.json'),JSON.stringify({title,maps:['Color'],textures:listed?textures:undefined}));
 return dir;
}

/** 最小 ZIP 写入器：只支持 stored/deflated，够把交付目录打成包。 */
async function zipFolder(dir,target){
 const entries=[];
 const walk=async(current,prefix='')=>{
  for(const item of await fs.readdir(current,{withFileTypes:true})){
   const full=path.join(current,item.name),name=prefix?`${prefix}/${item.name}`:item.name;
   if(item.isDirectory())await walk(full,name);
   else entries.push({name,data:await fs.readFile(full)});
  }
 };
 await walk(dir);
 const locals=[],central=[];
 let offset=0;
 for(const entry of entries){
  const name=Buffer.from(entry.name,'utf8');
  const deflated=zlib.deflateRawSync(entry.data),method=8;
  const crc=(await import('../server/archive.mjs')).crc32(entry.data);
  const local=Buffer.alloc(30+name.length);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);
  local.writeUInt16LE(method,8);local.writeUInt32LE(crc,14);
  local.writeUInt32LE(deflated.length,18);local.writeUInt32LE(entry.data.length,22);
  local.writeUInt16LE(name.length,26);name.copy(local,30);
  locals.push(local,deflated);
  const cd=Buffer.alloc(46+name.length);
  cd.writeUInt32LE(0x02014b50,0);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(method,10);
  cd.writeUInt32LE(crc,16);cd.writeUInt32LE(deflated.length,20);cd.writeUInt32LE(entry.data.length,24);
  cd.writeUInt16LE(name.length,28);cd.writeUInt32LE(offset,42);name.copy(cd,46);
  central.push(cd);
  offset+=local.length+deflated.length;
 }
 const cd=Buffer.concat(central),body=Buffer.concat(locals);
 const eocd=Buffer.alloc(22);
 eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(entries.length,8);eocd.writeUInt16LE(entries.length,10);
 eocd.writeUInt32LE(cd.length,12);eocd.writeUInt32LE(body.length,16);
 await fs.writeFile(target,Buffer.concat([body,cd,eocd]));
 return target;
}

test('目录交付：按 info.json 的 map 名解析成 Blender 语义槽位',async()=>{
 const base=await temp();
 try{
  const dir=await folderDelivery(base);
  const bundle=findMaterialBundle(dir);
  assert.equal(bundle.name,'Wood 096');
  assert.equal(bundle.tmpDir,null,'目录交付不该留临时目录');
  // ARM 打包图不是三张独立贴图，服务端不该把它硬塞进某个槽位
  assert.deepEqual(Object.keys(bundle.maps).sort(),['baseColor','normal','roughness']);
  assert.equal(bundle.maps.baseColor,path.join(dir,'textures','Color.jpg'));
  assert.ok(bundle.maps.normal.endsWith('NormalGL.png'),'法线优先认 NormalGL');
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('没有 info.json 清单时按文件名里的 map token 兜底',async()=>{
 const base=await temp();
 try{
  const dir=await folderDelivery(base,{listed:false});
  const bundle=findMaterialBundle(dir);
  assert.equal(bundle.maps.baseColor,path.join(dir,'textures','Color.jpg'));
  assert.equal(bundle.maps.roughness,path.join(dir,'textures','Roughness.jpg'));
  assert.equal(bundle.maps.normal,path.join(dir,'textures','NormalGL.png'),'NormalGL 要归到 normal 槽');
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('ZIP 交付：解包后同样能解析，并且不把解包目录当成交付物',async()=>{
 const base=await temp();
 try{
  const dir=await folderDelivery(base);
  const zip=await zipFolder(dir,path.join(base,'Wood096.zip'));
  const bundle=findMaterialBundle(zip);
  assert.equal(bundle.tmpDir,zip,'ZIP 交付要标记来源是压缩包，导入后据此清理解包目录');
  assert.ok(bundle.dir!==zip,'贴图必须解到真实目录，Blender 读不了压缩包');
  assert.equal(bundle.maps.baseColor,path.join(bundle.dir,'textures','Color.jpg'));
  assert.ok(fsSync.existsSync(bundle.maps.baseColor),'解包后贴图必须真实存在');
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('贴图一个都没识别出来时明确报错，不静默导一个空材质',async()=>{
 const base=await temp();
 try{
  const dir=path.join(base,'empty');
  await fs.mkdir(path.join(dir,'textures'),{recursive:true});
  await fs.writeFile(path.join(dir,'textures','readme.txt'),'no maps here');
  assert.throws(()=>findMaterialBundle(dir),/没有识别到可用的 PBR 贴图/);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('sendToBlender 按 kind 分流：材质走 materialImporter，模型走 blenderImporter',async()=>{
 const base=await temp();
 try{
  const calls=[];
  const m=await new DownloadManager({
   dataDir:path.join(base,'state'),defaultFolder:path.join(base,'downloads'),
   browser:()=>'/fixture/browser',blender:()=>'/fixture/blender',
   blenderImporter:file=>(calls.push({which:'model',file}),{ok:true,file}),
   materialImporter:file=>(calls.push({which:'material',file}),{ok:true,name:'Wood 096'}),
  }).init();
  try{
   const materialJob={kind:'ambientcg',filePath:'C:/x/wood',logs:[]};
   // sendToBlender 现在是异步的：桥接请求改成进程内 socket 后不再有同步子进程。
   const result=await m.sendToBlender(materialJob);
   await m.sendToBlender({kind:'sketchfab',filePath:'C:/x/model',logs:[]});
   assert.deepEqual(calls.map(c=>c.which),['material','model']);
   // 材质的消息要说「导入材质」，别再说「已发送模型文件」
   assert.match(materialJob.logs.join('\n'),/导入/);
   assert.equal(result.name,'Wood 096');
  }finally{await m.close();}
 }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('Blender 按钮文案按 kind 分：材质说导入材质，模型说发送模型',()=>{
 const button=createBlenderButton({icon:name=>`<i class="${name}"></i>`});
 const material=button({job:{id:'j1',kind:'ambientcg'}});
 assert.match(material,/把已下载的材质导入已打开的 Blender/);
 assert.ok(material.includes('>材质<'),'材质卡按钮不该写「发送到 Blender」');
 const model=button({job:{id:'j2',kind:'sketchfab'}});
 assert.match(model,/把已下载的模型发送到已打开的 Blender/);
 assert.ok(model.includes('发送到 Blender'));
 assert.equal(button({job:null}),'','没有本地文件就没有按钮');
});

test('模型导入仍只认 glb/gltf/fbx —— 材质路径不能放宽这条',async()=>{
 const base=await temp();
 try{
  const dir=await folderDelivery(base);
  // findBlenderImportFile 只在 launchBlenderImport 内部用，这里直接验证它拒绝材质目录。
  // launchBlenderImport 是 async 的（桥接走进程内 socket），失败表现为 rejected promise。
  await assert.rejects(()=>launchBlenderImport(dir,{blender:()=>null}),/没有可导入 Blender 的 GLB、glTF 或 FBX 文件/);
 }finally{await fs.rm(base,{recursive:true,force:true});}
});
test('桥接请求不得靠派生子进程发 —— 同步 spawn 在部分 Windows 上直接 EBUSY',()=>{
 // 这条是防回归：早前bridgeRequest 用 execFileSync 拉一个 node 子进程当socket 客户端，
 // 而同步派生子进程在部分环境（实测本机连 cmd.exe 都 EBUSY）会让整条链路断成「Blender 没响应」。
 // 现在必须是进程内 net.createConnection。
 const src=fsSync.readFileSync(new URL('../server/blender-import.mjs',import.meta.url),'utf8');
 const body=src.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
 assert.equal(/execFileSync/.test(body),false,'blender-import.mjs 不该再出现 execFileSync');
 assert.match(body,/createConnection/,'桥接请求应该直接用 net.createConnection');
 // 同步 sleepSync（Atomics.wait）同样会冻住事件循环，不该留着。
 assert.equal(/Atomics\.wait/.test(body),false,'不该再用 Atomics.wait 做同步等待');
});
